import { normalizeBackgroundSettings } from './background-update-logic.js';
import { normalizeConfiguredLanguage } from './i18n.js';
import { normalizeArchivePaths } from './multi-archive-logic.js';
import { normalizeEnabledProviders, normalizeProviderSettings } from './provider-lifecycle-logic.js';
import { normalizeDefaultSortModes, normalizeStartTab } from './unified-packages.js';

export const SETTINGS_TABS = Object.freeze([
  { id: 'general', label: '⚙️ Allgemein', icon: '⚙️', labelKey: 'settings.tabs.general' },
  { id: 'archive', label: '🗄️ Archiv & Downloads', icon: '🗄️', labelKey: 'settings.tabs.archive' },
  { id: 'providers', label: '📦 Paketmanager', icon: '📦', labelKey: 'settings.tabs.providers' },
  { id: 'updates', label: '🔔 Hintergrund & Updates', icon: '🔔', labelKey: 'settings.tabs.updates' },
  { id: 'security', label: '🛡️ Sicherheit & Richtlinien', icon: '🛡️', labelKey: 'settings.tabs.security' },
  { id: 'maintenance', label: '🛠️ Wartung & Über', icon: '🛠️', labelKey: 'settings.tabs.maintenance' },
]);

const VALID_SETTINGS_TAB_IDS = new Set(SETTINGS_TABS.map((t) => t.id));
const VALID_ARCHIVE_SAVE_MODES = new Set(['ask', 'auto-id', 'none']);
const VALID_UPDATE_INTERVALS = new Set([0, 24, 168, 720, -1]);
const DEFAULT_AUTO_EXTENSIONS = ['.exe', '.msi', '.zip'];
const DEFAULT_FILENAME_PATTERN = '{Name}_v{Version}{Arch}{Ext}';

/**
 * Normalisiert eine Tab-ID fuer das Einstellungs-Modal.
 * @param {unknown} tab
 * @returns {'general' | 'archive' | 'providers' | 'updates' | 'security' | 'maintenance'}
 */
export function normalizeSettingsTab(tab) {
  const clean = String(tab || '')
    .trim()
    .toLowerCase();
  if (VALID_SETTINGS_TAB_IDS.has(clean)) {
    return /** @type {'general' | 'archive' | 'providers' | 'updates' | 'security' | 'maintenance'} */ (clean);
  }
  return 'general';
}

/**
 * Parst Setup-Dateiendungen aus Text (kommagetrennt) oder Array in normalisierte Form.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseAutoExtensionsInput(raw) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const seen = new Set();
  const normalized = [];

  for (const entry of list) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const withDot = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    const key = withDot.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(withDot);
  }

  return normalized.length > 0 ? normalized : [...DEFAULT_AUTO_EXTENSIONS];
}

function normalizeBoundedInt(raw, min, max, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const parsed = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeUpdateInterval(raw) {
  if (raw === null || raw === undefined || raw === '') return 24;
  const parsed = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed)) return 24;
  return VALID_UPDATE_INTERVALS.has(parsed) ? parsed : 24;
}

function normalizeArchiveSaveMode(raw) {
  const clean = String(raw || '')
    .trim()
    .toLowerCase();
  return VALID_ARCHIVE_SAVE_MODES.has(clean) ? /** @type {'ask' | 'auto-id' | 'none'} */ (clean) : 'ask';
}

