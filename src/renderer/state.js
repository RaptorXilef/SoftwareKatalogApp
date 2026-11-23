import { buildUnifiedPackages, computeTabCounts, getBaseName, getPackageStatus } from '../shared/unified-packages.js';

export { getBaseName };

let providersInitialized = false;

export const state = {
  catalog: [],
  installedApps: [],
  packages: [],
  bundles: [],
  providers: [],
  settings: {},
  favorites: [],
  availableHiddenCats: [],
  activeTab: 'archive',
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
  discoverQuery: '',
  discoverSelectedProviders: [],
  discoverResults: [],
  discoverByProvider: {},
  discoverHasSearched: false,
  discoverLoading: false,
  isScanningInstalled: false,
  hasScannedInstalled: false,
  pcIconCache: new Map(),
  pcIconTried: new Set(),
  currentModalId: null,
  isEditModalOpen: false,
  hasCheckedAppUpdate: false,
  selectedUpdateIds: new Set(),
  isBatchActionRunning: false,
};

export function rebuildUnifiedPackages() {
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
  });
}

export function getTabCounts() {
  return computeTabCounts(state.packages, {
    visibleHiddenCats: state.settings.visibleHiddenCats || [],
    versionCompareDepth: state.settings.versionCompareDepth ?? 3,
    bundlesCount: state.bundles.length,
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
  return Boolean((item.webSourceType && item.webSourceType !== 'none') || item.wingetId || item.webVersionUrl);
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

export async function refreshProviders() {
  const res = await window.electronAPI.listProviders();
  state.providers = Array.isArray(res?.providers) ? res.providers : [];
  const searchableEnabled = state.providers.filter((p) => p.capabilities?.search && p.enabled).map((p) => p.id);

  if (!providersInitialized) {
    providersInitialized = true;
    state.discoverSelectedProviders = searchableEnabled;
  } else {
    const validIds = new Set(searchableEnabled);
    state.discoverSelectedProviders = state.discoverSelectedProviders.filter((id) => validIds.has(id));
    if (state.discoverSelectedProviders.length === 0 && searchableEnabled.length > 0) {
      state.discoverSelectedProviders = searchableEnabled;
    }
  }
}

export function setInstalledApps(programs) {
  state.installedApps = Array.isArray(programs) ? programs : [];
  state.hasScannedInstalled = true;
  state.isScanningInstalled = false;
  rebuildUnifiedPackages();
}

export async function toggleFavorite(id) {
  const idx = state.favorites.indexOf(id);
  if (idx > -1) state.favorites.splice(idx, 1);
  else state.favorites.push(id);

  await window.electronAPI.saveSettings({ favorites: state.favorites });
}
