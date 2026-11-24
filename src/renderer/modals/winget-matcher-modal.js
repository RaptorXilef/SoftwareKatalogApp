import { showToast } from '../components/toast.js';
import { state } from '../state.js';
import { closestEl, closestInput, closestSelect, qsInput } from '../utils/dom.js';
import { t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';

let activeMatcherToken = 0;

function getStageBadge(entry) {
  if (entry.stage === 'installed') {
    return `<span class="matcher-badge is-stage1">✅ ${escapeHTML(t('wingetMatcher.stage1Badge'))}</span>`;
  }
  if (entry.stage === 'search') {
    return `<span class="matcher-badge is-stage2">🔎 ${escapeHTML(t('wingetMatcher.stage2Badge'))}</span>`;
  }
  return `<span class="matcher-badge is-none">${escapeHTML(t('wingetMatcher.noMatchBadge'))}</span>`;
}

export async function renderWingetMatcherModal() {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();

  const token = ++activeMatcherToken;
  state.currentModalId = null;
  state.isEditModalOpen = false;

  const isStillOpen = () => token === activeMatcherToken && !overlay.hidden;

  modal.innerHTML = `
    <div class="modal-header">
      <div>
        <h2>🪄 ${escapeHTML(t('wingetMatcher.title'))}</h2>
        <span class="muted">${escapeHTML(t('wingetMatcher.loadingSubtitle'))}</span>
      </div>
      <button type="button" class="icon-btn" data-matcher-action="close" title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(t('common.close'))}">✕</button>
    </div>

    <div class="modal-body matcher-body">
      <div class="matcher-loading-box">
        <strong>⏳ ${escapeHTML(t('wingetMatcher.loadingHeadline'))}</strong>
        <p class="muted">
          ${escapeHTML(t('wingetMatcher.loadingLine1'))}<br>
          ${escapeHTML(t('wingetMatcher.loadingLine2'))}
        </p>
      </div>
    </div>

    <div class="modal-footer">
      <span class="muted">${escapeHTML(t('wingetMatcher.searchingFooter'))}</span>
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-matcher-action="close">${escapeHTML(t('common.close'))}</button>
      </div>
    </div>
  `;

  overlay.hidden = false;

  modal.onclick = (e) => {
    const btn = closestEl(e.target, '[data-matcher-action="close"]');
    if (btn) closeModal();
  };

  const scanRes = await window.electronAPI.scanWingetMatches({ includeStage2: true });
  if (!isStillOpen()) return;

  if (!scanRes?.success) {
    modal.innerHTML = `
      <div class="modal-header">
        <h2>🪄 ${escapeHTML(t('wingetMatcher.title'))}</h2>
        <button type="button" class="icon-btn" data-matcher-action="close" title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(t('common.close'))}">✕</button>
      </div>
      <div class="modal-body">
        <div class="matcher-empty-box">
          <strong>${escapeHTML(t('wingetMatcher.errorHeadline'))}</strong>
          <p class="muted">${escapeHTML(scanRes?.error || t('wingetMatcher.errorUnknown'))}</p>
        </div>
      </div>
      <div class="modal-footer">
        <span></span>
        <button type="button" class="btn btn-primary" data-matcher-action="close">${escapeHTML(t('common.close'))}</button>
      </div>
    `;
    modal.onclick = (e) => {
      if (closestEl(e.target, '[data-matcher-action="close"]')) closeModal();
    };
    return;
  }

  const rows = (scanRes.entries || []).map((entry) => ({
    ...entry,
    checked: Boolean(entry.preselected && entry.selectedPackageId),
  }));

  let filterText = '';
  let stageFilter = 'all';
  let isSaving = false;

  const getFilteredRows = () => {
    const q = filterText.trim().toLowerCase();
    return rows.filter((row) => {
      if (stageFilter === 'installed' && row.stage !== 'installed') return false;
      if (stageFilter === 'search' && row.stage !== 'search') return false;
      if (!q) return true;
      const haystack = [row.itemName, row.folderName, row.selectedPackageId, ...row.candidates.map((c) => c.packageId)]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  };

  const renderBody = () => {
    const selectedCount = rows.filter((r) => r.checked && r.selectedPackageId).length;
    const filtered = getFilteredRows();
    const stats = scanRes.stats || { stage1: 0, stage2: 0, unmatched: 0 };

    const listHtml =
      rows.length === 0
        ? `
          <div class="matcher-empty-box">
            <strong>🎉 ${escapeHTML(t('wingetMatcher.allLinkedTitle', { total: scanRes.totalArchive || 0 }))}</strong>
            <p class="muted">${escapeHTML(t('wingetMatcher.allLinkedDesc'))}</p>
          </div>
        `
        : filtered.length === 0
          ? `<div class="matcher-empty-box"><span class="muted">${escapeHTML(t('wingetMatcher.noFilterMatches'))}</span></div>`
          : filtered
              .map((row) => {
                const hasCandidates = row.candidates.length > 0;
                const optionsHtml = hasCandidates
                  ? row.candidates
                      .map((cand) => {
                        const verStr = cand.version ? ` (v${cand.version})` : '';
                        const label = `${cand.name} - ${cand.packageId}${verStr}`;
                        return `<option value="${escapeHTML(cand.packageId)}" ${row.selectedPackageId === cand.packageId ? 'selected' : ''}>${escapeHTML(label)}</option>`;
                      })
                      .join('')
                  : `<option value="">${escapeHTML(t('wingetMatcher.noCandidatesOption'))}</option>`;
                const reasonText = row.matchReasonKey
                  ? t(row.matchReasonKey, row.matchReasonParams || {})
                  : row.matchReason || '';

                return `
                  <div class="matcher-row ${row.checked ? 'is-checked' : ''} ${!hasCandidates ? 'is-disabled' : ''}" data-matcher-item-id="${escapeHTML(row.itemId)}">
                    <label class="matcher-check-col">
                      <input type="checkbox" class="matcher-checkbox" data-matcher-check="${escapeHTML(row.itemId)}" ${row.checked ? 'checked' : ''} ${!hasCandidates || isSaving ? 'disabled' : ''}>
                    </label>
                    <div class="matcher-info-col">
                      <div class="matcher-title-line">
                        <strong>${escapeHTML(row.itemName)}</strong>
                        ${getStageBadge(row)}
                      </div>
                      <div class="matcher-meta-line">
                        <code>${escapeHTML(row.folderName || row.itemPath)}</code>
                        <span class="muted">${escapeHTML(reasonText)}</span>
                      </div>
                    </div>
                    <div class="matcher-select-col">
                      <select class="matcher-select" data-matcher-select="${escapeHTML(row.itemId)}" ${!hasCandidates || isSaving ? 'disabled' : ''}>
                        ${optionsHtml}
                      </select>
                    </div>
                  </div>
                `;
              })
              .join('');

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>🪄 ${escapeHTML(t('wingetMatcher.title'))}</h2>
          <span class="muted">${escapeHTML(t('wingetMatcher.subtitleStats', { linked: scanRes.alreadyLinked || 0, unmatched: rows.length }))}</span>
        </div>
        <button type="button" class="icon-btn" data-matcher-action="close" title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(t('common.close'))}">✕</button>
      </div>

      <div class="modal-body matcher-body">
        ${
          scanRes.partial ? `<div class="pkg-stale-notice">⚠️ ${escapeHTML(t('wingetMatcher.partialNotice'))}</div>` : ''
        }

        <div class="matcher-summary-bar">
          <div class="matcher-kpi"><strong>${stats.stage1}</strong><span>${escapeHTML(t('wingetMatcher.kpiStage1'))}</span></div>
          <div class="matcher-kpi"><strong>${stats.stage2}</strong><span>${escapeHTML(t('wingetMatcher.kpiStage2'))}</span></div>
          <div class="matcher-kpi"><strong>${stats.unmatched}</strong><span>${escapeHTML(t('wingetMatcher.kpiUnmatched'))}</span></div>
          <div class="matcher-kpi is-accent"><strong id="matcherSelectedCount">${selectedCount}</strong><span>${escapeHTML(t('wingetMatcher.kpiSelected'))}</span></div>
        </div>

        ${
          rows.length > 0
            ? `
              <div class="matcher-controls-bar">
                <input type="text" id="matcherSearchInput" value="${escapeHTML(filterText)}" placeholder="${escapeHTML(t('wingetMatcher.filterPlaceholder'))}">
                <div class="matcher-filter-chips">
                  <button type="button" class="origin-chip ${stageFilter === 'all' ? 'active' : ''}" data-matcher-stage="all">${escapeHTML(t('wingetMatcher.chipAll', { count: rows.length }))}</button>
                  <button type="button" class="origin-chip ${stageFilter === 'installed' ? 'active' : ''}" data-matcher-stage="installed">${escapeHTML(t('wingetMatcher.chipStage1', { count: stats.stage1 }))}</button>
                  <button type="button" class="origin-chip ${stageFilter === 'search' ? 'active' : ''}" data-matcher-stage="search">${escapeHTML(t('wingetMatcher.chipStage2', { count: stats.stage2 }))}</button>
                </div>
                <div class="matcher-bulk-btns">
                  <button type="button" class="btn btn-ghost btn-xs" data-matcher-action="select-stage1">${escapeHTML(t('wingetMatcher.btnSelectStage1'))}</button>
                  <button type="button" class="btn btn-ghost btn-xs" data-matcher-action="select-all">${escapeHTML(t('wingetMatcher.btnSelectAll'))}</button>
                  <button type="button" class="btn btn-ghost btn-xs" data-matcher-action="select-none">${escapeHTML(t('wingetMatcher.btnSelectNone'))}</button>
                </div>
              </div>
            `
            : ''
        }

        <div class="matcher-list">
          ${listHtml}
        </div>
      </div>

      <div class="modal-footer">
        <span class="muted">${escapeHTML(t('wingetMatcher.footerHint'))}</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-matcher-action="close" ${isSaving ? 'disabled' : ''}>${escapeHTML(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" id="btnApplyWingetMatches" data-matcher-action="apply" ${selectedCount === 0 || isSaving ? 'disabled' : ''}>
            ${isSaving ? `⏳ ${escapeHTML(t('common.saving'))}` : `💾 ${escapeHTML(t('wingetMatcher.applyBtn', { count: selectedCount }))}`}
          </button>
        </div>
      </div>
    `;

    const searchInput = qsInput(modal, '#matcherSearchInput');
    if (searchInput) {
      searchInput.oninput = () => {
        filterText = searchInput.value;
        const caret = searchInput.selectionStart;
        renderBody();
        const nextInput = qsInput(modal, '#matcherSearchInput');
        if (nextInput) {
          nextInput.focus();
          if (typeof caret === 'number') nextInput.setSelectionRange(caret, caret);
        }
      };
    }
  };

  renderBody();

  modal.onchange = (e) => {
    const chk = closestInput(e.target, '[data-matcher-check]');
    if (chk) {
      const row = rows.find((r) => r.itemId === chk.dataset.matcherCheck);
      if (row) {
        row.checked = chk.checked && Boolean(row.selectedPackageId);
        renderBody();
      }
      return;
    }

    const sel = closestSelect(e.target, '[data-matcher-select]');
    if (sel) {
      const row = rows.find((r) => r.itemId === sel.dataset.matcherSelect);
      if (row) {
        row.selectedPackageId = sel.value;
        row.checked = Boolean(sel.value);
        renderBody();
      }
    }
  };

  modal.onclick = async (e) => {
    const stageBtn = closestEl(e.target, '[data-matcher-stage]');
    if (stageBtn) {
      stageFilter = stageBtn.dataset.matcherStage;
      renderBody();
      return;
    }

    const btn = closestEl(e.target, '[data-matcher-action]');
    if (!btn) return;
    const action = btn.dataset.matcherAction;

    if (action === 'close') {
      closeModal();
    } else if (action === 'select-stage1') {
      for (const r of rows) {
        r.checked = r.stage === 'installed' && Boolean(r.selectedPackageId);
      }
      renderBody();
    } else if (action === 'select-all') {
      for (const r of rows) {
        r.checked = Boolean(r.selectedPackageId);
      }
      renderBody();
    } else if (action === 'select-none') {
      for (const r of rows) {
        r.checked = false;
      }
      renderBody();
    } else if (action === 'apply') {
      const assignments = rows
        .filter((r) => r.checked && r.selectedPackageId)
        .map((r) => ({
          itemId: r.itemId,
          itemName: r.itemName,
          itemPath: r.itemPath,
          packageManager: 'winget',
          packageId: r.selectedPackageId,
        }));

      if (assignments.length === 0) return;

      isSaving = true;
      renderBody();

      const res = await window.electronAPI.applyWingetMatches(assignments);
      if (!isStillOpen()) return;

      isSaving = false;
      if (res?.success) {
        await triggerCatalogReload();
        showToast(t('wingetMatcher.savedToast', { count: res.savedCount }), { type: 'success' });
        closeModal();
      } else {
        showToast(res?.errors?.[0] || t('wingetMatcher.saveErrorToast'), { type: 'error', duration: 6000 });
        renderBody();
      }
    }
  };
}
