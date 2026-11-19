import { renderCatalogGrid } from './components/cards.js';
import { initJobsBar } from './components/jobs-bar.js';
import { closeLightbox, initLightbox, isLightboxOpen, nextLightbox, prevLightbox } from './components/lightbox.js';
import { showToast } from './components/toast.js';
import { initToolbar, renderTagChips } from './components/toolbar.js';
import { closeModal, openDetailModal, openSettingsModal } from './modals/index.js';
import { refreshCatalogData, state, toggleFavorite } from './state.js';
import { escapeHTML } from './utils/sanitize.js';

async function reloadUI({ preserveScroll = true } = {}) {
  const y = window.scrollY;
  await refreshCatalogData();
  renderTagChips();
  renderCatalogGrid();
  if (preserveScroll) window.scrollTo(0, y);
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
  grid?.addEventListener('click', async (e) => {
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

function setupGlobalDragAndDrop() {
  const overlay = document.getElementById('dropOverlay');
  let dragDepth = 0;

  document.body.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!document.getElementById('modalOverlay').hidden) return;
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

    // Drops innerhalb offener Modals werden vom jeweiligen Modal verarbeitet
    if (!document.getElementById('modalOverlay').hidden) return;

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    const droppedPath = window.electronAPI.getFilePath(files[0]);
    if (!droppedPath) return;

    const res = await window.electronAPI.addSoftwareFromPath(droppedPath);
    if (res.success) {
      await reloadUI();
      showToast('Software-Ordner wurde zum Katalog hinzugefügt.', { type: 'success' });
    } else if (res.error) {
      showToast(res.error, { type: 'error', duration: 6000 });
    }
  });
}

function setupKeyboardShortcuts() {
  const searchInput = document.getElementById('searchInput');
  const clearBtn = document.getElementById('clearSearchBtn');
  const modalOverlay = document.getElementById('modalOverlay');

  document.addEventListener('keydown', (e) => {
    if (isLightboxOpen()) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowRight') nextLightbox();
      else if (e.key === 'ArrowLeft') prevLightbox();
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
      searchInput?.focus();
    } else if (e.key === 'Escape' && active === searchInput) {
      searchInput.value = '';
      state.searchQuery = '';
      if (clearBtn) clearBtn.hidden = true;
      searchInput.blur();
      renderCatalogGrid();
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
  setupGridEvents();
  setupGlobalDragAndDrop();
  setupKeyboardShortcuts();

  initJobsBar({
    onJobAction: async (action) => {
      if (action.type === 'recheck-local' && action.itemId) {
        const res = await window.electronAPI.scanLocalVersions({ itemIds: [action.itemId], silent: true });
        await window.electronAPI.dismissJob(action.jobId);
        await reloadUI();
        if (res.success && res.versions?.[action.itemId]) {
          showToast(`Erkannte Version: v${res.versions[action.itemId]}`, { type: 'success' });
        } else {
          showToast('Version konnte noch nicht ausgelesen werden.', { type: 'warn' });
        }
      }
    },
  });

  initToolbar({
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
      const res = await window.electronAPI.scanLocalVersions();
      if (res.alreadyRunning) {
        showToast('Lokale Versionsprüfung läuft bereits.', { type: 'info' });
        return;
      }
      if (res.success) {
        await reloadUI();
        showToast(`${res.count} lokale Programme geprüft.`, { type: 'success' });
      } else if (res.error && !res.canceled) {
        showToast(`Fehler bei lokaler Prüfung: ${res.error}`, { type: 'error' });
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
  });

  try {
    const info = await window.electronAPI.getAppInfo();
    const verEl = document.getElementById('appVersion');
    if (verEl) verEl.textContent = `(v${info.version})`;

    await reloadUI({ preserveScroll: false });
    checkAppUpdateInBackground();
  } catch (err) {
    console.error('Fehler beim Starten:', err);
    showToast(`Katalog konnte nicht geladen werden: ${err.message}`, { type: 'error', duration: 0 });
  }
}

bootstrap();
