import { buildBundleDraftFromInstalled } from '../shared/bundles-logic.js';
import { buildIgnoreEntryFromPackage } from '../shared/ignore-logic.js';
import { normalizeStartTab } from '../shared/unified-packages.js';
import { initBundlesView, renderBundlesView } from './components/bundles-view.js';
import {
  getPendingArchiveWebUpdateItems,
  getVisibleUpdateEntries,
  renderCatalogGrid,
  renderUpdatesBatchBar,
} from './components/cards.js';
import { closeContextMenu, openContextMenu } from './components/context-menu.js';
import { initDiscoverView, renderDiscoverView } from './components/discover.js';
import { initJobsBar } from './components/jobs-bar.js';
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
import { escapeHTML } from './utils/sanitize.js';

function renderActiveView() {
  syncToolbarForTab();
  updateNavCounts();
  renderUpdateQueue();

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
  if (state.activeTab === 'updates' || state.activeTab === 'installed') {
    renderCatalogGrid();
  }

  try {
    const res = await window.electronAPI.scanInstalledSoftware({ silent });
    if (res?.success && Array.isArray(res.programs)) {
      setInstalledApps(res.programs);
      await refreshCatalogData();
      renderTagChips();
      renderActiveView();
      return res;
    }

    state.isScanningInstalled = false;
    if (!silent && res?.error && !res.canceled) {
      showToast(`PC-Scan fehlgeschlagen: ${res.error}`, { type: 'error', duration: 6000 });
    }
    renderActiveView();
    return res;
  } catch (err) {
    state.isScanningInstalled = false;
    if (!silent) {
      showToast(`PC-Scan fehlgeschlagen: ${err.message}`, { type: 'error', duration: 6000 });
    }
    renderActiveView();
    return { success: false, error: err.message };
  }
}

