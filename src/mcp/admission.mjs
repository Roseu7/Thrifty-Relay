import fs from "node:fs/promises";
import path from "node:path";
import { classifyPath, effectiveTier } from "./access.mjs";
import { approvalDirectory, writeAudit } from "./approval.mjs";
import { parsePolicy, pathsAdapter, policyFile, readPolicy } from "../platform/index.mjs";

// One decision point for every step, whichever tool carried it. The tool handlers keep their
// own validation, but permission is answered here from the registration and the path rules,
// so a new tool cannot become a new way around them (design 2.1).
//
// The transition rule is deliberate: a host that was never registered keeps the behaviour it
// had. Enforcement begins with the registration the administrator writes, which is also the
// moment the user can see what it allows (design 2.6.2). A registration that exists but
// cannot be honoured is not a missing registration: it fails closed.

const READ_KINDS = new Set(["read", "search"]);
const WRITE_KINDS = new Set(["write", "edit", "patch"]);
// Kinds that run whatever the caller put in them: a shell, an arbitrary child tool, or the
// bounded JavaScript of code mode. A path rule cannot describe them, so the tier has to.
const PRIVILEGED_KINDS = new Set(["run", "call", "code"]);

// codex is not in the set above: the SDK sandbox is enforced by the worker, and the adapter
// already pins the working directory to the configured workspace root, so the tier selects the
// sandbox instead of denying the step.
export function sandboxForTier(tier) {
  if (tier === "full") return "danger-full-access";
  if (tier === "trusted") return "workspace-write";
  return "read-only";
}

// The paths a step will touch. Only the ones the server knows before execution are listed;
// a shell command names its targets at run time, which is exactly why it is a privileged kind
// rather than a path-checked one.
export function targetsOf(step) {
  if (step.kind === "patch") return (step.files ?? []).map(file => file.path);
  if (step.kind === "edit") return [step.file_path];
  if (READ_KINDS.has(step.kind) || step.kind === "write") return [step.path];
  return [];
}

// The suites start the server against a policy file of their own (tests/policy-isolation.mjs,
// loaded with --import), so a registration on this machine does not decide what a test may run.
// Whoever controls the server's startup can reach this too, for example with NODE_OPTIONS
// importing that file, and turn a registered host into an unregistered one. That adds no new
// power: the same NODE_OPTIONS can import arbitrary code (a data: URL needs no file) that
// replaces the policy read. The registration constrains requests sent through MCP, not the
// user who launches the server; see SECURITY.md.
let policyFileForTest = null;
export function setPolicyFileForTest(file) {
  policyFileForTest = file;
}

export async function admissionState({ file = policyFileForTest ?? policyFile(), platform = process.platform } = {}) {
  try {
    if (policyFileForTest && file === policyFileForTest) {
      // A suite writes its policy in its own temporary directory, where the ACL that makes a
      // registration non-replaceable cannot hold. The hook is reachable only from code the
      // launcher imports (see above), so the document is parsed and the protection check is
      // the one thing skipped; the real path below still goes through readPolicy.
      let text;
      try { text = await fs.readFile(file, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return { status: "unregistered" }; throw error; }
      return { status: "registered", policy: parsePolicy(text, platform) };
    }
    return { status: "registered", policy: await readPolicy(file, platform) };
  } catch (error) {
    if (error.code === "POLICY_MISSING") return { status: "unregistered" };
    return { status: "blocked", code: error.code };
  }
}

function refusal(code, detail) {
  return { allowed: false, code, detail };
}

// The order inside a step is the same as the order between kinds: a protected path stays
// protected even when it also matches a sensitive pattern, and a write is refused there
// whatever the tier is.
export function evaluateStep({
  step,
  policy,
  tier,
  appDirectory,
  platform = process.platform,
  env = process.env,
  home,
} = {}) {
  if (!policy) return { allowed: true, tier: "standard", enforcement: "none", decisions: [] };
  if (PRIVILEGED_KINDS.has(step.kind) && tier !== "full") return refusal("ADMISSION_TIER_REQUIRED", step.kind);
  if (step.kind === "codex") {
    return { allowed: true, tier, enforcement: "policy", sandbox: sandboxForTier(tier), decisions: [] };
  }

  const write = WRITE_KINDS.has(step.kind);
  const decisions = [];
  for (const target of targetsOf(step)) {
    const kind = classifyPath({ platform, env, home, appDirectory, target, policy });
    if (kind.kind === "protected") {
      if (write) return refusal("ADMISSION_PROTECTED_PATH", target);
      decisions.push({ target, kind: "protected", action: "read" });
    } else if (kind.kind === "sensitive") {
      if (tier !== "full") return refusal("ADMISSION_APPROVAL_REQUIRED", target);
      decisions.push({ target, kind: "sensitive", action: write ? "write" : "read" });
    } else if (kind.kind === "scratch") {
      // The registration already consented to this area, so ordinary reads and writes do not
      // need a window. Privileged kinds were handled above and are unaffected.
      decisions.push({ target, kind: "scratch", action: write ? "write" : "read" });
    } else if (kind.kind === "workspace") {
      decisions.push({ target, kind: "workspace", action: write ? "write" : "read" });
    } else {
      // Outside every registered root: allowed only under the tier the registration permits
      // for full access, which is where the user's approval enters the decision.
      if (tier !== "full") return refusal("ADMISSION_OUTSIDE_WORKSPACE", target);
      decisions.push({ target, kind: "outside", action: write ? "write" : "read" });
    }
  }
  return { allowed: true, tier, enforcement: "policy", decisions };
}

// Classification is lexical: it cannot see that "work/link" points somewhere else. Real path
// resolution is therefore a second pass, used by the execution path for every target the
// server knows. A link that leaves the registered area is judged by where it really lands.
export async function resolveTargetPath(target, { platform = process.platform, fsApi = fs } = {}) {
  const flavour = platform === "win32" ? path.win32 : path.posix;
  let current = flavour.resolve(String(target));
  const missing = [];
  for (let depth = 0; depth < 64; depth++) {
    try {
      const real = await fsApi.realpath(current);
      return missing.length ? flavour.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = flavour.dirname(current);
      if (parent === current) return flavour.resolve(String(target));
      missing.push(flavour.basename(current));
      current = parent;
    }
  }
  throw Object.assign(new Error("ADMISSION_PATH_TOO_DEEP"), { code: "ADMISSION_PATH_TOO_DEEP" });
}

// A task directory under scratch belongs to the task that created it. Without this check one
// task could read or overwrite another task's temporary files just because both are inside a
// registered scratch root.
async function foreignScratchOwner({ resolved, policy, taskId, platform }) {
  const flavour = platform === "win32" ? path.win32 : path.posix;
  const paths = pathsAdapter(platform);
  for (const root of policy.scratch_roots || []) {
    let realRoot;
    try { realRoot = await fs.realpath(root); } catch { continue; }
    const relative = flavour.relative(paths.comparisonKey(realRoot), paths.comparisonKey(resolved));
    if (flavour.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + flavour.sep)) continue;
    // The root itself is the one path every task shares: a search there walks every sibling
    // directory, and the owner check only sees the target, not each reported hit. A caller
    // must name its own task directory (or a file directly under the root) instead.
    if (!relative) return { code: "ADMISSION_SCRATCH_ROOT_SCOPE", detail: resolved };
    if (!taskId) return null;
    const first = relative.split(flavour.sep)[0];
    if (!first || first === "." || first === "..") continue;
    const ownerFile = flavour.join(realRoot, first, "owner.json");
    let source;
    try { source = await fs.readFile(ownerFile, "utf8"); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        if (first === taskId) return null;
        // An existing sibling directory with no owner is not safe to treat as an ordinary
        // root-level file. A missing task-shaped name is reserved for a real task directory.
        const sibling = flavour.join(realRoot, first);
        const stats = await fs.lstat(sibling).catch(() => null);
        if (stats?.isDirectory() || (!stats && first.startsWith("task_"))) {
          return { code: "ADMISSION_SCRATCH_OWNER_UNKNOWN", detail: resolved };
        }
        return null;
      }
      return { code: "ADMISSION_SCRATCH_OWNER_UNKNOWN", detail: resolved };
    }
    let owner;
    try { owner = JSON.parse(source); }
    catch { return { code: "ADMISSION_SCRATCH_OWNER_UNKNOWN", detail: resolved }; }
    if (typeof owner?.task_id !== "string" || owner.task_id === "") {
      return { code: "ADMISSION_SCRATCH_OWNER_UNKNOWN", detail: resolved };
    }
    if (owner.task_id !== taskId) return { code: "ADMISSION_SCRATCH_OTHER_TASK", detail: resolved };
    return null;
  }
  return null;
}

