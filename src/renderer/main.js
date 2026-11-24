import { buildBundleDraftFromInstalled } from '../shared/bundles-logic.js';
import { buildIgnoreEntryFromPackage } from '../shared/ignore-logic.js';
import { normalizeStartTab } from '../shared/unified-packages.js';
import { initBundlesView, renderBundlesView } from './components/bundles-view.js';
import {
  getPendingArchiveWebUpdateItems,
  getVisibleUpdateEntries,
  renderCatalogGrid,
  renderScanProgressBanner,
  renderUpdatesBatchBar,
} from './components/cards.js';
import { closeContextMenu, openContextMenu } from './components/context-menu.js';
import { initDiscoverView, renderDiscoverView } from './components/discover.js';
import { initJobsBar, rerenderJobsBar } from './components/jobs-bar.js';
import { closeLightbox, initLightbox, isLightboxOpen, nextLightbox, prevLightbox } from './components/lightbox.js';
import { showToast } from './components/toast.js';
import {
  initToolbar,
  renderAdminSessionButton,
  renderAuthHeaderControls,
  renderTagChips,
  syncToolbarForTab,
  updateNavCounts,
} from './components/toolbar.js';
import { initUpdateQueue, renderUpdateQueue } from './components/update-queue.js';
import { askBatchArchiveSaveChoice, openNestedDialog, pickArchiveTargetFolder } from './modals/archive-target-modal.js';
import {
  closeAdminModalIfOpen,
  closeModal,
  initModals,
  openArchiveLinkModal,
  openBundleEditorModal,
  openBundleRunnerModal,
  openCleanupModal,
  openDetailModal,
  openIgnoreListModal,
  openProviderPackageModal,
  openSettingsModal,
  openWingetMatcherModal,
} from './modals/index.js';
import { ensureAdminAuthenticated, openLoginModal } from './modals/login-modal.js';
import {
  applyAuthStatus,
  applyDefaultSortModesFromSettings,
  evaluateItemPolicy,
  getItemById,
  getItemStatus,
  refreshAuthStatus,
  refreshBundles,
  refreshCatalogData,
  refreshIgnoredUpdates,
  refreshProviders,
  setInstalledApps,
  state,
  toggleFavorite,
} from './state.js';
import { initRendererI18n, t } from './utils/i18n.js';
import { escapeHTML } from './utils/sanitize.js';

function handleLanguageChanged() {
  renderAuthHeaderControls();
  renderAdminSessionButton();
  renderTagChips();
  rerenderJobsBar();
  renderActiveView();
}

function renderActiveView() {
  syncToolbarForTab();
  updateNavCounts();
  renderUpdateQueue();
  renderScanProgressBanner();

  if (state.activeTab === 'discover') {
    renderDiscoverView();
  } else if (state.activeTab === 'bundles') {
    renderBundlesView();
  } else {
    renderCatalogGrid();
  }
}

async function runInstalledScan({ silent = false } = {}) {
  state.isScanningInstalled = true;
  state.lastScanFailedProviders = [];
  renderScanProgressBanner();
  if (!state.hasScannedInstalled && (state.activeTab === 'updates' || state.activeTab === 'installed')) {
    renderCatalogGrid();
  }

  try {
    const res = await window.electronAPI.scanInstalledSoftware({ silent });
    if (res?.success && Array.isArray(res.programs)) {
      state.installedScanProgress = null;
      state.lastScanFailedProviders = Array.isArray(res.failedProviders) ? res.failedProviders : [];
      setInstalledApps(res.programs);
      await refreshCatalogData();
      renderTagChips();
      renderActiveView();
      return res;
    }

    state.isScanningInstalled = false;
    state.installedScanProgress = null;
    if (!silent && res?.error && !res.canceled) {
      showToast(t('toasts.pcScanFailed', { error: res.error }), { type: 'error', duration: 6000 });
    }
    renderActiveView();
    return res;
  } catch (err) {
    state.isScanningInstalled = false;
    state.installedScanProgress = null;
    if (!silent) {
      showToast(t('toasts.pcScanFailed', { error: err.message }), { type: 'error', duration: 6000 });
    }
    renderActiveView();
    return { success: false, error: err.message };
  }
}

async function reloadUI({
  preserveScroll = true,
  rescanInstalled = false,
  applyStartTab = false,
  applySortDefaults = false,
} = {}) {
  const y = window.scrollY;
  await Promise.all([
    refreshCatalogData(),
    refreshProviders(),
    refreshBundles(),
    refreshIgnoredUpdates(),
    refreshAuthStatus(),
  ]);
  renderAuthHeaderControls();
  if (applyStartTab) {
    state.activeTab = normalizeStartTab(state.settings.startTab);
  }
  if (applyStartTab || applySortDefaults) {
    applyDefaultSortModesFromSettings(state.settings);
  }
  renderTagChips();
  renderActiveView();
  if (preserveScroll) window.scrollTo(0, y);

  if (rescanInstalled) {
    await runInstalledScan({ silent: true });
  }
}

