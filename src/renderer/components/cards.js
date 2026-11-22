import { scoreCatalogItem } from '../../shared/search.js';
import { compareVersions } from '../../shared/version.js';
import { getItemStatus, hasAnyLocalPath, hasOnlineSource, isItemNew, state } from '../state.js';
import { escapeHTML, toMediaUrl } from '../utils/sanitize.js';

const STATUS_META = {
  webupdate: { label: 'Web-Update', title: 'Neuere Version im Internet verfügbar' },
  update: { label: 'NAS-Update', title: 'Neuere Version im Archiv verfügbar' },
  installed: { label: 'Installiert', title: 'Auf diesem PC installiert' },
  newer: { label: 'PC neuer', title: 'Installierte Version ist neuer als im Archiv' },
};

function getFilteredAndSortedEntries() {
  const hasSearch = state.searchQuery.trim().length > 0;
  const visibleHidden = state.settings.visibleHiddenCats || [];
  const depth = state.settings.versionCompareDepth ?? 3;

  const entries = [];

  for (const item of state.catalog) {
    const isHidden = Boolean(item.hiddenCategory?.trim());
    if (isHidden && !visibleHidden.includes(item.hiddenCategory)) continue;
    if (state.activeTag && !item.tags.includes(state.activeTag)) continue;

    const st = getItemStatus(item);
    if (state.filterMode === 'any-update' && !st.hasWebUpdate && !st.hasNasUpdate) continue;
    if (state.filterMode === 'webupdate' && !st.hasWebUpdate) continue;
    if (state.filterMode === 'nasupdate' && !st.hasNasUpdate) continue;
    if (state.filterMode === 'installed' && !item.isInstalled) continue;
    if (state.filterMode === 'missing-path') {
      const isStandard = !item.softwareType || item.softwareType === 'default';
      if (!isStandard || hasAnyLocalPath(item)) continue;
    }
    if (state.filterMode === 'missing-web' && hasOnlineSource(item)) continue;

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

    const aFav = state.favorites.includes(a.item.id);
    const bFav = state.favorites.includes(b.item.id);
    if (aFav !== bFav) return aFav ? -1 : 1;

    if (state.sortMode === 'updates') {
      const rank = (s) => (s.hasWebUpdate ? 2 : s.hasNasUpdate ? 1 : 0);
      const diff = rank(b.st) - rank(a.st);
      if (diff !== 0) return diff;
    } else if (state.sortMode === 'webnas') {
      if (a.st.hasWebUpdate !== b.st.hasWebUpdate) return a.st.hasWebUpdate ? -1 : 1;
    } else if (state.sortMode === 'update') {
      if (a.st.hasNasUpdate !== b.st.hasNasUpdate) return a.st.hasNasUpdate ? -1 : 1;
    } else if (state.sortMode === 'installed') {
      if (a.item.isInstalled !== b.item.isInstalled) return a.item.isInstalled ? -1 : 1;
    } else if (state.sortMode === 'newest') {
      return (b.item.addedAt || 0) - (a.item.addedAt || 0);
    } else if (state.sortMode === 'updated') {
      return (b.item.updatedAt || 0) - (a.item.updatedAt || 0);
    }

    if (state.sortMode === 'webnas' && a.st.webVersion && b.st.webVersion) {
      const cmp = compareVersions(b.st.webVersion, a.st.webVersion, depth);
      if (cmp !== 0) return cmp;
    }
    return a.item.name.localeCompare(b.item.name, 'de', { sensitivity: 'base' });
  });

  return { entries, hasSearch };
}

