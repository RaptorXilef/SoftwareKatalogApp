import fs from 'node:fs';
import path from 'node:path';
import {
  AUTO_LOCALE,
  DEFAULT_LOCALE,
  i18n as defaultI18n,
  extractLocaleMeta,
  normalizeConfiguredLanguage,
  normalizeLocaleCode,
  resolveEffectiveLocale,
} from '../shared/i18n.js';

function readJsonDir(dirPath, source, localesMap) {
  if (!dirPath) return;
  let entries;
  try {
    if (!fs.existsSync(dirPath)) return;
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const fullPath = path.join(dirPath, entry.name);
    const stem = path.basename(entry.name, path.extname(entry.name));
    try {
      const rawText = fs.readFileSync(fullPath, 'utf-8');
      const parsed = JSON.parse(rawText);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn(`Locale file ignored (invalid object): ${fullPath}`);
        continue;
      }
      const meta = extractLocaleMeta(parsed, stem);
      const { _meta: _ignoredMeta, ...messages } = parsed;
      localesMap.set(meta.code, {
        ...meta,
        source,
        filePath: fullPath,
        messages,
      });
    } catch (err) {
      console.warn(`Could not load locale file ${fullPath}:`, err?.message || err);
    }
  }
}

/**
 * Loads built-in and community locale JSON files from disk.
 * Community locales from `userDir` can add new languages or override built-in ones.
 * @param {{ builtinDir?: string, userDir?: string }} [dirs]
 */
export function loadLocalesFromDirs({ builtinDir = '', userDir = '' } = {}) {
  /** @type {Map<string, { code: string, name: string, nativeName: string, author: string, source: 'builtin' | 'custom', filePath: string, messages: Record<string, any> }>} */
  const localesMap = new Map();

  readJsonDir(builtinDir, 'builtin', localesMap);
  readJsonDir(userDir, 'custom', localesMap);

  const availableLocales = Array.from(localesMap.values())
    .map(({ code, name, nativeName, author, source }) => ({
      code,
      name,
      nativeName,
      author,
      source,
    }))
    .sort((a, b) => {
      if (a.code === DEFAULT_LOCALE) return -1;
      if (b.code === DEFAULT_LOCALE) return 1;
      if (a.code === 'de') return -1;
      if (b.code === 'de') return 1;
      return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
    });

  return { localesMap, availableLocales };
}

/**
 * Creates the main-process i18n service with dependency injection for unit testing.
 * @param {{
 *   getBuiltinLocalesDirFn?: () => string,
 *   getUserLocalesDirFn?: () => string,
 *   getConfigFn?: () => Record<string, any>,
 *   saveConfigFn?: (patch: Record<string, any>) => void,
 *   getSystemLocaleFn?: () => string,
 *   onLanguageChanged?: (snapshot: Record<string, any>) => void,
 *   i18nInstance?: ReturnType<typeof import('../shared/i18n.js').createI18n>,
 * }} [deps]
 */
export function createI18nService(deps = {}) {
  const getBuiltinLocalesDirFn =
    typeof deps.getBuiltinLocalesDirFn === 'function' ? deps.getBuiltinLocalesDirFn : () => '';
  const getUserLocalesDirFn = typeof deps.getUserLocalesDirFn === 'function' ? deps.getUserLocalesDirFn : () => '';
  const getConfigFn = typeof deps.getConfigFn === 'function' ? deps.getConfigFn : () => ({});
  const saveConfigFn = typeof deps.saveConfigFn === 'function' ? deps.saveConfigFn : () => {};
  const getSystemLocaleFn =
    typeof deps.getSystemLocaleFn === 'function' ? deps.getSystemLocaleFn : () => DEFAULT_LOCALE;
  const i18nInstance = deps.i18nInstance || defaultI18n;

  let onLanguageChanged = typeof deps.onLanguageChanged === 'function' ? deps.onLanguageChanged : null;
  let cachedLocales = loadLocalesFromDirs({
    builtinDir: getBuiltinLocalesDirFn(),
    userDir: getUserLocalesDirFn(),
  });

  function ensureUserLocalesDir() {
    const userDir = getUserLocalesDirFn();
    if (!userDir) return '';
    try {
      if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
      }
    } catch {
      // Ignore if directory cannot be created
    }
    return userDir;
  }

  function reloadLocales() {
    const builtinDir = getBuiltinLocalesDirFn();
    const userDir = getUserLocalesDirFn();
    cachedLocales = loadLocalesFromDirs({ builtinDir, userDir });
    return cachedLocales;
  }

  function validateConfiguredLanguage(rawCode) {
    const normalized = normalizeConfiguredLanguage(rawCode);
    if (normalized === AUTO_LOCALE) return AUTO_LOCALE;
    const availableCodes = cachedLocales.availableLocales.map((item) => item.code);
    if (availableCodes.includes(normalized)) return normalized;
    const base = normalizeLocaleCode(normalized).split('-')[0];
    if (base && availableCodes.includes(base)) return base;
    return DEFAULT_LOCALE;
  }

  function buildSnapshot(configuredLanguage, activeLocale) {
    const enEntry = cachedLocales.localesMap.get(DEFAULT_LOCALE);
    const activeEntry = cachedLocales.localesMap.get(activeLocale) || enEntry;
    const fallbackMessages = enEntry ? enEntry.messages : {};
    const messages = activeEntry ? activeEntry.messages : fallbackMessages;
    const userLocalesDir = getUserLocalesDirFn();

    return {
      configuredLanguage,
      activeLocale,
      messages,
      fallbackMessages,
      availableLocales: [...cachedLocales.availableLocales],
      userLocalesDir,
    };
  }

  function applyConfiguredLanguage(rawCode, { persist = false, emit = false } = {}) {
    reloadLocales();
    const configuredLanguage = validateConfiguredLanguage(rawCode);
    const availableCodes = cachedLocales.availableLocales.map((item) => item.code);
    const systemLocale = getSystemLocaleFn();
    const activeLocale = resolveEffectiveLocale(configuredLanguage, availableCodes, systemLocale);

    const snapshot = buildSnapshot(configuredLanguage, activeLocale);
    i18nInstance.setState(snapshot);

    if (persist) {
      saveConfigFn({ language: configuredLanguage });
    }

    if (emit && typeof onLanguageChanged === 'function') {
      try {
        onLanguageChanged(snapshot);
      } catch {
        // Isolate listener errors
      }
    }

    return snapshot;
  }

  function configure(options = {}) {
    if (typeof options.onLanguageChanged === 'function') {
      onLanguageChanged = options.onLanguageChanged;
    }
  }

  function init() {
    ensureUserLocalesDir();
    const cfg = getConfigFn() || {};
    return applyConfiguredLanguage(cfg.language || DEFAULT_LOCALE, { persist: false, emit: false });
  }

  function getState({ reload = false } = {}) {
    if (reload) {
      const cfg = getConfigFn() || {};
      return applyConfiguredLanguage(cfg.language || i18nInstance.getConfiguredLanguage() || DEFAULT_LOCALE, {
        persist: false,
        emit: false,
      });
    }
    return buildSnapshot(i18nInstance.getConfiguredLanguage(), i18nInstance.getLocale());
  }

  function setLanguage(code) {
    const snapshot = applyConfiguredLanguage(code, { persist: true, emit: true });
    return {
      success: true,
      ...snapshot,
    };
  }

  return {
    configure,
    init,
    reloadLocales,
    getState,
    setLanguage,
  };
}
