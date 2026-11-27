import { getInstallModeBadge } from '../../shared/installer-logic.js';
import { formatScanProgressBanner, formatSourceNameList } from '../../shared/scan-progress-logic.js';
import { scoreCatalogItem } from '../../shared/search.js';
import { canDownloadOnline, isPackageVisible, matchesProviderFilter } from '../../shared/unified-packages.js';
import { compareVersions } from '../../shared/version.js';
import {
  evaluateItemPolicy,
  getActiveOriginFilter,
  getActiveSortMode,
  getItemStatus,
  hasAnyLocalPath,
  hasOnlineSource,
  isItemNew,
  isItemVisibleForTab,
  isProviderUsable,
  state,
} from '../state.js';
import { getI18nLocale, getLocalizedProviderBadge, t } from '../utils/i18n.js';
import { escapeHTML, toMediaUrl } from '../utils/sanitize.js';
import { updateNavCounts } from './toolbar.js';

function getStatusMeta(status) {
  if (status === 'webupdate') {
    return { label: t('cards.statusWebUpdate'), title: t('cards.statusWebUpdateTitle') };
  }
  if (status === 'update') {
    return { label: t('cards.statusArchiveUpdate'), title: t('cards.statusArchiveUpdateTitle') };
  }
  if (status === 'installed') {
    return { label: t('cards.statusInstalled'), title: t('cards.statusInstalledTitle') };
  }
  if (status === 'newer') {
    return { label: t('cards.statusNewer'), title: t('cards.statusNewerTitle') };
  }
  return null;
}

const iconQueue = [];
const queuedIconIds = new Set();
let activeIconJobs = 0;
const MAX_ICON_JOBS = 4;

function createCardIconImg(iconPath, cls = 'card-icon') {
  const img = document.createElement('img');
  img.className = cls;
  img.src = toMediaUrl(iconPath);
  if (cls === 'card-icon') {
    img.loading = 'lazy';
    img.decoding = 'async';
  }
  img.alt = '';
  return img;
}

function updateCardIconInDom(itemId, iconPath) {
  const grid = document.getElementById('grid');
  if (grid) {
    for (const card of grid.querySelectorAll('.card')) {
      if (!(card instanceof HTMLElement) || card.dataset.id !== itemId) continue;
      const fallback = card.querySelector('.card-icon-fallback');
      if (!fallback) continue;
      fallback.replaceWith(createCardIconImg(iconPath, 'card-icon'));
    }
  }

  const bundlesView = document.getElementById('bundlesView');
  if (bundlesView) {
    for (const slot of bundlesView.querySelectorAll('[data-icon-item-id]')) {
      if (!(slot instanceof HTMLElement) || slot.dataset.iconItemId !== itemId) continue;
      slot.replaceWith(createCardIconImg(iconPath, 'bundle-item-icon'));
    }
  }

  if (state.currentModalId === itemId) {
    const detailFallback = document.querySelector('#modalContent .detail-icon-fallback');
    if (detailFallback) {
      detailFallback.replaceWith(createCardIconImg(iconPath, 'detail-icon'));
    }
  }

  const modalEl = document.getElementById('modalContent');
  if (modalEl) {
    for (const slot of modalEl.querySelectorAll('[data-icon-item-id]')) {
      if (!(slot instanceof HTMLElement) || slot.dataset.iconItemId !== itemId) continue;
      slot.replaceWith(createCardIconImg(iconPath, 'bundle-item-icon'));
    }
  }
}

function getExecutableCandidateForItem(item) {
  if (item.validInstallPath) return item.validInstallPath;
  if (Array.isArray(item.autoPaths) && item.autoPaths.length > 0) return item.autoPaths[0];
  if (Array.isArray(item.installPaths) && item.installPaths.length > 0) return item.installPaths[0];
  return '';
}

function hasAnyIconSourceCandidate(item) {
  return Boolean(
    item.displayIcon ||
      item.installLocation ||
      item.validInstallPath ||
      item.autoPaths?.length ||
      item.installPaths?.length ||
      item.uninstallString ||
      item.packageId ||
      item.wingetId ||
      item.appxPackageFamilyName ||
      item.homepage ||
      item.packageManager ||
      item.webVersionUrl ||
      item.links?.length ||
      item.isInstalled
  );
}

