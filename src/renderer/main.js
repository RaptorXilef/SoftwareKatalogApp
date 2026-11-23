import { buildBundleDraftFromInstalled } from '../shared/bundles-logic.js';
import { initBundlesView, renderBundlesView } from './components/bundles-view.js';
import {
  getPendingArchiveWebUpdateItems,
  getVisibleUpdateEntries,
  renderCatalogGrid,
  renderUpdatesBatchBar,
} from './components/cards.js';
import { initDiscoverView, renderDiscoverView } from './components/discover.js';
import { initJobsBar } from './components/jobs-bar.js';
import { closeLightbox, initLightbox, isLightboxOpen, nextLightbox, prevLightbox } from './components/lightbox.js';
import { showToast } from './components/toast.js';
import { initToolbar, renderTagChips, syncToolbarForTab, updateNavCounts } from './components/toolbar.js';
import { askBatchArchiveSaveChoice, openNestedDialog, pickArchiveTargetFolder } from './modals/archive-target-modal.js';
import {
  closeModal,
  initModals,
  openArchiveLinkModal,
  openBundleEditorModal,
  openBundleRunnerModal,
  openCleanupModal,
  openDetailModal,
  openProviderPackageModal,
  openSettingsModal,
  openWingetMatcherModal,
} from './modals/index.js';
import {
  getItemStatus,
  refreshBundles,
  refreshCatalogData,
  refreshProviders,
  setInstalledApps,
  state,
  toggleFavorite,
} from './state.js';
import { escapeHTML } from './utils/sanitize.js';

function renderActiveView() {
  syncToolbarForTab();
  updateNavCounts();

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

async function reloadUI({ preserveScroll = true, rescanInstalled = false } = {}) {
  const y = window.scrollY;
  await Promise.all([refreshCatalogData(), refreshProviders(), refreshBundles()]);
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
      document.getElementById('btnHeaderAppUpdate')?.addEventListener('click', () => openSettingsModal());
    }
  }
}

function setupGridEvents() {
  const grid = document.getElementById('grid');
  grid?.addEventListener('change', (e) => {
    const chk = e.target.closest('.card-select-checkbox');
    if (!chk) return;
    const pkgId = chk.dataset.selectUpdateId;
    if (!pkgId) return;
    if (chk.checked) state.selectedUpdateIds.add(pkgId);
    else state.selectedUpdateIds.delete(pkgId);
    chk.closest('.card')?.classList.toggle('is-selected', chk.checked);
    renderUpdatesBatchBar();
  });

  grid?.addEventListener('click', async (e) => {
    if (e.target.closest('.card-select-wrap')) {
      e.stopPropagation();
      return;
    }

    const favBtn = e.target.closest('.fav-btn');
    if (favBtn) {
      e.stopPropagation();
      await toggleFavorite(favBtn.dataset.favId);
      renderCatalogGrid();
      return;
    }

    const card = e.target.closest('.card');
    if (card) {
      openDetailModal(card.dataset.id);
    }
  });
}