async function checkAppUpdateInBackground() {
  if (state.hasCheckedAppUpdate) return;
  state.hasCheckedAppUpdate = true;

  const interval = state.settings.updateInterval ?? 24;
  if (interval === -1) return;

  const elapsed = Date.now() - (state.settings.lastUpdateCheck || 0);
  if (elapsed < interval * 60 * 60 * 1000) return;

  const res = await window.electronAPI.checkAppUpdate();
  if (res && !res.error && res.updateAvailable) {
    const notice = document.getElementById('headerUpdateNotice');
    if (notice) {
      notice.innerHTML = `<button type="button" class="update-pill" id="btnHeaderAppUpdate">🎁 ${escapeHTML(t('app.updatePill', { version: res.latestVersion }))}</button>`;
      document.getElementById('btnHeaderAppUpdate')?.addEventListener('click', () => openSettingsModal('updates'));
    }
  }
}

function setupGridEvents() {
  const grid = document.getElementById('grid');
  grid?.addEventListener('change', (e) => {
    if (!(e.target instanceof Element)) return;
    const chk = e.target.closest('.card-select-checkbox');
    if (!(chk instanceof HTMLInputElement)) return;
    const pkgId = chk.dataset.selectUpdateId;
    if (!pkgId) return;
    if (chk.checked) state.selectedUpdateIds.add(pkgId);
    else state.selectedUpdateIds.delete(pkgId);
    chk.closest('.card')?.classList.toggle('is-selected', chk.checked);
    renderUpdatesBatchBar();
  });

  grid?.addEventListener('click', async (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.closest('.card-select-wrap')) {
      e.stopPropagation();
      return;
    }

    const favBtn = e.target.closest('.fav-btn');
    if (favBtn instanceof HTMLElement) {
      e.stopPropagation();
      await toggleFavorite(favBtn.dataset.favId);
      renderCatalogGrid();
      return;
    }

    const archiveBtn = e.target.closest('.card-archive-btn');
    if (archiveBtn instanceof HTMLElement) {
      e.stopPropagation();
      const item = getItemById(archiveBtn.dataset.cardArchiveId);
      if (!item) return;
      const pm = String(item.packageManager || (item.wingetId ? 'winget' : ''))
        .trim()
        .toLowerCase();
      const pid = String(item.packageId || item.wingetId || '').trim();
      const prov = pm ? state.providers.find((p) => p.id === pm) : null;
      const supportsSetupDl = prov ? Boolean(prov.capabilities?.supportsArchiveDownload) : pm === 'winget';
      await openArchiveLinkModal(
        {
          id: item.id,
          packageManager: pm,
          packageId: pid,
          name: item.name,
          version: item.webVersion || item.installedVersion || '',
          shortDescription: item.shortDescription || '',
          homepage: item.homepage || '',
          icon: item.icon || '',
          displayIcon: item.displayIcon || '',
          installLocation: item.installLocation || '',
          validInstallPath: item.validInstallPath || '',
          uninstallString: item.uninstallString || '',
          appxPackageFamilyName: item.appxPackageFamilyName || '',
          installPaths: item.installLocation ? [item.installLocation] : [],
        },
        { downloadSetup: supportsSetupDl }
      );
      return;
    }

    const card = e.target.closest('.card');
    if (card instanceof HTMLElement) {
      openDetailModal(card.dataset.id);
    }
  });

  grid?.addEventListener('contextmenu', (e) => {
    if (state.activeTab !== 'updates') return;
    if (!(e.target instanceof Element)) return;
    const card = e.target.closest('.card');
    if (!(card instanceof HTMLElement)) return;

    const item = getItemById(card.dataset.id);
    if (!item) return;

    e.preventDefault();
    openUpdateCardContextMenu(e, item);
  });
}

async function ignorePackageUpdate(item, { mode, targetVersion }) {
  const entry = buildIgnoreEntryFromPackage(item, {
    mode,
    ignoredVersion: targetVersion,
  });
  const res = await window.electronAPI.addIgnoredUpdate(entry);
  if (!res?.success) {
    showToast(res?.error || t('toasts.ignoreFailed'), { type: 'error' });
    return;
  }

  state.selectedUpdateIds.delete(item.id);
  state.ignoredUpdates = Array.isArray(res.entries) ? res.entries : state.ignoredUpdates;
  renderActiveView();

  const addedId = res.entry?.id || '';
  const msg =
    mode === 'version' && targetVersion
      ? t('toasts.ignoreVersionAdded', { name: item.name, version: targetVersion })
      : t('toasts.ignoreAllAdded', { name: item.name });

  showToast(msg, {
    type: 'info',
    duration: 6000,
    action: addedId
      ? {
          label: t('common.undo'),
          onClick: async () => {
            const undoRes = await window.electronAPI.removeIgnoredUpdate(addedId);
            if (undoRes?.success) {
              state.ignoredUpdates = Array.isArray(undoRes.entries) ? undoRes.entries : [];
              renderActiveView();
              showToast(t('toasts.ignoreUndone', { name: item.name }), { type: 'success' });
            }
          },
        }
      : null,
  });
}

