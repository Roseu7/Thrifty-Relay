const FIELDS = [
  "language", "baseModel", "upperModel", "maxCodexAgents", "reviewPolicy",
  "fiveHourLimitPercent", "weeklyLimitPercent", "fiveHourLimitAction", "weeklyLimitAction",
];
const PERCENT_FIELDS = new Set(["fiveHourLimitPercent", "weeklyLimitPercent"]);
const REQUEST_TIMEOUT_MS = 15000;
const form = document.querySelector("#settings");
const heading = document.querySelector("#heading");
const status = document.querySelector("#status");
const saveButton = document.querySelector("#save");
const notes = document.querySelector("#notes");
const pending = new Map();
let current;
let draft = {};
let hostReady = false;
let saving = false;
let nextId = 1;
let loadTimer;

function request(method, params) {
  if (method === "tools/call" && !hostReady) return Promise.reject(new Error("HOST_NOT_READY"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error("HOST_TIMEOUT"), { name: "TimeoutError" }));
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    } catch (error) {
      window.clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function payloadOf(value) {
  const result = value?.result && typeof value.result === "object" ? value.result : value;
  return result?.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent : result;
}

function isPercent(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function validPayload(payload) {
  if (!payload?.settings || !payload.options || !payload.labels || !payload.sources || !payload.recommended ||
    !["heading", "current", "recommended", "save", "saving", "failure", "saved", "modelsNote", "reviewNote", "concurrentNote", "quotaNote", "quotaActionNote", "percentRange", "percentInvalid"]
      .every(label => typeof payload.labels[label] === "string")) return false;
  return FIELDS.every(field => {
    const options = payload.options[field];
    if (!Array.isArray(options) ||
      (PERCENT_FIELDS.has(field) && (options.length !== 101 || options.some((value, index) => value !== index))) ||
      !options.includes(payload.settings[field]) ||
      !options.includes(payload.recommended[field]) ||
      typeof payload.labels.fields?.[field] !== "string" ||
      typeof payload.labels.choices?.[field]?.[String(payload.settings[field])] !== "string" ||
      typeof payload.labels.choices[field][String(payload.recommended[field])] !== "string" ||
      typeof payload.labels.sources?.[payload.sources[field]] !== "string") return false;
    return !PERCENT_FIELDS.has(field) ||
      (isPercent(payload.settings[field]) && isPercent(payload.recommended[field]));
  });
}

function showFailure(payload) {
  status.textContent = payload?.labels?.failure || current?.labels?.failure || "Settings could not be loaded or saved.";
}

function timeoutMessage(kind) {
  const japanese = current?.settings?.language === "ja" ||
    (!current && (navigator.language || "").toLowerCase().startsWith("ja"));
  if (japanese) {
    if (kind === "connect") return "設定画面のホストに接続できませんでした。MCP Apps 対応クライアントで開き直してください。";
    if (kind === "load") return "設定を受信できませんでした。画面を開き直してください。";
    return "保存の応答がなく、結果を確認できません。画面を開き直して設定を確認してください。";
  }
  if (kind === "connect") return "Could not connect to the settings host. Reopen this view in an MCP Apps compatible client.";
  if (kind === "load") return "Settings were not received. Please reopen this view.";
  return "The save did not respond, so its result is unknown. Reopen this view to check the settings.";
}

function hasChanges() {
  return Boolean(current && FIELDS.some(field => draft[field] !== current.settings[field]));
}

function refreshSaveButton() {
  const validDraft = [...PERCENT_FIELDS].every(field => {
    const input = form.elements.namedItem(field);
    return isPercent(draft[field]) && input?.validity.valid;
  });
  saveButton.disabled = !hostReady || !current || saving || !hasChanges() || !validDraft;
}

function render(payload) {
  if (!validPayload(payload)) {
    showFailure(payload);
    return false;
  }
  current = payload;
  draft = Object.fromEntries(FIELDS.map(field => [field, payload.settings[field]]));
  heading.textContent = payload.labels.heading;
  form.replaceChildren();
  for (const field of FIELDS) {
    const section = document.createElement("section");
    section.className = "setting";
    const label = document.createElement("label");
    label.htmlFor = `setting-${field}`;
    label.textContent = payload.labels.fields[field];
    const detail = document.createElement("small");
    detail.id = `detail-${field}`;
    detail.className = "detail";
    const source = payload.labels.sources[payload.sources[field]];
    const value = payload.labels.choices[field][String(payload.settings[field])];
    const recommended = payload.labels.choices[field][String(payload.recommended[field])];
    const recommendation = field !== "language" && payload.settings[field] !== payload.recommended[field]
      ? ` (${payload.labels.recommended}: ${recommended})` : "";
    detail.textContent = `${payload.labels.current} (${source}): ${value}${recommendation}${PERCENT_FIELDS.has(field) ? ` · ${payload.labels.percentRange}` : ""}`;
    if (PERCENT_FIELDS.has(field)) {
      const input = document.createElement("input");
      input.type = "number";
      input.id = `setting-${field}`;
      input.name = field;
      input.min = "0";
      input.max = "100";
      input.step = "1";
      input.required = true;
      input.inputMode = "numeric";
      input.value = String(draft[field]);
      input.style.boxSizing = "border-box";
      input.style.width = "6.5rem";
      input.style.minHeight = "40px";
      input.style.padding = "7px 10px";
      input.setAttribute("aria-describedby", `detail-${field} error-${field}`);
      input.setAttribute("aria-invalid", "false");
      const suffix = document.createElement("span");
      suffix.textContent = "%";
      suffix.setAttribute("aria-hidden", "true");
      const control = document.createElement("div");
      control.style.display = "flex";
      control.style.alignItems = "center";
      control.style.gap = "6px";
      control.append(input, suffix);
      const error = document.createElement("small");
      error.id = `error-${field}`;
      error.className = "detail";
      error.setAttribute("aria-live", "polite");
      input.addEventListener("input", () => {
        const next = input.value === "" ? null : input.valueAsNumber;
        draft[field] = next;
        const valid = isPercent(next);
        input.setCustomValidity(valid ? "" : payload.labels.percentInvalid);
        input.setAttribute("aria-invalid", String(!valid));
        error.textContent = valid ? "" : payload.labels.percentInvalid;
        refreshSaveButton();
        status.textContent = "";
      });
      section.append(label, control, detail, error);
    } else {
      const select = document.createElement("select");
      select.id = `setting-${field}`;
      select.name = field;
      select.setAttribute("aria-describedby", `detail-${field}`);
      for (const optionValue of payload.options[field]) {
        const option = document.createElement("option");
        option.value = String(optionValue);
        option.textContent = payload.labels.choices[field][String(optionValue)];
        select.append(option);
      }
      select.value = String(draft[field]);
      select.addEventListener("change", () => {
        draft[field] = field === "maxCodexAgents" ? Number(select.value) : select.value;
        refreshSaveButton();
        status.textContent = "";
      });
      section.append(label, select, detail);
    }
    if (field === "reviewPolicy" || field.endsWith("Action")) {
      const note = document.createElement("small");
      note.className = "detail";
      note.textContent = field === "reviewPolicy" ? payload.labels.reviewNote : payload.labels.quotaActionNote;
      section.append(note);
    }
    form.append(section);
  }
  saveButton.textContent = payload.labels.save;
  notes.replaceChildren();
  for (const note of [payload.labels.modelsNote, payload.labels.concurrentNote, payload.labels.quotaNote]) {
    if (typeof note !== "string") continue;
    const item = document.createElement("li");
    item.textContent = note;
    notes.append(item);
  }
  refreshSaveButton();
  return true;
}

function handleMessage(event) {
  if (event.source !== window.parent) return;
  const message = event.data;
  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") return;
  if (message.id !== undefined && message.id !== null && pending.has(message.id)) {
    const item = pending.get(message.id);
    pending.delete(message.id);
    window.clearTimeout(item.timer);
    if (message.error) item.reject(new Error("HOST_REQUEST_FAILED"));
    else item.resolve(message.result);
  }
  if (message.method === "ui/notifications/tool-result" && !current) {
    window.clearTimeout(loadTimer);
    const payload = payloadOf(message.params);
    if (render(payload)) status.textContent = "";
    else showFailure(payload);
  }
}

window.addEventListener("message", handleMessage);
loadTimer = window.setTimeout(() => showTimeout("load"), REQUEST_TIMEOUT_MS);

function showTimeout(kind) {
  status.textContent = timeoutMessage(kind);
}

request("ui/initialize", {
  protocolVersion: "2026-01-26",
  appInfo: { name: "ThriftyRelay Settings", version: "1.0.0" },
  appCapabilities: {},
}).then(() => {
  hostReady = true;
  window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
  refreshSaveButton();
}).catch(() => {
  window.clearTimeout(loadTimer);
  showTimeout("connect");
});

saveButton.addEventListener("click", async () => {
  if (saveButton.disabled || !hostReady || !current || saving) return;
  saving = true;
  refreshSaveButton();
  status.textContent = current.labels.saving;
  try {
    const result = await request("tools/call", {
      name: "settings_update",
      arguments: Object.fromEntries(FIELDS.filter(field => draft[field] !== current.settings[field])
        .map(field => [field, draft[field]])),
    });
    const payload = payloadOf(result);
    if (result?.isError || !render(payload)) throw new Error("SETTINGS_SAVE_FAILED");
    status.textContent = payload.labels.saved;
  } catch (error) {
    if (error?.name === "TimeoutError") showTimeout("save");
    else showFailure();
  } finally {
    saving = false;
    refreshSaveButton();
  }
});
