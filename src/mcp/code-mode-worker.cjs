'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { newQuickJSWASMModuleFromVariant } = require('quickjs-emscripten-core');
const variant = require('@jitl/quickjs-wasmfile-release-sync').default;

// Model-authored JavaScript runs ONLY inside QuickJS/WASM, never Node's evaluator.
let stopped = false;
const send = (message) => { if (!stopped) parentPort.postMessage(message); };
const done = (error = null) => {
  if (stopped) return;
  send({ type: 'done', error });
  stopped = true;
};
(async () => {
  const qjs = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = qjs.newRuntime();
  runtime.setMemoryLimit(workerData.limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext();
  const pending = new Map();
  let cpuMs = 0, sliceStart = 0, nextId = 0, emittedChars = 0, emittedItems = 0, fatal = null;
  const enter = (fn) => {
    sliceStart = performance.now();
    try { return fn(); }
    finally { cpuMs += performance.now() - sliceStart; }
  };
  runtime.setInterruptHandler(() => cpuMs + performance.now() - sliceStart > workerData.limits.cpuMs);
  const errorText = (handle) => {
    try { return JSON.stringify(vm.dump(handle)).slice(0, 350); }
    catch { return 'unknown QuickJS error'; }
  };
  const bridge = vm.newFunction('__hostBridge', (operation, payload) => {
    const kind = vm.getString(operation);
    const json = vm.getString(payload);
    if (stopped || fatal) return { error: vm.newError(fatal || 'Execution ended') };
    if (kind === 'call') {
      if (++nextId > workerData.limits.calls ||
          pending.size >= workerData.limits.concurrent ||
          Buffer.byteLength(json, 'utf8') > workerData.limits.argumentBytes) {
        fatal = 'CALL_LIMIT';
        return { error: vm.newError(fatal) };
      }
      const promise = vm.newPromise();
      pending.set(nextId, promise);
      send({ type: 'call', id: nextId, json });
      return promise.handle.dup();
    }
    if (kind === 'text') {
      if (++emittedItems > workerData.limits.outputItems ||
          (emittedChars += json.length) > workerData.limits.outputChars) {
        fatal = 'OUTPUT_LIMIT';
        return { error: vm.newError(fatal) };
      }
      send({ type: 'emit', json });
      return vm.undefined;
    }
    fatal = 'BRIDGE_ERROR';
    return { error: vm.newError(fatal) };
  });
  vm.setProp(vm.global, '__hostBridge', bridge);
  bridge.dispose();

  const bootstrap = [
    '(() => {',
    'const bridge = globalThis.__hostBridge;',
    'const tools = Object.create(null);',
    'tools.step = async (step) => {',
    '  const response = JSON.parse(await bridge("call", JSON.stringify(step)));',
    '  if (!response.ok) throw new Error(response.error || response.summary || "Remote step failed");',
    '  return { output: response.output, summary: response.summary };',
    '};',
    'for (const kind of ["read","edit","write","run","search","patch","call"]) {',
    '  tools[kind] = (options = {}) => tools.step({ ...options, kind });',
    '}',
    'Object.defineProperties(globalThis, {',
    '  tools: { value: Object.freeze(tools) },',
    '  ALL_TOOLS: { value: Object.freeze(["read","edit","write","run","search","patch","call"]) },',
    '  text: { value: (value) => bridge("text", JSON.stringify(typeof value === "string" ? value : JSON.stringify(value))) },',
    '});',
    '})()'
  ].join('\n');
  const setup = enter(() => vm.evalCode(bootstrap));
  if (setup.error) {
    const msg = errorText(setup.error);
    setup.error.dispose();
    done('BOOTSTRAP_ERROR: ' + msg);
    return;
  }
  setup.value.dispose();

  let execution;
  const check = () => {
    if (stopped) return;
    if (fatal) { done(fatal); return; }
    if (cpuMs > workerData.limits.cpuMs) { done('CPU_LIMIT'); return; }
    const jobs = enter(() => runtime.executePendingJobs(64));
    if (jobs.error) {
      const msg = errorText(jobs.error);
      jobs.error.dispose();
      done(cpuMs > workerData.limits.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR: ' + msg);
      return;
    }
    const state = enter(() => vm.getPromiseState(execution));
    if (state.type === 'rejected') {
      const msg = errorText(state.error);
      state.error.dispose();
      done(fatal || (cpuMs > workerData.limits.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR: ' + msg));
      return;
    }
    if (state.type === 'fulfilled') {
      state.value.dispose();
      done(fatal);
      return;
    }
    if (runtime.hasPendingJob()) setImmediate(check);
  };
  parentPort.on('message', (message) => {
    if (stopped || message.type !== 'result') return;
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    enter(() => {
      const handle = vm.newString(message.json);
      promise.resolve(handle);
      handle.dispose();
      promise.dispose();
    });
    check();
  });
  const evaluated = enter(() => vm.evalCode(workerData.code, 'thriftyrelay-code-mode.mjs', { type: 'module' }));
  if (evaluated.error) {
    const msg = errorText(evaluated.error);
    evaluated.error.dispose();
    done(cpuMs > workerData.limits.cpuMs ? 'CPU_LIMIT' : 'PARSE_ERROR: ' + msg);
    return;
  }
  execution = evaluated.value;
  check();
})().catch((error) => done('RUNTIME_ERROR: ' + String(error).slice(0, 350)));