function openUpdateCardContextMenu(event, item) {
  const st = getItemStatus(item);
  const targetVersion = st.targetUpdateVersion || st.webVersion || st.archiveVersion || '';
  const silentLocked = item.installMode === 'interactive-required';
  const policyEval = evaluateItemPolicy(item, 'update');
  const adwareBlocked = policyEval.adwareConflict || silentLocked;

  const menuItems = [];
  if (!policyEval.silentOnly) {
    menuItems.push({
      id: 'update-interactive',
      label: `🖱️ ${t('contextMenu.updateInteractive')}`,
      onSelect: () => enqueueUpdateItems([item], { silent: false, forceInteractive: true }),
    });
  }

  menuItems.push({
    id: 'update-silent',
    label: `⚡ ${t('contextMenu.updateSilent')}`,
    hint: policyEval.adwareConflict
      ? `🚫 ${t('contextMenu.hintAdwareConflict')}`
      : silentLocked
        ? `🛡️ ${t('contextMenu.hintAdwareProtection')}`
        : policyEval.silentOnly
          ? `🔒 ${t('contextMenu.hintSilentOnly')}`
          : '',
    disabled: adwareBlocked,
    title: policyEval.adwareConflict
      ? policyEval.error
      : silentLocked
        ? `🛡️ ${t('contextMenu.titleAdwareProtection')}`
        : t('contextMenu.titleSilentQueue'),
    onSelect: () => enqueueUpdateItems([item], { silent: true }),
  });

  menuItems.push(
    { type: 'separator' },
    {
      id: 'ignore-version',
      label: targetVersion
        ? `⏭️ ${t('contextMenu.ignoreVersion', { version: targetVersion })}`
        : `⏭️ ${t('contextMenu.ignoreVersionGeneric')}`,
      disabled: !targetVersion,
      title: !targetVersion ? t('contextMenu.ignoreVersionNoTarget') : '',
      onSelect: () => ignorePackageUpdate(item, { mode: 'version', targetVersion }),
    },
    {
      id: 'ignore-all',
      label: `🚫 ${t('contextMenu.ignoreAll')}`,
      danger: true,
      onSelect: () => ignorePackageUpdate(item, { mode: 'all', targetVersion }),
    },
    { type: 'separator' },
    {
      id: 'open-details',
      label: `ℹ️ ${t('contextMenu.openDetails')}`,
      onSelect: () => openDetailModal(item.id),
    }
  );

  openContextMenu({
    x: event.clientX,
    y: event.clientY,
    ariaLabel: t('contextMenu.actionsFor', { name: item.name }),
    items: menuItems,
  });
}

async function enqueueUpdateItems(targetItems, { silent = false, forceInteractive = false } = {}) {
  if (!Array.isArray(targetItems) || targetItems.length === 0) return;

  const saveMode = state.settings.archiveSaveMode || 'ask';
  const supportsArchiveSave = (pm) => {
    const provider = state.providers.find((p) => p.id === pm);
    return provider ? Boolean(provider.capabilities?.supportsArchiveDownload) : pm === 'winget';
  };
  const nonArchiveWinget = targetItems.filter(
    (item) => !item.inArchive && item.packageId && supportsArchiveSave(String(item.packageManager || '').toLowerCase())
  );
  const saveSpecsById = new Map();

  if (saveMode === 'ask' && nonArchiveWinget.length > 0) {
    for (let idx = 0; idx < nonArchiveWinget.length; idx++) {
      const item = nonArchiveWinget[idx];
      const choice = await askBatchArchiveSaveChoice({
        softwareName: item.name,
        packageId: item.packageId,
        index: idx + 1,
        total: nonArchiveWinget.length,
      });
      if (choice === 'cancel') return;
      if (choice === 'skip-archive') {
        saveSpecsById.set(item.id, { saveMode: 'none' });
        continue;
      }
      const picked = await pickArchiveTargetFolder({
        softwareName: item.name,
        packageId: item.packageId,
      });
      if (picked.canceled) return;
      saveSpecsById.set(item.id, {
        saveMode: 'ask',
        targetDir: picked.targetDir,
        collisionMode: picked.collisionMode,
      });
    }
  }

  const queueItems = targetItems.map((item) => {
    const st = getItemStatus(item);
    const archiveSaveSpec = !item.inArchive
      ? saveSpecsById.get(item.id) || { saveMode: saveMode === 'auto-id' ? 'auto-id' : 'none' }
      : null;

    return {
      id: item.id,
      itemId: item.id,
      name: item.name,
      icon: item.icon || null,
      fromVersion: st.localVersion || item.installedVersion || '',
      toVersion: st.webVersion || st.archiveVersion || '',
      source: item.inArchive ? 'archive' : item.packageManager || 'winget',
      inArchive: Boolean(item.inArchive),
      isInstalled: Boolean(item.isInstalled),
      packageManager: item.packageManager || (item.wingetId ? 'winget' : ''),
      packageId: item.packageId || item.wingetId || '',
      wingetId: item.wingetId || '',
      publisher: item.publisher || '',
      hasWebUpdate: Boolean(st.hasWebUpdate),
      hasArchiveUpdate: Boolean(st.hasArchiveUpdate),
      installMode: item.installMode || 'interactive',
      archiveSaveSpec,
    };
  });

  const res = await window.electronAPI.enqueueUpdates(queueItems, { silent, forceInteractive });
  if (res?.adminPrompt?.canceled) {
    showToast(t('toasts.uacCanceledQueue'), { type: 'info' });
  }
  if (res?.success) {
    for (const qItem of queueItems) {
      state.selectedUpdateIds.delete(qItem.itemId);
    }
    renderUpdatesBatchBar();

    if (res.added > 0) {
      showToast(t(silent ? 'toasts.queueEnqueuedSilent' : 'toasts.queueEnqueued', { count: res.added }), {
        type: 'info',
      });
      if (res.blockedCount > 0) {
        const firstReason = res.blockedItems?.[0]?.error || t('toasts.queueBlockedDefault');
        showToast(t('toasts.queueBlocked', { count: res.blockedCount, reason: firstReason }), {
          type: 'warn',
          duration: 6000,
        });
      }
    } else {
      showToast(t('toasts.queueAllAlreadyQueued'), { type: 'info' });
    }
  } else if (res?.error) {
    showToast(res.policyBlocked ? res.error : t('toasts.queueError', { error: res.error }), {
      type: 'error',
      duration: 6000,
    });
  }
}

