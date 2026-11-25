import { state } from '../state.js';
import { t } from '../utils/i18n.js';
import { savePackageToArchive } from './archive-target-modal.js';
import { renderBundleEditorModal } from './bundle-editor-modal.js';
import { renderBundleRunnerModal } from './bundle-runner-modal.js';
import { renderCleanupModal } from './cleanup-modal.js';
import { renderDetailModal, renderRemoteDetailModal } from './detail-modal.js';
import { renderDevAuditModal } from './dev-audit-modal.js';
import { renderDevBundleEditorModal } from './dev-bundle-editor-modal.js';
import { renderDevBundleRunnerModal } from './dev-bundle-runner-modal.js';
import { renderEditModal } from './edit-modal.js';
import { renderIgnoreListModal } from './ignore-list-modal.js';
import { ensureAdminAuthenticated } from './login-modal.js';
import { openProviderSourcesModal } from './provider-sources-modal.js';
import { renderSettingsModal } from './settings-modal.js';
import { renderWingetMatcherModal } from './winget-matcher-modal.js';

/** @type {(opts?: any) => Promise<void> | void} */
let reloadHandler = () => {};

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
  content.onkeydown = null;
  content.ondragstart = null;
  content.ondragover = null;
  content.ondragleave = null;
  content.ondrop = null;
  content.ondragend = null;
}

const ADMIN_MODAL_KINDS = new Set([
  'settings',
  'edit',
  'winget-matcher',
  'cleanup',
  'bundle-editor',
  'dev-bundle-editor',
]);

export function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  resetModalContent();
  if (overlay) overlay.hidden = true;
  if (content) content.innerHTML = '';
  state.currentModalId = null;
  state.currentModalKind = null;
  state.isEditModalOpen = false;
}

export function closeAdminModalIfOpen() {
  if (state.currentModalKind && ADMIN_MODAL_KINDS.has(state.currentModalKind)) {
    closeModal();
  }
}

export function openDetailModal(id, options = {}) {
  state.currentModalKind = 'detail';
  renderDetailModal(id, options);
}

export async function openEditModal(id, initialTab = 'general') {
  const ok = await ensureAdminAuthenticated({
    reason: t('modals.authReasonEdit'),
  });
  if (!ok) return false;
  state.currentModalKind = 'edit';
  renderEditModal(id, initialTab);
  return true;
}

export async function openSettingsModal(initialTab = 'general') {
  const ok = await ensureAdminAuthenticated({
    reason: t('modals.authReasonSettings'),
  });
  if (!ok) return false;
  state.currentModalKind = 'settings';
  return renderSettingsModal(initialTab);
}

export function openProviderPackageModal(providerId, packageId, summary = {}, options = {}) {
  state.currentModalKind = 'detail';
  renderRemoteDetailModal(providerId, packageId, summary, options);
}

export async function openArchiveLinkModal(pkg, options = {}) {
  const ok = await ensureAdminAuthenticated({
    reason: t('modals.authReasonAddArchive'),
  });
  if (!ok) return { success: false, canceled: true };
  const defaultMode = state.settings.archiveSaveMode === 'auto-id' ? 'auto-id' : 'ask';
  const pm = String(pkg?.packageManager || pkg?.providerId || (pkg?.wingetId ? 'winget' : ''))
    .trim()
    .toLowerCase();
  const provider = pm ? state.providers.find((p) => p.id === pm) : null;
  const defaultDownloadSetup = provider ? Boolean(provider.capabilities?.supportsArchiveDownload) : pm === 'winget';
  return savePackageToArchive(pkg, {
    mode: options.mode || defaultMode,
    downloadSetup: options.downloadSetup ?? defaultDownloadSetup,
    onLinked: options.onLinked || null,
  });
}

export { openProviderSourcesModal };

export async function openWingetMatcherModal() {
  const ok = await ensureAdminAuthenticated({
    reason: t('modals.authReasonWingetMatcher'),
  });
  if (!ok) return false;
  state.currentModalKind = 'winget-matcher';
  return renderWingetMatcherModal();
}

export async function openCleanupModal() {
  const ok = await ensureAdminAuthenticated({
    reason: t('modals.authReasonCleanup'),
  });
  if (!ok) return false;
  state.currentModalKind = 'cleanup';
  return renderCleanupModal();
}

export function openIgnoreListModal() {
  state.currentModalKind = 'ignore-list';
  return renderIgnoreListModal();
}

export async function openBundleEditorModal(options = {}) {
  const ok = await ensureAdminAuthenticated({
    reason: t('modals.authReasonBundleEditor'),
  });
  if (!ok) return false;
  state.currentModalKind = 'bundle-editor';
  return renderBundleEditorModal(options);
}

export function openBundleRunnerModal(bundleId, options = {}) {
  state.currentModalKind = 'bundle-runner';
  return renderBundleRunnerModal(bundleId, options);
}

export async function openDevBundleEditorModal(options = {}) {
  const ok = await ensureAdminAuthenticated({
    reason: t('modals.authReasonDevBundleEditor'),
  });
  if (!ok) return false;
  state.currentModalKind = 'dev-bundle-editor';
  return renderDevBundleEditorModal(options);
}

export function openDevBundleRunnerModal(options) {
  state.currentModalKind = 'dev-bundle-runner';
  return renderDevBundleRunnerModal(options);
}

export function openDevAuditModal(options) {
  state.currentModalKind = 'dev-audit';
  return renderDevAuditModal(options);
}
