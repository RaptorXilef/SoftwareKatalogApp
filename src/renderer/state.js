import { createDefaultAccessPolicy, evaluatePackagePolicy, normalizeAccessPolicy } from '../shared/policy-logic.js';
import { filterUsableProviders, isProviderUsableInUi } from '../shared/provider-lifecycle-logic.js';
import { buildUnifiedPackages, computeTabCounts, getBaseName, getPackageStatus } from '../shared/unified-packages.js';

export { getBaseName };

let providersInitialized = false;
const knownUsableSearchProviders = new Set();

export const state = {
  catalog: [],
  installedApps: [],
  packages: [],
  bundles: [],
  ignoredUpdates: [],
  providers: [],
  settings: {},
  favorites: [],
  availableHiddenCats: [],
  activeTab: 'updates',
  originFilters: {
    updates: 'all',
    installed: 'all',
  },
  sortModes: {
    updates: 'updates',
    installed: 'az',
    archive: 'az',
  },
  filterMode: 'all',
  activeTag: null,
  searchQuery: '',
  bundleSearchQuery: '',
  bundleProviderFilter: 'all',
  discoverQuery: '',
  discoverSelectedProviders: [],
  discoverResults: [],
  discoverByProvider: {},
  discoverHasSearched: false,
  discoverLoading: false,
  isCheckingProviders: false,
  isScanningInstalled: false,
  hasScannedInstalled: false,
  installedScanProgress: null,
  lastScanFailedProviders: [],
  pcIconCache: new Map(),
  pcIconTried: new Set(),
  currentModalId: null,
  currentModalKind: null,
  isEditModalOpen: false,
  hasCheckedAppUpdate: false,
  selectedUpdateIds: new Set(),
  isBatchActionRunning: false,
  isBundleInstallRunning: false,
  bundlesIpcUnavailable: false,
  adminSession: {
    mode: 'off',
    isProcessElevated: false,
    isSessionActive: false,
    canUseAdmin: false,
    workerPid: null,
    startedAt: null,
    supported: true,
  },
  adminSessionBusy: false,
  authStatus: {
    enabled: false,
    isAuthenticated: false,
    username: '',
    authenticatedUser: '',
    sessionTimeoutMinutes: 0,
    lastActivityAt: null,
    policyPath: '',
    configuredPolicyPath: '',
    defaultPolicyPath: '',
    pathSource: 'default',
    isHklmLocked: false,
    hklmPolicyPath: '',
    isReadOnlyPolicy: false,
    policyExists: false,
    integrityValid: true,
    integrityWarning: '',
    integrityChecksum: '',
    platformSupportedForHklm: true,
    accessPolicy: createDefaultAccessPolicy(),
  },
};

function rebuildUnifiedPackages() {
  state.packages = buildUnifiedPackages({
    catalogItems: state.catalog,
    installedApps: state.installedApps,
    pcIconCache: state.pcIconCache,
  });
}

export function getItemById(id) {
  return state.packages.find((i) => i.id === id) || state.catalog.find((i) => i.id === id) || null;
}

export function getCatalogItemById(id) {
  return state.catalog.find((i) => i.id === id) || null;
}

/**
 * Ermittelt Status & Versionen für Karte und Detailansicht.
 * Priorität: webupdate (Lila) > update / Archiv-Update (Orange) > newer / PC neuer (Blau) > installed (Grün) > none
 */
export function getItemStatus(item) {
  return getPackageStatus(item, {
    versionCompareDepth: state.settings.versionCompareDepth ?? 3,
    ignoredUpdates: state.ignoredUpdates,
  });
}

export function isProviderUsable(providerId) {
  if (!providerId) return true;
  if (!Array.isArray(state.providers) || state.providers.length === 0) return true;
  const cleanId = String(providerId).trim().toLowerCase();
  const provider = state.providers.find((p) => p.id === cleanId);
  if (!provider) return true;
  return isProviderUsableInUi(provider);
}

