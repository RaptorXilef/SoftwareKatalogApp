import {
  DEFAULT_LOCALE,
  getAvailableLocales,
  getConfiguredLanguage,
  getI18nLocale,
  hasI18nKey,
  onI18nChange,
  setI18nState,
  t,
} from '../../shared/i18n.js';
import { getProviderBadgeInfo, PROVIDER_DISPLAY_META } from '../../shared/unified-packages.js';

export { getAvailableLocales, getConfiguredLanguage, getI18nLocale, onI18nChange, t };

/**
 * Returns the localized display name for a provider ID or provider object.
 * @param {string | { id?: string, name?: string } | null | undefined} providerOrId
 * @param {Array<Record<string, any>>} [providersList]
 * @returns {string}
 */
export function getLocalizedProviderName(providerOrId, providersList = []) {
  const id =
    typeof providerOrId === 'string'
      ? providerOrId.trim().toLowerCase()
      : String(providerOrId?.id || '')
          .trim()
          .toLowerCase();
  if (id === 'archive') {
    return t('providers.names.archive');
  }
  if (providerOrId && typeof providerOrId === 'object' && providerOrId.name) {
    return String(providerOrId.name);
  }
  const found = Array.isArray(providersList)
    ? providersList.find((p) => String(p?.id || '').toLowerCase() === id)
    : null;
  if (found?.name) return String(found.name);
  return PROVIDER_DISPLAY_META[id]?.label || id;
}

/**
 * Returns provider badge info with localized Archive label.
 * @param {unknown} providerId
 * @param {Array<Record<string, any>>} [providersList]
 * @returns {{ id: string, label: string, badgeClass: string } | null}
 */
export function getLocalizedProviderBadge(providerId, providersList = []) {
  const info = getProviderBadgeInfo(providerId, providersList);
  if (!info) return null;
  if (info.id === 'archive') {
    return { ...info, label: t('providers.names.archive') };
  }
  return info;
}

/**
 * Returns the localized provider description if available.
 * @param {Record<string, any> | null | undefined} provider
 * @returns {string}
 */
export function getLocalizedProviderDescription(provider) {
  const id = String(provider?.id || '')
    .trim()
    .toLowerCase();
  const key = id ? `providers.descriptions.${id}` : '';
  if (key && hasI18nKey(key)) {
    return t(key);
  }
  return String(provider?.description || '');
}

/**
 * Returns the localized provider uninstall warning if available.
 * @param {Record<string, any> | null | undefined} provider
 * @returns {string}
 */
export function getLocalizedProviderUninstallWarning(provider) {
  if (!provider?.uninstallWarning) return '';
  const id = String(provider?.id || '')
    .trim()
    .toLowerCase();
  const key = id ? `providers.uninstallWarnings.${id}` : '';
  if (key && hasI18nKey(key)) {
    return t(key);
  }
  return String(provider.uninstallWarning || '');
}

/**
 * Returns the localized description for a provider source quick template.
 * @param {string} providerId
 * @param {{ name?: string, url?: string, description?: string } | null | undefined} template
 * @returns {string}
 */
export function getLocalizedSourceTemplateDescription(providerId, template) {
  const cleanPm = String(providerId || '')
    .trim()
    .toLowerCase();
  const cleanName = String(template?.name || '').trim();
  const key = cleanPm && cleanName ? `providerSources.templates.${cleanPm}.${cleanName}` : '';
  if (key && hasI18nKey(key)) {
    return t(key);
  }
  return String(template?.description || template?.url || cleanName || '');
}

/**
 * Maps a policy evaluation result to a localized error message.
 * @param {{ reason?: string, error?: string } | null | undefined} policyEval
 * @param {string} [fallbackKey]
 * @returns {string}
 */
export function getLocalizedPolicyError(policyEval, fallbackKey = 'policy.blockedDefault') {
  const reason = policyEval?.reason;
  if (reason === 'not-in-whitelist') return t('policy.errorNotInWhitelist');
  if (reason === 'in-blacklist') return t('policy.errorInBlacklist');
  if (reason === 'adware-silent-conflict') return t('policy.errorAdwareConflict');
  return String(policyEval?.error || t(fallbackKey));
}

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