function pumpIconQueue() {
  while (activeIconJobs < MAX_ICON_JOBS && iconQueue.length > 0) {
    const item = iconQueue.shift();
    if (!item) continue;
    queuedIconIds.delete(item.id);
    if (state.pcIconCache.has(item.id) || item.icon) continue;
    activeIconJobs++;
    window.electronAPI
      .extractCachedAppIcon({
        id: item.id,
        name: item.name || '',
        displayIcon: item.displayIcon || '',
        installLocation: item.installLocation || '',
        executablePath: getExecutableCandidateForItem(item),
        uninstallString: item.uninstallString || '',
        packageManager: item.packageManager || (item.wingetId ? 'winget' : ''),
        packageId: item.packageId || item.wingetId || '',
        appxPackageFamilyName: item.appxPackageFamilyName || '',
        homepage: item.homepage || '',
        webVersionUrl: item.webVersionUrl || '',
        links: Array.isArray(item.links) ? item.links : [],
      })
      .then((res) => {
        if (res?.success && res.iconPath) {
          state.pcIconCache.set(item.id, res.iconPath);
          if (item.pcApp?.id) {
            state.pcIconCache.set(item.pcApp.id, res.iconPath);
          }
          item.icon = res.iconPath;
          updateCardIconInDom(item.id, res.iconPath);
        }
      })
      .catch(() => {
        // Fallback-Icon bleibt stehen
      })
      .finally(() => {
        activeIconJobs--;
        pumpIconQueue();
      });
  }
}

/**
 * Reiht sichtbare Pakete/Karten fuer die gedrosselte Hintergrund-Icon-Aufloesung ein
 * und aktualisiert vorhandene Karten sofort live im DOM.
 * @param {Array<Record<string, any>>} items
 * @param {{ prioritize?: boolean }} [options]
 */
export function queueItemsForIconResolution(items, { prioritize = true } = {}) {
  const toPrepend = [];
  for (const item of items || []) {
    if (!item?.id) continue;
    const cachedPath =
      item.icon ||
      state.pcIconCache.get(item.id) ||
      (item.pcApp?.id ? state.pcIconCache.get(item.pcApp.id) : null) ||
      null;
    if (cachedPath) {
      item.icon = cachedPath;
      updateCardIconInDom(item.id, cachedPath);
      continue;
    }
    if (state.pcIconTried.has(item.id) || queuedIconIds.has(item.id)) continue;
    if (!hasAnyIconSourceCandidate(item)) continue;
    state.pcIconTried.add(item.id);
    queuedIconIds.add(item.id);
    if (prioritize) {
      toPrepend.push(item);
    } else {
      iconQueue.push(item);
    }
  }
  if (toPrepend.length > 0) {
    iconQueue.unshift(...toPrepend);
  }
  pumpIconQueue();
}

function queuePcIconExtraction(entries) {
  queueItemsForIconResolution(
    (entries || []).map((e) => e.item),
    { prioritize: true }
  );
}

function isProviderItemVisible(item) {
  if (item.inArchive) return true;
  if (item.origin === 'pc' && item.pcSource !== 'registry' && item.packageManager) {
    return isProviderUsable(item.packageManager);
  }
  return true;
}

function matchesTabAndFilter(item, st) {
  const tab = state.activeTab;

  if (!isItemVisibleForTab(item, tab)) return false;

  if (tab === 'updates') {
    if (!isProviderItemVisible(item)) return false;
    if (item.origin === 'pc' && item.packageManager && !isProviderUsable(item.packageManager)) return false;
    if (!st.hasVisibleUpdate) return false;
    const originFilter = getActiveOriginFilter();
    if (!['all', 'in-archive', 'not-in-archive'].includes(originFilter) && !isProviderUsable(originFilter)) {
      return false;
    }
    return matchesProviderFilter(item, originFilter);
  }

  if (tab === 'installed') {
    if (!isProviderItemVisible(item)) return false;
    if (!item.isInstalled) return false;
    const originFilter = getActiveOriginFilter();
    if (!['all', 'in-archive', 'not-in-archive'].includes(originFilter) && !isProviderUsable(originFilter)) {
      return false;
    }
    return matchesProviderFilter(item, originFilter);
  }

  // Archiv-Tab
  if (!item.inArchive) return false;
  if (state.activeTag && !item.tags.includes(state.activeTag)) return false;

  if (state.filterMode === 'any-update' && !st.hasWebUpdate && !st.hasArchiveUpdate) return false;
  if (state.filterMode === 'webupdate' && !st.hasWebUpdate) return false;
  if (state.filterMode === 'archiveupdate' && !st.hasArchiveUpdate) return false;
  if (state.filterMode === 'installed' && !item.isInstalled) return false;
  if (state.filterMode === 'missing-path') {
    const isStandard = !item.softwareType || item.softwareType === 'default';
    if (!isStandard || hasAnyLocalPath(item)) return false;
  }
  if (state.filterMode === 'missing-web' && hasOnlineSource(item)) return false;

  return true;
}

