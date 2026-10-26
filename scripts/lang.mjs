import { formatLanguageError, getSavedLanguage, parseLanguageFlags, resolveLanguagePreference, saveLanguage, translate, validateLanguage } from "../src/i18n/index.mjs";

function languageName(language) {
  return translate(language, `cli.language.name.${language}`);
}

async function main() {
  let language = (await resolveLanguagePreference()).language;
  try {
    const parsed = parseLanguageFlags(process.argv.slice(2));
    if (parsed.args.length > 1 || (parsed.explicitLanguage && parsed.args.length)) {
      throw Object.assign(new Error("LANG_ARGUMENTS_INVALID"), { code: "LANG_ARGUMENTS_INVALID" });
    }
    const selected = parsed.explicitLanguage ?? (parsed.args.length ? validateLanguage(parsed.args[0]) : undefined);
    if (selected) {
      await saveLanguage(selected);
      console.log(translate(selected, "cli.language.saved", {
        language: selected,
        name: languageName(selected),
      }));
      return;
    }

    const preference = await resolveLanguagePreference();
    const saved = await getSavedLanguage();
    language = preference.language;
    console.log(translate(language, "cli.language.current", {
      language,
      name: languageName(language),
    }));
    console.log(translate(language, "cli.language.savedValue", {
      value: saved ? `${languageName(saved)} (${saved})` : translate(language, "cli.language.value.unset"),
    }));
    console.log(translate(language, "cli.language.source", {
      source: translate(language, `cli.language.source.${preference.source}`),
    }));
  } catch (error) {
    const source = await resolveLanguagePreference().catch(() => ({ language: "en" }));
    language = source.language;
    console.error(formatLanguageError(error, language));
    process.exitCode = 1;
  }
}

await main();
