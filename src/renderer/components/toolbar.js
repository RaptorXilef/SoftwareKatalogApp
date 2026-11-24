import {
  getActiveOriginFilter,
  getActiveSortMode,
  getTabCounts,
  setActiveOriginFilter,
  setActiveSortMode,
  state,
} from '../state.js';
import { closestEl, qsa, qsInput, qsSelect } from '../utils/dom.js';
import { escapeHTML } from '../utils/sanitize.js';

const ORIGIN_FILTERS_BY_TAB = {
  updates: [
    { id: 'all', label: 'Alle' },
    { id: 'in-archive', label: 'Im Archiv' },
    { id: 'not-in-archive', label: 'Nicht im Archiv' },
  ],
  installed: [
    { id: 'all', label: 'Alle' },
    { id: 'in-archive', label: 'Im Archiv' },
    { id: 'not-in-archive', label: 'Nicht im Archiv' },
    { id: 'winget', label: 'Winget-verwaltet' },
  ],
};

export function updateNavCounts() {
  const counts = getTabCounts();
  const updatesEl = document.getElementById('navCountUpdates');
  const installedEl = document.getElementById('navCountInstalled');
  const archiveEl = document.getElementById('navCountArchive');
  const bundlesEl = document.getElementById('navCountBundles');

  if (updatesEl) {
    updatesEl.textContent = String(counts.updates);
    updatesEl.classList.toggle('has-updates', counts.updates > 0);
  }
  if (installedEl) installedEl.textContent = String(counts.installed);
  if (archiveEl) archiveEl.textContent = String(counts.archive);
  if (bundlesEl) bundlesEl.textContent = String(counts.bundles);
}

function renderOriginFilterBar() {
  const bar = document.getElementById('originFilterBar');
  if (!bar) return;

  const options = ORIGIN_FILTERS_BY_TAB[state.activeTab];
  if (!options) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }

  const active = getActiveOriginFilter();
  bar.hidden = false;
  bar.innerHTML = options
    .map(
      (opt) =>
        `<button type="button" class="origin-chip ${active === opt.id ? 'active' : ''}" data-origin-filter="${escapeHTML(opt.id)}">${escapeHTML(opt.label)}</button>`
    )
    .join('');
}