function getTabBaseCount(visibleHidden) {
  let count = 0;
  for (const item of state.packages) {
    if (!isPackageVisible(item, visibleHidden)) continue;
    if (!isProviderItemVisible(item)) continue;
    if (!isItemVisibleForTab(item, state.activeTab)) continue;
    const st = getItemStatus(item);
    if (
      state.activeTab === 'updates' &&
      !(item.origin === 'pc' && item.packageManager && !isProviderUsable(item.packageManager)) &&
      st.hasVisibleUpdate
    ) {
      count++;
    } else if (state.activeTab === 'installed' && item.isInstalled) count++;
    else if (state.activeTab === 'archive' && item.inArchive) count++;
  }
  return count;
}

function getFilteredAndSortedEntries() {
  const hasSearch = state.searchQuery.trim().length > 0;
  const visibleHidden = state.settings.visibleHiddenCats || [];
  const depth = state.settings.versionCompareDepth ?? 3;
  const sortMode = getActiveSortMode();

  const entries = [];

  for (const item of state.packages) {
    if (!isPackageVisible(item, visibleHidden)) continue;

    const st = getItemStatus(item);
    if (!matchesTabAndFilter(item, st)) continue;

    const search = scoreCatalogItem(item, state.searchQuery);
    if (!search.matched) continue;

    entries.push({ item, st, search });
  }

  entries.sort((a, b) => {
    // Bei aktiver Suche hat Relevanz (Kerntreffer + Score) immer oberste Priorität!
    if (hasSearch) {
      if (a.search.isCoreMatch !== b.search.isCoreMatch) {
        return a.search.isCoreMatch ? -1 : 1;
      }
      if (b.search.score !== a.search.score) {
        return b.search.score - a.search.score;
      }
    }

    if (state.activeTab === 'archive') {
      const aFav = state.favorites.includes(a.item.id);
      const bFav = state.favorites.includes(b.item.id);
      if (aFav !== bFav) return aFav ? -1 : 1;
    }

    if (sortMode === 'updates') {
      const rank = (s) => (s.hasWebUpdate ? 2 : s.hasArchiveUpdate ? 1 : 0);
      const diff = rank(b.st) - rank(a.st);
      if (diff !== 0) return diff;
    } else if (sortMode === 'webarchive') {
      if (a.st.hasWebUpdate !== b.st.hasWebUpdate) return a.st.hasWebUpdate ? -1 : 1;
    } else if (sortMode === 'update') {
      if (a.st.hasArchiveUpdate !== b.st.hasArchiveUpdate) return a.st.hasArchiveUpdate ? -1 : 1;
    } else if (sortMode === 'installed') {
      if (a.item.isInstalled !== b.item.isInstalled) return a.item.isInstalled ? -1 : 1;
    } else if (sortMode === 'newest') {
      return (b.item.addedAt || 0) - (a.item.addedAt || 0);
    } else if (sortMode === 'updated') {
      return (b.item.updatedAt || 0) - (a.item.updatedAt || 0);
    }

    if (sortMode === 'webarchive' && a.st.webVersion && b.st.webVersion) {
      const cmp = compareVersions(b.st.webVersion, a.st.webVersion, depth);
      if (cmp !== 0) return cmp;
    }
    return a.item.name.localeCompare(b.item.name, getI18nLocale() || 'en', { sensitivity: 'base', numeric: true });
  });

  return { entries, hasSearch };
}