export function getUsableProviders({ capability = null, excludeIds = [] } = {}) {
  return filterUsableProviders(state.providers, { capability, excludeIds });
}

function getVisibleTabPackages() {
  return state.packages.filter((item) => {
    if (item.inArchive) return true;
    if (item.origin === 'pc' && item.pcSource !== 'registry' && item.packageManager) {
      return isProviderUsable(item.packageManager);
    }
    return true;
  });
}

export function isAdminAuthenticated() {
  return Boolean(state.authStatus?.enabled && state.authStatus?.isAuthenticated);
}

export function getAccessPolicy() {
  return state.authStatus?.accessPolicy || createDefaultAccessPolicy();
}

/**
 * @param {Record<string, any> | null | undefined} item
 * @param {'update' | 'install' | 'view'} [action]
 */
export function evaluateItemPolicy(item, action = 'view') {
  return evaluatePackagePolicy(item, action, getAccessPolicy(), isAdminAuthenticated());
}

export function isItemVisibleForTab(item, tab = state.activeTab) {
  if (!item) return false;
  if (tab === 'updates') return evaluateItemPolicy(item, 'update').visible;
  if (tab === 'discover') return evaluateItemPolicy(item, 'install').visible;
  return evaluateItemPolicy(item, 'view').visible;
}

export function buildBundleItemPolicyPkg(entry, matchedPkg = null) {
  const src = String(entry?.source || 'archive')
    .trim()
    .toLowerCase();
  const matched = matchedPkg || entry?.matchedPackage || null;
  return {
    id: matched?.id || entry?.refId || entry?.packageId || entry?.key || '',
    archiveItemId: matched?.archiveItemId || (src === 'archive' ? entry?.refId || null : null),
    inArchive: Boolean(src === 'archive' || matched?.inArchive),
    source: src,
    packageManager: matched?.packageManager || (src === 'archive' ? 'archive' : src),
    packageId: entry?.packageId || matched?.packageId || matched?.wingetId || '',
    wingetId: matched?.wingetId || '',
    name: entry?.name || matched?.name || entry?.packageId || entry?.refId || '',
    installMode: entry?.installMode || matched?.installMode || 'interactive',
    adwareProtected: Boolean(entry?.adwareProtected),
  };
}

function findMatchedPackageForBundlePolicy(entry) {
  const refId = String(entry?.refId || '').trim();
  const pkgIdLower = String(entry?.packageId || '')
    .trim()
    .toLowerCase();
  const src = String(entry?.source || 'archive')
    .trim()
    .toLowerCase();
  if (src === 'archive') {
    if (refId) {
      const direct = state.packages.find((p) => p.inArchive && (p.id === refId || p.archiveItemId === refId));
      if (direct) return direct;
    }
    if (pkgIdLower) {
      return (
        state.packages.find(
          (p) =>
            p.inArchive &&
            String(p.packageId || p.wingetId || '')
              .trim()
              .toLowerCase() === pkgIdLower
        ) || null
      );
    }
    return null;
  }
  if (!pkgIdLower) return null;
  return (
    state.packages.find((p) => {
      const pId = String(p.packageId || p.wingetId || '')
        .trim()
        .toLowerCase();
      const pPm = String(p.packageManager || (p.wingetId ? 'winget' : ''))
        .trim()
        .toLowerCase();
      return pId === pkgIdLower && (!pPm || pPm === src);
    }) || null
  );
}

export function getVisibleBundleItems(bundle) {
  const rawItems = Array.isArray(bundle?.items) ? bundle.items : [];
  return rawItems.filter((entry) => {
    const matched = findMatchedPackageForBundlePolicy(entry);
    return evaluateItemPolicy(buildBundleItemPolicyPkg(entry, matched), 'view').visible;
  });
}

export function getVisibleBundles() {
  return (state.bundles || []).filter((b) => {
    const items = Array.isArray(b?.items) ? b.items : [];
    if (items.length === 0) return true;
    return getVisibleBundleItems(b).length > 0;
  });
}

