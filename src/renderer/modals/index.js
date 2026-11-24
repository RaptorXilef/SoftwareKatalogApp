import { state } from '../state.js';
import { savePackageToArchive } from './archive-target-modal.js';
import { renderBundleEditorModal } from './bundle-editor-modal.js';
import { renderBundleRunnerModal } from './bundle-runner-modal.js';
import { renderCleanupModal } from './cleanup-modal.js';
import { renderDetailModal, renderRemoteDetailModal } from './detail-modal.js';
import { renderEditModal } from './edit-modal.js';
import { renderSettingsModal } from './settings-modal.js';
import { renderWingetMatcherModal } from './winget-matcher-modal.js';

/** @type {(opts?: any) => Promise<void> | void} */
let reloadHandler = async () => {};

/**
 * @param {{ onReload?: (opts?: any) => Promise<void> | void }} [options]
 */
export function initModals({ onReload } = {}) {
  if (typeof onReload === 'function') {
    reloadHandler = onReload;
  }
}

/** @param {any} [opts] */
export async function triggerCatalogReload(opts) {
  await reloadHandler(opts);
}

export function resetModalContent() {
  const content = document.getElementById('modalContent');
  if (!content) return;
  content.onclick = null;
  content.onchange = null;
  content.oninput = null;
  content.ondragstart = null;
  content.ondragover = null;
  content.ondragleave = null;
  content.ondrop = null;
  content.ondragend = null;
}

export function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  resetModalContent();
  if (overlay) overlay.hidden = true;
  if (content) content.innerHTML = '';
  state.currentModalId = null;
  state.isEditModalOpen = false;
}

export function openDetailModal(id, options = {}) {
  renderDetailModal(id, options);
}

export function openEditModal(id, initialTab = 'general') {
  renderEditModal(id, initialTab);
}

export function openSettingsModal() {
  renderSettingsModal();
}

export function openProviderPackageModal(providerId, packageId, summary = {}, options = {}) {
  renderRemoteDetailModal(providerId, packageId, summary, options);
}

export function openArchiveLinkModal(pkg, options = {}) {
  const defaultMode = state.settings.archiveSaveMode === 'auto-id' ? 'auto-id' : 'ask';
  return savePackageToArchive(pkg, {
    mode: options.mode || defaultMode,
    downloadSetup: options.downloadSetup ?? true,
    onLinked: options.onLinked || null,
  });
}

export function openWingetMatcherModal() {
  return renderWingetMatcherModal();
}

export function openCleanupModal() {
  return renderCleanupModal();
}

export function openBundleEditorModal(options = {}) {
  return renderBundleEditorModal(options);
}

export function openBundleRunnerModal(bundleId, options = {}) {
  return renderBundleRunnerModal(bundleId, options);
}
