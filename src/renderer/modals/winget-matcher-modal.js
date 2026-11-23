import { showToast } from '../components/toast.js';
import { state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';

let activeMatcherToken = 0;

function getStageBadge(entry) {
  if (entry.stage === 'installed') {
    return '<span class="matcher-badge is-stage1">✅ Stufe 1 · PC-Treffer</span>';
  }
  if (entry.stage === 'search') {
    return '<span class="matcher-badge is-stage2">🔎 Stufe 2 · Vorschlag</span>';
  }
  return '<span class="matcher-badge is-none">Ohne Treffer</span>';
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
        <h2>🪄 Winget-IDs zuordnen</h2>
        <span class="muted">Zweistufiger Assistent für Archiv-Ordner ohne Paket-ID</span>
      </div>
      <button type="button" class="icon-btn" data-matcher-action="close" title="Schließen" aria-label="Schließen">✕</button>
    </div>

    <div class="modal-body matcher-body">
      <div class="matcher-loading-box">
        <strong>⏳ Analysiere Archiv-Ordner und suche Winget-Kandidaten...</strong>
        <p class="muted">
          Stufe 1 gleicht mit <code>winget export</code> (installierte PC-Programme) ab.<br>
          Stufe 2 sucht für übrige Ordner gedrosselt via <code>winget search</code> (jederzeit oben in der Job-Leiste abbrechbar).
        </p>
      </div>
    </div>

    <div class="modal-footer">
      <span class="muted">Suche läuft...</span>
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-matcher-action="close">Schließen</button>
      </div>
    </div>
  `;

  overlay.hidden = false;

  modal.onclick = (e) => {
    const btn = e.target.closest('[data-matcher-action="close"]');
    if (btn) closeModal();
  };

  const scanRes = await window.electronAPI.scanWingetMatches({ includeStage2: true });
  if (!isStillOpen()) return;

  if (!scanRes?.success) {
    modal.innerHTML = `
      <div class="modal-header">
        <h2>🪄 Winget-IDs zuordnen</h2>
        <button type="button" class="icon-btn" data-matcher-action="close" title="Schließen" aria-label="Schließen">✕</button>
      </div>
      <div class="modal-body">
        <div class="matcher-empty-box">
          <strong>Zuordnung konnte nicht gestartet werden</strong>
          <p class="muted">${escapeHTML(scanRes?.error || 'Unbekannter Fehler beim Winget-Abgleich.')}</p>
        </div>
      </div>
      <div class="modal-footer">
        <span></span>
        <button type="button" class="btn btn-primary" data-matcher-action="close">Schließen</button>
      </div>
    `;
    modal.onclick = (e) => {
      if (e.target.closest('[data-matcher-action="close"]')) closeModal();
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
            <strong>🎉 Alle ${scanRes.totalArchive || 0} Archiv-Ordner haben bereits eine Paket-ID!</strong>
            <p class="muted">Es wurden keine nicht zugeordneten Archiv-Einträge gefunden.</p>
          </div>
        `
        : filtered.length === 0
          ? `<div class="matcher-empty-box"><span class="muted">Keine Einträge entsprechen dem aktuellen Filter.</span></div>`
          : filtered
              .map((row) => {
                const hasCandidates = row.candidates.length > 0;
                const optionsHtml = hasCandidates
                  ? row.candidates
                      .map((cand) => {
                        const verStr = cand.version ? ` (v${cand.version})` : '';
                        const label = `${cand.name} — ${cand.packageId}${verStr}`;
                        return `<option value="${escapeHTML(cand.packageId)}" ${row.selectedPackageId === cand.packageId ? 'selected' : ''}>${escapeHTML(label)}</option>`;
                      })
                      .join('')
                  : '<option value="">Kein Winget-Kandidat gefunden</option>';

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
                        <span class="muted">${escapeHTML(row.matchReason || '')}</span>
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
          <h2>🪄 Winget-IDs zuordnen</h2>
          <span class="muted">${scanRes.alreadyLinked || 0} bereits verknüpft · ${rows.length} ohne Paket-ID</span>
        </div>
        <button type="button" class="icon-btn" data-matcher-action="close" title="Schließen" aria-label="Schließen">✕</button>
      </div>

      <div class="modal-body matcher-body">
        ${
          scanRes.partial
            ? '<div class="pkg-stale-notice">⚠️ Suche wurde vorzeitig abgebrochen – bereits gefundene Treffer werden angezeigt.</div>'
            : ''
        }

        <div class="matcher-summary-bar">
          <div class="matcher-kpi"><strong>${stats.stage1}</strong><span>Stufe 1 (Sicher)</span></div>
          <div class="matcher-kpi"><strong>${stats.stage2}</strong><span>Stufe 2 (Vorschläge)</span></div>
          <div class="matcher-kpi"><strong>${stats.unmatched}</strong><span>Ohne Treffer</span></div>
          <div class="matcher-kpi is-accent"><strong id="matcherSelectedCount">${selectedCount}</strong><span>Ausgewählt</span></div>
        </div>

        ${
          rows.length > 0
            ? `
              <div class="matcher-controls-bar">
                <input type="text" id="matcherSearchInput" value="${escapeHTML(filterText)}" placeholder="Ordner oder Winget-ID filtern...">
                <div class="matcher-filter-chips">
                  <button type="button" class="origin-chip ${stageFilter === 'all' ? 'active' : ''}" data-matcher-stage="all">Alle (${rows.length})</button>
                  <button type="button" class="origin-chip ${stageFilter === 'installed' ? 'active' : ''}" data-matcher-stage="installed">Stufe 1 (${stats.stage1})</button>
                  <button type="button" class="origin-chip ${stageFilter === 'search' ? 'active' : ''}" data-matcher-stage="search">Stufe 2 (${stats.stage2})</button>
                </div>
                <div class="matcher-bulk-btns">
                  <button type="button" class="btn btn-ghost btn-xs" data-matcher-action="select-stage1">Nur sichere</button>
                  <button type="button" class="btn btn-ghost btn-xs" data-matcher-action="select-all">Alle mit Vorschlag</button>
                  <button type="button" class="btn btn-ghost btn-xs" data-matcher-action="select-none">Keine</button>
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
        <span class="muted">Erst nach Bestätigung wird <code>_metadata/meta.json</code> aktualisiert.</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-matcher-action="close" ${isSaving ? 'disabled' : ''}>Abbrechen</button>
          <button type="button" class="btn btn-primary" id="btnApplyWingetMatches" data-matcher-action="apply" ${selectedCount === 0 || isSaving ? 'disabled' : ''}>
            ${isSaving ? '⏳ Speichere...' : `💾 Ausgewählte übernehmen (${selectedCount})`}
          </button>
        </div>
      </div>
    `;

    const searchInput = modal.querySelector('#matcherSearchInput');
    if (searchInput) {
      searchInput.oninput = () => {
        filterText = searchInput.value;
        const caret = searchInput.selectionStart;
        renderBody();
        const nextInput = modal.querySelector('#matcherSearchInput');
        if (nextInput) {
          nextInput.focus();
          if (typeof caret === 'number') nextInput.setSelectionRange(caret, caret);
        }
      };
    }
  };

  renderBody();

  modal.onchange = (e) => {
    const chk = e.target.closest('[data-matcher-check]');
    if (chk) {
      const row = rows.find((r) => r.itemId === chk.dataset.matcherCheck);
      if (row) {
        row.checked = chk.checked && Boolean(row.selectedPackageId);
        renderBody();
      }
      return;
    }

    const sel = e.target.closest('[data-matcher-select]');
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
    const stageBtn = e.target.closest('[data-matcher-stage]');
    if (stageBtn) {
      stageFilter = stageBtn.dataset.matcherStage;
      renderBody();
      return;
    }

    const btn = e.target.closest('[data-matcher-action]');
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
        showToast(`${res.savedCount} Winget-ID(s) in meta.json gespeichert.`, { type: 'success' });
        closeModal();
      } else {
        showToast(res?.errors?.[0] || 'Fehler beim Speichern der Zuordnungen.', { type: 'error', duration: 6000 });
        renderBody();
      }
    }
  };
}