function renderVersionStrip(item, st) {
  if (!st.localVersion && !st.archiveVersion && !st.webVersion) return '';

  const pcClass = st.isPcNewer
    ? 'is-newer'
    : st.localVersion && !st.hasArchiveUpdate && !(item.origin === 'pc' && st.hasWebUpdate)
      ? 'is-ok'
      : '';
  const archiveClass = st.hasArchiveUpdate ? 'is-highlight-archive' : '';
  const webClass = st.hasWebUpdate ? 'is-highlight-web' : '';

  return `
    <div class="card-versions">
      <div class="ver-slot ${pcClass}" title="${escapeHTML(t('cards.slotPcTitle'))}">
        <span class="ver-lbl">${escapeHTML(t('cards.slotPc'))}</span>
        <span class="ver-val">${st.localVersion ? escapeHTML(st.localVersion) : '-'}</span>
      </div>
      <div class="ver-slot ${archiveClass}" title="${escapeHTML(t('cards.slotArchiveTitle'))}">
        <span class="ver-lbl">${escapeHTML(t('cards.slotArchive'))}</span>
        <span class="ver-val">${st.archiveVersion ? escapeHTML(st.archiveVersion) : '-'}</span>
      </div>
      <div class="ver-slot ${webClass}" title="${escapeHTML(t('cards.slotWebTitle'))}">
        <span class="ver-lbl">${escapeHTML(t('cards.slotWeb'))}</span>
        <span class="ver-val">${st.webVersion ? escapeHTML(st.webVersion) : '-'}</span>
      </div>
    </div>
  `;
}

function renderCardHtml(item, st) {
  const isFav = item.inArchive && state.favorites.includes(item.id);
  const statusCfg = getStatusMeta(st.status);
  const isUpdatesTab = state.activeTab === 'updates';
  const isSelected = isUpdatesTab && state.selectedUpdateIds.has(item.id);

  let secondaryTag = '';
  if (item.packageManager === 'nvm' && item.isActive) {
    secondaryTag = `<span class="card-chip chip-install-silent" title="${escapeHTML(t('cards.chipActiveTitle'))}">⚡ ${escapeHTML(t('cards.chipActive'))}</span>`;
  } else if (item.inArchive && isItemNew(item)) {
    secondaryTag = `<span class="card-chip chip-new">${escapeHTML(t('cards.chipNew'))}</span>`;
  } else if (item.softwareType === 'portable') {
    secondaryTag = `<span class="card-chip">${escapeHTML(t('cards.chipPortable'))}</span>`;
  } else if (item.softwareType === 'driver') {
    secondaryTag = `<span class="card-chip">${escapeHTML(t('cards.chipDriver'))}</span>`;
  }

  let originTag = '';
  let providerTag = '';
  if (state.activeTab !== 'archive') {
    originTag = item.inArchive
      ? `<span class="card-chip chip-origin-archive" title="${escapeHTML(t('cards.chipOriginArchiveTitle'))}">${escapeHTML(t('cards.chipOriginArchive'))}</span>`
      : `<span class="card-chip chip-origin-pc" title="${escapeHTML(t('cards.chipOriginPcTitle'))}">${escapeHTML(t('cards.chipOriginPc'))}</span>`;

    const providerBadge = getLocalizedProviderBadge(item.packageManager, state.providers);
    if (providerBadge) {
      providerTag = `<span class="provider-badge ${escapeHTML(providerBadge.badgeClass)}">${escapeHTML(providerBadge.label)}</span>`;
    }
  }

  let installModeTag = '';
  if (isUpdatesTab && item.inArchive) {
    const badge = getInstallModeBadge(item);
    if (badge) {
      const cls = badge.type === 'protected' ? 'chip-install-protected' : 'chip-install-silent';
      const label =
        badge.type === 'protected' ? `🛡️ ${t('cards.chipInstallProtected')}` : `⚡ ${t('cards.chipInstallSilent')}`;
      const title =
        badge.type === 'protected'
          ? t('cards.chipInstallProtectedTitle')
          : t('cards.chipInstallSilentTitle', { args: String(item.silentArgs || '').trim() });
      installModeTag = `<span class="card-chip ${cls}" title="${escapeHTML(title)}">${escapeHTML(label)}</span>`;
    }
  }

  const iconHtml = item.icon
    ? `<img class="card-icon" src="${escapeHTML(toMediaUrl(item.icon))}" loading="lazy" decoding="async" alt="">`
    : `<div class="card-icon-fallback">${item.origin === 'pc' ? '💻' : '📦'}</div>`;

  const favBtnHtml = item.inArchive
    ? `<button type="button" class="fav-btn ${isFav ? 'active' : ''}" data-fav-id="${escapeHTML(item.id)}" title="${escapeHTML(t('cards.favToggleTitle'))}" aria-label="${escapeHTML(t('cards.favAria'))}">★</button>`
    : item.origin === 'pc'
      ? `<button type="button" class="card-archive-btn" data-card-archive-id="${escapeHTML(item.id)}" title="${escapeHTML(t('cards.addToArchiveTitle'))}" aria-label="${escapeHTML(t('cards.addToArchiveAria'))}">📥</button>`
      : '';

  const selectHtml = isUpdatesTab
    ? `<label class="card-select-wrap" title="${escapeHTML(t('cards.selectForBatchTitle'))}"><input type="checkbox" class="card-select-checkbox" data-select-update-id="${escapeHTML(item.id)}" ${isSelected ? 'checked' : ''}></label>`
    : '';

  const subtitle = item.inArchive
    ? item.tags.slice(0, 3).join(' · ')
    : [item.publisher, item.packageId].filter(Boolean).join(' · ') || t('cards.windowsInstallation');

  return `
    <article class="card status-${st.status} ${isSelected ? 'is-selected' : ''}" data-id="${escapeHTML(item.id)}">
      <div class="card-top">
        <div class="card-badges">
          ${selectHtml}
          ${statusCfg ? `<span class="status-pill is-${st.status}" title="${escapeHTML(statusCfg.title)}">${escapeHTML(statusCfg.label)}</span>` : ''}
          ${providerTag}
          ${originTag}
          ${installModeTag}
          ${secondaryTag}
        </div>
        ${favBtnHtml}
      </div>

      <div class="card-body">
        ${iconHtml}
        <h3 class="card-title">${escapeHTML(item.name)}</h3>
        <p class="card-tags">${escapeHTML(subtitle)}</p>
      </div>

      ${renderVersionStrip(item, st)}
    </article>
  `;
}