function setupUpdatesBatchBar() {
  const bar = document.getElementById('updatesBatchBar');
  if (!bar) return;

  bar.addEventListener('change', (e) => {
    if (!(e.target instanceof Element)) return;
    const chk = e.target.closest('#chkSelectAllUpdates');
    if (!(chk instanceof HTMLInputElement)) return;
    const entries = getVisibleUpdateEntries();
    if (chk.checked) {
      for (const entry of entries) {
        state.selectedUpdateIds.add(entry.item.id);
      }
    } else {
      state.selectedUpdateIds.clear();
    }
    renderCatalogGrid();
  });

  bar.addEventListener('click', async (e) => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest('button');
    if (!(btn instanceof HTMLButtonElement)) return;

    if (btn.id === 'btnOpenIgnoreList') {
      openIgnoreListModal();
      return;
    }

    if (state.isBatchActionRunning) return;

    if (btn.id === 'btnBatchDownloadArchive') {
      const pendingItems = getPendingArchiveWebUpdateItems();
      if (pendingItems.length === 0) return;

      state.isBatchActionRunning = true;
      renderUpdatesBatchBar();
      showToast(t('toasts.batchDownloading', { count: pendingItems.length }), { type: 'info' });

      try {
        const res = await window.electronAPI.batchDownloadArchiveUpdates(pendingItems.map((i) => i.id));
        await reloadUI();
        if (res?.canceled) {
          showToast(t('toasts.batchDownloadCanceled'), { type: 'info' });
        } else if (res?.success) {
          const type = res.failed > 0 ? 'warn' : 'success';
          showToast(t('toasts.batchDownloadDone', { completed: res.completed, failed: res.failed }), { type });
        } else if (res?.alreadyRunning) {
          showToast(t('toasts.batchDownloadAlreadyRunning'), { type: 'info' });
        } else if (res?.error) {
          showToast(t('common.errorPrefix', { error: res.error }), { type: 'error', duration: 6000 });
        }
      } finally {
        state.isBatchActionRunning = false;
        renderUpdatesBatchBar();
      }
      return;
    }

    if (btn.id === 'btnUpdateAllStandard' || btn.id === 'btnUpdateAllSilent') {
      const entries = getVisibleUpdateEntries();
      const targetItems = entries.map((entry) => entry.item);
      await enqueueUpdateItems(targetItems, { silent: btn.id === 'btnUpdateAllSilent' });
      return;
    }

    if (btn.id === 'btnBatchUpdateSelected') {
      const entries = getVisibleUpdateEntries();
      const selectedItems = entries.map((entry) => entry.item).filter((item) => state.selectedUpdateIds.has(item.id));
      const selectedSilentOnly =
        selectedItems.length > 0 && selectedItems.every((item) => evaluateItemPolicy(item, 'update').silentOnly);
      await enqueueUpdateItems(selectedItems, { silent: selectedSilentOnly });
    }
  });
}

function setupGlobalDragAndDrop() {
  const overlay = document.getElementById('dropOverlay');
  let dragDepth = 0;

  document.body.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (state.activeTab !== 'archive') return;
    if (!document.getElementById('modalOverlay').hidden) return;
    if (!document.getElementById('dialogOverlay')?.hidden) return;
    if (e.target instanceof Element && e.target.closest('.media-dropzone')) return;
    dragDepth++;
    if (overlay) overlay.hidden = false;
  });

  document.body.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  document.body.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (dragDepth > 0) dragDepth--;
    if (dragDepth === 0 && overlay) overlay.hidden = true;
  });

  document.body.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    if (overlay) overlay.hidden = true;

    if (state.activeTab !== 'archive') return;
    // Drops innerhalb offener Modals werden vom jeweiligen Modal verarbeitet
    if (!document.getElementById('modalOverlay').hidden) return;
    if (!document.getElementById('dialogOverlay')?.hidden) return;

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    const droppedPath = window.electronAPI.getFilePath(files[0]);
    if (!droppedPath) return;

    const ok = await ensureAdminAuthenticated({
      reason: t('toasts.authReasonAddArchive'),
    });
    if (!ok) return;

    const res = await window.electronAPI.addSoftwareFromPath(droppedPath);
    if (res.success) {
      await reloadUI();
      showToast(t('toasts.folderAddedToArchive'), { type: 'success' });
    } else if (res.error) {
      showToast(res.error, { type: 'error', duration: 6000 });
    }
  });
}

