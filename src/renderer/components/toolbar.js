import { state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';

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
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');
  const sortSelect = document.getElementById('sortSelect');
  const filterSelect = document.getElementById('filterSelect');
  const tagContainer = document.getElementById('tagContainer');
  const moreBtn = document.getElementById('btnMoreActions');
  const moreMenu = document.getElementById('moreActionsMenu');
  const legendBtn = document.getElementById('btnLegendToggle');
  const legendPopover = document.getElementById('legendPopover');

  const closePopovers = () => {
    if (moreMenu) moreMenu.hidden = true;
    if (legendPopover) legendPopover.hidden = true;
  };

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
    state.sortMode = sortSelect.value;
    handlers.onFilterChange();
  });

  filterSelect?.addEventListener('change', () => {
    state.filterMode = filterSelect.value;
    handlers.onFilterChange();
  });

  tagContainer?.addEventListener('click', (e) => {
    const chip = e.target.closest('.tag-chip');
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
    const item = e.target.closest('[data-toolbar-action]');
    if (!item) return;
    closePopovers();
    const act = item.dataset.toolbarAction;
    if (act === 'add-software') handlers.onAddSoftware();
    else if (act === 'auto-detect-all') handlers.onAutoDetectAll();
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
      !e.target.closest('.menu-anchor') &&
      !e.target.closest('#btnLegendToggle') &&
      !e.target.closest('#legendPopover')
    ) {
      closePopovers();
    }
  });

  // Sticky Shrink beim Scrollen
  window.addEventListener('scroll', () => {
    const tb = document.getElementById('mainToolbar');
    tb?.classList.toggle('shrink', window.scrollY > 40);
  });
}