function setupUpdatesBatchBar() {
  const bar = document.getElementById('updatesBatchBar');
  if (!bar) return;

  bar.addEventListener('change', (e) => {
    const chk = e.target.closest('#chkSelectAllUpdates');
    if (!chk) return;
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
    const btn = e.target.closest('button');
    if (!btn || state.isBatchActionRunning) return;

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

    if (btn.id === 'btnBatchUpdateSelected') {
      const entries = getVisibleUpdateEntries();
      const selectedItems = entries.map((entry) => entry.item).filter((item) => state.selectedUpdateIds.has(item.id));
      if (selectedItems.length === 0) return;

      const saveMode = state.settings.archiveSaveMode || 'ask';
      const nonArchiveWinget = selectedItems.filter(
        (item) => !item.inArchive && item.packageManager === 'winget' && item.packageId
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
          if (choice === 'cancel') {
            return;
          }
          if (choice === 'skip-archive') {
            saveSpecsById.set(item.id, { saveMode: 'none' });
            continue;
          }
          const picked = await pickArchiveTargetFolder({
            softwareName: item.name,
            packageId: item.packageId,
          });
          if (picked.canceled) {
            return;
          }
          saveSpecsById.set(item.id, {
            saveMode: 'ask',
            targetDir: picked.targetDir,
            collisionMode: picked.collisionMode,
          });
        }
      }

      const tasks = selectedItems.map((item) => {
        const st = getItemStatus(item);
        const archiveSaveSpec = !item.inArchive
          ? saveSpecsById.get(item.id) || { saveMode: saveMode === 'auto-id' ? 'auto-id' : 'none' }
          : null;
        return {
          id: item.id,
          name: item.name,
          origin: item.origin,
          inArchive: Boolean(item.inArchive),
          isInstalled: Boolean(item.isInstalled),
          packageManager: item.packageManager || (item.wingetId ? 'winget' : ''),
          packageId: item.packageId || item.wingetId || '',
          hasWebUpdate: Boolean(st.hasWebUpdate),
          hasArchiveUpdate: Boolean(st.hasArchiveUpdate),
          archiveSaveSpec,
        };
      });

      state.isBatchActionRunning = true;
      renderUpdatesBatchBar();
      showToast(`Aktualisiere ${tasks.length} ausgewählte Paket(e)...`, { type: 'info' });

      try {
        const res = await window.electronAPI.batchUpdatePackages(tasks, { allowSilent: true });
        if (Array.isArray(res?.results)) {
          for (const r of res.results) {
            if (r.status === 'done') state.selectedUpdateIds.delete(r.id);
          }
        }
        await reloadUI({ rescanInstalled: true });
        if (res?.canceled) {
          showToast('Massenaktualisierung abgebrochen.', { type: 'info' });
        } else if (res?.success) {
          const type = res.failed > 0 ? 'warn' : 'success';
          showToast(`${res.completed} Paket(e) aktualisiert (${res.skipped} übersprungen, ${res.failed} Fehler).`, {
            type,
          });
        } else if (res?.alreadyRunning) {
          showToast('Eine Massenaktualisierung läuft bereits.', { type: 'info' });
        } else if (res?.error) {
          showToast(`Fehler: ${res.error}`, { type: 'error', duration: 6000 });
        }
      } finally {
        state.isBatchActionRunning = false;
        renderUpdatesBatchBar();
      }
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
    if (e.target.closest('.media-dropzone')) return;
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
    const isTyping = active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' || active?.isContentEditable;

    if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && !isTyping)) {
      e.preventDefault();
      if (state.activeTab === 'discover') {
        discoverInput?.focus();
      } else if (state.activeTab === 'bundles') {
        document.getElementById('bundleSearchInput')?.focus();
      } else {
        searchInput?.focus();
      }
    } else if (e.key === 'Escape' && active === searchInput) {
      searchInput.value = '';
      state.searchQuery = '';
      if (clearBtn) clearBtn.hidden = true;
      searchInput.blur();
      renderCatalogGrid();
    } else if (e.key === 'Escape' && active === discoverInput) {
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

// Fehlende Bilder sauber verstecken
document.addEventListener(
  'error',
  (e) => {
    if (e.target?.tagName === 'IMG') {
      e.target.hidden = true;
    }
  },
  true
);

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
        showToast('Keine übernehmbaren Archiv- oder Winget-Programme auf diesem PC erkannt.', { type: 'warn' });
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
      const res = await window.electronAPI.duplicateBundle(bundleId);
      if (res?.success) {
        await reloadUI();
        showToast(`Bündel "${res.bundle?.name || 'Kopie'}" erstellt.`, { type: 'success' });
      } else {
        showToast(res?.error || 'Bündel konnte nicht dupliziert werden.', { type: 'error' });
      }
    },
    onDeleteBundle: async (bundle) => {
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
    onImportBundle: async () => {
      const res = await window.electronAPI.importBundle();
      if (res?.success) {
        await reloadUI();
        showToast(`Bündel "${res.bundle?.name || 'Import'}" importiert.`, { type: 'success' });
      } else if (res?.error && !res.canceled) {
        showToast(`Import fehlgeschlagen: ${res.error}`, { type: 'error', duration: 6000 });
      }
    },
  });

  initToolbar({
    onTabChange: (tab) => {
      state.activeTab = tab;
      renderActiveView();
    },
    onFilterChange: () => renderCatalogGrid(),
    onOpenSettings: () => openSettingsModal(),
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
      const res = await window.electronAPI.checkWebVersions();
      if (res.alreadyRunning) {
        showToast('Online-Prüfung läuft bereits.', { type: 'info' });
        return;
      }
      if (res.success) {
        await reloadUI();
        showToast(
          res.count > 0 ? `${res.count} neue Online-Versionen gefunden!` : 'Alle Online-Quellen sind aktuell.',
          { type: res.count > 0 ? 'success' : 'info' }
        );
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
        showToast(`${total} PC-Programme geprüft (${upd} Winget-Updates).`, { type: 'success' });
      } else if (localRes?.success) {
        await reloadUI();
        showToast(`${localRes.count} lokale Programme geprüft.`, { type: 'success' });
      }
    },
    onAddSoftware: async () => {
      const res = await window.electronAPI.addSoftware();
      if (res.success) {
        await reloadUI();
        showToast('Neue Software wurde hinzugefügt.', { type: 'success' });
      } else if (res.error) {
        showToast(res.error, { type: 'error', duration: 6000 });
      }
    },
    onAutoDetectAll: async () => {
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
    const info = await window.electronAPI.getAppInfo();
    const verEl = document.getElementById('appVersion');
    if (verEl) verEl.textContent = `(v${info.version})`;

    await reloadUI({ preserveScroll: false });
    checkAppUpdateInBackground();
    runInstalledScan({ silent: true });
  } catch (err) {
    console.error('Fehler beim Starten:', err);
    showToast(`Katalog konnte nicht geladen werden: ${err.message}`, { type: 'error', duration: 0 });
  }
}

bootstrap();
