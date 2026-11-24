import {
  DEFAULT_LOCALE,
  getAvailableLocales,
  getConfiguredLanguage,
  getI18nLocale,
  onI18nChange,
  setI18nState,
  t,
} from '../../shared/i18n.js';

export { getAvailableLocales, getConfiguredLanguage, getI18nLocale, onI18nChange, t };

/**
 * Applies translations to all `[data-i18n*]` elements under `root` and updates `<html lang>` / `<title>`.
 * @param {ParentNode} [root]
 */
export function applyTranslationsToDom(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  if (root === document && document.documentElement) {
    document.documentElement.lang = getI18nLocale() || DEFAULT_LOCALE;
    const appTitle = t('app.title');
    if (appTitle && appTitle !== 'app.title') {
      document.title = appTitle;
    }
  }

  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  }

  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.setAttribute('title', t(key));
  }

  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', t(key));
  }

  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    const key = el.getAttribute('data-i18n-aria-label');
    if (key) el.setAttribute('aria-label', t(key));
  }

  for (const el of root.querySelectorAll('[data-i18n-label]')) {
    const key = el.getAttribute('data-i18n-label');
    if (key) el.setAttribute('label', t(key));
  }

  for (const el of root.querySelectorAll('[data-i18n-alt]')) {
    const key = el.getAttribute('data-i18n-alt');
    if (key) el.setAttribute('alt', t(key));
  }
}

/**
 * Updates renderer i18n state from a main-process snapshot and refreshes static DOM translations.
 * @param {Record<string, any> | null | undefined} payload
 */
export function applyI18nState(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const snapshot = setI18nState({
    activeLocale: payload.activeLocale || payload.locale || DEFAULT_LOCALE,
    configuredLanguage: payload.configuredLanguage || payload.activeLocale || DEFAULT_LOCALE,
    messages: payload.messages || {},
    fallbackMessages: payload.fallbackMessages || {},
    availableLocales: Array.isArray(payload.availableLocales) ? payload.availableLocales : [],
    userLocalesDir: typeof payload.userLocalesDir === 'string' ? payload.userLocalesDir : '',
  });
  applyTranslationsToDom(document);
  return snapshot;
}

/**
 * Loads initial i18n state from main process and subscribes to live language changes.
 * @param {{ onLanguageUpdated?: (snapshot: Record<string, any>) => void }} [options]
 */
export async function initRendererI18n({ onLanguageUpdated } = {}) {
  if (typeof window.electronAPI?.getI18nState === 'function') {
    try {
      const initial = await window.electronAPI.getI18nState();
      applyI18nState(initial);
    } catch (err) {
      console.warn('Could not load initial i18n state:', err);
    }
  } else {
    applyTranslationsToDom(document);
  }

  if (typeof window.electronAPI?.onLanguageChanged === 'function') {
    return window.electronAPI.onLanguageChanged((nextState) => {
      const snapshot = applyI18nState(nextState);
      if (snapshot && typeof onLanguageUpdated === 'function') {
        onLanguageUpdated(snapshot);
      }
    });
  }

  return () => {};
}