function renderVersionStrip(st) {
  if (!st.localVersion && !st.nasVersion && !st.webVersion) return '';

  const pcClass = st.isPcNewer ? 'is-newer' : st.localVersion && !st.hasNasUpdate ? 'is-ok' : '';
  const nasClass = st.hasNasUpdate ? 'is-highlight-nas' : '';
  const webClass = st.hasWebUpdate ? 'is-highlight-web' : '';

  return `
    <div class="card-versions">
      <div class="ver-slot ${pcClass}" title="Installiert auf diesem PC">
        <span class="ver-lbl">PC</span>
        <span class="ver-val">${st.localVersion ? escapeHTML(st.localVersion) : '-'}</span>
      </div>
      <div class="ver-slot ${nasClass}" title="Version im NAS-Archiv">
        <span class="ver-lbl">NAS</span>
        <span class="ver-val">${st.nasVersion ? escapeHTML(st.nasVersion) : '-'}</span>
      </div>
      <div class="ver-slot ${webClass}" title="Aktuellste Version im Web">
        <span class="ver-lbl">Web</span>
        <span class="ver-val">${st.webVersion ? escapeHTML(st.webVersion) : '-'}</span>
      </div>
    </div>
  `;
}

function renderCardHtml(item, st) {
  const isFav = state.favorites.includes(item.id);
  const statusCfg = STATUS_META[st.status];

  let secondaryTag = '';
  if (isItemNew(item)) secondaryTag = '<span class="card-chip chip-new">NEU</span>';
  else if (item.softwareType === 'portable') secondaryTag = '<span class="card-chip">Portabel</span>';
  else if (item.softwareType === 'driver') secondaryTag = '<span class="card-chip">Treiber</span>';

  const iconHtml = item.icon
    ? `<img class="card-icon" src="${escapeHTML(toMediaUrl(item.icon))}" loading="lazy" decoding="async" alt="">`
    : '<div class="card-icon-fallback">📦</div>';

  return `
    <article class="card status-${st.status}" data-id="${escapeHTML(item.id)}">
      <div class="card-top">
        <div class="card-badges">
          ${statusCfg ? `<span class="status-pill is-${st.status}" title="${escapeHTML(statusCfg.title)}">${escapeHTML(statusCfg.label)}</span>` : ''}
          ${secondaryTag}
        </div>
        <button type="button" class="fav-btn ${isFav ? 'active' : ''}" data-fav-id="${escapeHTML(item.id)}" title="Favorit umschalten" aria-label="Favorit">★</button>
      </div>

      <div class="card-body">
        ${iconHtml}
        <h3 class="card-title">${escapeHTML(item.name)}</h3>
        <p class="card-tags">${escapeHTML(item.tags.slice(0, 3).join(' · '))}</p>
      </div>

      ${renderVersionStrip(st)}
    </article>
  `;
}

export function renderCatalogGrid() {
  const grid = document.getElementById('grid');
  const countEl = document.getElementById('catalogCountDisplay');
  const countSub = document.getElementById('catalogCountSub');
  if (!grid) return;

  if (state.catalog.length === 0) {
    if (countEl) countEl.textContent = '0';
    if (countSub) countSub.textContent = 'Programme';
    grid.innerHTML = `
      <div class="empty-state">
        <h3>Noch keine Programme im Katalog</h3>
        <p>Klicke oben auf <strong>🔄 Archiv prüfen</strong>, um deinen Software-Ordner einzulesen.</p>
      </div>
    `;
    return;
  }

  const { entries, hasSearch } = getFilteredAndSortedEntries();
  if (countEl) countEl.textContent = String(entries.length);
  if (countSub) {
    countSub.textContent = entries.length === state.catalog.length ? 'Programme' : `von ${state.catalog.length}`;
  }

  if (entries.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <h3>Keine Treffer</h3>
        <p>Passe Suche, Kategorie oder Filter an.</p>
      </div>
    `;
    return;
  }

  if (!hasSearch) {
    grid.innerHTML = entries.map((e) => renderCardHtml(e.item, e.st)).join('');
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
        `<div class="grid-section-divider"><span>Auch in Beschreibungen erwähnt (${descMatches.length})</span></div>`
      );
    }
    htmlParts.push(descMatches.map((e) => renderCardHtml(e.item, e.st)).join(''));
  }

  grid.innerHTML = htmlParts.join('');
}