function setupKeyboardShortcuts() {
  const searchInput = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearSearchBtn');
  const discoverInput = document.getElementById('discoverSearchInput');
  const clearDiscoverBtn = document.getElementById('clearDiscoverSearchBtn');
  const modalOverlay = document.getElementById('modalOverlay');
  const dialogOverlay = document.getElementById('dialogOverlay');

  document.addEventListener('keydown', (e) => {
    if (isLightboxOpen()) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') nextLightbox();
      else if (e.key === 'ArrowLeft') prevLightbox();
      return;
    }

    if (dialogOverlay && !dialogOverlay.hidden) {
      return;
    }

    if (modalOverlay && !modalOverlay.hidden) {
      if (e.key === 'Escape' && !state.isEditModalOpen) closeModal();
      return;
    }

    const active = document.activeElement;
    const isTyping =
      active?.tagName === 'INPUT' ||
      active?.tagName === 'TEXTAREA' ||
      (active instanceof HTMLElement && active.isContentEditable);

    if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && !isTyping)) {
      e.preventDefault();
      if (state.activeTab === 'discover') {
        discoverInput?.focus();
      } else if (state.activeTab === 'bundles') {
        document.getElementById('bundleSearchInput')?.focus();
      } else {
        searchInput?.focus();
      }
    } else if (e.key === 'Escape' && active === searchInput && searchInput instanceof HTMLInputElement) {
      searchInput.value = '';
      state.searchQuery = '';
      if (clearBtn) clearBtn.hidden = true;
      searchInput.blur();
      renderCatalogGrid();
    } else if (e.key === 'Escape' && active === discoverInput && discoverInput instanceof HTMLInputElement) {
      discoverInput.value = '';
      state.discoverQuery = '';
      if (clearDiscoverBtn) clearDiscoverBtn.hidden = true;
      discoverInput.blur();
    }
  });

  modalOverlay?.addEventListener('click', (e) => {
    if (e.target === modalOverlay && !state.isEditModalOpen) {
      closeModal();
    }
  });
}

const PC_ONLY_ID_RE =
  /^(?:winget|scoop|chocolatey|msstore|msi|npm|bun|nvm|pnpm|composer|pip|uv|cargo|vcpkg|dotnet|pwsh7|pwsh5|registry):/;

// Fehlende/defekte Bilder sauber durch passenden Platzhalter ersetzen
document.addEventListener(
  'error',
  (e) => {
    const target = e.target;
    if (!(target instanceof HTMLImageElement)) return;
    if (target.classList.contains('card-icon')) {
      const card = target.closest('.card');
      const id = card instanceof HTMLElement ? card.dataset.id : '';
      const isPcOnly = Boolean(id && PC_ONLY_ID_RE.test(id));
      const fallback = document.createElement('div');
      fallback.className = 'card-icon-fallback';
      fallback.textContent = isPcOnly ? '💻' : '📦';
      target.replaceWith(fallback);
      return;
    }
    if (target.classList.contains('bundle-item-icon')) {
      target.remove();
      return;
    }
    if (target.classList.contains('detail-icon')) {
      const id = state.currentModalId || '';
      const isPcOnly = PC_ONLY_ID_RE.test(id);
      const fallback = document.createElement('div');
      fallback.className = 'detail-icon-fallback';
      fallback.textContent = id.startsWith('remote:') ? '🛍️' : isPcOnly ? '💻' : '📦';
      target.replaceWith(fallback);
      return;
    }
    target.hidden = true;
  },
  true
);

function applyAdminSessionStatus(status) {
  if (!status || typeof status !== 'object') return;
  state.adminSession = {
    mode: status.mode || 'off',
    isProcessElevated: Boolean(status.isProcessElevated),
    isSessionActive: Boolean(status.isSessionActive),
    canUseAdmin: Boolean(status.canUseAdmin),
    workerPid: status.workerPid ?? null,
    startedAt: status.startedAt ?? null,
    supported: status.supported !== false,
  };
  renderAdminSessionButton();
}

async function toggleAdminSession() {
  if (state.adminSessionBusy || state.adminSession.mode === 'elevated' || state.adminSession.isProcessElevated) {
    return;
  }

  state.adminSessionBusy = true;
  renderAdminSessionButton();
  try {
    if (state.adminSession.mode === 'active' || state.adminSession.isSessionActive) {
      const res = await window.electronAPI.stopAdminSession();
      if (res?.status) applyAdminSessionStatus(res.status);
      showToast(t('toasts.adminSessionEnded'), { type: 'info' });
    } else {
      const res = await window.electronAPI.startAdminSession();
      if (res?.status) applyAdminSessionStatus(res.status);
      if (res?.alreadyElevated) {
        showToast(t('toasts.adminAlreadyElevated'), { type: 'info' });
      } else if (res?.success) {
        showToast(t('toasts.adminSessionStarted'), {
          type: 'success',
        });
      } else if (res?.canceled) {
        showToast(t('toasts.adminSessionCanceled'), { type: 'info' });
      } else {
        showToast(t('toasts.adminSessionStartFailed', { error: res?.error || t('common.unknownError') }), {
          type: 'error',
          duration: 6000,
        });
      }
    }
  } finally {
    state.adminSessionBusy = false;
    renderAdminSessionButton();
  }
}

