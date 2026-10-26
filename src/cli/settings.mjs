import { createInterface, emitKeypressEvents } from "node:readline";
import {
  CODEX_MODEL_OPTIONS,
  DEFAULT_SETTINGS,
  MAX_CODEX_AGENTS,
  MIN_CODEX_AGENTS,
  QUOTA_LIMIT_ACTION_OPTIONS,
  REVIEW_POLICY_OPTIONS,
  SETTINGS_FIELDS,
  UPPER_MODEL_OPTIONS,
  readSetupConfig,
  updateSetupConfig,
} from "../config.mjs";
import { languageFromLocale, translate } from "../i18n/index.mjs";

const QUOTA_LIMIT_PERCENT_FIELDS = Object.freeze(["fiveHourLimitPercent", "weeklyLimitPercent"]);
const QUOTA_LIMIT_PERCENT_OPTIONS = Object.freeze(Array.from({ length: 101 }, (_, value) => value));
const CLI_SETTING_FIELDS = Object.freeze([
  "fiveHourLimitPercent", "weeklyLimitPercent", "fiveHourLimitAction", "weeklyLimitAction",
]);
const SETTINGS_OPTIONS = Object.freeze({
  language: Object.freeze(["ja", "en"]),
  baseModel: CODEX_MODEL_OPTIONS,
  upperModel: UPPER_MODEL_OPTIONS,
  maxCodexAgents: Object.freeze([1, 2, 3, 4, 5]),
  reviewPolicy: REVIEW_POLICY_OPTIONS,
  fiveHourLimitPercent: QUOTA_LIMIT_PERCENT_OPTIONS,
  weeklyLimitPercent: QUOTA_LIMIT_PERCENT_OPTIONS,
  fiveHourLimitAction: QUOTA_LIMIT_ACTION_OPTIONS,
  weeklyLimitAction: QUOTA_LIMIT_ACTION_OPTIONS,
});

function currentSystemLanguage() {
  try {
    return languageFromLocale(Intl.DateTimeFormat().resolvedOptions().locale) || "en";
  } catch {
    return "en";
  }
}

function settingsFromConfig(config, language) {
  const values = Object.fromEntries(SETTINGS_FIELDS.map(field => [
    field,
    Object.hasOwn(config, field) ? config[field] : field === "language" ? language : DEFAULT_SETTINGS[field],
  ]));
  const sources = Object.fromEntries(SETTINGS_FIELDS.map(field => [
    field,
    Object.hasOwn(config, field) ? "saved" : "default",
  ]));
  const recommended = { ...DEFAULT_SETTINGS, language: currentSystemLanguage() };
  return { ...values, source: sources.maxCodexAgents, sources, recommended };
}

export async function readSettings({
  configFile,
  platform = process.platform,
  language = currentSystemLanguage(),
} = {}) {
  const config = await readSetupConfig(configFile, { platform });
  return settingsFromConfig(config, language);
}

function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw Object.assign(new Error("SETTINGS_VALUE_INVALID"), { code: "SETTINGS_VALUE_INVALID" });
  }
  const fields = Object.keys(patch);
  if (!fields.length || fields.some(field => !SETTINGS_FIELDS.includes(field))) {
    throw Object.assign(new Error("SETTINGS_VALUE_INVALID"), { code: "SETTINGS_VALUE_INVALID" });
  }
  for (const [field, value] of Object.entries(patch)) {
    const valid = QUOTA_LIMIT_PERCENT_FIELDS.includes(field)
      ? Number.isInteger(value) && value >= 0 && value <= 100
      : field === "maxCodexAgents"
        ? Number.isInteger(value) && value >= MIN_CODEX_AGENTS && value <= MAX_CODEX_AGENTS
        : SETTINGS_OPTIONS[field].includes(value);
    if (!valid) throw Object.assign(new Error("SETTINGS_VALUE_INVALID"), { code: "SETTINGS_VALUE_INVALID" });
  }
}

export async function updateSettings(patch, {
  configFile,
  platform = process.platform,
  language = currentSystemLanguage(),
} = {}) {
  validateSettingsPatch(patch);
  const config = await updateSetupConfig(configFile, patch, { platform });
  return settingsFromConfig(config, language);
}

export async function setMaxCodexAgents(maxCodexAgents, options = {}) {
  const settings = await updateSettings({ maxCodexAgents }, options);
  return { maxCodexAgents: settings.maxCodexAgents, source: "saved" };
}

