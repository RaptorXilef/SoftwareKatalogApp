import { clampKeepVersions, DEFAULT_KEEP_VERSIONS, formatBytes } from '../../shared/archive-cleaner-logic.js';
import { showToast } from '../components/toast.js';
import { state } from '../state.js';
import { closestButton, qsaInputs, qsInput } from '../utils/dom.js';
import { getI18nLocale, t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openNestedDialog } from './archive-target-modal.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';

let activeCleanupToken = 0;

function showCleanupConfirmDialog({ filesCount, reclaimBytes, action, keepVersions }) {
  const locale = getI18nLocale() || 'en';
  const actionText = action === 'trash' ? t('cleanup.confirmActionTrash') : t('cleanup.confirmActionArchive');
  const filesLabel = t('cleanup.confirmFilesCount', { count: filesCount });
  const sizeLabel = formatBytes(reclaimBytes, locale);
  const bodyToken = '__FILES_TOKEN__';
  const bodyTemplate = t('cleanup.confirmBody', { files: bodyToken, size: sizeLabel, action: actionText });
  const [bodyBefore, bodyAfter = ''] = bodyTemplate.split(bodyToken);

  return openNestedDialog({
    defaultAction: 'cancel',
    html: `
      <div class="modal-header">
        <h2>🧹 ${escapeHTML(t('cleanup.confirmTitle'))}</h2>
        <button type="button" class="icon-btn" data-dialog-action="cancel" title="${escapeHTML(t('common.cancel'))}" aria-label="${escapeHTML(t('common.cancel'))}">✕</button>
      </div>
      <div class="modal-body collision-warning-body">
        <p>
          ${escapeHTML(bodyBefore)}<strong>${escapeHTML(filesLabel)}</strong>${escapeHTML(bodyAfter)}
        </p>
        <div class="collision-meta-card">
          <div class="tech-row"><span>${escapeHTML(t('cleanup.keptVersionsLabel'))}</span><strong>${escapeHTML(t('cleanup.keptVersionsValue', { count: keepVersions }))}</strong></div>
          <div class="tech-row"><span>${escapeHTML(t('cleanup.targetActionLabel'))}</span><strong>${action === 'trash' ? `🗑️ ${escapeHTML(t('cleanup.targetTrashShort'))}` : `📦 ${escapeHTML(t('cleanup.targetArchiveShort'))}`}</strong></div>
          <div class="tech-row"><span>${escapeHTML(t('cleanup.protectionRulesLabel'))}</span><strong>${escapeHTML(t('cleanup.protectionRulesValuePrefix'))}🔒 ${escapeHTML(t('cleanup.protectionRulesValueSuffix'))}</strong></div>
        </div>
        <div class="collision-actions-grid">
          <button type="button" class="btn btn-ghost" data-dialog-action="cancel">${escapeHTML(t('common.cancel'))}</button>
          <button type="button" class="btn btn-danger" data-dialog-action="confirm">🧹 ${escapeHTML(t('cleanup.confirmExecute'))}</button>
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

    const locale = getI18nLocale() || 'en';
    const candidates = plan?.candidates || [];
    const protectedItems = plan?.protectedItems || [];
    const totalFiles = plan?.totalFilesToRemove || 0;
    const totalBytes = plan?.totalReclaimBytes || 0;

    let previewHtml = '';
    if (isLoading) {
      previewHtml = `<div class="matcher-loading-box"><strong>⏳ ${escapeHTML(t('cleanup.loadingPreview'))}</strong></div>`;
    } else if (loadError) {
      previewHtml = `<div class="matcher-empty-box"><strong>${escapeHTML(t('cleanup.errorLabel'))}</strong> <span class="muted">${escapeHTML(loadError)}</span></div>`;
    } else if (candidates.length === 0) {
      previewHtml = `
        <div class="matcher-empty-box">
          <strong>✨ ${escapeHTML(t('cleanup.allCleanTitle'))}</strong>
          <p class="muted">${escapeHTML(t('cleanup.allCleanDesc', { count: keepVersions }))}</p>
        </div>
      `;
    } else {
      previewHtml = candidates
        .map((cand) => {
          const keptLabel = cand.keptFiles.map((f) => f.name).join(', ');
          const pillLabel = t('cleanup.filesPill', {
            count: cand.filesToRemove.length,
            size: formatBytes(cand.reclaimBytes, locale),
          });
          return `
            <article class="cleanup-item-card">
              <div class="cleanup-item-head">
                <div class="cleanup-item-title">
                  <strong>${escapeHTML(cand.name)}</strong>
                  <span class="cleanup-reclaim-pill">${escapeHTML(pillLabel)}</span>
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs cleanup-lock-btn"
                  data-cleanup-action="lock-program"
                  data-item-path="${escapeHTML(cand.path)}"
                  data-item-name="${escapeHTML(cand.name)}"
                  title="${escapeHTML(t('cleanup.lockBtnTitle'))}"
                  ${isExecuting ? 'disabled' : ''}
                >
                  🔒 ${escapeHTML(t('cleanup.lockBtnLabel'))}
                </button>
              </div>
              <div class="cleanup-kept-hint">
                <span>${escapeHTML(t('cleanup.keptLabel', { count: cand.keptFiles.length }))}</span>
                <code>${escapeHTML(keptLabel)}</code>
              </div>
              <ul class="cleanup-files-list">
                ${cand.filesToRemove
                  .map(
                    (f) => `
                      <li>
                        <code>${escapeHTML(f.name)}</code>
                        <span class="muted">${f.version ? `v${escapeHTML(f.version)} · ` : ''}${escapeHTML(formatBytes(f.size, locale))}</span>
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
            <summary>🛡️ ${escapeHTML(t('cleanup.protectedDrawer', { count: protectedItems.length }))}</summary>
            <div class="cleanup-protected-list">
              ${protectedItems
                .map((p) => {
                  const badges = [];
                  if (p.hasLastDir)
                    badges.push(
                      `<span class="matcher-badge is-stage1">📌 ${escapeHTML(t('cleanup.badgeLastDir'))}</span>`
                    );
                  if (p.keepAllVersions)
                    badges.push(
                      `<span class="matcher-badge is-stage2">🔒 ${escapeHTML(t('cleanup.badgeKeepAll'))}</span>`
                    );
                  const canUnlock = p.keepAllVersions && !p.hasLastDir;
                  const metaLabel = t('cleanup.filesPill', {
                    count: p.totalFiles,
                    size: formatBytes(p.totalBytes, locale),
                  });
                  return `
                    <div class="cleanup-protected-row">
                      <div class="cleanup-protected-info">
                        <strong>${escapeHTML(p.name)}</strong>
                        <div class="cleanup-protected-badges">${badges.join('')}</div>
                      </div>
                      <div class="cleanup-protected-meta">
                        <span class="muted">${escapeHTML(metaLabel)}</span>
                        ${
                          canUnlock
                            ? `<button type="button" class="btn btn-ghost btn-xs" data-cleanup-action="unlock-program" data-item-path="${escapeHTML(p.path)}" data-item-name="${escapeHTML(p.name)}" ${isExecuting ? 'disabled' : ''}>🔓 ${escapeHTML(t('cleanup.unlockBtn'))}</button>`
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
          <h2>🧹 ${escapeHTML(t('cleanup.modalTitle'))}</h2>
          <span class="muted">${escapeHTML(t('cleanup.modalSubtitle'))}</span>
        </div>
        <button type="button" class="icon-btn" data-cleanup-action="close" title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(t('common.close'))}">✕</button>
      </div>

      <div class="modal-body cleanup-body">
        <div class="cleanup-config-grid">
          <label class="form-field">
            <span>${escapeHTML(t('cleanup.keepVersionsInputLabel'))}</span>
            <input type="number" id="cleanupKeepInput" min="1" max="50" value="${keepVersions}" ${isExecuting ? 'disabled' : ''}>
          </label>

          <div class="form-field">
            <span>${escapeHTML(t('cleanup.targetActionFieldLabel'))}</span>
            <div class="cleanup-action-radios">
              <label class="radio-card cleanup-radio">
                <input type="radio" name="cleanupAction" value="archive" ${targetAction === 'archive' ? 'checked' : ''} ${isExecuting ? 'disabled' : ''}>
                <div>
                  <strong>📦 ${escapeHTML(t('cleanup.radioArchiveTitle'))}</strong>
                  <p>${escapeHTML(t('cleanup.radioArchiveDesc'))}</p>
                </div>
              </label>
              <label class="radio-card cleanup-radio">
                <input type="radio" name="cleanupAction" value="trash" ${targetAction === 'trash' ? 'checked' : ''} ${isExecuting ? 'disabled' : ''}>
                <div>
                  <strong>🗑️ ${escapeHTML(t('cleanup.radioTrashTitle'))}</strong>
                  <p>${escapeHTML(t('cleanup.radioTrashDesc'))}</p>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div class="matcher-summary-bar">
          <div class="matcher-kpi"><strong>${candidates.length}</strong><span>${escapeHTML(t('cleanup.kpiPrograms'))}</span></div>
          <div class="matcher-kpi"><strong>${totalFiles}</strong><span>${escapeHTML(t('cleanup.kpiFiles'))}</span></div>
          <div class="matcher-kpi is-accent"><strong>${escapeHTML(formatBytes(totalBytes, locale))}</strong><span>${escapeHTML(t('cleanup.kpiReclaim'))}</span></div>
          <div class="matcher-kpi"><strong>${protectedItems.length}</strong><span>${escapeHTML(t('cleanup.kpiProtected'))}</span></div>
        </div>

        <div class="cleanup-preview-list">
          ${previewHtml}
        </div>

        ${protectedHtml}
      </div>

      <div class="modal-footer">
        <span class="muted">${escapeHTML(t('cleanup.footerHint'))}</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-cleanup-action="close" ${isExecuting ? 'disabled' : ''}>${escapeHTML(t('common.close'))}</button>
          <button type="button" class="btn btn-danger" data-cleanup-action="execute" ${totalFiles === 0 || isLoading || isExecuting ? 'disabled' : ''}>
            ${
              isExecuting
                ? `⏳ ${escapeHTML(t('cleanup.executing'))}`
                : `🧹 ${escapeHTML(t('cleanup.executeBtn', { count: totalFiles, size: formatBytes(totalBytes, locale) }))}`
            }
          </button>
        </div>
      </div>
    `;

    const keepInput = qsInput(modal, '#cleanupKeepInput');
    if (keepInput) {
      keepInput.onchange = async () => {
        keepVersions = clampKeepVersions(keepInput.value);
        keepInput.value = String(keepVersions);
        await refreshPreview();
      };
    }

    qsaInputs(modal, 'input[name="cleanupAction"]').forEach((radio) => {
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
      loadError = res?.error || t('cleanup.previewError');
    }
    render();
  };

  overlay.hidden = false;

  modal.onclick = async (e) => {
    const btn = closestButton(e.target, '[data-cleanup-action]');
    if (!btn) return;
    const action = btn.dataset.cleanupAction;

    if (action === 'close') {
      closeModal();
    } else if (action === 'lock-program' || action === 'unlock-program') {
      const itemPath = btn.dataset.itemPath;
      const itemName = btn.dataset.itemName || t('cleanup.programFallback');
      const nextKeep = action === 'lock-program';
      btn.disabled = true;
      const res = await window.electronAPI.setKeepAllVersions(itemPath, nextKeep);
      if (!isStillOpen()) return;
      if (res?.success) {
        showToast(
          nextKeep
            ? `🔒 ${t('cleanup.lockSuccess', { name: itemName })}`
            : `🔓 ${t('cleanup.unlockSuccess', { name: itemName })}`,
          { type: 'success' }
        );
        await triggerCatalogReload();
        await refreshPreview();
      } else {
        showToast(res?.error || t('cleanup.saveKeepError'), { type: 'error' });
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
        const locale = getI18nLocale() || 'en';
        await triggerCatalogReload();
        showToast(t('cleanup.doneToast', { count: res.processedFiles, size: formatBytes(res.freedBytes, locale) }), {
          type: res.errors?.length ? 'warn' : 'success',
        });
        await refreshPreview();
      } else if (!res?.canceled) {
        showToast(res?.error || t('cleanup.failedToast'), { type: 'error', duration: 6000 });
        render();
      } else {
        await refreshPreview();
      }
    }
  };

  await refreshPreview();
}
