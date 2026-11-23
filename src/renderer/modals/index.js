import { state } from '../state.js';
import { renderDetailModal } from './detail-modal.js';
import { renderEditModal } from './edit-modal.js';
import { renderArchiveLinkModal, renderProviderPackageModal } from './package-modal.js';
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

export function openProviderPackageModal(providerId, packageId, summary = {}) {
  renderProviderPackageModal(providerId, packageId, summary);
}

export function openArchiveLinkModal(pkg, options = {}) {
  renderArchiveLinkModal(pkg, options);
}