export function syncToolbarForTab() {
  const tab = state.activeTab;
  const isCatalogView = tab === 'updates' || tab === 'installed' || tab === 'archive';

  qsa(document, '#mainNav .nav-tab').forEach((btn) => {
    const isActive = btn.dataset.mainTab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  const mainToolbar = document.getElementById('mainToolbar');
  if (mainToolbar) mainToolbar.hidden = !isCatalogView;

  const filterSelect = document.getElementById('filterSelect');
  if (filterSelect) filterSelect.hidden = tab !== 'archive';

  const tagsDetails = document.getElementById('tagsDetails');
  if (tagsDetails) tagsDetails.hidden = tab !== 'archive';

  const sortSelect = qsSelect(document, '#sortSelect');
  if (sortSelect) {
    qsa(sortSelect, 'option[data-archive-only="true"]').forEach((opt) => {
      opt.hidden = tab !== 'archive';
    });
    const mode = getActiveSortMode();
    sortSelect.value = mode;
    if (sortSelect.selectedOptions[0]?.hidden) {
      setActiveSortMode('az');
      sortSelect.value = 'az';
    }
  }

  renderOriginFilterBar();

  const updatesBatchBar = document.getElementById('updatesBatchBar');
  if (updatesBatchBar) updatesBatchBar.hidden = tab !== 'updates';

  const updateQueuePanel = document.getElementById('updateQueuePanel');
  if (updateQueuePanel && tab !== 'updates') updateQueuePanel.hidden = true;

  const grid = document.getElementById('grid');
  const bundlesView = document.getElementById('bundlesView');
  const discoverView = document.getElementById('discoverView');
  if (grid) grid.hidden = !isCatalogView;
  if (bundlesView) bundlesView.hidden = tab !== 'bundles';
  if (discoverView) discoverView.hidden = tab !== 'discover';
}

export function renderTagChips() {
  const container = document.getElementById('tagContainer');
  if (!container) return;

  const visibleHidden = state.settings.visibleHiddenCats || [];
  const allTags = new Set();

  for (const item of state.catalog) {
    const isHidden = Boolean(item.hiddenCategory?.trim());
    if (isHidden && !visibleHidden.includes(item.hiddenCategory)) continue;
    for (const t of item.tags) allTags.add(t);
  }

  const chips = [
    `<button type="button" class="tag-chip ${!state.activeTag ? 'active' : ''}" data-tag="all">Alle</button>`,
    ...Array.from(allTags)
      .sort((a, b) => a.localeCompare(b, 'de'))
      .map(
        (tag) =>
          `<button type="button" class="tag-chip ${state.activeTag === tag ? 'active' : ''}" data-tag="${escapeHTML(tag)}">${escapeHTML(tag)}</button>`
      ),
  ];

  container.innerHTML = chips.join('');
}

export function initToolbar(handlers) {
  const mainNav = document.getElementById('mainNav');
  const searchInput = qsInput(document, '#searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const sortSelect = qsSelect(document, '#sortSelect');
  const filterSelect = qsSelect(document, '#filterSelect');
  const originFilterBar = document.getElementById('originFilterBar');
  const tagContainer = document.getElementById('tagContainer');
  const moreBtn = document.getElementById('btnMoreActions');
  const moreMenu = document.getElementById('moreActionsMenu');
  const legendBtn = document.getElementById('btnLegendToggle');
  const legendPopover = document.getElementById('legendPopover');

  const closePopovers = () => {
    if (moreMenu) moreMenu.hidden = true;
    if (legendPopover) legendPopover.hidden = true;
  };

  mainNav?.addEventListener('click', (e) => {
    const tabBtn = closestEl(e.target, '[data-main-tab]');
    if (!tabBtn) return;
    const nextTab = tabBtn.dataset.mainTab;
    if (!nextTab || nextTab === state.activeTab) return;
    closePopovers();
    handlers.onTabChange?.(nextTab);
  });

  searchInput?.addEventListener('input', () => {
    state.searchQuery = searchInput.value;
    if (clearSearchBtn) clearSearchBtn.hidden = state.searchQuery.length === 0;
    handlers.onFilterChange();
  });

  clearSearchBtn?.addEventListener('click', () => {
    if (!searchInput) return;
    searchInput.value = '';
    state.searchQuery = '';
    clearSearchBtn.hidden = true;
    handlers.onFilterChange();
    searchInput.focus();
  });

  sortSelect?.addEventListener('change', () => {
    setActiveSortMode(sortSelect.value);
    handlers.onFilterChange();
  });

  filterSelect?.addEventListener('change', () => {
    state.filterMode = filterSelect.value;
    handlers.onFilterChange();
  });

  originFilterBar?.addEventListener('click', (e) => {
    const chip = closestEl(e.target, '[data-origin-filter]');
    if (!chip) return;
    setActiveOriginFilter(chip.dataset.originFilter);
    renderOriginFilterBar();
    handlers.onFilterChange();
  });

  tagContainer?.addEventListener('click', (e) => {
    const chip = closestEl(e.target, '.tag-chip');
    if (!chip) return;
    const tag = chip.dataset.tag;
    state.activeTag = tag === 'all' ? null : tag;
    renderTagChips();
    handlers.onFilterChange();
  });

  // Die 3 parallelen Hauptprüfungen
  document.getElementById('btnCheckArchive')?.addEventListener('click', () => handlers.onScanArchive('smart'));
  document.getElementById('btnCheckOnline')?.addEventListener('click', () => handlers.onCheckOnline());
  document.getElementById('btnCheckLocal')?.addEventListener('click', () => handlers.onCheckLocal());

  // Popover-Menü (⋯)
  moreBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasHidden = moreMenu.hidden;
    closePopovers();
    moreMenu.hidden = !wasHidden;
  });

  moreMenu?.addEventListener('click', (e) => {
    const item = closestEl(e.target, '[data-toolbar-action]');
    if (!item) return;
    closePopovers();
    const act = item.dataset.toolbarAction;
    if (act === 'add-software') handlers.onAddSoftware();
    else if (act === 'auto-detect-all') handlers.onAutoDetectAll();
    else if (act === 'winget-matcher') handlers.onOpenWingetMatcher?.();
    else if (act === 'archive-cleaner') handlers.onOpenArchiveCleaner?.();
    else if (act === 'scan-update') handlers.onScanArchive('update');
    else if (act === 'scan-full') handlers.onScanArchive('full');
  });

  // Legenden-Popover (ⓘ)
  legendBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasHidden = legendPopover.hidden;
    closePopovers();
    legendPopover.hidden = !wasHidden;
  });

  document.getElementById('btnSettingsToggle')?.addEventListener('click', () => {
    closePopovers();
    handlers.onOpenSettings();
  });

  document.addEventListener('click', (e) => {
    if (
      !closestEl(e.target, '.menu-anchor') &&
      !closestEl(e.target, '#btnLegendToggle') &&
      !closestEl(e.target, '#legendPopover')
    ) {
      closePopovers();
    }
  });

  // Sticky Shrink beim Scrollen
  window.addEventListener('scroll', () => {
    const tb = document.getElementById('mainToolbar');
    tb?.classList.toggle('shrink', window.scrollY > 40);
  });

  syncToolbarForTab();
}
