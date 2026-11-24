import { filterIgnoredEntries } from '../../shared/ignore-logic.js';
import { showToast } from '../components/toast.js';
import { refreshIgnoredUpdates, state } from '../state.js';
import { closestButton, qs, qsInput } from '../utils/dom.js';
import { getI18nLocale, getLocalizedProviderBadge, t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openNestedDialog } from './archive-target-modal.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';

let activeIgnoreModalToken = 0;

function formatRuleBadge(entry) {
  if (entry.mode === 'all') {
    return `<span class="ignore-rule-pill is-all">🚫 ${escapeHTML(t('ignoreList.ruleAll'))}</span>`;
  }
  const ver = entry.ignoredVersion ? `v${entry.ignoredVersion}` : t('ignoreList.ruleVersionFallback');
  return `<span class="ignore-rule-pill is-version">⏭️ ${escapeHTML(t('ignoreList.ruleVersion', { version: ver }))}</span>`;
}

function formatCreatedDate(ts) {
  if (!Number.isFinite(Number(ts)) || Number(ts) <= 0) return '';
  try {
    return new Date(Number(ts)).toLocaleDateString(getI18nLocale() || 'en');
  } catch {
    return '';
  }
}

function showImportModeDialog(existingCount) {
  return openNestedDialog({
    defaultAction: 'cancel',
    html: `
      <div class="modal-header">
        <h2>📥 ${escapeHTML(t('ignoreList.importTitle'))}</h2>
        <button type="button" class="icon-btn" data-dialog-action="cancel" title="${escapeHTML(t('common.cancel'))}" aria-label="${escapeHTML(t('common.cancel'))}">✕</button>
      </div>
      <div class="modal-body collision-warning-body">
        <p>
          ${escapeHTML(t('ignoreList.importExistingNotice', { count: existingCount }))}
        </p>
        <div class="collision-actions-grid">
          <button type="button" class="btn btn-primary" data-dialog-action="merge">🔗 ${escapeHTML(t('ignoreList.importMerge'))}</button>
          <button type="button" class="btn btn-danger" data-dialog-action="replace">♻️ ${escapeHTML(t('ignoreList.importReplace'))}</button>
          <button type="button" class="btn btn-ghost" data-dialog-action="cancel">${escapeHTML(t('common.cancel'))}</button>
        </div>
      </div>
    `,
    onAction: (act) => (['merge', 'replace', 'cancel'].includes(act) ? act : 'cancel'),
  });
}

function buildEntriesListHtml(entries, filteredEntries, { isBusy = false } = {}) {
  if (entries.length === 0) {
    return `
      <div class="ignore-empty-box">
        <strong>${escapeHTML(t('ignoreList.emptyTitle'))}</strong>
        <p class="muted">
          ${escapeHTML(t('ignoreList.emptyDescPrefix'))}<strong>${escapeHTML(t('tabs.updates'))}</strong>${escapeHTML(t('ignoreList.emptyDescSuffix'))}
        </p>
      </div>
    `;
  }

  if (filteredEntries.length === 0) {
    return `
      <div class="ignore-empty-box">
        <strong>${escapeHTML(t('ignoreList.noMatchTitle'))}</strong>
        <p class="muted">${escapeHTML(t('ignoreList.noMatchDesc'))}</p>
      </div>
    `;
  }

  return filteredEntries
    .map((entry) => {
      const sourceInfo = getLocalizedProviderBadge(entry.packageManager || 'archive', state.providers);
      const sourceBadge = sourceInfo
        ? `<span class="provider-badge ${escapeHTML(sourceInfo.badgeClass)}">${escapeHTML(sourceInfo.label)}</span>`
        : '';
      const dateStr = formatCreatedDate(entry.createdAt);
      const pkgIdHtml = entry.packageId ? `<code>${escapeHTML(entry.packageId)}</code>` : '';

      return `
        <article class="ignore-entry-row" data-ignore-row-id="${escapeHTML(entry.id)}">
          <div class="ignore-entry-info">
            <div class="ignore-entry-head">
              <strong>${escapeHTML(entry.name || entry.packageId || entry.packageKey)}</strong>
              ${sourceBadge}
              ${formatRuleBadge(entry)}
            </div>
            <div class="ignore-entry-meta">
              ${pkgIdHtml}
              ${dateStr ? `<span class="muted">${escapeHTML(t('ignoreList.addedDate', { date: dateStr }))}</span>` : ''}
            </div>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            data-ignore-action="remove"
            data-ignore-id="${escapeHTML(entry.id)}"
            data-ignore-name="${escapeHTML(entry.name || entry.packageKey)}"
            ${isBusy ? 'disabled' : ''}
          >
            ↩️ ${escapeHTML(t('ignoreList.allowAgainBtn'))}
          </button>
        </article>
      `;
    })
    .join('');
}