// evaluateStep answers from the spelling of the path. This wrapper keeps that answer unless the
// resolved location is stricter, or the target sits at or in another task's scratch directory.
export async function evaluateStepResolved({
  step, policy, tier, appDirectory, platform = process.platform, env = process.env, home, taskId = null,
  fsApi = fs,
} = {}) {
  const lexical = evaluateStep({ step, policy, tier, appDirectory, platform, env, home });
  if (!lexical.allowed || !policy) return lexical;
  const write = WRITE_KINDS.has(step.kind);
  const decisions = [];
  for (const target of targetsOf(step)) {
    const spelling = lexical.decisions.find(decision => decision.target === target);
    if (!spelling) continue;
    let resolved;
    try { resolved = await resolveTargetPath(target, { platform, fsApi }); }
    catch (error) {
      return refusal(error?.code || "ADMISSION_PATH_UNRESOLVED", target);
    }
    let actual;
    try { actual = classifyPath({ platform, env, home, appDirectory, target: resolved, policy }); }
    catch (error) { return refusal(error?.code || "ADMISSION_PATH_UNSUPPORTED", target); }
    if (actual.kind === "protected") {
      if (write) return refusal("ADMISSION_PROTECTED_PATH", target);
    } else if (actual.kind === "sensitive") {
      if (tier !== "full") return refusal("ADMISSION_APPROVAL_REQUIRED", target);
    } else if (actual.kind === "outside") {
      if (tier !== "full") return refusal("ADMISSION_OUTSIDE_WORKSPACE", target);
    } else if (actual.kind === "scratch") {
      const foreign = await foreignScratchOwner({ resolved, policy, taskId, platform });
      if (foreign && tier !== "full") return refusal(foreign.code, foreign.detail);
    }
    decisions.push({
      target, kind: actual.kind, action: write ? "write" : "read",
      ...(actual.kind !== spelling.kind ? { resolved_target: resolved } : {}),
    });
  }
  return { ...lexical, decisions };
}

// A refused step is recorded like a refused window: the audit answers what was attempted,
// for which task and why it stopped, without carrying the command text or file content.
export async function recordRefusal({ code, detail, kind, taskId = null, directory = approvalDirectory(), now = Date.now() }) {
  await writeAudit({
    directory,
    entry: {
      at: new Date(now).toISOString(), event: "admission.refused", reason: code,
      kind, task_id: taskId, target: typeof detail === "string" ? detail : null,
    },
  });
}

export function tierForPolicy({ configured = "full", policy, window = null, now = Date.now() } = {}) {
  // Until the preset exists as a setting, "full" means "follow the registration": the
  // administrator's file is the decision, and a narrower preset can only be added later.
  return effectiveTier({ configured, policy, window, now });
}
