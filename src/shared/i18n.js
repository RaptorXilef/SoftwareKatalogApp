export const DEFAULT_LOCALE = 'en';
export const AUTO_LOCALE = 'auto';

const LOCALE_CODE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * Normalizes a BCP-47-like locale code (e.g. "de_DE" -> "de-de").
 * Returns an empty string if invalid.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeLocaleCode(raw) {
  if (typeof raw !== 'string') return '';
  const clean = raw.trim().replace(/_/g, '-').toLowerCase();
  if (!clean || clean === AUTO_LOCALE) return '';
  return LOCALE_CODE_RE.test(clean) ? clean : '';
}

/**
 * Normalizes the configured language setting ('auto' or a locale code, defaulting to 'en').
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeConfiguredLanguage(raw) {
  if (typeof raw !== 'string') return DEFAULT_LOCALE;
  const clean = raw.trim().replace(/_/g, '-').toLowerCase();
  if (!clean) return DEFAULT_LOCALE;
  if (clean === AUTO_LOCALE) return AUTO_LOCALE;
  return LOCALE_CODE_RE.test(clean) ? clean : DEFAULT_LOCALE;
}

/**
 * Resolves the effective locale code against available locales with fallback to 'en'.
 * @param {unknown} requestedCode
 * @param {string[]} [availableCodes]
 * @param {unknown} [systemLocale]
 * @returns {string}
 */
export function resolveEffectiveLocale(
  requestedCode,
  availableCodes = [DEFAULT_LOCALE],
  systemLocale = DEFAULT_LOCALE
) {
  const normalizedAvailable = [];
  const availableSet = new Set();

  for (const rawCode of Array.isArray(availableCodes) ? availableCodes : []) {
    const code = normalizeLocaleCode(rawCode);
    if (code && !availableSet.has(code)) {
      availableSet.add(code);
      normalizedAvailable.push(code);
    }
  }

  if (normalizedAvailable.length === 0) {
    availableSet.add(DEFAULT_LOCALE);
    normalizedAvailable.push(DEFAULT_LOCALE);
  }

  const defaultCandidate = availableSet.has(DEFAULT_LOCALE) ? DEFAULT_LOCALE : normalizedAvailable[0];

  const matchAvailable = (rawCandidate) => {
    const code = normalizeLocaleCode(rawCandidate);
    if (!code) return '';
    if (availableSet.has(code)) return code;
    const base = code.split('-')[0];
    if (base && availableSet.has(base)) return base;
    return '';
  };

  const configured = normalizeConfiguredLanguage(requestedCode);
  if (!configured || configured === AUTO_LOCALE) {
    return matchAvailable(systemLocale) || defaultCandidate;
  }

  return matchAvailable(configured) || defaultCandidate;
}

/**
 * Extracts normalized locale metadata from a dictionary's `_meta` block.
 * @param {Record<string, any> | null | undefined} dictionary
 * @param {string} [fallbackCode]
 * @returns {{ code: string, name: string, nativeName: string, author: string }}
 */
export function extractLocaleMeta(dictionary, fallbackCode = DEFAULT_LOCALE) {
  const meta =
    dictionary && typeof dictionary === 'object' && !Array.isArray(dictionary) && dictionary._meta
      ? dictionary._meta
      : {};
  const fallback = normalizeLocaleCode(fallbackCode) || DEFAULT_LOCALE;
  const code = normalizeLocaleCode(meta.code) || fallback;
  const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : code.toUpperCase();
  const nativeName = typeof meta.nativeName === 'string' && meta.nativeName.trim() ? meta.nativeName.trim() : name;
  const author = typeof meta.author === 'string' ? meta.author.trim() : '';

  return {
    code,
    name,
    nativeName,
    author,
  };
}

/**
 * Flattens a nested dictionary (skipping `_meta`) into a flat `{ 'dot.key': 'string' }` object.
 * @param {Record<string, any> | null | undefined} dict
 * @param {string} [prefix]
 * @returns {Record<string, string>}
 */
export function flattenMessages(dict, prefix = '') {
  /** @type {Record<string, string>} */
  const out = {};
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
    return out;
  }

  for (const [key, value] of Object.entries(dict)) {
    if (!prefix && key === '_meta') continue;
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      out[nextKey] = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenMessages(value, nextKey));
    }
  }

  return out;
}

/**
 * Resolves a dot-separated translation key (or direct key) from a dictionary.
 * @param {Record<string, any> | null | undefined} dict
 * @param {string} key
 * @returns {string | null}
 */
function getNestedValue(dict, key) {
  if (!dict || typeof dict !== 'object' || typeof key !== 'string' || !key) {
    return null;
  }
  if (typeof dict[key] === 'string') {
    return dict[key];
  }
  const parts = key.split('.');
  /** @type {any} */
  let cur = dict;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur) || part === '_meta') {
      return null;
    }
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : null;
}

/**
 * Replaces `{placeholder}` tokens with provided parameter values.
 * @param {string} template
 * @param {Record<string, unknown> | null | undefined} [params]
 * @returns {string}
 */