function renderEmptyState() {
  if (state.activeTab === 'updates') {
    if ((state.isScanningInstalled || state.isCheckingProviders) && !state.hasScannedInstalled) {
      return `
        <div class="empty-state">
          <h3>${escapeHTML(t('empty.updatesScanningTitle'))}</h3>
          <p>${escapeHTML(t('empty.updatesScanningDesc'))}</p>
        </div>
      `;
    }
    const ignoredCount = state.ignoredUpdates.length;
    const ignoredNote =
      ignoredCount > 0
        ? `<p class="muted">${escapeHTML(t('empty.updatesIgnoredNotePrefix', { count: ignoredCount }))}<strong>🙈 ${escapeHTML(t('empty.updatesIgnoredNoteButton', { count: ignoredCount }))}</strong>${escapeHTML(t('empty.updatesIgnoredNoteSuffix'))}</p>`
        : '';
    return `
      <div class="empty-state">
        <h3>${escapeHTML(t('empty.updatesNoneTitle'))}</h3>
        <p>${escapeHTML(t('empty.updatesNoneDescPrefix'))}<strong>🌐 ${escapeHTML(t('toolbar.checkOnline'))}</strong>${escapeHTML(t('empty.updatesNoneDescMid'))}<strong>💻 ${escapeHTML(t('toolbar.checkLocal'))}</strong>${escapeHTML(t('empty.updatesNoneDescSuffix'))}</p>
        ${ignoredNote}
      </div>
    `;
  }

  if (state.activeTab === 'installed') {
    if ((state.isScanningInstalled || state.isCheckingProviders) && !state.hasScannedInstalled) {
      return `
        <div class="empty-state">
          <h3>${escapeHTML(t('empty.installedScanningTitle'))}</h3>
          <p>${escapeHTML(t('empty.installedScanningDesc'))}</p>
        </div>
      `;
    }
    return `
      <div class="empty-state">
        <h3>${escapeHTML(t('empty.installedNoneTitle'))}</h3>
        <p>${escapeHTML(t('empty.installedNoneDescPrefix'))}<strong>💻 ${escapeHTML(t('toolbar.checkLocal'))}</strong>${escapeHTML(t('empty.installedNoneDescSuffix'))}</p>
      </div>
    `;
  }

  if (state.catalog.length === 0) {
    return `
      <div class="empty-state">
        <h3>${escapeHTML(t('empty.archiveEmptyTitle'))}</h3>
        <p>${escapeHTML(t('empty.archiveEmptyDescPrefix'))}<strong>🔄 ${escapeHTML(t('toolbar.checkArchive'))}</strong>${escapeHTML(t('empty.archiveEmptyDescSuffix'))}</p>
      </div>
    `;
  }

  return `
    <div class="empty-state">
      <h3>${escapeHTML(t('empty.noMatchesTitle'))}</h3>
      <p>${escapeHTML(t('empty.noMatchesDesc'))}</p>
    </div>
  `;
}

