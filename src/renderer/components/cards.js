import { getInstallModeBadge } from '../../shared/installer-logic.js';
import { scoreCatalogItem } from '../../shared/search.js';
import {
  canDownloadOnline,
  getProviderBadgeInfo,
  isPackageVisible,
  matchesProviderFilter,
} from '../../shared/unified-packages.js';
import { compareVersions } from '../../shared/version.js';
import {
  getActiveOriginFilter,
  getActiveSortMode,
  getItemStatus,
  hasAnyLocalPath,
  hasOnlineSource,
  isItemNew,
  isProviderUsable,
  state,
} from '../state.js';
import { escapeHTML, toMediaUrl } from '../utils/sanitize.js';
import { updateNavCounts } from './toolbar.js';

const STATUS_META = {
  webupdate: { label: 'Web-Update', title: 'Neuere Version im Internet verfügbar' },
  update: { label: 'Archiv-Update', title: 'Neuere Version im Archiv verfügbar' },
  installed: { label: 'Installiert', title: 'Auf diesem PC installiert' },
  newer: { label: 'PC neuer', title: 'Installierte Version ist neuer als im Archiv' },
};

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

  if (tab === 'updates') {
    if (!isProviderItemVisible(item)) return false;
    if (item.origin === 'pc' && item.packageManager && !isProviderUsable(item.packageManager)) return false;
    if (!st.hasWebUpdate && !st.hasArchiveUpdate) return false;
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
    const st = getItemStatus(item);
    if (
      state.activeTab === 'updates' &&
      !(item.origin === 'pc' && item.packageManager && !isProviderUsable(item.packageManager)) &&
      (st.hasWebUpdate || st.hasArchiveUpdate)
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
    return a.item.name.localeCompare(b.item.name, 'de', { sensitivity: 'base' });
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
      <div class="ver-slot ${pcClass}" title="Installiert auf diesem PC">
        <span class="ver-lbl">PC</span>
        <span class="ver-val">${st.localVersion ? escapeHTML(st.localVersion) : '-'}</span>
      </div>
      <div class="ver-slot ${archiveClass}" title="Version im Archiv">
        <span class="ver-lbl">Archiv</span>
        <span class="ver-val">${st.archiveVersion ? escapeHTML(st.archiveVersion) : '-'}</span>
      </div>
      <div class="ver-slot ${webClass}" title="Aktuellste Version im Web">
        <span class="ver-lbl">Web</span>
        <span class="ver-val">${st.webVersion ? escapeHTML(st.webVersion) : '-'}</span>
      </div>
    </div>
  `;
}

function renderCardHtml(item, st) {
  const isFav = item.inArchive && state.favorites.includes(item.id);
  const statusCfg = STATUS_META[st.status];
  const isUpdatesTab = state.activeTab === 'updates';
  const isSelected = isUpdatesTab && state.selectedUpdateIds.has(item.id);

  let secondaryTag = '';
  if (item.packageManager === 'nvm' && item.isActive) {
    secondaryTag = '<span class="card-chip chip-install-silent" title="Aktuell aktive Node.js-Version">⚡ Aktiv</span>';
  } else if (item.inArchive && isItemNew(item)) secondaryTag = '<span class="card-chip chip-new">NEU</span>';
  else if (item.softwareType === 'portable') secondaryTag = '<span class="card-chip">Portabel</span>';
  else if (item.softwareType === 'driver') secondaryTag = '<span class="card-chip">Treiber</span>';

  let originTag = '';
  let providerTag = '';
  if (state.activeTab !== 'archive') {
    originTag = item.inArchive
      ? '<span class="card-chip chip-origin-archive" title="Im Archiv hinterlegt">Archiv</span>'
      : '<span class="card-chip chip-origin-pc" title="Nur lokal auf diesem PC installiert">Nur PC</span>';

    const providerBadge = getProviderBadgeInfo(item.packageManager, state.providers);
    if (providerBadge) {
      providerTag = `<span class="provider-badge ${escapeHTML(providerBadge.badgeClass)}">${escapeHTML(providerBadge.label)}</span>`;
    }
  }

  let installModeTag = '';
  if (isUpdatesTab && item.inArchive) {
    const badge = getInstallModeBadge(item);
    if (badge) {
      const cls = badge.type === 'protected' ? 'chip-install-protected' : 'chip-install-silent';
      installModeTag = `<span class="card-chip ${cls}" title="${escapeHTML(badge.title)}">${escapeHTML(badge.label)}</span>`;
    }
  }

  const iconHtml = item.icon
    ? `<img class="card-icon" src="${escapeHTML(toMediaUrl(item.icon))}" loading="lazy" decoding="async" alt="">`
    : `<div class="card-icon-fallback">${item.origin === 'pc' ? '💻' : '📦'}</div>`;

  const favBtnHtml = item.inArchive
    ? `<button type="button" class="fav-btn ${isFav ? 'active' : ''}" data-fav-id="${escapeHTML(item.id)}" title="Favorit umschalten" aria-label="Favorit">★</button>`
    : item.origin === 'pc'
      ? `<button type="button" class="card-archive-btn" data-card-archive-id="${escapeHTML(item.id)}" title="Ins Archiv aufnehmen" aria-label="Ins Archiv aufnehmen">📥</button>`
      : '';

  const selectHtml = isUpdatesTab
    ? `<label class="card-select-wrap" title="Für Massenaktion auswählen"><input type="checkbox" class="card-select-checkbox" data-select-update-id="${escapeHTML(item.id)}" ${isSelected ? 'checked' : ''}></label>`
    : '';

  const subtitle = item.inArchive
    ? item.tags.slice(0, 3).join(' · ')
    : [item.publisher, item.packageId].filter(Boolean).join(' · ') || 'Windows-Installation';

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
    if (state.isScanningInstalled && !state.hasScannedInstalled) {
      return `
        <div class="empty-state">
          <h3>Suche nach PC- & Archiv-Updates...</h3>
          <p>Installierte Programme und Winget-Upgrades werden gerade ermittelt.</p>
        </div>
      `;
    }
    return `
      <div class="empty-state">
        <h3>Keine offenen Updates gefunden</h3>
        <p>Alle erkannten Programme sind aktuell - oder starte oben <strong>🌐 Online-Updates</strong> bzw. <strong>💻 PC prüfen</strong>.</p>
      </div>
    `;
  }

  if (state.activeTab === 'installed') {
    if (state.isScanningInstalled && !state.hasScannedInstalled) {
      return `
        <div class="empty-state">
          <h3>Scanne installierte PC-Programme...</h3>
          <p>Winget-Pakete und Windows-Registry werden eingelesen.</p>
        </div>
      `;
    }
    return `
      <div class="empty-state">
        <h3>Keine installierten Programme angezeigt</h3>
        <p>Klicke auf <strong>💻 PC prüfen</strong> oder passe Suche und Herkunfts-Filter an.</p>
      </div>
    `;
  }

  if (state.catalog.length === 0) {
    return `
      <div class="empty-state">
        <h3>Noch keine Programme im Archiv</h3>
        <p>Klicke oben auf <strong>🔄 Archiv prüfen</strong>, um deinen Software-Ordner einzulesen.</p>
      </div>
    `;
  }

  return `
    <div class="empty-state">
      <h3>Keine Treffer</h3>
      <p>Passe Suche, Kategorie oder Filter an.</p>
    </div>
  `;
}

export function getPendingArchiveWebUpdateItems() {
  const visibleHidden = state.settings.visibleHiddenCats || [];
  const items = [];
  for (const item of state.packages) {
    if (!item.inArchive) continue;
    if (!isPackageVisible(item, visibleHidden)) continue;
    const st = getItemStatus(item);
    if (st.hasWebUpdate && canDownloadOnline(item)) {
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
  const disabledAttr = state.isBatchActionRunning ? 'disabled' : '';

  const modeSourceEntries =
    selectedCount > 0 ? activeEntries.filter((e) => state.selectedUpdateIds.has(e.item.id)) : activeEntries;
  let silentCount = 0;
  let protectedCount = 0;
  for (const { item } of modeSourceEntries) {
    if (!item.inArchive) continue;
    const badge = getInstallModeBadge(item);
    if (badge?.type === 'silent') silentCount++;
    else if (badge?.type === 'protected') protectedCount++;
  }
  const modePills = [];
  if (silentCount > 0) {
    modePills.push(
      `<span class="batch-mode-pill is-silent" title="Wird bei Massenaktualisierung still installiert">⚡ ${silentCount} Silent</span>`
    );
  }
  if (protectedCount > 0) {
    modePills.push(
      `<span class="batch-mode-pill is-protected" title="Silent-Parameter werden wegen Adware-Schutz immer ignoriert">🛡️ ${protectedCount} Interaktiv-Schutz</span>`
    );
  }
  const modePillsHtml = modePills.length > 0 ? `<div class="batch-mode-pills">${modePills.join('')}</div>` : '';

  bar.hidden = false;
  bar.innerHTML = `
    <div class="batch-bar-left">
      <label class="batch-select-all">
        <input type="checkbox" id="chkSelectAllUpdates" ${allSelected ? 'checked' : ''} ${totalCount === 0 || state.isBatchActionRunning ? 'disabled' : ''}>
        <span>Alle auswählen</span>
      </label>
      <span class="batch-selected-count">${selectedCount} von ${totalCount} ausgewählt</span>
      ${modePillsHtml}
    </div>
    <div class="batch-bar-right">
      <button type="button" class="btn btn-online" id="btnBatchDownloadArchive" ${pendingArchiveDownloads === 0 || state.isBatchActionRunning ? 'disabled' : ''}>
        ⬇️ Alle Online-Updates ins Archiv laden <span class="btn-count-badge">${pendingArchiveDownloads}</span>
      </button>
      <button type="button" class="btn btn-primary" id="btnUpdateAllStandard" ${totalCount === 0 || state.isBatchActionRunning ? 'disabled' : ''}>
        ⬆️ Alle Updaten <span class="btn-count-badge">${totalCount}</span>
      </button>
      <button type="button" class="btn btn-local" id="btnUpdateAllSilent" ${totalCount === 0 || state.isBatchActionRunning ? 'disabled' : ''}>
        ⚡ Alle Updaten (silent) <span class="btn-count-badge">${totalCount}</span>
      </button>
      <button type="button" class="btn btn-ghost" id="btnBatchUpdateSelected" ${selectedCount === 0 ? 'disabled' : disabledAttr}>
        ⬆️ Ausgewählte aktualisieren <span class="btn-count-badge">${selectedCount}</span>
      </button>
    </div>
  `;

  const chkAll = bar.querySelector('#chkSelectAllUpdates');
  if (chkAll instanceof HTMLInputElement) {
    chkAll.indeterminate = someSelected;
  }
}

export function renderCatalogGrid() {
  updateNavCounts();

  const grid = document.getElementById('grid');
  const countEl = document.getElementById('catalogCountDisplay');
  const countSub = document.getElementById('catalogCountSub');
  if (!grid) return;

  const visibleHidden = state.settings.visibleHiddenCats || [];
  const baseCount = getTabBaseCount(visibleHidden);
  const { entries, hasSearch } = getFilteredAndSortedEntries();

  if (countEl) countEl.textContent = String(entries.length);
  if (countSub) {
    countSub.textContent = entries.length === baseCount ? 'Programme' : `von ${baseCount}`;
  }

  if (state.activeTab === 'updates') {
    renderUpdatesBatchBar(entries);
  }

  if (entries.length === 0) {
    grid.innerHTML = renderEmptyState();
    return;
  }

  const bannerHtml =
    state.isScanningInstalled && (state.activeTab === 'updates' || state.activeTab === 'installed')
      ? '<div class="pc-scan-banner"><span>⏳ Installierte PC-Programme und Winget-Updates werden im Hintergrund aktualisiert...</span></div>'
      : '';

  if (!hasSearch) {
    grid.innerHTML = bannerHtml + entries.map((e) => renderCardHtml(e.item, e.st)).join('');
    queuePcIconExtraction(entries);
    return;
  }

  const coreMatches = entries.filter((e) => e.search.isCoreMatch);
  const descMatches = entries.filter((e) => !e.search.isCoreMatch);

  const htmlParts = [];
  if (bannerHtml) htmlParts.push(bannerHtml);
  if (coreMatches.length > 0) {
    htmlParts.push(coreMatches.map((e) => renderCardHtml(e.item, e.st)).join(''));
  }
  if (descMatches.length > 0) {
    if (coreMatches.length > 0) {
      htmlParts.push(
        `<div class="grid-section-divider"><span>Auch in Beschreibungen erwähnt (${descMatches.length})</span></div>`
      );
    }
    htmlParts.push(descMatches.map((e) => renderCardHtml(e.item, e.st)).join(''));
  }

  grid.innerHTML = htmlParts.join('');
  queuePcIconExtraction(entries);
}
