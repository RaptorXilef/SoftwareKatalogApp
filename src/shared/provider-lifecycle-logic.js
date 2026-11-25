import { normalizeCustomSourcesList } from './provider-sources-parser.js';

export const DEFAULT_ENABLED_PROVIDERS = Object.freeze(['winget', 'archive']);

export const DEFAULT_PROVIDER_SETTINGS = Object.freeze({
  vcpkgRoot: '',
});

const PROVIDER_UI_GROUPS = Object.freeze([
  { id: 'system', label: 'System', categories: ['system'] },
  { id: 'developer', label: 'Sprachen & Entwickler', categories: ['runtime', 'developer'] },
  { id: 'archive', label: 'Archiv', categories: ['archive'] },
]);

/**
 * Normalisiert eine Provider-Kategorie auf die erlaubten Werte.
 * @param {unknown} category
 * @returns {'system' | 'runtime' | 'developer' | 'archive'}
 */
export function normalizeProviderCategory(category) {
  const clean = String(category || '')
    .trim()
    .toLowerCase();
  if (clean === 'runtime' || clean === 'developer' || clean === 'archive' || clean === 'system') {
    return clean;
  }
  return 'system';
}

/**
 * Normalisiert die Liste aktivierter Provider-IDs (Standard: ['winget', 'archive']).
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeEnabledProviders(raw) {
  if (!Array.isArray(raw)) {
    return [...DEFAULT_ENABLED_PROVIDERS];
  }
  const seen = new Set();
  const normalized = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const clean = entry.trim().toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    normalized.push(clean);
  }
  return normalized;
}

/**
 * Normalisiert provider-spezifische Einstellungen (z. B. vcpkgRoot).
 * @param {unknown} raw
 * @returns {{ vcpkgRoot: string } & Record<string, any>}
 */
export function normalizeProviderSettings(raw) {
  /** @type {Record<string, any>} */
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  /** @type {{ vcpkgRoot: string } & Record<string, any>} */
  const cleaned = { ...DEFAULT_PROVIDER_SETTINGS };
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      cleaned[key] = value.trim();
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nextObj = { ...value };
      if ('customSources' in nextObj) {
        const normalizedSources = normalizeCustomSourcesList(nextObj.customSources);
        if (normalizedSources.length > 0) {
          nextObj.customSources = normalizedSources;
        } else {
          delete nextObj.customSources;
        }
      }
      if (Object.keys(nextObj).length > 0) {
        cleaned[key] = nextObj;
      }
    } else {
      cleaned[key] = value;
    }
  }
  cleaned.vcpkgRoot = typeof base.vcpkgRoot === 'string' ? base.vcpkgRoot.trim() : '';
  return cleaned;
}

/**
 * Bereinigt eine erkannte Manager-Version (z. B. entfernt führendes "v").
 * @param {unknown} rawVersion
 * @returns {string | null}
 */
export function normalizeProviderVersion(rawVersion) {
  if (rawVersion === null || rawVersion === undefined) return null;
  const trimmed = String(rawVersion).trim();
  if (!trimmed) return null;
  const withoutPrefix = trimmed.replace(/^v(?=\d)/i, '').trim();
  return withoutPrefix || null;
}

function tr(translateFn, key, params, fallback) {
  if (typeof translateFn === 'function') {
    const translated = translateFn(key, params);
    if (typeof translated === 'string' && translated && translated !== key) {
      return translated;
    }
  }
  return fallback;
}

/**
 * Gruppiert registrierte Provider in die UI-Kategorien ("System", "Sprachen & Entwickler", "Archiv").
 * @param {Array<Record<string, any>>} providers
 * @param {{ t?: (key: string, params?: Record<string, unknown>) => string }} [options]
 * @returns {Array<{ id: string, label: string, providers: Array<Record<string, any>> }>}
 */
export function groupProvidersByUiCategory(providers, { t = undefined } = {}) {
  const list = Array.isArray(providers) ? providers : [];
  return PROVIDER_UI_GROUPS.map((group) => {
    const allowedCats = new Set(group.categories);
    const items = list.filter((provider) => allowedCats.has(normalizeProviderCategory(provider?.category)));
    return {
      id: group.id,
      label: tr(t, `providers.groups.${group.id}`, {}, group.label),
      providers: items,
    };
  }).filter((group) => group.providers.length > 0);
}

/**
 * Erzeugt den Live-Status-Badge für einen Paketmanager im Einstellungs-Modal.
 * @param {Record<string, any>} provider
 * @param {{ available?: boolean, version?: string | null, binaryPath?: string | null, error?: string | null } | null} [availability]
 * @param {{ t?: (key: string, params?: Record<string, unknown>) => string }} [options]
 * @returns {{ kind: 'checking' | 'installed' | 'missing' | 'system', text: string, title: string }}
 */
export function formatProviderStatusBadge(provider, availability = null, { t = undefined } = {}) {
  if (!availability) {
    return {
      kind: 'checking',
      text: `⏳ ${tr(t, 'providers.status.checking', {}, 'Prüfe...')}`,
      title: tr(t, 'providers.status.checkingTitle', {}, 'Verfügbarkeit wird geprüft...'),
    };
  }

  const version = normalizeProviderVersion(availability.version);
  if (availability.available && provider?.isSystemComponent) {
    return {
      kind: 'system',
      text: version
        ? `🔒 ${tr(t, 'providers.status.systemVersion', { version }, `Systemkomponente v${version}`)}`
        : `🔒 ${tr(t, 'providers.status.system', {}, 'Systemkomponente')}`,
      title:
        availability.binaryPath || tr(t, 'providers.status.systemTitle', {}, 'Integrierte Windows-Systemkomponente'),
    };
  }

  if (availability.available) {
    return {
      kind: 'installed',
      text: version
        ? `🟢 ${tr(t, 'providers.status.installedVersion', { version }, `Installiert v${version}`)}`
        : `🟢 ${tr(t, 'providers.status.installed', {}, 'Installiert')}`,
      title: availability.binaryPath || tr(t, 'providers.status.installedTitle', {}, 'Installiert und einsatzbereit'),
    };
  }

  return {
    kind: 'missing',
    text: `⚪ ${tr(t, 'providers.status.missing', {}, 'Nicht installiert')}`,
    title: availability.error || tr(t, 'providers.status.missingTitle', {}, 'Auf diesem PC nicht installiert'),
  };
}

/**
 * Prüft, ob ein Provider in Tabs/Suchen/Bündeln als nutzbar angezeigt werden soll.
 * @param {Record<string, any> | null | undefined} provider
 * @returns {boolean}
 */
export function isProviderUsableInUi(provider) {
  return Boolean(provider?.enabled) && provider?.availability?.available !== false;
}

/**
 * Filtert Provider auf aktive & installierte Manager für UI-Tabs und Bündel-Editor.
 * @param {Array<Record<string, any>>} providers
 * @param {{ capability?: string | null, excludeIds?: string[] }} [options]
 * @returns {Array<Record<string, any>>}
 */
export function filterUsableProviders(providers, { capability = null, excludeIds = [] } = {}) {
  const list = Array.isArray(providers) ? providers : [];
  const excluded = new Set(excludeIds.map((id) => String(id).trim().toLowerCase()));
  return list.filter((provider) => {
    if (!provider?.id) return false;
    const id = String(provider.id).trim().toLowerCase();
    if (excluded.has(id)) return false;
    if (!isProviderUsableInUi(provider)) return false;
    if (capability && !provider.capabilities?.[capability]) return false;
    return true;
  });
}