let manualLogoutInFlight = false;

function handleAuthStatusUpdate(status) {
  const prev = /** @type {Record<string, any>} */ (state.authStatus || {});
  const wasAuthenticated = Boolean(prev.enabled && prev.isAuthenticated);
  const next = applyAuthStatus(status);
  renderAuthHeaderControls();
  renderTagChips();
  renderActiveView();

  if (wasAuthenticated && next.enabled && !next.isAuthenticated) {
    closeAdminModalIfOpen();
    if (!manualLogoutInFlight) {
      showToast(t('toasts.adminSessionExpired'), { type: 'info' });
    }
  }
}

function setupScanProgressBanner() {
  const host = document.getElementById('scanProgressBanner');
  host?.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest('[data-scan-banner-action]');
    if (!(btn instanceof HTMLElement)) return;
    const act = btn.dataset.scanBannerAction;
    if (act === 'retry-scan') {
      state.lastScanFailedProviders = [];
      void runInstalledScan({ silent: false });
    } else if (act === 'dismiss-warning') {
      state.lastScanFailedProviders = [];
      renderScanProgressBanner();
    }
  });
}

async function bootstrap() {
  await initRendererI18n({
    onLanguageUpdated: () => handleLanguageChanged(),
  });
  initLightbox();
  initModals({ onReload: reloadUI });
  setupGridEvents();
  setupScanProgressBanner();
  setupUpdatesBatchBar();
  setupGlobalDragAndDrop();
  setupKeyboardShortcuts();

  initJobsBar({
    onJobAction: async (action) => {
      if (action.type === 'recheck-local' && action.itemId) {
        const res = await window.electronAPI.scanLocalVersions({ itemIds: [action.itemId], silent: true });
        await window.electronAPI.dismissJob(action.jobId);
        await reloadUI({ rescanInstalled: true });
        if (res.success && res.versions?.[action.itemId]) {
          showToast(t('toasts.recheckVersionFound', { version: res.versions[action.itemId] }), { type: 'success' });
        } else {
          showToast(t('toasts.recheckVersionMissing'), { type: 'warn' });
        }
      }
    },
  });

  initUpdateQueue({
    onItemCompleted: () => {
      void reloadUI({ rescanInstalled: true });
    },
    onQueueDrained: async ({ completed, failed, canceled }) => {
      await reloadUI({ rescanInstalled: true });
      if (completed === 0 && failed === 0 && canceled > 0) {
        showToast(t('toasts.queueCanceled'), { type: 'info' });
      } else if (completed > 0 || failed > 0) {
        const type = failed > 0 ? 'warn' : 'success';
        const parts = [t('toasts.queuePartUpdated', { count: completed })];
        if (canceled > 0) parts.push(t('toasts.queuePartCanceled', { count: canceled }));
        if (failed > 0) parts.push(t('toasts.queuePartFailed', { count: failed }));
        showToast(t('toasts.queueFinished', { summary: parts.join(' · ') }), { type, duration: 5500 });
      }
    },
  });

  initDiscoverView({
    onReload: reloadUI,
    onOpenArchiveDetail: (id) => openDetailModal(id),
    onOpenPackageDetail: (providerId, packageId, summary) => openProviderPackageModal(providerId, packageId, summary),
    onLinkToArchive: (pkg, opts) => openArchiveLinkModal(pkg, opts),
  });

  initBundlesView({
    onNewBundle: () => openBundleEditorModal(),
    onSnapshotFromPc: async () => {
      if (!state.hasScannedInstalled) {
        showToast(t('toasts.bundleSnapshotScanning'), { type: 'info' });
        await runInstalledScan({ silent: false });
      }
      const snapshot = buildBundleDraftFromInstalled(state.packages);
      if (snapshot.includedCount === 0) {
        showToast(t('toasts.bundleSnapshotEmpty'), { type: 'warn' });
        return;
      }
      openBundleEditorModal({
        snapshotDraft: snapshot.draft,
        snapshotStats: snapshot,
      });
    },
    onEditBundle: (bundle) => openBundleEditorModal({ bundle }),
    onRunBundle: (bundleId) =>
      openBundleRunnerModal(bundleId, {
        onRescanPc: () => runInstalledScan({ silent: false }),
      }),
    onDuplicateBundle: async (bundleId) => {
      const ok = await ensureAdminAuthenticated({
        reason: t('toasts.authReasonDuplicateBundle'),
      });
      if (!ok) return;
      const res = await window.electronAPI.duplicateBundle(bundleId);
      if (res?.success) {
        await reloadUI();
        showToast(t('toasts.bundleCreated', { name: res.bundle?.name || t('toasts.bundleCopyDefault') }), {
          type: 'success',
        });
      } else {
        showToast(res?.error || t('toasts.bundleDuplicateFailed'), { type: 'error' });
      }
    },
    onDeleteBundle: async (bundle) => {
      const ok = await ensureAdminAuthenticated({
        reason: t('toasts.authReasonDeleteBundle'),
      });
      if (!ok) return;
      const decision = await openNestedDialog({
        defaultAction: 'cancel',
        html: `
          <div class="modal-header">
            <h2>🗑️ ${escapeHTML(t('toasts.bundleDeleteTitle'))}</h2>
            <button type="button" class="icon-btn" data-dialog-action="cancel" title="${escapeHTML(t('common.cancel'))}" aria-label="${escapeHTML(t('common.cancel'))}">✕</button>
          </div>
          <div class="modal-body collision-warning-body">
            <p>${escapeHTML(t('toasts.bundleDeleteConfirm', { name: bundle.name, count: bundle.items?.length || 0 }))}</p>
            <div class="collision-actions-grid">
              <button type="button" class="btn btn-ghost" data-dialog-action="cancel">${escapeHTML(t('common.cancel'))}</button>
              <button type="button" class="btn btn-danger" data-dialog-action="confirm">🗑️ ${escapeHTML(t('toasts.bundleDeleteAction'))}</button>
            </div>
          </div>
        `,
        onAction: (act) => (act === 'confirm' ? 'confirm' : 'cancel'),
      });
      if (decision !== 'confirm') return;

      const res = await window.electronAPI.deleteBundle(bundle.id);
      if (res?.success) {
        await reloadUI();
        showToast(t('toasts.bundleDeleted', { name: bundle.name }), { type: 'success' });
      } else {
        showToast(res?.error || t('toasts.bundleDeleteFailed'), { type: 'error' });
      }
    },
    onExportBundle: async (bundleId) => {
      const res = await window.electronAPI.exportBundle(bundleId);
      if (res?.success) {
        showToast(t('toasts.bundleExported'), { type: 'success' });
      } else if (res?.error && !res.canceled) {
        showToast(t('toasts.bundleExportFailed', { error: res.error }), { type: 'error' });
      }
    },
    onExportAllBundles: async () => {
      const res = await window.electronAPI.exportAllBundles();
      if (res?.success) {
        showToast(t('toasts.bundlesExported', { count: res.count || 0 }), { type: 'success' });
      } else if (res?.error && !res.canceled) {
        showToast(t('toasts.bundleExportFailed', { error: res.error }), { type: 'error' });
      }
    },
    onImportBundle: async () => {
      const ok = await ensureAdminAuthenticated({
        reason: t('toasts.authReasonImportBundle'),
      });
      if (!ok) return;
      const res = await window.electronAPI.importBundle();
      if (res?.success) {
        await reloadUI();
        const msg =
          res.importedCount > 1
            ? t('toasts.bundlesImported', { count: res.importedCount })
            : t('toasts.bundleImported', { name: res.bundle?.name || t('toasts.bundleImportDefault') });
        showToast(msg, { type: 'success' });
      } else if (res?.error && !res.canceled) {
        showToast(t('toasts.bundleImportFailed', { error: res.error }), { type: 'error', duration: 6000 });
      }
    },
  });

  initToolbar({
    onTabChange: (tab) => {
      closeContextMenu();
      state.activeTab = tab;
      renderActiveView();
    },
    onFilterChange: () => renderCatalogGrid(),
    onOpenSettings: () => openSettingsModal(),
    onToggleAdminSession: () => toggleAdminSession(),
    onAuthLogin: async () => {
      const res = await openLoginModal({
        reason: t('toasts.authReasonLogin'),
      });
      if (res?.authenticated) {
        showToast(t('toasts.authLoggedIn'), { type: 'success' });
      }
    },
    onAuthLogout: async () => {
      manualLogoutInFlight = true;
      try {
        const res = await window.electronAPI.logoutAuth();
        if (res?.status) {
          applyAuthStatus(res.status);
        }
        closeAdminModalIfOpen();
        renderAuthHeaderControls();
        renderTagChips();
        renderActiveView();
        showToast(t('toasts.authLoggedOut'), { type: 'info' });
      } finally {
        manualLogoutInFlight = false;
      }
    },
    onScanArchive: async (mode) => {
      const res = await window.electronAPI.runScan(mode);
      if (res.alreadyRunning) {
        showToast(t('toasts.archiveScanAlreadyRunning'), { type: 'info' });
        return;
      }
      if (res.success) {
        await reloadUI();
        showToast(t('toasts.archiveUpdated'), { type: 'success' });
      } else if (res.error && !res.canceled) {
        const msg = res.error === 'LOCKED' ? t('toasts.archiveScanLocked') : res.error;
        showToast(msg, { type: 'error', duration: 6000 });
      }
    },
    onCheckOnline: async () => {
      const [res, pcRes] = await Promise.all([
        window.electronAPI.checkWebVersions(),
        runInstalledScan({ silent: true }),
      ]);
      if (res.alreadyRunning) {
        showToast(t('toasts.onlineCheckRunning'), { type: 'info' });
        return;
      }
      const providerUpd = pcRes?.success ? (pcRes.stats?.updatesAvailable ?? 0) : 0;
      if (res.success) {
        await reloadUI();
        const archiveUpd = res.count || 0;
        if (archiveUpd > 0 && providerUpd > 0) {
          showToast(t('toasts.onlineFoundBoth', { archiveCount: archiveUpd, providerCount: providerUpd }), {
            type: 'success',
          });
        } else if (archiveUpd > 0) {
          showToast(t('toasts.onlineFoundArchive', { count: archiveUpd }), { type: 'success' });
        } else if (providerUpd > 0) {
          showToast(t('toasts.onlineFoundProvider', { count: providerUpd }), { type: 'success' });
        } else {
          showToast(t('toasts.onlineUpToDate'), { type: 'info' });
        }
      } else if (res.error && !res.canceled) {
        showToast(t('toasts.onlineCheckFailed', { error: res.error }), { type: 'error', duration: 6000 });
      }
    },
    onCheckLocal: async () => {
      const [pcRes, localRes] = await Promise.all([
        runInstalledScan({ silent: false }),
        window.electronAPI.scanLocalVersions({ silent: true }),
      ]);

      if (pcRes?.alreadyRunning) {
        showToast(t('toasts.localCheckRunning'), { type: 'info' });
        return;
      }
      if (pcRes?.success) {
        await reloadUI();
        const total = pcRes.stats?.total ?? pcRes.programs?.length ?? 0;
        const upd = pcRes.stats?.updatesAvailable ?? 0;
        showToast(t('toasts.localCheckDone', { total, updates: upd }), { type: 'success' });
      } else if (localRes?.success) {
        await reloadUI();
        showToast(t('toasts.localVersionsDone', { count: localRes.count }), { type: 'success' });
      }
    },
    onAddSoftware: async () => {
      const ok = await ensureAdminAuthenticated({
        reason: t('toasts.authReasonAddFolder'),
      });
      if (!ok) return;
      const res = await window.electronAPI.addSoftware();
      if (res.success) {
        await reloadUI();
        showToast(t('toasts.softwareAdded'), { type: 'success' });
      } else if (res.error) {
        showToast(res.error, { type: 'error', duration: 6000 });
      }
    },
    onAutoDetectAll: async () => {
      const ok = await ensureAdminAuthenticated({
        reason: t('toasts.authReasonAutoDetect'),
      });
      if (!ok) return;
      const res = await window.electronAPI.autoDetectAll();
      if (res.alreadyRunning) {
        showToast(t('toasts.autoDetectRunning'), { type: 'info' });
        return;
      }
      if (res.success) {
        await reloadUI();
        showToast(
          res.total === 0
            ? t('toasts.autoDetectAllSet')
            : t('toasts.autoDetectFound', { found: res.found, total: res.total }),
          { type: 'success' }
        );
      }
    },
    onOpenWingetMatcher: () => openWingetMatcherModal(),
    onOpenArchiveCleaner: () => openCleanupModal(),
  });

  try {
    let lastBgCheckAt = 0;
    if (typeof window.electronAPI?.onNavigateTab === 'function') {
      window.electronAPI.onNavigateTab((tab) => {
        closeContextMenu();
        state.activeTab = normalizeStartTab(tab);
        renderActiveView();
      });
    }
    if (typeof window.electronAPI?.onOpenSettings === 'function') {
      window.electronAPI.onOpenSettings((tab) => {
        closeContextMenu();
        void openSettingsModal(tab || 'general');
      });
    }
    if (typeof window.electronAPI?.onBackgroundStatusUpdated === 'function') {
      window.electronAPI.onBackgroundStatusUpdated((bgStatus) => {
        if (!bgStatus || bgStatus.isChecking) return;
        if (bgStatus.lastCheckAt && bgStatus.lastCheckAt !== lastBgCheckAt) {
          lastBgCheckAt = bgStatus.lastCheckAt;
          void reloadUI({ preserveScroll: true });
        }
      });
    }

    if (typeof window.electronAPI?.onAuthStatusUpdated === 'function') {
      window.electronAPI.onAuthStatusUpdated((status) => handleAuthStatusUpdate(status));
    }
    await refreshAuthStatus();
    renderAuthHeaderControls();

    if (typeof window.electronAPI?.onAdminSessionUpdated === 'function') {
      window.electronAPI.onAdminSessionUpdated((status) => applyAdminSessionStatus(status));
    }
    if (typeof window.electronAPI?.getAdminSessionStatus === 'function') {
      void window.electronAPI.getAdminSessionStatus().then((st) => applyAdminSessionStatus(st));
    }

    const info = await window.electronAPI.getAppInfo();
    const verEl = document.getElementById('appVersion');
    if (verEl) verEl.textContent = `(v${info.version})`;

    if (typeof window.electronAPI?.onInstalledScanProgress === 'function') {
      window.electronAPI.onInstalledScanProgress((progress) => {
        state.installedScanProgress = progress?.active ? progress : null;
        renderScanProgressBanner();
      });
    }

    await reloadUI({ preserveScroll: false, applyStartTab: true });
    checkAppUpdateInBackground();
    void (async () => {
      state.isCheckingProviders = true;
      renderScanProgressBanner();
      try {
        await refreshProviders({ checkAvailability: true });
      } finally {
        state.isCheckingProviders = false;
      }
      renderActiveView();
      await runInstalledScan({ silent: true });
    })();
  } catch (err) {
    console.error('Fehler beim Starten:', err);
    showToast(t('app.loadFailed', { error: err.message }), { type: 'error', duration: 0 });
  }
}

bootstrap();
