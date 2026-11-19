import { compareVersions, extractVersion } from '../shared/version.js';

export const state = {
  catalog: [],
  settings: {},
  favorites: [],
  availableHiddenCats: [],
  activeTag: null,
  searchQuery: '',
  sortMode: 'az',
  filterMode: 'all',
  currentModalId: null,
  isEditModalOpen: false,
  hasCheckedAppUpdate: false,
};

export function getBaseName(filePath) {
  if (!filePath) return '';
  return filePath.split('\\').pop().split('/').pop();
}

export function getItemById(id) {
  return state.catalog.find((i) => i.id === id) || null;
}

/**
 * Ermittelt Status & Versionen für Karte und Detailansicht.
 * Priorität für Kartenfarbe: webupdate (Lila) > update (Orange) > newer (Blau) > installed (Grün) > none
 */
export function getItemStatus(item) {
  const nasVersion = item.lastFiles?.length > 0 ? extractVersion(getBaseName(item.lastFiles[0])) : null;
  const localVersion = item.installedVersion || null;
  const webVersion = item.webVersion || null;
  const depth = state.settings.versionCompareDepth ?? 3;

  const hasWebUpdate = Boolean(webVersion && (!nasVersion || compareVersions(webVersion, nasVersion, depth) > 0));
  const hasNasUpdate = Boolean(
    item.isInstalled && nasVersion && localVersion && compareVersions(nasVersion, localVersion, depth) > 0
  );
  const isPcNewer = Boolean(
    item.isInstalled && nasVersion && localVersion && compareVersions(nasVersion, localVersion, depth) < 0
  );

  let status = 'none';
  if (hasWebUpdate) {
    status = 'webupdate';
  } else if (hasNasUpdate) {
    status = 'update';
  } else if (isPcNewer) {
    status = 'newer';
  } else if (item.isInstalled) {
    status = 'installed';
  }

  return {
    status,
    nasVersion,
    localVersion,
    webVersion,
    hasWebUpdate,
    hasNasUpdate,
    isPcNewer,
  };
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
}

export async function toggleFavorite(id) {
  const idx = state.favorites.indexOf(id);
  if (idx > -1) state.favorites.splice(idx, 1);
  else state.favorites.push(id);

  await window.electronAPI.saveSettings({ favorites: state.favorites });
}
