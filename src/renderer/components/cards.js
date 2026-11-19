import { compareVersions } from '../../shared/version.js';
import { getItemStatus, hasAnyLocalPath, hasOnlineSource, isItemNew, state } from '../state.js';
import { escapeHTML, toMediaUrl } from '../utils/sanitize.js';

const STATUS_META = {
  webupdate: { label: 'Web-Update', title: 'Neuere Version im Internet verfügbar' },
  update: { label: 'NAS-Update', title: 'Neuere Version im Archiv verfügbar' },
  installed: { label: 'Installiert', title: 'Auf diesem PC installiert' },
  newer: { label: 'PC neuer', title: 'Installierte Version ist neuer als im Archiv' },
};

function getEditDistance(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const v0 = Array.from({ length: b.length + 1 }, (_, i) => i);
  const v1 = new Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}

function fuzzyMatch(searchWord, fullText) {
  if (fullText.includes(searchWord)) return true;
  if (searchWord.length < 3) return false;
  const words = fullText.split(/[^a-z0-9äöüß]+/);
  for (const w of words) {
    if (w.length < 3) continue;
    if (getEditDistance(searchWord, w) <= (searchWord.length <= 5 ? 1 : 2)) return true;
  }
  return false;
}

function getFilteredAndSortedItems() {
  const searchWords = state.searchQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);

  const visibleHidden = state.settings.visibleHiddenCats || [];
  const depth = state.settings.versionCompareDepth ?? 3;

  const filtered = state.catalog.filter((item) => {
    const isHidden = Boolean(item.hiddenCategory?.trim());
    if (isHidden && !visibleHidden.includes(item.hiddenCategory)) return false;
    if (state.activeTag && !item.tags.includes(state.activeTag)) return false;

    // Status- & Wartungsfilter
    const st = getItemStatus(item);
    if (state.filterMode === 'any-update' && !st.hasWebUpdate && !st.hasNasUpdate) return false;
    if (state.filterMode === 'webupdate' && !st.hasWebUpdate) return false;
    if (state.filterMode === 'nasupdate' && !st.hasNasUpdate) return false;
    if (state.filterMode === 'installed' && !item.isInstalled) return false;
    if (state.filterMode === 'missing-path') {
      const isStandard = !item.softwareType || item.softwareType === 'default';
      if (!isStandard || hasAnyLocalPath(item)) return false;
    }
    if (state.filterMode === 'missing-web' && hasOnlineSource(item)) return false;

    if (searchWords.length > 0) {
      const haystack =
        `${item.name} ${item.description} ${item.tags.join(' ')} ${(item.formats || []).join(' ')}`.toLowerCase();
      for (const word of searchWords) {
        if (!fuzzyMatch(word, haystack)) return false;
      }
    }

    return true;
  });

  filtered.sort((a, b) => {
    const aFav = state.favorites.includes(a.id);
    const bFav = state.favorites.includes(b.id);
    if (aFav !== bFav) return aFav ? -1 : 1;

    const stA = getItemStatus(a);
    const stB = getItemStatus(b);

    if (state.sortMode === 'updates') {
      const rank = (s) => (s.hasWebUpdate ? 2 : s.hasNasUpdate ? 1 : 0);
      const diff = rank(stB) - rank(stA);
      if (diff !== 0) return diff;
    } else if (state.sortMode === 'webnas') {
      if (stA.hasWebUpdate !== stB.hasWebUpdate) return stA.hasWebUpdate ? -1 : 1;
    } else if (state.sortMode === 'update') {
      if (stA.hasNasUpdate !== stB.hasNasUpdate) return stA.hasNasUpdate ? -1 : 1;
    } else if (state.sortMode === 'installed') {
      if (a.isInstalled !== b.isInstalled) return a.isInstalled ? -1 : 1;
    } else if (state.sortMode === 'newest') {
      return (b.addedAt || 0) - (a.addedAt || 0);
    } else if (state.sortMode === 'updated') {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    }

    // Sekundär nach Alphabet (bei gleichem Status)
    if (state.sortMode === 'webnas' && stA.webVersion && stB.webVersion) {
      const cmp = compareVersions(stB.webVersion, stA.webVersion, depth);
      if (cmp !== 0) return cmp;
    }
    return a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
  });

  return filtered;
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
        <span class="ver-val">${st.localVersion ? escapeHTML(st.localVersion) : '–'}</span>
      </div>
      <div class="ver-slot ${nasClass}" title="Version im NAS-Archiv">
        <span class="ver-lbl">NAS</span>
        <span class="ver-val">${st.nasVersion ? escapeHTML(st.nasVersion) : '–'}</span>
      </div>
      <div class="ver-slot ${webClass}" title="Aktuellste Version im Web">
        <span class="ver-lbl">Web</span>
        <span class="ver-val">${st.webVersion ? escapeHTML(st.webVersion) : '–'}</span>
      </div>
    </div>
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

  const items = getFilteredAndSortedItems();
  if (countEl) countEl.textContent = String(items.length);
  if (countSub) {
    countSub.textContent = items.length === state.catalog.length ? 'Programme' : `von ${state.catalog.length}`;
  }

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <h3>Keine Treffer</h3>
        <p>Passe Suche, Kategorie oder Filter an.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = items
    .map((item) => {
      const isFav = state.favorites.includes(item.id);
      const st = getItemStatus(item);
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
    })
    .join('');
}