async function reloadUI({ preserveScroll = true, rescanInstalled = false, applyStartTab = false } = {}) {
  const y = window.scrollY;
  await Promise.all([refreshCatalogData(), refreshProviders(), refreshBundles(), refreshIgnoredUpdates()]);
  if (applyStartTab) {
    state.activeTab = normalizeStartTab(state.settings.startTab);
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
      notice.innerHTML = `<button type="button" class="update-pill" id="btnHeaderAppUpdate">🎁 App-Update v${escapeHTML(res.latestVersion)}</button>`;
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
    showToast(res?.error || 'Update konnte nicht ignoriert werden.', { type: 'error' });
    return;
  }

  state.selectedUpdateIds.delete(item.id);
  state.ignoredUpdates = Array.isArray(res.entries) ? res.entries : state.ignoredUpdates;
  renderActiveView();

  const addedId = res.entry?.id || '';
  const msg =
    mode === 'version' && targetVersion
      ? `${item.name} (v${targetVersion}) wird ignoriert.`
      : `Alle Updates für ${item.name} werden ignoriert.`;

  showToast(msg, {
    type: 'info',
    duration: 6000,
    action: addedId
      ? {
          label: 'Rückgängig',
          onClick: async () => {
            const undoRes = await window.electronAPI.removeIgnoredUpdate(addedId);
            if (undoRes?.success) {
              state.ignoredUpdates = Array.isArray(undoRes.entries) ? undoRes.entries : [];
              renderActiveView();
              showToast(`Ignorier-Regel für ${item.name} rückgängig gemacht.`, { type: 'success' });
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
      label: '🖱️ Jetzt interaktiv aktualisieren',
      onSelect: () => enqueueUpdateItems([item], { silent: false, forceInteractive: true }),
    });
  }

  menuItems.push({
    id: 'update-silent',
    label: '⚡ Jetzt silent aktualisieren',
    hint: policyEval.adwareConflict
      ? '🚫 Adware-Konflikt'
      : silentLocked
        ? '🛡️ Adware-Schutz'
        : policyEval.silentOnly
          ? '🔒 Nur Silent'
          : '',
    disabled: adwareBlocked,
    title: policyEval.adwareConflict
      ? policyEval.error
      : silentLocked
        ? '🛡️ Gesperrt wegen Adware-/Klick-Schutz (installMode: interactive-required)'
        : 'Update im Hintergrund (silent) einreihen',
    onSelect: () => enqueueUpdateItems([item], { silent: true }),
  });

  menuItems.push(
    { type: 'separator' },
    {
      id: 'ignore-version',
      label: targetVersion ? `⏭️ Diese Version ignorieren (v${targetVersion})` : '⏭️ Diese Version ignorieren',
      disabled: !targetVersion,
      title: !targetVersion ? 'Keine eindeutige Zielversion erkannt' : '',
      onSelect: () => ignorePackageUpdate(item, { mode: 'version', targetVersion }),
    },
    {
      id: 'ignore-all',
      label: '🚫 Alle Updates ignorieren',
      danger: true,
      onSelect: () => ignorePackageUpdate(item, { mode: 'all', targetVersion }),
    },
    { type: 'separator' },
    {
      id: 'open-details',
      label: 'ℹ️ Details öffnen',
      onSelect: () => openDetailModal(item.id),
    }
  );

  openContextMenu({
    x: event.clientX,
    y: event.clientY,
    ariaLabel: `Aktionen für ${item.name}`,
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
    showToast('UAC-Abfrage abgebrochen - Updates laufen im normalen Modus weiter.', { type: 'info' });
  }
  if (res?.success) {
    for (const qItem of queueItems) {
      state.selectedUpdateIds.delete(qItem.itemId);
    }
    renderUpdatesBatchBar();

    if (res.added > 0) {
      const modeHint = silent ? ' (Silent-Modus mit Adware-Schutz)' : '';
      showToast(`${res.added} Update(s) in die Warteschlange eingereiht${modeHint}.`, { type: 'info' });
      if (res.blockedCount > 0) {
        const firstReason = res.blockedItems?.[0]?.error || 'Durch Zugriffsrichtlinie blockiert.';
        showToast(`${res.blockedCount} Update(s) durch Zugriffsrichtlinie blockiert: ${firstReason}`, {
          type: 'warn',
          duration: 6000,
        });
      }
    } else {
      showToast('Alle ausgewählten Updates befinden sich bereits in der Warteschlange.', { type: 'info' });
    }
  } else if (res?.error) {
    showToast(res.policyBlocked ? res.error : `Warteschlangen-Fehler: ${res.error}`, { type: 'error', duration: 6000 });
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
      showToast(`Lade ${pendingItems.length} Online-Update(s) ins Archiv...`, { type: 'info' });

      try {
        const res = await window.electronAPI.batchDownloadArchiveUpdates(pendingItems.map((i) => i.id));
        await reloadUI();
        if (res?.canceled) {
          showToast('Massen-Download abgebrochen.', { type: 'info' });
        } else if (res?.success) {
          const type = res.failed > 0 ? 'warn' : 'success';
          showToast(`${res.completed} Online-Update(s) ins Archiv geladen (${res.failed} Fehler).`, { type });
        } else if (res?.alreadyRunning) {
          showToast('Es läuft bereits ein Massen-Download.', { type: 'info' });
        } else if (res?.error) {
          showToast(`Fehler: ${res.error}`, { type: 'error', duration: 6000 });
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
      reason: 'Zum Hinzufügen von Software ins Archiv ist eine Admin-Anmeldung erforderlich.',
    });
    if (!ok) return;

    const res = await window.electronAPI.addSoftwareFromPath(droppedPath);
    if (res.success) {
      await reloadUI();
      showToast('Software-Ordner wurde zum Archiv hinzugefügt.', { type: 'success' });
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
      showToast('Admin-Sitzung wurde beendet.', { type: 'info' });
    } else {
      const res = await window.electronAPI.startAdminSession();
      if (res?.status) applyAdminSessionStatus(res.status);
      if (res?.alreadyElevated) {
        showToast('App läuft bereits als Administrator.', { type: 'info' });
      } else if (res?.success) {
        showToast('Admin-Sitzung aktiv - Updates und Installationen laufen nun ohne weitere UAC-Abfragen.', {
          type: 'success',
        });
      } else if (res?.canceled) {
        showToast('UAC-Abfrage abgebrochen - Admin-Modus bleibt aus.', { type: 'info' });
      } else {
        showToast(`Admin-Sitzung konnte nicht gestartet werden: ${res?.error || 'Unbekannter Fehler'}`, {
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
      showToast('Admin-Sitzung abgelaufen - bitte erneut anmelden.', { type: 'info' });
    }
  }
}

async function bootstrap() {
  initLightbox();
  initModals({ onReload: reloadUI });
  setupGridEvents();
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
          showToast(`Erkannte Version: v${res.versions[action.itemId]}`, { type: 'success' });
        } else {
          showToast('Version konnte noch nicht ausgelesen werden.', { type: 'warn' });
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
        showToast('Update-Warteschlange wurde abgebrochen.', { type: 'info' });
      } else if (completed > 0 || failed > 0) {
        const type = failed > 0 ? 'warn' : 'success';
        const parts = [`${completed} aktualisiert`];
        if (canceled > 0) parts.push(`${canceled} abgebrochen`);
        if (failed > 0) parts.push(`${failed} fehlgeschlagen`);
        showToast(`Warteschlange abgeschlossen: ${parts.join(' · ')}`, { type, duration: 5500 });
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
        showToast('Scanne installierte PC-Programme für den Snapshot...', { type: 'info' });
        await runInstalledScan({ silent: false });
      }
      const snapshot = buildBundleDraftFromInstalled(state.packages);
      if (snapshot.includedCount === 0) {
        showToast('Keine übernehmbaren Archiv- oder Paketmanager-Programme auf diesem PC erkannt.', { type: 'warn' });
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
        reason: 'Zum Duplizieren von Paketbündeln ist eine Admin-Anmeldung erforderlich.',
      });
      if (!ok) return;
      const res = await window.electronAPI.duplicateBundle(bundleId);
      if (res?.success) {
        await reloadUI();
        showToast(`Bündel "${res.bundle?.name || 'Kopie'}" erstellt.`, { type: 'success' });
      } else {
        showToast(res?.error || 'Bündel konnte nicht dupliziert werden.', { type: 'error' });
      }
    },
    onDeleteBundle: async (bundle) => {
      const ok = await ensureAdminAuthenticated({
        reason: 'Zum Löschen von Paketbündeln ist eine Admin-Anmeldung erforderlich.',
      });
      if (!ok) return;
      const decision = await openNestedDialog({
        defaultAction: 'cancel',
        html: `
          <div class="modal-header">
            <h2>🗑️ Bündel löschen</h2>
            <button type="button" class="icon-btn" data-dialog-action="cancel" title="Abbrechen" aria-label="Abbrechen">✕</button>
          </div>
          <div class="modal-body collision-warning-body">
            <p>Möchtest du das Bündel <strong>${escapeHTML(bundle.name)}</strong> (${bundle.items?.length || 0} Pakete) wirklich löschen?</p>
            <div class="collision-actions-grid">
              <button type="button" class="btn btn-ghost" data-dialog-action="cancel">Abbrechen</button>
              <button type="button" class="btn btn-danger" data-dialog-action="confirm">🗑️ Endgültig löschen</button>
            </div>
          </div>
        `,
        onAction: (act) => (act === 'confirm' ? 'confirm' : 'cancel'),
      });
      if (decision !== 'confirm') return;

      const res = await window.electronAPI.deleteBundle(bundle.id);
      if (res?.success) {
        await reloadUI();
        showToast(`Bündel "${bundle.name}" gelöscht.`, { type: 'success' });
      } else {
        showToast(res?.error || 'Bündel konnte nicht gelöscht werden.', { type: 'error' });
      }
    },
    onExportBundle: async (bundleId) => {
      const res = await window.electronAPI.exportBundle(bundleId);
      if (res?.success) {
        showToast('Bündel erfolgreich als JSON exportiert.', { type: 'success' });
      } else if (res?.error && !res.canceled) {
        showToast(`Export fehlgeschlagen: ${res.error}`, { type: 'error' });
      }
    },
    onExportAllBundles: async () => {
      const res = await window.electronAPI.exportAllBundles();
      if (res?.success) {
        showToast(`${res.count || 0} Bündel erfolgreich als JSON exportiert.`, { type: 'success' });
      } else if (res?.error && !res.canceled) {
        showToast(`Export fehlgeschlagen: ${res.error}`, { type: 'error' });
      }
    },
    onImportBundle: async () => {
      const ok = await ensureAdminAuthenticated({
        reason: 'Zum Importieren von Paketbündeln ist eine Admin-Anmeldung erforderlich.',
      });
      if (!ok) return;
      const res = await window.electronAPI.importBundle();
      if (res?.success) {
        await reloadUI();
        const msg =
          res.importedCount > 1
            ? `${res.importedCount} Bündel erfolgreich importiert.`
            : `Bündel "${res.bundle?.name || 'Import'}" importiert.`;
        showToast(msg, { type: 'success' });
      } else if (res?.error && !res.canceled) {
        showToast(`Import fehlgeschlagen: ${res.error}`, { type: 'error', duration: 6000 });
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
        reason: 'Als Administrator anmelden, um Einstellungen und Katalog zu bearbeiten.',
      });
      if (res?.authenticated) {
        showToast('Als Administrator angemeldet.', { type: 'success' });
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
        showToast('Admin-Sitzung abgemeldet.', { type: 'info' });
      } finally {
        manualLogoutInFlight = false;
      }
    },
    onScanArchive: async (mode) => {
      const res = await window.electronAPI.runScan(mode);
      if (res.alreadyRunning) {
        showToast('Ein Archiv-Scan läuft bereits.', { type: 'info' });
        return;
      }
      if (res.success) {
        await reloadUI();
        showToast('Archiv wurde aktualisiert.', { type: 'success' });
      } else if (res.error && !res.canceled) {
        const msg = res.error === 'LOCKED' ? 'Archiv wird gerade von einem anderen PC gescannt.' : res.error;
        showToast(msg, { type: 'error', duration: 6000 });
      }
    },
    onCheckOnline: async () => {
      const [res, pcRes] = await Promise.all([
        window.electronAPI.checkWebVersions(),
        runInstalledScan({ silent: true }),
      ]);
      if (res.alreadyRunning) {
        showToast('Online-Prüfung läuft bereits.', { type: 'info' });
        return;
      }
      const providerUpd = pcRes?.success ? (pcRes.stats?.updatesAvailable ?? 0) : 0;
      if (res.success) {
        await reloadUI();
        const archiveUpd = res.count || 0;
        if (archiveUpd > 0 && providerUpd > 0) {
          showToast(`${archiveUpd} Archiv- und ${providerUpd} Paketmanager-Updates gefunden!`, { type: 'success' });
        } else if (archiveUpd > 0) {
          showToast(`${archiveUpd} neue Online-Versionen gefunden!`, { type: 'success' });
        } else if (providerUpd > 0) {
          showToast(`${providerUpd} Paketmanager-Updates auf diesem PC verfügbar.`, { type: 'success' });
        } else {
          showToast('Alle Online-Quellen sind aktuell.', { type: 'info' });
        }
      } else if (res.error && !res.canceled) {
        showToast(`Online-Prüfung fehlgeschlagen: ${res.error}`, { type: 'error', duration: 6000 });
      }
    },
    onCheckLocal: async () => {
      const [pcRes, localRes] = await Promise.all([
        runInstalledScan({ silent: false }),
        window.electronAPI.scanLocalVersions({ silent: true }),
      ]);

      if (pcRes?.alreadyRunning) {
        showToast('PC-Prüfung läuft bereits.', { type: 'info' });
        return;
      }
      if (pcRes?.success) {
        await reloadUI();
        const total = pcRes.stats?.total ?? pcRes.programs?.length ?? 0;
        const upd = pcRes.stats?.updatesAvailable ?? 0;
        showToast(`${total} PC-Programme geprüft (${upd} Updates verfügbar).`, { type: 'success' });
      } else if (localRes?.success) {
        await reloadUI();
        showToast(`${localRes.count} lokale Programme geprüft.`, { type: 'success' });
      }
    },
    onAddSoftware: async () => {
      const ok = await ensureAdminAuthenticated({
        reason: 'Zum Hinzufügen eines Software-Ordners ist eine Admin-Anmeldung erforderlich.',
      });
      if (!ok) return;
      const res = await window.electronAPI.addSoftware();
      if (res.success) {
        await reloadUI();
        showToast('Neue Software wurde hinzugefügt.', { type: 'success' });
      } else if (res.error) {
        showToast(res.error, { type: 'error', duration: 6000 });
      }
    },
    onAutoDetectAll: async () => {
      const ok = await ensureAdminAuthenticated({
        reason: 'Zum automatischen Speichern fehlender PC-Pfade ist eine Admin-Anmeldung erforderlich.',
      });
      if (!ok) return;
      const res = await window.electronAPI.autoDetectAll();
      if (res.alreadyRunning) {
        showToast('Pfadsuche läuft bereits.', { type: 'info' });
        return;
      }
      if (res.success) {
        await reloadUI();
        showToast(
          res.total === 0
            ? 'Alle Programme haben bereits einen Pfad.'
            : `${res.found} von ${res.total} Installationspfaden gefunden.`,
          { type: 'success' }
        );
      }
    },
    onOpenWingetMatcher: () => openWingetMatcherModal(),
    onOpenArchiveCleaner: () => openCleanupModal(),
  });

  try {
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

    await reloadUI({ preserveScroll: false, applyStartTab: true });
    void refreshProviders({ checkAvailability: true }).then(() => renderActiveView());
    checkAppUpdateInBackground();
    runInstalledScan({ silent: true });
  } catch (err) {
    console.error('Fehler beim Starten:', err);
    showToast(`Katalog konnte nicht geladen werden: ${err.message}`, { type: 'error', duration: 0 });
  }
}

bootstrap();