export function publicSettingsPayload(settings, language = settings.language) {
  const options = Object.fromEntries(Object.entries(SETTINGS_OPTIONS).map(([field, values]) => [field, [...values]]));
  const choices = Object.fromEntries(Object.entries(SETTINGS_OPTIONS).map(([field, values]) => [
    field,
    Object.fromEntries(values.map(value => [value, optionLabel(field, value, language)])),
  ]));
  return {
    settings: Object.fromEntries(SETTINGS_FIELDS.map(field => [field, settings[field]])),
    sources: { ...settings.sources },
    recommended: { ...settings.recommended },
    options,
    labels: {
      heading: translate(language, "settings.heading"),
      fields: Object.fromEntries(SETTINGS_FIELDS.map(field => [field, fieldLabel(field, language)])),
      choices,
      sources: {
        saved: translate(language, "settings.source.saved"),
        default: translate(language, "settings.source.default"),
      },
      current: translate(language, "settings.ui.current"),
      recommended: translate(language, "settings.ui.recommended"),
      save: translate(language, "settings.ui.save"),
      saving: translate(language, "settings.ui.saving"),
      waiting: translate(language, "settings.ui.waiting"),
      failure: translate(language, "settings.ui.failure"),
      saved: translate(language, "settings.ui.saved"),
      fallback: translate(language, "settings.ui.fallback"),
      modelsNote: translate(language, "settings.note.models"),
      reviewNote: translate(language, "settings.note.review"),
      concurrentNote: translate(language, "settings.note.concurrent"),
      quotaNote: translate(language, "settings.note.quota"),
      quotaActionNote: translate(language, "settings.note.quotaAction"),
      percentRange: translate(language, "settings.ui.percentRange"),
      percentInvalid: translate(language, "settings.ui.percentInvalid"),
    },
    notes: {
      modelPreferencesOnly: true,
      reviewPolicyPreferenceOnly: true,
      currentCodexAdapterUsesGlobalLock: true,
    },
  };
}

function optionLabel(field, value, language) {
  if (field === "maxCodexAgents") {
    return translate(language, "settings.choice.maxCodexAgents", { value });
  }
  if (QUOTA_LIMIT_PERCENT_FIELDS.includes(field)) {
    return translate(language, "settings.choice.percent", { value });
  }
  return translate(language, `settings.choice.${field}.${value}`);
}

function fieldLabel(field, language) {
  return translate(language, `settings.item.${field}`);
}

function recommendation(settings, field, language) {
  if (field === "language" || settings[field] === settings.recommended[field]) return "";
  return translate(language, "settings.recommendedValue", { value: optionLabel(field, settings.recommended[field], language) });
}

function editingNote(field, language) {
  if (field === "reviewPolicy") return translate(language, "settings.note.review");
  if (field.endsWith("Action")) return translate(language, "settings.note.quotaAction");
  return "";
}