export function getPendingArchiveWebUpdateItems() {
  const visibleHidden = state.settings.visibleHiddenCats || [];
  const items = [];
  for (const item of state.packages) {
    if (!item.inArchive) continue;
    if (!isPackageVisible(item, visibleHidden)) continue;
    if (!isItemVisibleForTab(item, 'updates')) continue;
    const st = getItemStatus(item);
    if (st.hasWebUpdate && !st.isIgnoredUpdate && canDownloadOnline(item)) {
      items.push(item);
    }
  }
  return items;
}

export function getVisibleUpdateEntries() {
  if (state.activeTab !== 'updates') return [];
  return getFilteredAndSortedEntries().entries;
}

export function renderUpdatesBatchBar(entries = null) {
  const bar = document.getElementById('updatesBatchBar');
  if (!bar) return;

  if (state.activeTab !== 'updates') {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }

  const activeEntries = entries ?? getVisibleUpdateEntries();
  const visibleIds = new Set(activeEntries.map((e) => e.item.id));
  for (const id of [...state.selectedUpdateIds]) {
    if (!visibleIds.has(id)) state.selectedUpdateIds.delete(id);
  }

  const selectedCount = state.selectedUpdateIds.size;
  const totalCount = activeEntries.length;
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  const someSelected = selectedCount > 0 && selectedCount < totalCount;
  const pendingArchiveDownloads = getPendingArchiveWebUpdateItems().length;
  const ignoredCount = state.ignoredUpdates.length;
  const disabledAttr = state.isBatchActionRunning ? 'disabled' : '';

  const modeSourceEntries =
    selectedCount > 0 ? activeEntries.filter((e) => state.selectedUpdateIds.has(e.item.id)) : activeEntries;
  let silentCount = 0;
  let protectedCount = 0;
  let policySilentOnlyCount = 0;
  let adwareConflictCount = 0;

  for (const { item } of modeSourceEntries) {
    const policyEval = evaluateItemPolicy(item, 'update');
    if (policyEval.silentOnly) policySilentOnlyCount++;
    if (policyEval.adwareConflict) adwareConflictCount++;
    if (!item.inArchive) continue;
    const badge = getInstallModeBadge(item);
    if (badge?.type === 'silent') silentCount++;
    else if (badge?.type === 'protected') protectedCount++;
  }

  const allSilentOnly = modeSourceEntries.length > 0 && policySilentOnlyCount === modeSourceEntries.length;
  const anySilentOnly =
    activeEntries.length > 0 && activeEntries.every(({ item }) => evaluateItemPolicy(item, 'update').silentOnly);

  const modePills = [];
  if (anySilentOnly) {
    modePills.push(
      `<span class="batch-mode-pill is-silent" title="${escapeHTML(t('batch.policySilentOnlyTitle'))}">🔒 ${escapeHTML(t('batch.policySilentOnly'))}</span>`
    );
  }
  if (silentCount > 0) {
    modePills.push(
      `<span class="batch-mode-pill is-silent" title="${escapeHTML(t('batch.pillSilentTitle'))}">⚡ ${escapeHTML(t('batch.pillSilent', { count: silentCount }))}</span>`
    );
  }
  if (protectedCount > 0) {
    modePills.push(
      `<span class="batch-mode-pill is-protected" title="${escapeHTML(t('batch.pillProtectedTitle'))}">🛡️ ${escapeHTML(t('batch.pillProtected', { count: protectedCount }))}</span>`
    );
  }
  if (adwareConflictCount > 0) {
    modePills.push(
      `<span class="batch-mode-pill is-protected" title="${escapeHTML(t('batch.pillAdwareConflictTitle'))}">🚫 ${escapeHTML(t('batch.pillAdwareConflict', { count: adwareConflictCount }))}</span>`
    );
  }
  const modePillsHtml = modePills.length > 0 ? `<div class="batch-mode-pills">${modePills.join('')}</div>` : '';

  const standardAllBtnHtml = anySilentOnly
    ? ''
    : `<button type="button" class="btn btn-primary" id="btnUpdateAllStandard" ${totalCount === 0 || state.isBatchActionRunning ? 'disabled' : ''}>
        ⬆️ ${escapeHTML(t('batch.updateAll'))} <span class="btn-count-badge">${totalCount}</span>
      </button>`;
  const silentAllBtnCls = anySilentOnly ? 'btn-primary' : 'btn-local';
  const selectedBtnLabel = allSilentOnly ? `⚡ ${t('batch.updateSelectedSilent')}` : `⬆️ ${t('batch.updateSelected')}`;

  bar.hidden = false;
  bar.innerHTML = `
    <div class="batch-bar-left">
      <label class="batch-select-all">
        <input type="checkbox" id="chkSelectAllUpdates" ${allSelected ? 'checked' : ''} ${totalCount === 0 || state.isBatchActionRunning ? 'disabled' : ''}>
        <span>${escapeHTML(t('batch.selectAll'))}</span>
      </label>
      <span class="batch-selected-count">${escapeHTML(t('batch.selectedOfTotal', { selected: selectedCount, total: totalCount }))}</span>
      ${modePillsHtml}
    </div>
    <div class="batch-bar-right">
      <button type="button" class="btn btn-ghost btn-ignored-list" id="btnOpenIgnoreList" title="${escapeHTML(t('batch.ignoredButtonTitle'))}">
        🙈 ${escapeHTML(t('batch.ignoredButton', { count: ignoredCount }))}
      </button>
      <button type="button" class="btn btn-online" id="btnBatchDownloadArchive" ${pendingArchiveDownloads === 0 || state.isBatchActionRunning ? 'disabled' : ''}>
        ⬇️ ${escapeHTML(t('batch.downloadOnlineToArchive'))} <span class="btn-count-badge">${pendingArchiveDownloads}</span>
      </button>
      ${standardAllBtnHtml}
      <button type="button" class="btn ${silentAllBtnCls}" id="btnUpdateAllSilent" ${totalCount === 0 || state.isBatchActionRunning ? 'disabled' : ''}>
        ⚡ ${escapeHTML(t('batch.updateAllSilent'))} <span class="btn-count-badge">${totalCount}</span>
      </button>
      <button type="button" class="btn btn-ghost" id="btnBatchUpdateSelected" ${selectedCount === 0 ? 'disabled' : disabledAttr}>
        ${escapeHTML(selectedBtnLabel)} <span class="btn-count-badge">${selectedCount}</span>
      </button>
    </div>
  `;

  const chkAll = bar.querySelector('#chkSelectAllUpdates');
  if (chkAll instanceof HTMLInputElement) {
    chkAll.indeterminate = someSelected;
  }
}

