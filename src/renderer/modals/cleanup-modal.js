import { clampKeepVersions, DEFAULT_KEEP_VERSIONS, formatBytes } from '../../shared/archive-cleaner-logic.js';
import { showToast } from '../components/toast.js';
import { state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openNestedDialog } from './archive-target-modal.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';

let activeCleanupToken = 0;

function showCleanupConfirmDialog({ filesCount, reclaimBytes, action, keepVersions }) {
  const actionText =
    action === 'trash' ? 'in den Windows-Papierkorb verschoben' : 'in den jeweiligen Unterordner _archive verschoben';

  return openNestedDialog({
    defaultAction: 'cancel',
    html: `
      <div class="modal-header">
        <h2>🧹 Aufräumen bestätigen</h2>
        <button type="button" class="icon-btn" data-dialog-action="cancel" title="Abbrechen" aria-label="Abbrechen">✕</button>
      </div>
      <div class="modal-body collision-warning-body">
        <p>
          Es werden <strong>${filesCount} alte Setup-Datei(en)</strong> (${escapeHTML(formatBytes(reclaimBytes))})
          ${escapeHTML(actionText)}.
        </p>
        <div class="collision-meta-card">
          <div class="tech-row"><span>Behaltene Versionen</span><strong>Neueste ${keepVersions} pro Programm</strong></div>
          <div class="tech-row"><span>Zielaktion</span><strong>${action === 'trash' ? '🗑️ Papierkorb (shell.trashItem)' : '📦 Unterordner _archive'}</strong></div>
          <div class="tech-row"><span>Schutzregeln</span><strong>_last &amp; 🔒 Alle Versionen behalten werden übersprungen</strong></div>
        </div>
        <div class="collision-actions-grid">
          <button type="button" class="btn btn-ghost" data-dialog-action="cancel">Abbrechen</button>
          <button type="button" class="btn btn-danger" data-dialog-action="confirm">🧹 Jetzt aufräumen</button>
        </div>
      </div>
    `,
    onAction: (act) => (act === 'confirm' ? 'confirm' : 'cancel'),
  });
}