function settingsText(settings, language, interactive = false) {
  const lines = [translate(language, "settings.heading")];
  for (const field of SETTINGS_FIELDS) {
    if (interactive) {
      lines.push(`${SETTINGS_FIELDS.indexOf(field) + 1}. ${fieldLabel(field, language)}: ${optionLabel(field, settings[field], language)}`);
      continue;
    }
    const note = recommendation(settings, field, language);
    lines.push(`${fieldLabel(field, language)}: ${optionLabel(field, settings[field], language)}${note ? ` (${note})` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatSettingsFallback(settings, language) {
  return `${settingsText(settings, language)}${translate(language, "settings.fallback.edit")}\n`;
}

function safeJsonSettings(settings) {
  return {
    settings: Object.fromEntries(SETTINGS_FIELDS.map(field => [field, settings[field]])),
    sources: { ...settings.sources },
    recommended: { ...settings.recommended },
    options: Object.fromEntries(Object.entries(SETTINGS_OPTIONS).map(([field, values]) => [field,
      QUOTA_LIMIT_PERCENT_FIELDS.includes(field) ? { min: 0, max: 100, step: 1 } : [...values],
    ])),
  };
}

function settingError(error, language, stderr, field) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : "CONFIG_UNAVAILABLE";
  const key = code === "CONFIG_INVALID" || code === "CONFIG_SECRET_FIELD_FORBIDDEN"
    ? "settings.error.configInvalid"
    : code === "CONFIG_UNAVAILABLE" ? "settings.error.configUnavailable"
      : code === "SETTINGS_VALUE_INVALID" ? "settings.error.valueInvalid"
        : "settings.error.generic";
  const valueError = code === "SETTINGS_VALUE_INVALID" && field;
  const message = valueError ? translate(language,
    field.endsWith("Action") ? "settings.error.actionInvalid" : "settings.error.integerInvalid", {
      field: fieldLabel(field, language), min: field === "maxCodexAgents" ? 1 : 0,
      max: field === "maxCodexAgents" ? 5 : 100,
    }) : translate(language, key);
  stderr.write(`${code}: ${message}\n`);
  return code === "SETTINGS_VALUE_INVALID" ? 2 : 1;
}

function supportsArrowTui({ stdin, stdout, platform, env }) {
  if (!stdin?.isTTY || !stdout?.isTTY || typeof stdin.setRawMode !== "function") return false;
  const term = String(env.TERM || "").toLowerCase();
  if (platform === "win32") {
    return Boolean(env.WT_SESSION || env.ANSICON || env.ConEmuANSI === "ON" || env.TERM_PROGRAM === "vscode");
  }
  return Boolean(term && term !== "dumb");
}

function renderTui(settings, language, {
  screen = "fields",
  fieldIndex = 0,
  optionIndex = 0,
  inputValue = "",
  status = "",
  clear = false,
  stdout,
} = {}) {
  if (clear) stdout.write("\x1b[2J\x1b[H");
  const lines = [translate(language, "settings.heading"), ""];
  if (screen === "fields") {
    for (let index = 0; index < SETTINGS_FIELDS.length; index++) {
      const field = SETTINGS_FIELDS[index];
      lines.push(`${index === fieldIndex ? ">" : " "} ${index + 1}. ${fieldLabel(field, language)}: ${optionLabel(field, settings[field], language)}`);
    }
    const selected = SETTINGS_FIELDS[fieldIndex];
    const note = recommendation(settings, selected, language);
    if (note) lines.push("", `${fieldLabel(selected, language)} (${note})`);
  } else {
    const field = SETTINGS_FIELDS[fieldIndex];
    lines.push(translate(language, "settings.editing", { field: fieldLabel(field, language) }));
    lines.push(translate(language, "settings.currentValue", {
      value: optionLabel(field, settings[field], language),
      source: translate(language, `settings.source.${settings.sources[field]}`),
    }));
    const recommended = recommendation(settings, field, language);
    if (recommended) lines.push(`(${recommended})`);
    const note = editingNote(field, language);
    if (note) lines.push(note);
    if (screen === "number") {
      lines.push(translate(language, "settings.ui.percentRange"), "", `> ${inputValue}`);
      if (status) lines.push(status);
    } else {
      for (const [index, value] of SETTINGS_OPTIONS[field].entries()) {
        lines.push(`${index === optionIndex ? ">" : " "} ${index + 1}. ${optionLabel(field, value, language)}`);
      }
    }
  }
  lines.push("");
  lines.push(translate(language, screen === "number" ? "settings.tui.numberHelp" : "settings.tui.help"));
  if (status && screen !== "number") lines.push(status);
  stdout.write(`${lines.join("\n")}\n`);
}

function writeSettingsError(error, language) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : "CONFIG_UNAVAILABLE";
  const key = code === "CONFIG_INVALID" || code === "CONFIG_SECRET_FIELD_FORBIDDEN"
    ? "settings.error.configInvalid"
    : code === "CONFIG_UNAVAILABLE" ? "settings.error.configUnavailable"
      : code === "SETTINGS_VALUE_INVALID" ? "settings.error.valueInvalid"
        : "settings.error.generic";
  return `${code}: ${translate(language, key)}`;
}

async function saveSetting(settings, field, value, context, displayLanguage) {
  try {
    const updated = await updateSettings({ [field]: value }, {
      configFile: context.configFile,
      platform: context.platform,
      language: settings.language,
    });
    const nextLanguage = field === "language" && !context.explicitLanguage
      ? updated.language : displayLanguage;
    return {
      settings: updated,
      language: nextLanguage,
      status: translate(nextLanguage, "settings.savedField", {
        field: fieldLabel(field, nextLanguage),
        value: optionLabel(field, updated[field], nextLanguage),
      }),
    };
  } catch (error) {
    return {
      settings,
      language: displayLanguage,
      status: writeSettingsError(error, displayLanguage),
    };
  }
}

async function runArrowTui(settings, language, context) {
  const { stdin, stdout } = context;
  let screen = "fields";
  let fieldIndex = 0;
  let optionIndex = 0;
  let inputValue = "";
  let status = "";
  const keys = [];
  let waitingKey;
  const onKey = (_character, key) => {
    if (waitingKey) {
      const resolve = waitingKey;
      waitingKey = null;
      resolve(key);
    } else keys.push(key);
  };
  const wasPaused = stdin.isPaused?.() ?? false;
  emitKeypressEvents(stdin);
  stdin.on("keypress", onKey);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    while (true) {
      renderTui(settings, language, { screen, fieldIndex, optionIndex, inputValue, status, clear: true, stdout });
      const { name, sequence } = keys.length ? keys.shift() : await new Promise(resolve => { waitingKey = resolve; });
      if (name === "q" || (name === "c" && sequence === "\x03")) return name === "c" ? 130 : 0;
      if (screen === "fields") {
        if (name === "up") fieldIndex = (fieldIndex + SETTINGS_FIELDS.length - 1) % SETTINGS_FIELDS.length;
        else if (name === "down") fieldIndex = (fieldIndex + 1) % SETTINGS_FIELDS.length;
        else if (name === "return") {
          const current = SETTINGS_FIELDS[fieldIndex];
          screen = QUOTA_LIMIT_PERCENT_FIELDS.includes(current) ? "number" : "options";
          if (screen === "number") inputValue = String(settings[current]);
          else optionIndex = Math.max(0, SETTINGS_OPTIONS[current].indexOf(settings[current]));
          status = "";
        } else if (name === "escape") return 0;
      } else if (screen === "number") {
        status = "";
        const field = SETTINGS_FIELDS[fieldIndex];
        if (name === "escape") { screen = "fields"; status = ""; }
        else if (sequence === "\x15") inputValue = "";
        else if (name === "backspace") inputValue = inputValue.slice(0, -1);
        else if (name === "return") {
          if (!/^\d+$/.test(inputValue) || Number(inputValue) > 100) {
            status = translate(language, "settings.ui.percentInvalid");
            continue;
          }
          const saved = await saveSetting(settings, field, Number(inputValue), context, language);
          settings = saved.settings;
          language = saved.language;
          status = saved.status;
          screen = "fields";
        } else if (sequence && !/[\x00-\x1f\x7f]/.test(sequence)) {
          inputValue += sequence;
        }
      } else {
        const field = SETTINGS_FIELDS[fieldIndex];
        if (name === "up") optionIndex = (optionIndex + SETTINGS_OPTIONS[field].length - 1) % SETTINGS_OPTIONS[field].length;
        else if (name === "down") optionIndex = (optionIndex + 1) % SETTINGS_OPTIONS[field].length;
        else if (name === "escape") screen = "fields";
        else if (name === "return") {
          const saved = await saveSetting(settings, field, SETTINGS_OPTIONS[field][optionIndex], context, language);
          settings = saved.settings;
          language = saved.language;
          status = saved.status;
          screen = "fields";
          fieldIndex = SETTINGS_FIELDS.indexOf(field);
        }
      }
    }
  } finally {
    stdin.off("keypress", onKey);
    stdin.setRawMode(false);
    if (wasPaused) stdin.pause();
    stdout.write("\x1b[0m\x1b[?25h\n");
  }
}

function askOnce(readline, prompt) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      readline.off("close", onClose);
      readline.off("SIGINT", onSigint);
      resolve(result);
    };
    const onClose = () => finish({ kind: "closed" });
    const onSigint = () => {
      finish({ kind: "cancelled" });
      readline.close();
    };
    readline.once("close", onClose);
    readline.once("SIGINT", onSigint);
    readline.question(prompt, value => finish({ kind: "answer", value }));
  });
}

async function runNumberTui(settings, language, context) {
  const readline = createInterface({ input: context.stdin, output: context.stdout, terminal: true });
  try {
    while (true) {
      context.stdout.write(`\n${settingsText(settings, language, true)}`);
      context.stdout.write(`${translate(language, "settings.tui.numberMain")}\n`);
      const result = await askOnce(readline, `${translate(language, "settings.tui.numberPrompt")} `);
      if (result.kind === "closed" || result.kind === "cancelled") return result.kind === "cancelled" ? 130 : 0;
      const answer = result.value.trim().toLowerCase();
      if (answer === "q") return 0;
      if (!/^[1-9]$/.test(answer) || Number(answer) > SETTINGS_FIELDS.length) {
        context.stdout.write(`${translate(language, "settings.error.selectField")}\n`);
        continue;
      }
      const field = SETTINGS_FIELDS[Number(answer) - 1];
      const options = SETTINGS_OPTIONS[field];
      context.stdout.write(`${translate(language, "settings.editing", { field: fieldLabel(field, language) })}\n`);
      context.stdout.write(`${translate(language, "settings.currentValue", {
        value: optionLabel(field, settings[field], language),
        source: translate(language, `settings.source.${settings.sources[field]}`),
      })}\n`);
      const recommended = recommendation(settings, field, language);
      if (recommended) context.stdout.write(`(${recommended})\n`);
      const note = editingNote(field, language);
      if (note) context.stdout.write(`${note}\n`);
      const numeric = QUOTA_LIMIT_PERCENT_FIELDS.includes(field);
      if (numeric) context.stdout.write(`${translate(language, "settings.ui.percentRange")}\n`);
      else options.forEach((value, index) => context.stdout.write(`${index + 1}. ${optionLabel(field, value, language)}\n`));
      const choice = await askOnce(readline, `${translate(language, numeric ? "settings.tui.percentPrompt" : "settings.tui.numberOption")} `);
      if (choice.kind === "closed" || choice.kind === "cancelled") return choice.kind === "cancelled" ? 130 : 0;
      const selection = choice.value.trim().toLowerCase();
      if (selection === "q") return 0;
      if (numeric ? !/^\d+$/.test(selection) || Number(selection) > 100
        : !/^[1-9]\d*$/.test(selection) || Number(selection) > options.length) {
        const message = selection ? translate(language, numeric ? "settings.ui.percentInvalid" : "settings.error.selectOption") : translate(language, "settings.menu.cancelled");
        context.stdout.write(`${message}\n`);
        continue;
      }
      const saved = await saveSetting(settings, field, numeric ? Number(selection) : options[Number(selection) - 1], context, language);
      settings = saved.settings;
      language = saved.language;
      context.stdout.write(`${saved.status}\n`);
    }
  } finally {
    readline.close();
  }
}

export async function runSettingsCommand({
  args = [],
  json = false,
  language = "en",
  explicitLanguage,
  configFile,
  platform = process.platform,
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
} = {}) {
  if (json && !(args.length === 1 && args[0] === "show")) {
    stderr.write(`${translate(language, "settings.error.usage")}\n`);
    return 2;
  }

  if (args.length === 1 && args[0] === "show") {
    let settings;
    try { settings = await readSettings({ configFile, platform }); }
    catch (error) { return settingError(error, language, stderr); }
    if (json) stdout.write(`${JSON.stringify(safeJsonSettings(settings), null, 2)}\n`);
    else stdout.write(settingsText(settings, language));
    return 0;
  }

  if (args.length === 3 && args[0] === "set" && args[1] === "maxCodexAgents") {
    if (!/^[1-5]$/.test(args[2])) return settingError({ code: "SETTINGS_VALUE_INVALID" }, language, stderr, "maxCodexAgents");
    try {
      const settings = await setMaxCodexAgents(Number(args[2]), { configFile, platform, language });
      stdout.write(`${translate(language, "settings.saved", { value: settings.maxCodexAgents })}\n`);
      return 0;
    } catch (error) { return settingError(error, language, stderr, "maxCodexAgents"); }
  }

  if (args.length === 3 && args[0] === "set" && CLI_SETTING_FIELDS.includes(args[1])) {
    const field = args[1];
    let value = args[2];
    if (QUOTA_LIMIT_PERCENT_FIELDS.includes(field)) {
      if (!/^(?:0|[1-9]\d?|100)$/.test(value)) {
        return settingError({ code: "SETTINGS_VALUE_INVALID" }, language, stderr, field);
      }
      value = Number(value);
    }
    try {
      const settings = await updateSettings({ [field]: value }, { configFile, platform, language });
      stdout.write(`${translate(language, "settings.savedField", {
        field: fieldLabel(field, language),
        value: optionLabel(field, settings[field], language),
      })}\n`);
      return 0;
    } catch (error) { return settingError(error, language, stderr, field); }
  }

  if (args.length !== 0 || json) {
    stderr.write(`${translate(language, "settings.error.usage")}\n`);
    return 2;
  }
  if (!stdin?.isTTY || !stdout?.isTTY) {
    stderr.write(`${translate(language, "settings.error.interactiveRequired")}\n`);
    return 2;
  }

  let settings;
  try { settings = await readSettings({ configFile, platform }); }
  catch (error) { return settingError(error, language, stderr); }
  const context = { configFile, platform, env, stdout, stderr, stdin, explicitLanguage };
  const displayLanguage = explicitLanguage || settings.language || language;
  return supportsArrowTui(context)
    ? runArrowTui(settings, displayLanguage, context)
    : runNumberTui(settings, displayLanguage, context);
}