export function renderScanProgressBanner() {
  const host = document.getElementById('scanProgressBanner');
  if (!host) return;

  if (state.activeTab !== 'updates' && state.activeTab !== 'installed') {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }

  let banner = formatScanProgressBanner(state.installedScanProgress, {
    tab: state.activeTab,
    isCheckingProviders: state.isCheckingProviders,
    t,
  });

  if (state.isScanningInstalled && !banner.visible) {
    banner = {
      visible: true,
      headline:
        state.activeTab === 'installed'
          ? t('scanBanner.fallbackInstalledHeadline')
          : t('scanBanner.fallbackUpdatesHeadline'),
      subtext: t('scanBanner.fallbackSubtext'),
      percent: null,
      indeterminate: true,
      completed: 0,
      total: 0,
      chips: [],
    };
  }

  if (banner.visible) {
    const pctHtml =
      typeof banner.percent === 'number' && !banner.indeterminate
        ? `<span class="pc-scan-pct">${banner.percent}%</span>`
        : '';
    const fillCls = banner.indeterminate ? 'pc-scan-progress-fill is-indeterminate' : 'pc-scan-progress-fill is-active';
    const fillStyle = banner.indeterminate ? '' : `style="width: ${banner.percent ?? 10}%"`;

    const chipsHtml =
      banner.chips.length > 0
        ? `<div class="pc-scan-sources">
            ${banner.chips
              .map((chip) => {
                const statusCls =
                  chip.status === 'done' ? 'is-done' : chip.status === 'error' ? 'is-error' : 'is-running';
                const icon = chip.status === 'done' ? '✓' : chip.status === 'error' ? '⚠️' : '⏳';
                const titleAttr = chip.error ? ` title="${escapeHTML(chip.error)}"` : '';
                return `<span class="pc-scan-chip ${statusCls}"${titleAttr}>${icon} ${escapeHTML(chip.label)}</span>`;
              })
              .join('')}
          </div>`
        : '';

    host.hidden = false;
    host.innerHTML = `
      <div class="pc-scan-banner" role="status" aria-live="polite">
        <div class="pc-scan-banner-top">
          <div class="pc-scan-banner-title">
            <span class="pc-scan-spinner" aria-hidden="true"></span>
            <strong class="pc-scan-headline">${escapeHTML(banner.headline)}</strong>
          </div>
          <div class="pc-scan-meta">
            <span>${escapeHTML(banner.subtext)}</span>
            ${pctHtml}
          </div>
        </div>
        <div class="pc-scan-progress-track">
          <div class="${fillCls}" ${fillStyle}></div>
        </div>
        ${chipsHtml}
      </div>
    `;
    return;
  }

  if (
    state.activeTab === 'updates' &&
    Array.isArray(state.lastScanFailedProviders) &&
    state.lastScanFailedProviders.length > 0
  ) {
    const names = formatSourceNameList(
      state.lastScanFailedProviders.map((p) => p.name || p.id),
      { t }
    );
    const detailsTitle = state.lastScanFailedProviders
      .map((p) => `${p.name || p.id}: ${p.error || t('scanBanner.defaultError')}`)
      .join('\n');
    host.hidden = false;
    host.innerHTML = `
      <div class="pc-scan-banner is-warning" role="status" title="${escapeHTML(detailsTitle)}">
        <div class="pc-scan-warning-row">
          <span class="pc-scan-warning-text">⚠️ ${escapeHTML(t('scanBanner.warningFailedPrefix'))}<strong>${escapeHTML(names)}</strong>${escapeHTML(t('scanBanner.warningFailedSuffix'))}</span>
          <div class="pc-scan-warning-actions">
            <button type="button" class="btn btn-ghost btn-xs" data-scan-banner-action="retry-scan">🔄 ${escapeHTML(t('common.retry'))}</button>
            <button type="button" class="btn btn-ghost btn-xs" data-scan-banner-action="dismiss-warning" title="${escapeHTML(t('scanBanner.dismissWarning'))}" aria-label="${escapeHTML(t('scanBanner.dismissWarning'))}">✕</button>
          </div>
        </div>
      </div>
    `;
    return;
  }

  host.hidden = true;
  host.innerHTML = '';
}