export async function renderIgnoreListModal() {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();

  const token = ++activeIgnoreModalToken;
  state.currentModalId = null;
  state.isEditModalOpen = false;

  let searchQuery = '';
  let confirmClearArmed = false;
  let confirmClearTimer = null;
  let isBusy = false;

  const isStillOpen = () => token === activeIgnoreModalToken && !overlay.hidden;

  const disarmClear = () => {
    confirmClearArmed = false;
    if (confirmClearTimer) {
      clearTimeout(confirmClearTimer);
      confirmClearTimer = null;
    }
  };

  const updateFilteredListOnly = () => {
    if (!isStillOpen()) return;
    const entries = Array.isArray(state.ignoredUpdates) ? state.ignoredUpdates : [];
    const filtered = filterIgnoredEntries(entries, searchQuery);
    const listContainer = qs(modal, '#ignoreListContainer');
    const footerCount = qs(modal, '#ignoreListFooterCount');
    const clearSearchBtn = qs(modal, '#btnClearIgnoreSearch');

    if (listContainer) {
      listContainer.innerHTML = buildEntriesListHtml(entries, filtered, { isBusy });
    }
    if (footerCount) {
      footerCount.textContent =
        filtered.length === entries.length
          ? t('ignoreList.countTotal', { count: entries.length })
          : t('ignoreList.countFiltered', { filtered: filtered.length, total: entries.length });
    }
    if (clearSearchBtn) {
      clearSearchBtn.hidden = searchQuery.length === 0;
    }
  };

  const render = () => {
    if (!isStillOpen()) return;
    const entries = Array.isArray(state.ignoredUpdates) ? state.ignoredUpdates : [];
    const filtered = filterIgnoredEntries(entries, searchQuery);
    const clearBtnClass = confirmClearArmed ? 'btn btn-danger' : 'btn btn-ghost';
    const clearBtnLabel = confirmClearArmed ? `⚠️ ${t('ignoreList.clearArmed')}` : `🗑️ ${t('ignoreList.clearAll')}`;
    const footerText =
      filtered.length === entries.length
        ? t('ignoreList.countTotal', { count: entries.length })
        : t('ignoreList.countFiltered', { filtered: filtered.length, total: entries.length });

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>🙈 ${escapeHTML(t('ignoreList.title'))}</h2>
          <span class="muted">${escapeHTML(t('ignoreList.subtitle'))}</span>
        </div>
        <button type="button" class="icon-btn" data-ignore-action="close" title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(t('common.close'))}">✕</button>
      </div>

      <div class="modal-body ignore-modal-body">
        <div class="ignore-modal-toolbar">
          <div class="ignore-search-box">
            <input
              type="text"
              id="ignoreSearchInput"
              placeholder="${escapeHTML(t('ignoreList.searchPlaceholder'))}"
              value="${escapeHTML(searchQuery)}"
              autocomplete="off"
              ${isBusy ? 'disabled' : ''}
            >
            <button
              type="button"
              id="btnClearIgnoreSearch"
              class="clear-btn"
              data-ignore-action="clear-search"
              title="${escapeHTML(t('toolbar.clearSearch'))}"
              ${searchQuery.length === 0 ? 'hidden' : ''}
            >✕</button>
          </div>
          <div class="ignore-toolbar-actions">
            <button type="button" class="btn btn-ghost" data-ignore-action="export" ${entries.length === 0 || isBusy ? 'disabled' : ''}>
              📤 ${escapeHTML(t('common.export'))}
            </button>
            <button type="button" class="btn btn-ghost" data-ignore-action="import" ${isBusy ? 'disabled' : ''}>
              📥 ${escapeHTML(t('common.import'))}
            </button>
            <button type="button" id="btnIgnoreClearAll" class="${clearBtnClass}" data-ignore-action="clear-all" ${entries.length === 0 || isBusy ? 'disabled' : ''}>
              ${escapeHTML(clearBtnLabel)}
            </button>
          </div>
        </div>

        <div id="ignoreListContainer" class="ignore-list-items">
          ${buildEntriesListHtml(entries, filtered, { isBusy })}
        </div>
      </div>

      <div class="modal-footer">
        <span id="ignoreListFooterCount" class="muted">${escapeHTML(footerText)}</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-ignore-action="close" ${isBusy ? 'disabled' : ''}>${escapeHTML(t('common.close'))}</button>
        </div>
      </div>
    `;

    const searchInput = qsInput(modal, '#ignoreSearchInput');
    if (searchInput) {
      searchInput.oninput = () => {
        searchQuery = searchInput.value;
        updateFilteredListOnly();
      };
    }
  };

  overlay.hidden = false;
  render();

  await refreshIgnoredUpdates();
  if (!isStillOpen()) return;
  render();

  modal.onclick = async (e) => {
    const btn = closestButton(e.target, '[data-ignore-action]');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.ignoreAction;

    if (action === 'close') {
      disarmClear();
      closeModal();
      return;
    }

    if (action === 'clear-search') {
      searchQuery = '';
      const searchInput = qsInput(modal, '#ignoreSearchInput');
      if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
      }
      updateFilteredListOnly();
      return;
    }

    if (action === 'remove') {
      disarmClear();
      const entryId = btn.dataset.ignoreId || '';
      const entryName = btn.dataset.ignoreName || t('ignoreList.packageFallback');
      isBusy = true;
      render();
      try {
        const res = await window.electronAPI.removeIgnoredUpdate(entryId);
        if (res?.success) {
          state.ignoredUpdates = Array.isArray(res.entries) ? res.entries : [];
          await triggerCatalogReload();
          showToast(t('ignoreList.removedToast', { name: entryName }), { type: 'success' });
        } else {
          showToast(res?.error || t('ignoreList.removeErrorToast'), { type: 'error' });
        }
      } finally {
        isBusy = false;
        render();
      }
      return;
    }

    if (action === 'clear-all') {
      if (!confirmClearArmed) {
        confirmClearArmed = true;
        if (confirmClearTimer) clearTimeout(confirmClearTimer);
        confirmClearTimer = setTimeout(() => {
          confirmClearArmed = false;
          confirmClearTimer = null;
          if (isStillOpen()) render();
        }, 5000);
        render();
        return;
      }

      disarmClear();
      isBusy = true;
      render();
      try {
        const res = await window.electronAPI.clearIgnoredUpdates();
        if (res?.success) {
          state.ignoredUpdates = [];
          await triggerCatalogReload();
          showToast(t('ignoreList.clearedToast'), { type: 'success' });
        } else {
          showToast(res?.error || t('ignoreList.clearErrorToast'), { type: 'error' });
        }
      } finally {
        isBusy = false;
        render();
      }
      return;
    }

    if (action === 'export') {
      disarmClear();
      isBusy = true;
      render();
      try {
        const res = await window.electronAPI.exportIgnoredUpdates();
        if (res?.success) {
          showToast(t('ignoreList.exportedToast', { count: res.count || 0 }), { type: 'success' });
        } else if (res?.error && !res.canceled) {
          showToast(t('ignoreList.exportErrorToast', { error: res.error }), { type: 'error', duration: 6000 });
        }
      } finally {
        isBusy = false;
        render();
      }
      return;
    }

    if (action === 'import') {
      disarmClear();
      const existingCount = Array.isArray(state.ignoredUpdates) ? state.ignoredUpdates.length : 0;
      let importMode = 'merge';
      if (existingCount > 0) {
        const decision = await showImportModeDialog(existingCount);
        if (decision === 'cancel' || !isStillOpen()) return;
        importMode = decision;
      }

      isBusy = true;
      render();
      try {
        const res = await window.electronAPI.importIgnoredUpdates({ mode: importMode });
        if (res?.success) {
          state.ignoredUpdates = Array.isArray(res.entries) ? res.entries : [];
          await triggerCatalogReload();
          const summary =
            importMode === 'replace'
              ? t('ignoreList.importSummaryReplace', { added: res.added || 0 })
              : t('ignoreList.importSummaryMerge', {
                  added: res.added || 0,
                  updated: res.updated || 0,
                  skipped: res.skipped || 0,
                });
          showToast(t('ignoreList.importedToast', { summary }), { type: 'success', duration: 5000 });
        } else if (res?.error && !res.canceled) {
          showToast(t('ignoreList.importErrorToast', { error: res.error }), { type: 'error', duration: 6000 });
        }
      } finally {
        isBusy = false;
        render();
      }
    }
  };
}
