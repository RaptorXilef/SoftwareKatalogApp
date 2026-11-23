import { state } from '../state.js';
import { savePackageToArchive } from './archive-target-modal.js';
import { renderDetailModal, renderRemoteDetailModal } from './detail-modal.js';
import { renderEditModal } from './edit-modal.js';
import { renderSettingsModal } from './settings-modal.js';

let reloadHandler = async () => {};

export function initModals({ onReload } = {}) {
  if (typeof onReload === 'function') {
    reloadHandler = onReload;
  }
}

export async function triggerCatalogReload(opts) {
  await reloadHandler(opts);
}

export function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
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