export function getTabCounts() {
  return computeTabCounts(getVisibleTabPackages(), {
    visibleHiddenCats: state.settings.visibleHiddenCats || [],
    versionCompareDepth: state.settings.versionCompareDepth ?? 3,
    bundlesCount: getVisibleBundles().length,
    ignoredUpdates: state.ignoredUpdates,
    accessPolicy: getAccessPolicy(),
    isAdmin: isAdminAuthenticated(),
  });
}

export function getActiveSortMode() {
  return state.sortModes[state.activeTab] || 'az';
}

export function setActiveSortMode(mode) {
  if (state.activeTab in state.sortModes) {
    state.sortModes[state.activeTab] = mode;
  }
}

export function getActiveOriginFilter() {
  return state.originFilters[state.activeTab] || 'all';
}

export function setActiveOriginFilter(filter) {
  if (state.activeTab in state.originFilters) {
    state.originFilters[state.activeTab] = filter;
  }
}

export function isItemNew(item) {
  const days = state.settings.newBadgeDays ?? 14;
  if (days <= 0) return false;
  const ts = item.updatedAt || item.addedAt || 0;
  return ts > 0 && Date.now() - ts < days * 24 * 60 * 60 * 1000;
}

export function hasOnlineSource(item) {
  const pm = String(item.packageManager || '')
    .trim()
    .toLowerCase();
  const hasProviderLink = Boolean(pm && pm !== 'archive' && item.packageId);
  return Boolean(
    (item.webSourceType && item.webSourceType !== 'none') || item.wingetId || item.webVersionUrl || hasProviderLink
  );
}

export function hasAnyLocalPath(item) {
  return Boolean(item.autoPaths?.length > 0 || item.installPaths?.length > 0);
}

export async function refreshCatalogData() {
  const [catalogData, settingsData] = await Promise.all([
    window.electronAPI.loadCatalog(),
    window.electronAPI.getSettings(),
  ]);

  state.settings = settingsData || {};
  state.favorites = Array.isArray(state.settings.favorites) ? [...state.settings.favorites] : [];

  state.catalog = (catalogData || []).map((item) => {
    const tags = [];
    if (item.mainCategory) tags.push(item.mainCategory);
    if (item.subCategories?.length) tags.push(...item.subCategories);
    return { ...item, tags };
  });

  state.availableHiddenCats = [...new Set(state.catalog.map((i) => i.hiddenCategory).filter(Boolean))];
  rebuildUnifiedPackages();
}

export async function refreshProviders({ checkAvailability = false } = {}) {
  let res;
  if (checkAvailability && typeof window.electronAPI?.checkAllProvidersAvailability === 'function') {
    res = await window.electronAPI.checkAllProvidersAvailability();
  } else {
    res = await window.electronAPI.listProviders();
  }

  state.providers = Array.isArray(res?.providers) ? res.providers : [];
  const searchableUsable = filterUsableProviders(state.providers, { capability: 'search' }).map((p) => p.id);
  const usableSet = new Set(searchableUsable);

  if (!providersInitialized) {
    providersInitialized = true;
    state.discoverSelectedProviders = searchableUsable;
    for (const id of searchableUsable) knownUsableSearchProviders.add(id);
  } else {
    state.discoverSelectedProviders = state.discoverSelectedProviders.filter((id) => usableSet.has(id));
    for (const id of searchableUsable) {
      if (!knownUsableSearchProviders.has(id)) {
        knownUsableSearchProviders.add(id);
        if (!state.discoverSelectedProviders.includes(id)) {
          state.discoverSelectedProviders.push(id);
        }
      }
    }
    if (state.discoverSelectedProviders.length === 0 && searchableUsable.length > 0) {
      state.discoverSelectedProviders = searchableUsable;
    }
  }

  if (Array.isArray(state.discoverResults) && state.discoverResults.length > 0) {
    state.discoverResults = state.discoverResults.filter((pkg) => {
      const pid = String(pkg.providerId || pkg.packageManager || '').toLowerCase();
      return !pid || usableSet.has(pid);
    });
  }
  if (state.discoverByProvider && typeof state.discoverByProvider === 'object') {
    const nextByProvider = {};
    for (const [id, entry] of Object.entries(state.discoverByProvider)) {
      if (usableSet.has(id.toLowerCase())) {
        nextByProvider[id] = entry;
      }
    }
    state.discoverByProvider = nextByProvider;
  }
}