function normalizeVisibleHiddenCats(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const clean = entry.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/**
 * Erstellt einen kanonischen lokalen Einstellungs-Entwurf ohne geteilte Array-Referenzen.
 * @param {Record<string, any> | null | undefined} [rawSettings]
 * @returns {{
 *   language: string,
 *   startTab: string,
 *   newBadgeDays: number,
 *   versionCompareDepth: number,
 *   visibleHiddenCats: string[],
 *   archivePaths: string[],
 *   autoExtensions: string[],
 *   nestedDepth: number,
 *   scanNested: boolean,
 *   autoSaveDownloads: boolean,
 *   keepOriginalNameIfVersioned: boolean,
 *   filenamePattern: string,
 *   archiveSaveMode: 'ask' | 'auto-id' | 'none',
 *   enabledProviders: string[],
 *   vcpkgRoot: string,
 *   updateInterval: number,
 *   autoRequestAdminForBatch: boolean,
 *   minimizeToTrayOnClose: boolean,
 *   autostartEnabled: boolean,
 *   autostartMode: 'normal' | 'admin',
 *   backgroundCheckEnabled: boolean,
 *   backgroundCheckIntervalMinutes: number,
 *   notifyOnUpdates: boolean,
 *   autoUpdateEnabled: boolean,
 *   autoUpdateListType: 'all' | 'whitelist' | 'blacklist',
 *   autoUpdateEntries: import('./background-update-logic.js').AutoUpdateEntry[],
 *   defaultSortModes: { updates: string, installed: string, archive: string },
 * }}
 */
export function createSettingsDraft(rawSettings = {}) {
  const src = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
  const rawPattern = typeof src.filenamePattern === 'string' ? src.filenamePattern.trim() : '';
  const rawVcpkgRoot =
    src.providerSettings &&
    typeof src.providerSettings === 'object' &&
    typeof src.providerSettings.vcpkgRoot === 'string'
      ? src.providerSettings.vcpkgRoot
      : typeof src.vcpkgRoot === 'string'
        ? src.vcpkgRoot
        : '';
  const bg = normalizeBackgroundSettings(src);

  return {
    language: normalizeConfiguredLanguage(src.language),
    startTab: normalizeStartTab(src.startTab),
    defaultSortModes: normalizeDefaultSortModes(src.defaultSortModes),
    newBadgeDays: normalizeBoundedInt(src.newBadgeDays, 0, 365, 14),
    versionCompareDepth: normalizeBoundedInt(src.versionCompareDepth, 1, 10, 3),
    visibleHiddenCats: normalizeVisibleHiddenCats(src.visibleHiddenCats),
    archivePaths: normalizeArchivePaths(src),
    autoExtensions: parseAutoExtensionsInput(src.autoExtensions),
    nestedDepth: normalizeBoundedInt(src.nestedDepth, 1, 5, 1),
    scanNested: Boolean(src.scanNested),
    autoSaveDownloads: src.autoSaveDownloads !== false && !src.askSaveDialog,
    keepOriginalNameIfVersioned: src.keepOriginalNameIfVersioned !== false,
    filenamePattern: rawPattern || DEFAULT_FILENAME_PATTERN,
    archiveSaveMode: normalizeArchiveSaveMode(src.archiveSaveMode),
    enabledProviders: normalizeEnabledProviders(src.enabledProviders),
    vcpkgRoot: rawVcpkgRoot.trim(),
    updateInterval: normalizeUpdateInterval(src.updateInterval),
    autoRequestAdminForBatch: Boolean(src.autoRequestAdminForBatch),
    ...bg,
  };
}

/**
 * Schaltet einen Paketmanager im lokalen Entwurf um (ohne Seiteneffekte / Mutation).
 * @param {ReturnType<typeof createSettingsDraft>} draft
 * @param {unknown} providerId
 * @param {boolean} enabled
 * @returns {ReturnType<typeof createSettingsDraft>}
 */
export function toggleDraftProvider(draft, providerId, enabled) {
  const normalizedDraft = createSettingsDraft(draft);
  const cleanId = String(providerId || '')
    .trim()
    .toLowerCase();
  if (!cleanId) return normalizedDraft;

  const nextList = normalizedDraft.enabledProviders.filter((id) => id !== cleanId);
  if (enabled) {
    nextList.push(cleanId);
  }

  return {
    ...normalizedDraft,
    enabledProviders: nextList,
  };
}

function areArraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function areSetsEqual(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}

/**
 * Prüft, ob zwischen Ausgangsstand und aktuellem Entwurf ungespeicherte Änderungen vorliegen.
 * @param {Record<string, any>} initialDraft
 * @param {Record<string, any>} currentDraft
 * @returns {boolean}
 */
export function hasSettingsDraftChanges(initialDraft, currentDraft) {
  const initial = createSettingsDraft(initialDraft);
  const current = createSettingsDraft(currentDraft);

  if (initial.language !== current.language) return true;
  if (initial.startTab !== current.startTab) return true;
  if (initial.newBadgeDays !== current.newBadgeDays) return true;
  if (initial.versionCompareDepth !== current.versionCompareDepth) return true;
  if (initial.nestedDepth !== current.nestedDepth) return true;
  if (initial.scanNested !== current.scanNested) return true;
  if (initial.autoSaveDownloads !== current.autoSaveDownloads) return true;
  if (initial.keepOriginalNameIfVersioned !== current.keepOriginalNameIfVersioned) return true;
  if (initial.filenamePattern !== current.filenamePattern) return true;
  if (initial.archiveSaveMode !== current.archiveSaveMode) return true;
  if (initial.vcpkgRoot !== current.vcpkgRoot) return true;
  if (initial.updateInterval !== current.updateInterval) return true;
  if (initial.autoRequestAdminForBatch !== current.autoRequestAdminForBatch) return true;
  if (initial.minimizeToTrayOnClose !== current.minimizeToTrayOnClose) return true;
  if (initial.autostartEnabled !== current.autostartEnabled) return true;
  if (initial.autostartMode !== current.autostartMode) return true;
  if (initial.backgroundCheckEnabled !== current.backgroundCheckEnabled) return true;
  if (initial.backgroundCheckIntervalMinutes !== current.backgroundCheckIntervalMinutes) return true;
  if (initial.notifyOnUpdates !== current.notifyOnUpdates) return true;
  if (initial.autoUpdateEnabled !== current.autoUpdateEnabled) return true;
  if (initial.autoUpdateListType !== current.autoUpdateListType) return true;
  if (JSON.stringify(initial.autoUpdateEntries) !== JSON.stringify(current.autoUpdateEntries)) return true;
  if (initial.defaultSortModes.updates !== current.defaultSortModes.updates) return true;
  if (initial.defaultSortModes.installed !== current.defaultSortModes.installed) return true;
  if (initial.defaultSortModes.archive !== current.defaultSortModes.archive) return true;

  if (!areArraysEqual(initial.archivePaths, current.archivePaths)) return true;
  if (!areArraysEqual(initial.autoExtensions, current.autoExtensions)) return true;
  if (!areSetsEqual(initial.visibleHiddenCats, current.visibleHiddenCats)) return true;
  if (!areSetsEqual(initial.enabledProviders, current.enabledProviders)) return true;

  return false;
}

/**
 * Erzeugt das gebündelte Speicher-Payload sowie Folge-Aktionen (Archiv-Scan / PC-Scan).
 * @param {Record<string, any>} initialDraft
 * @param {Record<string, any>} currentDraft
 * @param {Record<string, any>} [baseProviderSettings]
 */
export function buildSettingsSavePlan(initialDraft, currentDraft, baseProviderSettings = {}) {
  const initial = createSettingsDraft(initialDraft);
  const current = createSettingsDraft(currentDraft);
  const baseProviderObj =
    baseProviderSettings && typeof baseProviderSettings === 'object' && !Array.isArray(baseProviderSettings)
      ? baseProviderSettings
      : {};

  const providerSettings = normalizeProviderSettings({
    ...baseProviderObj,
    vcpkgRoot: current.vcpkgRoot,
  });

  const payload = {
    language: current.language,
    enabledProviders: current.enabledProviders,
    providerSettings,
    archiveSaveMode: current.archiveSaveMode,
    archivePaths: current.archivePaths,
    targetPath: current.archivePaths[0] || '../software',
    scanNested: current.scanNested,
    nestedDepth: current.nestedDepth,
    visibleHiddenCats: current.visibleHiddenCats,
    updateInterval: current.updateInterval,
    autoExtensions: current.autoExtensions,
    newBadgeDays: current.newBadgeDays,
    versionCompareDepth: current.versionCompareDepth,
    startTab: current.startTab,
    defaultSortModes: current.defaultSortModes,
    autoSaveDownloads: current.autoSaveDownloads,
    askSaveDialog: !current.autoSaveDownloads,
    keepOriginalNameIfVersioned: current.keepOriginalNameIfVersioned,
    filenamePattern: current.filenamePattern,
    autoRequestAdminForBatch: current.autoRequestAdminForBatch,
    minimizeToTrayOnClose: current.minimizeToTrayOnClose,
    autostartEnabled: current.autostartEnabled,
    autostartMode: current.autostartMode,
    backgroundCheckEnabled: current.backgroundCheckEnabled,
    backgroundCheckIntervalMinutes: current.backgroundCheckIntervalMinutes,
    notifyOnUpdates: current.notifyOnUpdates,
    autoUpdateEnabled: current.autoUpdateEnabled,
    autoUpdateListType: current.autoUpdateListType,
    autoUpdateEntries: current.autoUpdateEntries,
  };

  const needsRescan =
    initial.archivePaths.join('|') !== current.archivePaths.join('|') ||
    initial.autoExtensions.join(',') !== current.autoExtensions.join(',');

  const initialEnabledSet = new Set(initial.enabledProviders);
  const newlyEnabledProvider = current.enabledProviders.some((id) => !initialEnabledSet.has(id));
  const providersChanged = !areSetsEqual(initial.enabledProviders, current.enabledProviders);
  const vcpkgRootChanged = initial.vcpkgRoot !== current.vcpkgRoot;
  const rescanInstalled = newlyEnabledProvider || (vcpkgRootChanged && current.enabledProviders.includes('vcpkg'));
  const autostartChanged =
    initial.autostartEnabled !== current.autostartEnabled || initial.autostartMode !== current.autostartMode;
  const sortDefaultsChanged =
    initial.defaultSortModes.updates !== current.defaultSortModes.updates ||
    initial.defaultSortModes.installed !== current.defaultSortModes.installed ||
    initial.defaultSortModes.archive !== current.defaultSortModes.archive;
  const backgroundChanged =
    autostartChanged ||
    initial.minimizeToTrayOnClose !== current.minimizeToTrayOnClose ||
    initial.backgroundCheckEnabled !== current.backgroundCheckEnabled ||
    initial.backgroundCheckIntervalMinutes !== current.backgroundCheckIntervalMinutes ||
    initial.notifyOnUpdates !== current.notifyOnUpdates ||
    initial.autoUpdateEnabled !== current.autoUpdateEnabled ||
    initial.autoUpdateListType !== current.autoUpdateListType ||
    JSON.stringify(initial.autoUpdateEntries) !== JSON.stringify(current.autoUpdateEntries);

  const languageChanged = initial.language !== current.language;

  return {
    payload,
    languageChanged,
    needsRescan,
    newlyEnabledProvider,
    providersChanged,
    vcpkgRootChanged,
    rescanInstalled,
    autostartChanged,
    sortDefaultsChanged,
    backgroundChanged,
  };
}