export function interpolate(template, params = {}) {
  const str = String(template ?? '');
  if (!params || typeof params !== 'object') {
    return str;
  }
  return str.replace(PLACEHOLDER_RE, (match, token) => {
    const val = params[token];
    if (val === undefined || val === null) {
      return match;
    }
    return String(val);
  });
}

function clonePlainObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  return { ...obj };
}

/**
 * Creates a standalone, dependency-free i18n translator instance.
 * Fallback chain: active messages -> fallbackMessages ('en') -> key name.
 * @param {{
 *   locale?: string,
 *   configuredLanguage?: string,
 *   messages?: Record<string, any>,
 *   fallbackMessages?: Record<string, any>,
 *   availableLocales?: Array<{ code: string, name: string, nativeName: string, author?: string, source?: string }>,
 *   userLocalesDir?: string,
 * }} [initialState]
 */
export function createI18n(initialState = {}) {
  let state = {
    locale: normalizeLocaleCode(initialState.locale) || DEFAULT_LOCALE,
    configuredLanguage: normalizeConfiguredLanguage(initialState.configuredLanguage || initialState.locale),
    messages: clonePlainObject(initialState.messages),
    fallbackMessages: clonePlainObject(initialState.fallbackMessages),
    availableLocales: Array.isArray(initialState.availableLocales) ? [...initialState.availableLocales] : [],
    userLocalesDir: typeof initialState.userLocalesDir === 'string' ? initialState.userLocalesDir : '',
  };

  /** @type {Set<(snapshot: ReturnType<typeof getSnapshot>) => void>} */
  const listeners = new Set();

  function getSnapshot() {
    return {
      locale: state.locale,
      configuredLanguage: state.configuredLanguage,
      messages: state.messages,
      fallbackMessages: state.fallbackMessages,
      availableLocales: [...state.availableLocales],
      userLocalesDir: state.userLocalesDir,
    };
  }

  /**
   * Translates a key using the active dictionary, falling back to 'en', then the key itself.
   * @param {string} key
   * @param {Record<string, unknown>} [params]
   * @returns {string}
   */
  function t(key, params = {}) {
    const keyStr = String(key ?? '');
    const raw = getNestedValue(state.messages, keyStr) ?? getNestedValue(state.fallbackMessages, keyStr) ?? keyStr;
    return interpolate(raw, params);
  }

  function hasKey(key) {
    const keyStr = String(key ?? '');
    return getNestedValue(state.messages, keyStr) !== null || getNestedValue(state.fallbackMessages, keyStr) !== null;
  }

  /**
   * Updates the active dictionary and language metadata, notifying subscribers.
   * @param {{
   *   locale?: string,
   *   activeLocale?: string,
   *   configuredLanguage?: string,
   *   messages?: Record<string, any>,
   *   fallbackMessages?: Record<string, any>,
   *   availableLocales?: Array<{ code: string, name: string, nativeName: string, author?: string, source?: string }>,
   *   userLocalesDir?: string,
   * }} [nextState]
   */
  function setState(nextState = {}) {
    const src = nextState && typeof nextState === 'object' ? nextState : {};
    const nextLocale = normalizeLocaleCode(src.activeLocale ?? src.locale ?? state.locale) || DEFAULT_LOCALE;
    const nextConfigured =
      src.configuredLanguage !== undefined
        ? normalizeConfiguredLanguage(src.configuredLanguage)
        : state.configuredLanguage;

    state = {
      locale: nextLocale,
      configuredLanguage: nextConfigured,
      messages: src.messages !== undefined ? clonePlainObject(src.messages) : state.messages,
      fallbackMessages:
        src.fallbackMessages !== undefined ? clonePlainObject(src.fallbackMessages) : state.fallbackMessages,
      availableLocales: Array.isArray(src.availableLocales) ? [...src.availableLocales] : state.availableLocales,
      userLocalesDir: typeof src.userLocalesDir === 'string' ? src.userLocalesDir : state.userLocalesDir,
    };

    const snapshot = getSnapshot();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // Isolate subscriber errors
      }
    }
    return snapshot;
  }

  /**
   * Registers a listener invoked whenever `setState` updates the active language.
   * @param {(snapshot: ReturnType<typeof getSnapshot>) => void} listener
   * @returns {() => void}
   */
  function onChange(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return {
    t,
    hasKey,
    setState,
    onChange,
    getSnapshot,
    getLocale: () => state.locale,
    getConfiguredLanguage: () => state.configuredLanguage,
    getMessages: () => state.messages,
    getFallbackMessages: () => state.fallbackMessages,
    getAvailableLocales: () => [...state.availableLocales],
    getUserLocalesDir: () => state.userLocalesDir,
  };
}

export const i18n = createI18n();

export const t = (key, params = {}) => i18n.t(key, params);
export const hasI18nKey = (key) => i18n.hasKey(key);
export const setI18nState = (nextState) => i18n.setState(nextState);
export const getI18nLocale = () => i18n.getLocale();
export const getConfiguredLanguage = () => i18n.getConfiguredLanguage();
export const getAvailableLocales = () => i18n.getAvailableLocales();
export const onI18nChange = (listener) => i18n.onChange(listener);