export function setInstalledApps(programs) {
  state.installedApps = Array.isArray(programs) ? programs : [];
  state.hasScannedInstalled = true;
  state.isScanningInstalled = false;
  state.pcIconTried.clear();
  rebuildUnifiedPackages();
}

export async function toggleFavorite(id) {
  const idx = state.favorites.indexOf(id);
  if (idx > -1) state.favorites.splice(idx, 1);
  else state.favorites.push(id);

  if (typeof window.electronAPI?.saveFavorites === 'function') {
    await window.electronAPI.saveFavorites(state.favorites);
  } else {
    await window.electronAPI.saveSettings({ favorites: state.favorites });
  }
}

export function applyAuthStatus(status) {
  if (!status || typeof status !== 'object') return state.authStatus;
  state.authStatus = {
    ...state.authStatus,
    ...status,
    enabled: Boolean(status.enabled),
    isAuthenticated: Boolean(status.isAuthenticated),
    isHklmLocked: Boolean(status.isHklmLocked),
    isReadOnlyPolicy: Boolean(status.isReadOnlyPolicy),
    policyExists: Boolean(status.policyExists),
    integrityValid: status.integrityValid !== false,
    platformSupportedForHklm: status.platformSupportedForHklm !== false,
    accessPolicy: normalizeAccessPolicy(status.accessPolicy),
  };
  return state.authStatus;
}

export async function refreshAuthStatus() {
  if (typeof window.electronAPI?.getAuthStatus !== 'function') {
    return state.authStatus;
  }
  try {
    const status = await window.electronAPI.getAuthStatus();
    return applyAuthStatus(status);
  } catch {
    return state.authStatus;
  }
}

export async function refreshBundles() {
  if (typeof window.electronAPI?.loadBundles !== 'function') {
    state.bundlesIpcUnavailable = true;
    state.bundles = [];
    console.warn('Bündel-API nicht verfügbar - bitte Electron-App bzw. Dev-Server einmal neu starten.');
    return;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await window.electronAPI.loadBundles();
      state.bundlesIpcUnavailable = false;
      if (res?.success === false && res.error) {
        console.error('Fehler beim Laden der Bündel:', res.error);
      }
      state.bundles = Array.isArray(res?.bundles) ? res.bundles : [];
      return;
    } catch (err) {
      const msg = String(err?.message || err || '');
      if (/No handler registered/i.test(msg)) {
        if (attempt === 0) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          continue;
        }
        state.bundlesIpcUnavailable = true;
        console.warn('Bündel-IPC-Handler noch nicht geladen - bitte Electron-App / npm run dev einmal neu starten.');
      } else {
        state.bundlesIpcUnavailable = false;
        console.error('Fehler beim Laden der Bündel:', err);
      }
      state.bundles = [];
      return;
    }
  }
}

export async function refreshIgnoredUpdates() {
  if (typeof window.electronAPI?.loadIgnoredUpdates !== 'function') {
    state.ignoredUpdates = [];
    return;
  }
  try {
    const res = await window.electronAPI.loadIgnoredUpdates();
    if (res?.success === false && res.error) {
      console.error('Fehler beim Laden der Ignorierliste:', res.error);
    }
    state.ignoredUpdates = Array.isArray(res?.entries) ? res.entries : [];
  } catch (err) {
    console.error('Fehler beim Laden der Ignorierliste:', err);
    state.ignoredUpdates = [];
  }
}