export function renderCatalogGrid() {
  updateNavCounts();
  renderScanProgressBanner();

  const grid = document.getElementById('grid');
  const countEl = document.getElementById('catalogCountDisplay');
  const countSub = document.getElementById('catalogCountSub');
  if (!grid) return;

  const visibleHidden = state.settings.visibleHiddenCats || [];
  const baseCount = getTabBaseCount(visibleHidden);
  const { entries, hasSearch } = getFilteredAndSortedEntries();

  if (countEl) countEl.textContent = String(entries.length);
  if (countSub) {
    countSub.textContent =
      entries.length === baseCount ? t('toolbar.programs') : t('toolbar.ofCount', { total: baseCount });
  }

  if (state.activeTab === 'updates') {
    renderUpdatesBatchBar(entries);
  }

  if (entries.length === 0) {
    grid.innerHTML = renderEmptyState();
    return;
  }

  if (!hasSearch) {
    grid.innerHTML = entries.map((e) => renderCardHtml(e.item, e.st)).join('');
    queuePcIconExtraction(entries);
    return;
  }

  const coreMatches = entries.filter((e) => e.search.isCoreMatch);
  const descMatches = entries.filter((e) => !e.search.isCoreMatch);

  const htmlParts = [];
  if (coreMatches.length > 0) {
    htmlParts.push(coreMatches.map((e) => renderCardHtml(e.item, e.st)).join(''));
  }
  if (descMatches.length > 0) {
    if (coreMatches.length > 0) {
      htmlParts.push(
        `<div class="grid-section-divider"><span>${escapeHTML(t('cards.alsoInDescriptions', { count: descMatches.length }))}</span></div>`
      );
    }
    htmlParts.push(descMatches.map((e) => renderCardHtml(e.item, e.st)).join(''));
  }

  grid.innerHTML = htmlParts.join('');
  queuePcIconExtraction(entries);
}