export async function renderCleanupModal() {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();

  const token = ++activeCleanupToken;
  state.currentModalId = null;
  state.isEditModalOpen = false;

  const isStillOpen = () => token === activeCleanupToken && !overlay.hidden;

  let keepVersions = DEFAULT_KEEP_VERSIONS;
  let targetAction = 'archive';
  let plan = null;
  let isLoading = true;
  let isExecuting = false;
  let loadError = '';

  const render = () => {
    if (!isStillOpen()) return;

    const candidates = plan?.candidates || [];
    const protectedItems = plan?.protectedItems || [];
    const totalFiles = plan?.totalFilesToRemove || 0;
    const totalBytes = plan?.totalReclaimBytes || 0;

    let previewHtml = '';
    if (isLoading) {
      previewHtml =
        '<div class="matcher-loading-box"><strong>⏳ Analysiere Archiv-Ordner und Versionen...</strong></div>';
    } else if (loadError) {
      previewHtml = `<div class="matcher-empty-box"><strong>Fehler:</strong> <span class="muted">${escapeHTML(loadError)}</span></div>`;
    } else if (candidates.length === 0) {
      previewHtml = `
        <div class="matcher-empty-box">
          <strong>✨ Alles sauber!</strong>
          <p class="muted">Keine ungeschützten Programme haben mehr als ${keepVersions} Version(en).</p>
        </div>
      `;
    } else {
      previewHtml = candidates
        .map((cand) => {
          const keptLabel = cand.keptFiles.map((f) => f.name).join(', ');
          return `
            <article class="cleanup-item-card">
              <div class="cleanup-item-head">
                <div class="cleanup-item-title">
                  <strong>${escapeHTML(cand.name)}</strong>
                  <span class="cleanup-reclaim-pill">${cand.filesToRemove.length} Datei(en) · ${escapeHTML(formatBytes(cand.reclaimBytes))}</span>
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs cleanup-lock-btn"
                  data-cleanup-action="lock-program"
                  data-item-path="${escapeHTML(cand.path)}"
                  data-item-name="${escapeHTML(cand.name)}"
                  title="Alle Versionen dauerhaft behalten (keepAllVersions: true)"
                  ${isExecuting ? 'disabled' : ''}
                >
                  🔒 Alle behalten
                </button>
              </div>
              <div class="cleanup-kept-hint">
                <span>Behalten (${cand.keptFiles.length}):</span>
                <code>${escapeHTML(keptLabel)}</code>
              </div>
              <ul class="cleanup-files-list">
                ${cand.filesToRemove
                  .map(
                    (f) => `
                      <li>
                        <code>${escapeHTML(f.name)}</code>
                        <span class="muted">${f.version ? `v${escapeHTML(f.version)} · ` : ''}${escapeHTML(formatBytes(f.size))}</span>
                      </li>
                    `
                  )
                  .join('')}
              </ul>
            </article>
          `;
        })
        .join('');
    }

    const protectedHtml =
      protectedItems.length > 0
        ? `
          <details class="cleanup-protected-drawer" ${candidates.length === 0 ? 'open' : ''}>
            <summary>🛡️ Geschützt (${protectedItems.length}) – wird niemals angefasst</summary>
            <div class="cleanup-protected-list">
              ${protectedItems
                .map((p) => {
                  const badges = [];
                  if (p.hasLastDir) badges.push('<span class="matcher-badge is-stage1">📌 _last-Ordner</span>');
                  if (p.keepAllVersions) badges.push('<span class="matcher-badge is-stage2">🔒 Alle Versionen</span>');
                  const canUnlock = p.keepAllVersions && !p.hasLastDir;
                  return `
                    <div class="cleanup-protected-row">
                      <div class="cleanup-protected-info">
                        <strong>${escapeHTML(p.name)}</strong>
                        <div class="cleanup-protected-badges">${badges.join('')}</div>
                      </div>
                      <div class="cleanup-protected-meta">
                        <span class="muted">${p.totalFiles} Datei(en) · ${escapeHTML(formatBytes(p.totalBytes))}</span>
                        ${
                          canUnlock
                            ? `<button type="button" class="btn btn-ghost btn-xs" data-cleanup-action="unlock-program" data-item-path="${escapeHTML(p.path)}" data-item-name="${escapeHTML(p.name)}" ${isExecuting ? 'disabled' : ''}>🔓 Schutz aufheben</button>`
                            : ''
                        }
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </details>
        `
        : '';

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>🧹 Archiv aufräumen</h2>
          <span class="muted">Manuelle Bereinigung alter Setup-Versionen (<code>_last</code> &amp; 🔒 bleiben immer geschützt)</span>
        </div>
        <button type="button" class="icon-btn" data-cleanup-action="close" title="Schließen" aria-label="Schließen">✕</button>
      </div>

      <div class="modal-body cleanup-body">
        <div class="cleanup-config-grid">
          <label class="form-field">
            <span>Wie viele neueste Versionen pro Programm behalten?</span>
            <input type="number" id="cleanupKeepInput" min="1" max="50" value="${keepVersions}" ${isExecuting ? 'disabled' : ''}>
          </label>

          <div class="form-field">
            <span>Zielaktion für ältere Dateien</span>
            <div class="cleanup-action-radios">
              <label class="radio-card cleanup-radio">
                <input type="radio" name="cleanupAction" value="archive" ${targetAction === 'archive' ? 'checked' : ''} ${isExecuting ? 'disabled' : ''}>
                <div>
                  <strong>📦 In Unterordner <code>_archive</code> verschieben</strong>
                  <p>Sicher umorganisieren (jederzeit wiederherstellbar)</p>
                </div>
              </label>
              <label class="radio-card cleanup-radio">
                <input type="radio" name="cleanupAction" value="trash" ${targetAction === 'trash' ? 'checked' : ''} ${isExecuting ? 'disabled' : ''}>
                <div>
                  <strong>🗑️ In Papierkorb verschieben</strong>
                  <p>Über Windows-Papierkorb (<code>shell.trashItem</code>)</p>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div class="matcher-summary-bar">
          <div class="matcher-kpi"><strong>${candidates.length}</strong><span>Betroffene Programme</span></div>
          <div class="matcher-kpi"><strong>${totalFiles}</strong><span>Betroffene Dateien</span></div>
          <div class="matcher-kpi is-accent"><strong>${escapeHTML(formatBytes(totalBytes))}</strong><span>Freiwerdender Speicher</span></div>
          <div class="matcher-kpi"><strong>${protectedItems.length}</strong><span>Geschützt</span></div>
        </div>

        <div class="cleanup-preview-list">
          ${previewHtml}
        </div>

        ${protectedHtml}
      </div>

      <div class="modal-footer">
        <span class="muted">Läuft ausschließlich nach deiner Bestätigung.</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-cleanup-action="close" ${isExecuting ? 'disabled' : ''}>Schließen</button>
          <button type="button" class="btn btn-danger" data-cleanup-action="execute" ${totalFiles === 0 || isLoading || isExecuting ? 'disabled' : ''}>
            ${isExecuting ? '⏳ Räume auf...' : `🧹 Aufräumen (${totalFiles} Datei(en) · ${escapeHTML(formatBytes(totalBytes))})`}
          </button>
        </div>
      </div>
    `;

    const keepInput = modal.querySelector('#cleanupKeepInput');
    if (keepInput) {
      keepInput.onchange = async () => {
        keepVersions = clampKeepVersions(keepInput.value);
        keepInput.value = String(keepVersions);
        await refreshPreview();
      };
    }

    modal.querySelectorAll('input[name="cleanupAction"]').forEach((radio) => {
      radio.onchange = () => {
        if (radio.checked) {
          targetAction = radio.value === 'trash' ? 'trash' : 'archive';
        }
      };
    });
  };

  const refreshPreview = async () => {
    isLoading = true;
    loadError = '';
    render();
    const res = await window.electronAPI.previewArchiveCleanup({ keepVersions });
    if (!isStillOpen()) return;
    isLoading = false;
    if (res?.success) {
      plan = res.plan;
    } else {
      loadError = res?.error || 'Vorschau konnte nicht erstellt werden.';
    }
    render();
  };

  overlay.hidden = false;

  modal.onclick = async (e) => {
    const btn = e.target.closest('[data-cleanup-action]');
    if (!btn) return;
    const action = btn.dataset.cleanupAction;

    if (action === 'close') {
      closeModal();
    } else if (action === 'lock-program' || action === 'unlock-program') {
      const itemPath = btn.dataset.itemPath;
      const itemName = btn.dataset.itemName || 'Programm';
      const nextKeep = action === 'lock-program';
      btn.disabled = true;
      const res = await window.electronAPI.setKeepAllVersions(itemPath, nextKeep);
      if (!isStillOpen()) return;
      if (res?.success) {
        showToast(
          nextKeep ? `🔒 ${itemName} dauerhaft vom Aufräumen ausgeschlossen.` : `🔓 Schutz für ${itemName} aufgehoben.`,
          { type: 'success' }
        );
        await triggerCatalogReload();
        await refreshPreview();
      } else {
        showToast(res?.error || 'Einstellung konnte nicht gespeichert werden.', { type: 'error' });
        btn.disabled = false;
      }
    } else if (action === 'execute') {
      const totalFiles = plan?.totalFilesToRemove || 0;
      const totalBytes = plan?.totalReclaimBytes || 0;
      if (totalFiles === 0) return;

      const decision = await showCleanupConfirmDialog({
        filesCount: totalFiles,
        reclaimBytes: totalBytes,
        action: targetAction,
        keepVersions,
      });
      if (decision !== 'confirm' || !isStillOpen()) return;

      isExecuting = true;
      render();

      const res = await window.electronAPI.executeArchiveCleanup({
        keepVersions,
        action: targetAction,
      });
      if (!isStillOpen()) return;

      isExecuting = false;
      if (res?.success) {
        await triggerCatalogReload();
        showToast(`${res.processedFiles} Datei(en) bereinigt (${formatBytes(res.freedBytes)}).`, {
          type: res.errors?.length ? 'warn' : 'success',
        });
        await refreshPreview();
      } else if (!res?.canceled) {
        showToast(res?.error || 'Aufräumen fehlgeschlagen.', { type: 'error', duration: 6000 });
        render();
      } else {
        await refreshPreview();
      }
    }
  };

  await refreshPreview();
}
