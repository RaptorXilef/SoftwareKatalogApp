let catalog = [];
let activeTag = null;
let appSettings = {};
let localFavorites = [];
let availableHiddenCats = [];
let hasCheckedForUpdates = false; // Verhindert mehrfaches Prüfen während einer Sitzung

// Globale Variablen für den intelligenten Ladebalken
let scanCounter = 0;
let currentScanMode = 'quick';
let expectedScanCount = 0;
let currentPct = 0;
let scanInterval = null;

// Globale Variablen für die Lightbox-Galerie
let currentLightboxMedia = [];
let currentLightboxIndex = 0;

let currentOpenModalId = null; // Tracke das aktuell offene Modal für Dropdown Updates
let isUpdating = false; // Merkt sich, ob gerade ein Update heruntergeladen wird
let isEditModalOpen = false; // Blockiert Klicks außerhalb des Modals im Bearbeiten-Modus

// Zentrale Badge-Definition (Einzigartige Farben + 100% Offline-SVGs)
const BADGE_CONFIG = {
  webupdate: {
    label: 'Web-Update',
    title: 'Neue Version im Web verfügbar',
    color: '#cba6f7',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  },
  update: {
    label: 'NAS-Update',
    title: 'Neue Version auf dem NAS verfügbar',
    color: '#fab387',
    icon: '<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
  },
  installed: {
    label: 'Installiert',
    title: 'Programm ist auf diesem PC installiert',
    color: '#a6e3a1',
    icon: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  },
  newer: {
    label: 'PC neuer als NAS',
    title: 'Installierte Version ist neuer als auf dem NAS',
    color: '#89dceb',
    icon: '<svg viewBox="0 0 24 24"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg>',
  },
  new: {
    label: 'NEU',
    title: 'Kürzlich hinzugefügt oder bearbeitet',
    color: '#89b4fa',
    icon: '<svg viewBox="0 0 24 24"><path d="M12 2l2.4 7.2H22l-6 4.4 2.3 7.2L12 16.4l-6.3 4.4 2.3-7.2-6-4.4h7.6z"/></svg>',
  },
  nopath: {
    label: 'Pfad fehlt',
    title: 'Installationspfad fehlt. Klicke auf Bearbeiten, um ihn automatisch zu suchen.',
    color: '#f38ba8',
    icon: '<svg viewBox="0 0 24 24"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  },
  portable: {
    label: 'Portabel',
    title: 'Portables Programm (benötigt keinen Installationspfad)',
    color: '#cdd6f4',
    icon: '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/></svg>',
  },
  driver: {
    label: 'Treiber',
    title: 'Treiber oder Systemkomponente',
    color: '#f9e2af',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  },
  webtracking: {
    label: 'Web-Tracking',
    title: 'Prüft automatisch nach neuen Versionen im Internet (URL1)',
    color: '#b4befe',
    icon: '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  },
  webdownload: {
    label: 'Web-Download',
    title: 'Download-Link hinterlegt (URL2)',
    color: '#94e2d5',
    icon: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  },
  manual: {
    label: 'Pfad: Manuell',
    title: 'Pfad wurde nur manuell eingetragen',
    color: '#a6adc8',
    icon: '<svg viewBox="0 0 24 24"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
  },
  auto: {
    label: 'Pfad: Auto',
    title: 'Pfad wurde automatisch erkannt',
    color: '#74c7ec',
    icon: '<svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  },
  multi: {
    label: 'Pfad: Mix',
    title: 'Pfade wurden sowohl manuell als auch automatisch hinterlegt',
    color: '#f5c2e7',
    icon: '<svg viewBox="0 0 24 24"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  },
};

function getItemBadges(item) {
  const { status } = getItemStatus(item);
  const badgeDays = appSettings.newBadgeDays !== undefined ? appSettings.newBadgeDays : 14;
  const TIME_WINDOW = badgeDays * 24 * 60 * 60 * 1000;
  const itemTimestamp = item.updatedAt || item.addedAt || 0;
  const keys = [];

  if (status === 'webupdate') keys.push('webupdate');
  else if (status === 'update') keys.push('update');
  else if (status === 'newer') keys.push('newer');
  else if (status === 'installed') keys.push('installed');

  if (itemTimestamp > 0 && badgeDays > 0 && Date.now() - itemTimestamp < TIME_WINDOW) {
    keys.push('new');
  }

  const hasManual = item.installPaths?.length > 0;
  const hasAuto = item.autoPaths?.length > 0;
  const sType = item.softwareType || 'default';

  if (sType === 'portable') {
    keys.push('portable');
  } else if (sType === 'driver') {
    keys.push('driver');
  } else if (!hasManual && !hasAuto) {
    keys.push('nopath');
  } else if (appSettings.showPathOriginBadges) {
    if (hasManual && hasAuto) keys.push('multi');
    else if (hasManual) keys.push('manual');
    else if (hasAuto) keys.push('auto');
  }

  if (item.webVersionUrl) keys.push('webtracking');
  if (item.downloadUrl) keys.push('webdownload');

  return keys;
}

function renderBadgeDot(key) {
  const cfg = BADGE_CONFIG[key];
  if (!cfg) return '';
  return `<div class="badge-dot" style="background:${cfg.color};" title="${escapeHTML(cfg.label)} – ${escapeHTML(cfg.title)}">${cfg.icon}</div>`;
}

function renderBadgePill(key) {
  const cfg = BADGE_CONFIG[key];
  if (!cfg) return '';
  return `<div class="badge-pill" style="background:${cfg.color};" title="${escapeHTML(cfg.title)}">${cfg.icon}<span>${escapeHTML(cfg.label)}</span></div>`;
}

function renderBadgeLegend() {
  const legendEl = document.getElementById('badgeLegend');
  if (!legendEl) return;

  const keys = [
    'webupdate',
    'update',
    'installed',
    'newer',
    'new',
    'nopath',
    'portable',
    'driver',
    'webtracking',
    'webdownload',
  ];
  if (appSettings.showPathOriginBadges) {
    keys.push('manual', 'auto', 'multi');
  }

  legendEl.innerHTML = keys
    .map((key) => {
      const cfg = BADGE_CONFIG[key];
      return `<div class="legend-item" title="${escapeHTML(cfg.title)}"><span class="badge-dot" style="background:${cfg.color};">${cfg.icon}</span><span>${escapeHTML(cfg.label)}</span></div>`;
    })
    .join('');
}

// Security: XSS Helper
function escapeHTML(str) {
  if (typeof str !== 'string') return str;
  return str.replace(
    /[&<>'"]/g,
    (tag) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[tag]
  );
}

// Browser-sicheres Extrahieren des Dateinamens (ersetzt Node path.basename)
function getBaseName(filePath) {
  if (!filePath) return '';
  return filePath.split('\\').pop().split('/').pop();
}

// SemVer / Regex Logic for "Update" Badges
function extractVersion(filename) {
  // Sucht ausschließlich nach dem ersten Zahl-Punkt-Zahl Block (z.B. 1.0 oder 2.8.0.0)
  // Ignoriert Anhänge wie -Win64, -German oder Präfixe wie _v.
  const match = filename.match(/(\d+(?:\.\d+)+)/);
  return match ? match[1] : null;
}

function compareVersions(v1, v2, maxDepth = 3) {
  if (!v1 || !v2) return 0;
  const p1 = v1.split('.').map(Number);
  const p2 = v2.split('.').map(Number);

  // Bestimmt, wie viele Stellen verglichen werden sollen
  const depth = maxDepth > 0 ? maxDepth : Math.max(p1.length, p2.length);

  for (let i = 0; i < depth; i++) {
    const n1 = p1[i] || 0;
    const n2 = p2[i] || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

// Ermittelt Status, NAS-Version und installierte Version eines Programms
function getItemStatus(item) {
  const nasVersion =
    item.lastFiles && item.lastFiles.length > 0 ? extractVersion(getBaseName(item.lastFiles[0])) : null;
  const localVersion = item.installedVersion || null;

  let status = 'none'; // 'none' | 'installed' | 'update' | 'newer' | 'webupdate'
  // Konfigurierte Vergleichstiefe auslesen
  const depth = appSettings.versionCompareDepth !== undefined ? appSettings.versionCompareDepth : 3;

  // Höchste Priorität: Ist die aus dem Web gezogene Version neuer als die auf dem NAS?
  if (item.webVersion) {
    if (!nasVersion || compareVersions(item.webVersion, nasVersion, depth) > 0) {
      status = 'webupdate';
    }
  }

  // Danach greift die bisherige PC-vs-NAS Auswertung
  if (status !== 'webupdate' && item.isInstalled) {
    status = 'installed';
    if (nasVersion && localVersion) {
      const cmp = compareVersions(nasVersion, localVersion, depth);
      if (cmp > 0) status = 'update';
      else if (cmp < 0) status = 'newer';
    }
  }

  return { status, nasVersion, localVersion };
}

// Globale Helper-Funktion für das Edit-Modal
window.handleWebUrlChange = (input) => {
  const val = input.value.trim();
  const isGithub = val.toLowerCase().includes('github.com');
  const scrapeOpts = document.getElementById('webScrapeOpts');
  if (scrapeOpts) scrapeOpts.style.display = isGithub ? 'none' : 'block';

  // Auto-Fill für GitHub Releases
  if (isGithub) {
    const dlInput = document.getElementById('editDownloadUrl');
    const repoMatch = val.match(/github\.com\/([^/]+\/[^/?#]+)/);
    if (dlInput && !dlInput.value.trim() && repoMatch) {
      // Entfernt trailing Slashes und .git am Ende
      const cleanUrl = val.replace(/\.git$/i, '').replace(/\/$/, '');
      dlInput.value = `${cleanUrl}/releases/latest`;
    }
  }
};

// Globaler Error-Listener zum Ausblenden fehlender Bilder
document.addEventListener(
  'error',
  (e) => {
    if (e.target.tagName === 'IMG') {
      e.target.style.display = 'none';
    }
  },
  true
); // capturing phase!

const el = {
  grid: document.getElementById('grid'),
  searchInput: document.getElementById('searchInput'),
  clearSearchBtn: document.getElementById('clearSearchBtn'),
  sortSelect: document.getElementById('sortSelect'),
  tagContainer: document.getElementById('tagContainer'),
  modalOverlay: document.getElementById('modalOverlay'),
  modalContent: document.getElementById('modalContent'),
  lightboxOverlay: document.getElementById('lightboxOverlay'),
  lightboxImg: document.getElementById('lightboxImg'),
  lightboxVid: document.getElementById('lightboxVid'),
  appVersion: document.getElementById('appVersion'),
  catalogCount: document.getElementById('catalogCountDisplay'),
  scanStatus: document.getElementById('scanStatus'),
  scanProgressBar: document.getElementById('scanProgressBar'),
  scanPercentText: document.getElementById('scanPercentText'),
  scanTargetText: document.getElementById('scanTargetText'),
  scanPathText: document.getElementById('scanPathText'),
  dropOverlay: document.getElementById('dropOverlay'),
};

// ==========================================
// DRAG & DROP & GLOBAL EVENT LISTENERS
// ==========================================
document.body.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.stopPropagation();

  // Unterscheide: Geht der Drop ans Media-Feld (im Modal) oder ins Fenster (Neues Programm)?
  const dropzone = e.target.closest('.media-dropzone');
  if (dropzone) {
    dropzone.classList.add('dragover');
    el.dropOverlay.style.display = 'none'; // Verstecke das große Overlay
    // Nur anzeigen, wenn das Modal geschlossen ist
  } else if (el.modalOverlay.style.display !== 'flex') {
    el.dropOverlay.style.display = 'flex';
  }
});

document.body.addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();

  const dropzone = e.target.closest('.media-dropzone');
  if (dropzone) dropzone.classList.remove('dragover');
});

document.getElementById('dropOverlay').addEventListener('dragleave', (e) => {
  e.preventDefault();
  e.stopPropagation();
  el.dropOverlay.style.display = 'none';
});

document.body.addEventListener('drop', async (e) => {
  e.preventDefault();
  e.stopPropagation();
  el.dropOverlay.style.display = 'none';
  if (!window.electronAPI) return;

  const files = Array.from(e.dataTransfer.files);
  if (files.length === 0) return;

  // 1. Fall: Drop ins Media-Feld des Edit-Modals (Bilder, Icons, Videos)
  const dropzone = e.target.closest('.media-dropzone');
  if (dropzone) {
    dropzone.classList.remove('dragover');
    const targetPath = dropzone.dataset.path;
    const softwareId = dropzone.dataset.id;
    const dropType = dropzone.dataset.type;

    if (dropType === 'icon') {
      const res = await window.electronAPI.addIcon(targetPath, files[0].path);
      if (res.success) {
        await startScan('update');
        editSoftware(softwareId);
      } else {
        alert(`Fehler beim Aktualisieren des Icons:\n${res.error}`);
      }
    } else {
      const filePaths = files.map((f) => f.path);
      const res = await window.electronAPI.addMedia(targetPath, filePaths);
      if (res.success) {
        // Flottes Update anstoßen, um das kopierte Bild sofort einzulesen
        await startScan('update');
        editSoftware(softwareId); // Modal mit neuen Bildern neu laden
      } else {
        alert(`Fehler beim Hinzufügen der Medien:\n${res.error}`);
      }
    }
    return;
  }

  // 2. Fall: Globaler Drop (Neues Programm-Verzeichnis hinzufügen)
  // Greift nur, wenn kein Modal offen ist
  if (el.modalOverlay.style.display !== 'flex') {
    const res = await window.electronAPI.addSoftwareFromPath(files[0].path);
    if (res.success) {
      await startScan('quick');
      alert(
        'Der Ordner wurde erfolgreich hinzugefügt!\n\nSuche das Programm nun in der Liste und klicke auf "Bearbeiten".'
      );
    } else if (res.error) {
      alert(`Fehler beim Hinzufügen:\n${res.error}`);
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (el.lightboxOverlay.style.display === 'flex') {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') lightboxNext();
    if (e.key === 'ArrowLeft') lightboxPrev();
  } else if (el.modalOverlay.style.display === 'flex') {
    if (e.key === 'Escape') closeModal();
  } else {
    // Keyboard Shortcut für Suche (Strg+F oder /)
    const isInputActive = document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA';
    // Ignoriere den Editor (contenteditable) für den Strg+F Shortcut
    const isEditorActive = document.activeElement.isContentEditable;

    if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && !isInputActive && !isEditorActive)) {
      e.preventDefault();
      el.searchInput.focus();
    } else if (e.key === 'Escape' && isInputActive) {
      el.searchInput.value = '';
      el.clearSearchBtn.style.display = 'none';
      el.searchInput.blur();
      renderGrid();
    }
  }
});

// Scroll-Event-Listener für die Sticky Toolbar
window.addEventListener('scroll', () => {
  const tb = document.getElementById('mainToolbar');
  if (window.scrollY > 40) tb.classList.add('shrink');
  else tb.classList.remove('shrink');
});

el.modalOverlay.addEventListener('click', (e) => {
  if (e.target === el.modalOverlay && !isEditModalOpen) closeModal();
});

el.lightboxOverlay.addEventListener('click', (e) => {
  if (e.target.tagName !== 'IMG' && e.target.tagName !== 'VIDEO' && e.target.tagName !== 'BUTTON') {
    closeLightbox();
  }
});

document.getElementById('lightboxBtnLeft').addEventListener('click', (e) => {
  e.stopPropagation();
  lightboxPrev();
});
document.getElementById('lightboxBtnRight').addEventListener('click', (e) => {
  e.stopPropagation();
  lightboxNext();
});

// Toolbar Buttons
document.body.addEventListener('click', (e) => {
  if (e.target.id === 'btnSettingsToggle') openSettings();
  if (e.target.id === 'btnAddSoftware') addSoftwareFolder();
  if (e.target.id === 'btnScan') startScan('quick');
  if (e.target.id === 'btnUpdate') startScan('update');
  if (e.target.id === 'btnLocalVersions') scanLocalVersionsUI();
  if (e.target.id === 'btnWebVersions') checkWebVersionsUI();
  if (e.target.id === 'btnAutoDetectAll') autoDetectAllPaths();
  if (e.target.id === 'btnFullScan') startScan('full');

  // Toggle für die versteckten Buttons
  const toggleBtn = e.target.closest('#btnToggleAdvanced');
  if (toggleBtn) {
    document.getElementById('advancedActionsWrapper').classList.toggle('expanded');
    toggleBtn.classList.toggle('expanded');
  }
});

el.searchInput.addEventListener('input', () => {
  el.clearSearchBtn.style.display = el.searchInput.value.length > 0 ? 'block' : 'none';
  renderGrid();
});

el.clearSearchBtn.addEventListener('click', () => {
  el.searchInput.value = '';
  el.clearSearchBtn.style.display = 'none';
  renderGrid();
  el.searchInput.focus();
});

el.sortSelect.addEventListener('change', renderGrid); // Auf Sortieränderung reagieren

// ==========================================
// EVENT DELEGATION
// ==========================================
document.body.addEventListener('click', async (e) => {
  // Nativer Rich Text Editor Toolbar Handling
  const cmdBtn = e.target.closest('.editor-toolbar button');
  if (cmdBtn) {
    e.preventDefault();
    const cmd = cmdBtn.dataset.cmd;
    if (cmd === 'createLink') {
      const url = prompt('Link URL einfügen (z.B. https://):', 'https://');
      if (url) document.execCommand(cmd, false, url);
    } else {
      document.execCommand(cmd, false, null);
    }
    return;
  }

  // Bilder (Lightbox) abfangen, VOR dem "Klick auf die Karte"
  if (e.target.classList.contains('img-zoomable') || e.target.closest('.vid-container')) {
    e.stopPropagation(); // Verhindert, dass das Klick-Event andere Aktionen auslöst
    const zoomTarget = e.target.classList.contains('img-zoomable') ? e.target : e.target.closest('.vid-container');
    if (zoomTarget.dataset.id) {
      openLightbox(zoomTarget.dataset.id, parseInt(zoomTarget.dataset.idx, 10));
    }
    return;
  }

  // Grid Card click
  const card = e.target.closest('.card');
  if (card && !e.target.classList.contains('fav-btn')) {
    openItemModal(card.dataset.id);
  }

  // Fav Button
  if (e.target.classList.contains('fav-btn')) {
    e.stopPropagation();
    toggleFav(e.target.dataset.id);
  }

  // Tag Filter Button
  if (e.target.classList.contains('tag')) {
    const rawTag = e.target.dataset.tag;
    activeTag = rawTag === 'all' ? null : rawTag;
    renderTags();
    renderGrid();
  }

  // Action Buttons
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // Modal Actions
  if (action === 'open-item-modal') openItemModal(actionEl.dataset.id);
  if (action === 'close-modal') closeModal();
  if (action === 'open-explorer') openInExplorer(actionEl.dataset.path);
  if (action === 'edit-software') editSoftware(actionEl.dataset.id);
  if (action === 'save-software') saveSoftware(actionEl.dataset.id);
  if (action === 'open-url') {
    e.preventDefault();
    openExternalUrl(actionEl.dataset.url);
  }
  if (action === 'save-settings') saveSettings();

  // Debug & Backup Event Listener
  if (action === 'reset-paths') {
    const type = actionEl.dataset.type;
    const typeName = type === 'auto' ? 'automatisch gefundenen' : 'manuell eingetragenen';
    if (
      !confirm(
        `Willst du wirklich ALLE ${typeName} Pfade aus dem gesamten Katalog löschen?\n\nDas kann nicht rückgängig gemacht werden!`
      )
    )
      return;

    actionEl.disabled = true;
    const origText = actionEl.textContent;
    actionEl.textContent = '⏳ Lösche...';
    try {
      const res = await window.electronAPI.resetPaths(type);
      if (res.success) {
        await startScan('update'); // Lädt den Katalog neu, um Änderungen sofort zu zeigen
        alert(`Erfolgreich gelöscht: ${res.count} Programme wurden aktualisiert.`);
      }
    } catch (err) {
      alert(err);
    }
    actionEl.textContent = origText;
    actionEl.disabled = false;
  }

  if (action === 'reset-versions') {
    const type = actionEl.dataset.type;
    if (type === 'nas') {
      alert(
        '💡 Info zu NAS-Versionen:\n\nDie NAS-Versionen werden nirgendwo in einer Datenbank gespeichert. Die App liest sie in Echtzeit aus den Dateinamen deiner Setup-Dateien (z.B. im "_last" Ordner) aus.\n\nUm diese Versionen zu löschen oder zu ändern, musst du die entsprechenden Dateien auf dem NAS-Laufwerk löschen oder umbenennen!'
      );
      return;
    }

    if (
      !confirm(
        'Willst du die gemerkten Versionen aller lokal installierten Programme auf diesem PC löschen?\n\nDie App wird sie beim nächsten Suchlauf neu einlesen.'
      )
    )
      return;
    const res = await window.electronAPI.resetVersions(type);
    if (res.success) {
      await init();
      alert('Lokale PC-Versionen wurden erfolgreich zurückgesetzt!');
    }
  }

  if (action === 'create-backup') {
    const res = await window.electronAPI.createBackup();
    if (res.success) alert('Backup erfolgreich als JSON-Datei gespeichert!');
    else if (res.error) alert(`Fehler beim Speichern:\n${res.error}`);
  }

  if (action === 'restore-backup') {
    if (
      !confirm(
        '⚠️ ACHTUNG ⚠️\n\nDein aktueller Zustand (Alle Einstellungen & Favoriten) wird komplett mit den Daten aus dem Backup überschrieben!\n\nWillst du wirklich fortfahren?'
      )
    )
      return;
    const res = await window.electronAPI.restoreBackup();
    if (res.success) {
      alert('Backup erfolgreich geladen!\nDie App-Ansicht wird nun aktualisiert.');
      el.modalOverlay.style.display = 'none';
      await init();
    } else if (res.error) {
      alert(`Fehler beim Laden des Backups:\n${res.error}`);
    }
  }
  // ENDE: Debug & Backup Event Listener

  if (action === 'browse-file') {
    const isDir = actionEl.dataset.type === 'dir';
    const filterExt = actionEl.dataset.ext;
    const inputId = actionEl.dataset.target;
    browseFile(inputId, isDir, filterExt ? [{ name: filterExt, extensions: [filterExt] }] : undefined);
  }

  // Auto-Detect Trigger mit dynamischen Namen aus dem UI
  if (action === 'auto-detect-path') {
    const inputId = actionEl.dataset.target;
    const origText = actionEl.textContent;
    const itemId = actionEl.dataset.id;

    const mainName = document.getElementById('editName').value.trim();
    const searchNamesInput = document
      .getElementById('editSearchNames')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const namesArray = [mainName, ...searchNamesInput].filter(Boolean);

    actionEl.textContent = '⏳ Suche...';
    actionEl.disabled = true;
    try {
      const res = await window.electronAPI.autoDetectPath(namesArray);
      if (res.success && res.path) {
        const textarea = document.getElementById(inputId);
        if (!textarea.value.includes(res.path)) {
          textarea.value = textarea.value ? `${textarea.value}\n${res.path}` : res.path;
        }

        const item = catalog.find((i) => i.id === itemId);
        if (item && !item.icon) {
          await window.electronAPI.extractExeIcon(res.path, item.path);
        }

        actionEl.textContent = '✓ Gefunden!';
        setTimeout(() => {
          actionEl.textContent = origText;
          actionEl.disabled = false;
        }, 2000);
      } else {
        alert('Kein passender Registry-Eintrag gefunden. Bitte Such-Namen anpassen oder manuell suchen!');
        actionEl.textContent = origText;
        actionEl.disabled = false;
      }
    } catch (err) {
      alert(`Fehler:\n${err.message}`);
      actionEl.textContent = origText;
      actionEl.disabled = false;
    }
  }

  // Manueller Icon-Extraktor
  if (action === 'extract-icon') {
    const itemId = actionEl.dataset.id;
    const item = catalog.find((i) => i.id === itemId);

    // Icon kann aus manuellen ODER automatischen Pfaden extrahiert werden
    const installPaths = document
      .getElementById('editInstallPaths')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const autoPaths = document
      .getElementById('editAutoPaths')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const allPaths = [...autoPaths, ...installPaths];

    if (allPaths.length > 0 && allPaths[0].toLowerCase().endsWith('.exe')) {
      const origText = actionEl.textContent;
      actionEl.textContent = '⏳ Lade...';
      actionEl.disabled = true;
      try {
        const res = await window.electronAPI.extractExeIcon(allPaths[0], item.path);
        if (res.success) {
          // Um das Icon sofort anzuzeigen, speichern wir kurz zwischen und laden das UI neu
          await startScan('update');
          editSoftware(itemId);
        } else {
          alert(`Fehler beim Extrahieren:\n${res.error}`);
          actionEl.textContent = origText;
          actionEl.disabled = false;
        }
      } catch (err) {
        alert(`Fehler:\n${err.message}`);
        actionEl.textContent = origText;
        actionEl.disabled = false;
      }
    } else {
      alert('Bitte trage zuerst einen gültigen .exe Installationspfad in eines der beiden Felder ein!');
    }
  }

  // Hinzufügen lokaler Installationspfade im Edit-Modal
  if (action === 'browse-install-path') {
    const inputId = actionEl.dataset.target;
    const selectedPath = await window.electronAPI.selectFile([
      { name: 'Ausführbare Dateien', extensions: ['exe', 'bat', 'cmd', 'ps1'] },
    ]);
    if (selectedPath) {
      const textarea = document.getElementById(inputId);
      textarea.value = textarea.value ? `${textarea.value}\n${selectedPath}` : selectedPath;
    }
  }

  if (action === 'manual-update') checkForUpdatesUI();
  if (action === 'install-update') {
    installUpdate(actionEl.dataset.url, actionEl.dataset.portable === 'true');
  }

  // Installer via Temp-Ordner sicher ausführen
  if (action === 'execute-temp') {
    const originalText = actionEl.textContent;
    const itemId = actionEl.dataset.id;
    const filePath = actionEl.dataset.path;

    // Markiere Programm als installiert & merke dir die Setup-Versionsnummer
    const version = extractVersion(getBaseName(filePath));
    if (version && itemId) {
      await window.electronAPI.markAsInstalled(itemId, version);
      const catItem = catalog.find((i) => i.id === itemId);
      if (catItem) {
        catItem.isInstalled = true;
        catItem.installedVersion = version;
        renderGrid();
      }
    }

    actionEl.textContent = '⏳ Kopiere & Starte...';
    actionEl.disabled = true;
    try {
      const res = await window.electronAPI.executeTempInstaller(filePath);
      if (!res.success) alert(`Fehler bei der Ausführung:\n${res.error}`);
    } catch (err) {
      alert(`Fehler:\n${err.message}`);
    }
    actionEl.textContent = originalText;
    actionEl.disabled = false;
  }

  if (action === 'start-download') {
    const originalText = actionEl.textContent;
    actionEl.textContent = 'Kopiere...';
    actionEl.disabled = true;
    try {
      const parsedFiles = JSON.parse(actionEl.dataset.files);
      const res = await window.electronAPI.downloadFiles(parsedFiles);
      if (res.success) alert(`Erfolgreich gespeichert unter:\n${res.dest}`);
      else if (res.error) alert(`Fehler beim Kopieren:\n${res.error}`);
    } catch (err) {
      alert(`Fehler: ${err.message}`);
    }
    actionEl.textContent = originalText;
    actionEl.disabled = false;
  }

  // Lädt die Liste aller installierten PC Programme für das Dropdown
  if (action === 'fetch-installed-apps') {
    actionEl.textContent = '⏳ Lade PC-Liste...';
    actionEl.disabled = true;
    try {
      const apps = await window.electronAPI.getInstalledApps();
      if (apps && apps.length > 0) {
        const selectHtml = `
          <select id="installedAppsSelect" class="version-selector" style="margin: 0; max-width: 250px; background:var(--surface); border:1px solid var(--border);">
            <option value="">-- Programm hinzufügen --</option>
            ${apps.map((a) => `<option value="${escapeHTML(a)}">${escapeHTML(a)}</option>`).join('')}
          </select>
        `;
        // Ersetzt den Button durch das Dropdown-Menü
        actionEl.outerHTML = selectHtml;
      } else {
        alert('Keine installierten Programme gefunden.');
        actionEl.textContent = '📋 Liste laden';
        actionEl.disabled = false;
      }
    } catch (e) {
      alert(e.message);
      actionEl.textContent = '📋 Liste laden';
      actionEl.disabled = false;
    }
  }

  // Visual Link Picker (nutzt ausschließlich URL2, unabhängig von URL1)
  if (action === 'visual-link-pick') {
    let startUrl = document.getElementById('editDownloadUrl').value.trim();
    if (!startUrl) {
      startUrl = prompt(
        'Bitte gib die Download-Webseite (URL2) ein, auf der der Download-Button zu finden ist:',
        'https://'
      );
      if (!startUrl || startUrl.trim() === 'https://') return;
      startUrl = startUrl.trim();
    }

    actionEl.disabled = true;
    const origText = actionEl.textContent;
    actionEl.textContent = '⏳ Öffne Browser...';

    try {
      const res = await window.electronAPI.openVisualLinkPicker(startUrl);
      if (res.success) {
        document.getElementById('editDownloadUrl').value = res.url;
        document.getElementById('editDlPrefix').value = res.prefix;
        document.getElementById('editDlSuffix').value = res.suffix;
        document.getElementById('dlScrapeOpts').style.display = 'block';
        alert(
          'Erfolgreich erkannt!\n\nDieser Download-Link wird ab sofort bei jedem Klick vollautomatisch aus der Quell-Webseite ausgelesen!'
        );
      } else if (!res.canceled) {
        alert(`Fehler:\n${res.error}`);
      }
    } catch (e) {
      alert(`Fehler:\n${e.message}`);
    } finally {
      actionEl.textContent = origText;
      actionEl.disabled = false;
    }
  }

  // Visual Scrape Button
  if (action === 'visual-scrape') {
    const url = document.getElementById('editWebVersionUrl').value.trim();
    if (!url || url.toLowerCase().includes('github.com')) {
      return alert('Bitte trage zuerst eine gültige Webseite (Kein GitHub!) in das URL1 Feld ein!');
    }

    actionEl.disabled = true;
    const origText = actionEl.textContent;
    actionEl.textContent = '⏳ Öffne Browser...';

    try {
      const res = await window.electronAPI.openVisualScraper(url);
      if (res.success) {
        document.getElementById('editWebPrefix').value = res.prefix;
        document.getElementById('editWebSuffix').value = res.suffix;
        document.getElementById('editWebVersion').value = res.version;
        document.getElementById('webScrapeOpts').style.display = 'block'; // Box zur Sicherheit aufklappen
        alert(`Erfolgreich markiert!\n\nPräfix und Suffix wurden automatisch generiert.\nVersion: ${res.version}`);
      } else if (!res.canceled) {
        alert(`Fehler:\n${res.error}`);
      }
    } catch (e) {
      alert(`Fehler:\n${e.message}`);
    } finally {
      actionEl.textContent = origText;
      actionEl.disabled = false;
    }
  }

  // Einzelnes Programm prüfen (Direkt aus dem Edit Modal)
  if (action === 'check-single-web') {
    const itemId = actionEl.dataset.id;
    const url = document.getElementById('editWebVersionUrl').value.trim();
    const prefix = document.getElementById('editWebPrefix').value;
    const suffix = document.getElementById('editWebSuffix').value;

    if (!url) return alert('Bitte zuerst eine URL1 eintragen!');

    actionEl.disabled = true;
    const origText = actionEl.textContent;
    actionEl.textContent = '⏳ Prüfe...';
    try {
      const res = await window.electronAPI.checkSingleWebVersion(itemId, url, prefix, suffix);
      if (res.success) {
        document.getElementById('editWebVersion').value = res.version;
        alert(
          `Erfolgreich geprüft!\n\nAktuellste Version im Web ist: ${res.version}\n\n(Bitte vergiss nicht, unten auf "Speichern" zu klicken)`
        );
      } else {
        alert(`Fehler:\n${res.error}`);
      }
    } catch (e) {
      alert(`Fehler:\n${e.message}`);
    } finally {
      actionEl.textContent = origText;
      actionEl.disabled = false;
    }
  }

  // Check Web Versions
  if (action === 'check-web-versions') {
    checkWebVersionsUI();
  }

  // Download Web Version
  if (action === 'download-web') {
    const url = actionEl.dataset.url;
    const dlPrefix = actionEl.dataset.pre || '';
    const dlSuffix = actionEl.dataset.suf || '';
    const folder = actionEl.dataset.path;
    const itemId = actionEl.dataset.id;

    // Generiert einen vernünftigen Standardnamen aus der URL
    let defaultName = url.split('/').pop().split('?')[0] || 'setup.exe';
    if (!defaultName.includes('.')) defaultName += '.exe';

    actionEl.disabled = true;
    const origText = actionEl.textContent;
    actionEl.textContent = '⏳ Wähle Ziel...';

    try {
      const res = await window.electronAPI.downloadWebUrl(url, dlPrefix, dlSuffix, folder, defaultName, itemId);
      if (res.success) {
        const doUpdate = confirm(
          `Download abgeschlossen!\n\nDie Setup-Datei liegt nun in deinem NAS-Ordner.\nDatei: ${res.filePath}\n\nMöchtest du das Programm (Metadaten/Ordner) jetzt kurz scannen, damit die neue Datei sofort sichtbar ist?`
        );
        if (doUpdate) startScan('update'); // Flottes NAS-Update, um die neue Setup-Datei sofort im Katalog zu sehen!
      } else if (!res.canceled) {
        alert(`Fehler beim Download:\n${res.error}`);
      }
    } catch (e) {
      alert(`Fehler:\n${e.message}`);
    } finally {
      actionEl.textContent = origText;
      actionEl.disabled = false;
    }
  }
});

// Reagiert auf die VersionSelector-Änderung (um die Buttons im Modal dynamisch anzupassen)
document.body.addEventListener('change', (e) => {
  // Wenn ein Programm aus dem Dropdown gewählt wird, ab in das Such-Namen Feld!
  if (e.target.id === 'installedAppsSelect') {
    const val = e.target.value;
    if (val) {
      const input = document.getElementById('editSearchNames');
      // Bisherige Einträge holen, aufsplitten und putzen
      const current = input.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      // Nur hinzufügen, wenn es noch nicht in der Liste steht
      if (!current.includes(val)) {
        current.push(val);
        input.value = current.join(', ');
      }
      // Dropdown wieder zurücksetzen
      e.target.value = '';
    }
  }

  // VersionSelector Logik
  if (e.target.id === 'versionSelector') {
    const selectedIdx = e.target.value;
    const activeItem = catalog.find((i) => i.id === currentOpenModalId);

    if (activeItem?.lastFiles[selectedIdx]) {
      const file = activeItem.lastFiles[selectedIdx];
      const installBtn = document.getElementById('dynamicInstallBtn');
      const dlBtn = document.getElementById('dynamicDownloadBtn');

      if (installBtn) installBtn.dataset.path = file;
      if (dlBtn) dlBtn.dataset.files = JSON.stringify([file]);
    }
  }
});

// ==========================================
// ELECTRON IPC LISTENERS & SCAN LOGIC
// ==========================================
if (window.electronAPI) {
  window.electronAPI.onScanStart((path) => {
    scanCounter = 0;
    currentPct = 0;
    el.scanTargetText.textContent = `Durchsuche Laufwerk (${escapeHTML(path)})...`;
    updateProgressUI();

    // Hole den spezifischen Zähler exakt für diesen Scan-Modus
    expectedScanCount = parseInt(localStorage.getItem(`scanCount_${currentScanMode}`), 10) || 0;
    if (currentScanMode === 'update') expectedScanCount = catalog.length || 1;

    // Simulierter Hintergrund-Timer: Füllt den Balken sanft in ~2 Minuten auf 99%
    // greift besonders dann, wenn die App die Dateimenge (noch) nicht kennt.
    clearInterval(scanInterval);
    scanInterval = setInterval(() => {
      if (currentPct < 99) {
        let increment = (99 - currentPct) * 0.015; // Wird langsamer, je näher er 99 kommt
        if (increment < 0.1) increment = 0.1;
        currentPct += increment;
        if (currentPct > 99) currentPct = 99;
        updateProgressUI();
      }
    }, 500);
  });

  window.electronAPI.onScanProgress((path) => {
    scanCounter++;
    if (el.scanPathText) el.scanPathText.textContent = path; // setTextContent is naturally XSS safe

    // Sobald wir einen echten (historischen) Wert haben, nutzen wir echte Mathematik
    if (expectedScanCount > 0) {
      let realPct = (scanCounter / expectedScanCount) * 100;
      if (realPct > 99) realPct = 99;

      // Die Prozentzahl darf niemals rückwärts laufen
      if (realPct > currentPct) currentPct = realPct;
    }
    updateProgressUI();
  });
}

// Ausgelagerte Funktion zum Aktualisieren der Balken-UI
function updateProgressUI() {
  const displayPct = Math.floor(currentPct);
  el.scanProgressBar.style.width = `${displayPct}%`;
  el.scanPercentText.textContent = `${displayPct}%`;
}

// Hört auf den Live-Fortschritt des Web-Downloads aus der main.js
if (window.electronAPI) {
  window.electronAPI.onWebDownloadProgress((data) => {
    const btn = document.getElementById(`btnWebDl_${data.id}`);
    if (btn) btn.textContent = `⏳ ${data.pct}%`;
  });
}

// ==========================================
// INIT & RENDERING
// ==========================================
async function init() {
  try {
    if (window.electronAPI) {
      catalog = await window.electronAPI.loadCatalog();
      appSettings = await window.electronAPI.getSettings();
      // Synchronisiere Favoriten sauber aus der PC-lokalen state.json ins Array
      if (!appSettings.favorites) appSettings.favorites = [];
      localFavorites = appSettings.favorites;

      const info = await window.electronAPI.getAppInfo();
      el.appVersion.textContent = `(v${escapeHTML(info.version)})`;
    } else {
      catalog = await (await fetch('catalog.json')).json();
      appSettings = {};
    }

    availableHiddenCats = [...new Set(catalog.map((i) => i.hiddenCategory).filter((c) => c))];

    catalog.forEach((item) => {
      item.tags = [];
      if (item.mainCategory) item.tags.push(item.mainCategory);
      if (item.subCategories) item.tags.push(...item.subCategories);
    });

    if (catalog.length === 0) {
      el.grid.innerHTML =
        '<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text); opacity: 0.7;">Katalog leer. Bitte zuerst scannen.</div>';
      el.catalogCount.textContent = '0';
    } else {
      el.catalogCount.textContent = catalog.length.toString();
      renderBadgeLegend();
      renderTags();
      renderGrid();
      performAutoUpdateCheck(); // Führt Prüfung im Hintergrund aus, falls Intervall erreicht
    }
  } catch (error) {
    console.error('Fehler beim Initialisieren:', error);
    el.grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: red;">Fehler: Konnte Daten nicht laden. Details: ${escapeHTML(error.message || error)}</div>`;
  }
}

async function startScan(mode) {
  if (!window.electronAPI) return alert('Scannen ist nur in der Desktop-App möglich.');
  currentScanMode = mode;

  const btns = [
    document.getElementById('btnScan'),
    document.getElementById('btnUpdate'),
    document.getElementById('btnFullScan'),
    document.getElementById('btnAutoDetectAll'),
    document.getElementById('btnLocalVersions'),
    document.getElementById('btnWebVersions'),
  ];
  btns.forEach((b) => {
    if (b) b.disabled = true;
  });

  // Zeige den flachen Banner an, lass das Grid unangetastet!
  el.scanStatus.style.display = 'block';

  // Sichere die aktuelle Scroll-Position des Nutzers
  const currentScroll = window.scrollY;

  try {
    await window.electronAPI.runScan(mode);

    // Timer hart stoppen und visuell sofort auf 100% setzen
    clearInterval(scanInterval);
    currentPct = 100;
    updateProgressUI();
    el.scanPathText.textContent = 'Katalog wird gespeichert...';

    // Speichere den Ordner-Zähler separat für den jeweiligen Scan-Modus in der Zukunft
    if (mode !== 'update') localStorage.setItem(`scanCount_${mode}`, scanCounter.toString());

    // Kurze Verzögerung, damit der Nutzer die 100% sieht
    await new Promise((r) => setTimeout(r, 400));
    await init();

    // Stelle die Scroll-Position sofort wieder her
    window.scrollTo(0, currentScroll);
  } catch (error) {
    console.error('Scan-Fehler:', error);
    if (error.message?.includes('LOCKED')) {
      alert('Scan abgebrochen: Ein anderes Familienmitglied führt gerade einen Scan durch.');
    } else {
      alert(`Fehler beim Scannen:\n${error.message || error}`);
    }
    init(); // Versuche den alten Zustand wiederherzustellen
  } finally {
    clearInterval(scanInterval);
    btns.forEach((b) => {
      if (b) b.disabled = false;
    });
    // Verstecke den Banner wieder
    el.scanStatus.style.display = 'none';
  }
}

async function scanLocalVersionsUI() {
  if (!window.electronAPI) return;
  const btn = document.getElementById('btnLocalVersions');
  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Prüfe PC...';
  }

  try {
    const res = await window.electronAPI.scanLocalVersions();
    if (res.success) {
      await init();
    } else if (res.error) {
      alert(`Fehler beim Auslesen der lokalen Versionen:\n${res.error}`);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

// Globaler Auto-Detect Batch-Lauf
async function autoDetectAllPaths() {
  if (!window.electronAPI) return;

  // Sucht jetzt spezifisch nach Programmen, denen der Auto-Pfad fehlt
  // Sucht spezifisch nach Programmen, denen der Auto-Pfad fehlt UND die normale Programme sind
  const itemsToProcess = catalog.filter((i) => {
    const isStandard = !i.softwareType || i.softwareType === 'default';
    const noAutoPath = !i.autoPaths || i.autoPaths.length === 0;
    return isStandard && noAutoPath;
  });
  if (itemsToProcess.length === 0) return alert('Alle Programme im Katalog wurden bereits automatisch gesucht!');

  if (
    !confirm(
      `Sollen ${itemsToProcess.length} Programme jetzt automatisch auf diesem PC gesucht werden?\n(Das kann einige Zeit dauern)`
    )
  )
    return;

  const btn = document.getElementById('btnAutoDetectAll');
  const origText = btn ? btn.textContent : '';
  if (btn) btn.disabled = true;

  el.scanStatus.style.display = 'block';
  el.scanTargetText.textContent = 'Auto-Detect läuft...';

  let processed = 0;
  let foundCount = 0;

  for (const item of itemsToProcess) {
    processed++;
    el.scanPathText.textContent = `Prüfe: ${item.name}`;
    currentPct = Math.round((processed / itemsToProcess.length) * 100);
    updateProgressUI();

    const namesToSearch = [item.name, ...(item.searchNames || [])];
    const res = await window.electronAPI.autoDetectPath(namesToSearch);
    if (res.success && res.path) {
      if (!item.icon) {
        await window.electronAPI.extractExeIcon(res.path, item.path);
      }

      const data = {
        name: item.name,
        softwareType: item.softwareType || 'default',
        webVersionUrl: item.webVersionUrl || '',
        webVersionPrefix: item.webVersionPrefix || '',
        webVersionSuffix: item.webVersionSuffix || '',
        downloadUrl: item.downloadUrl || '',
        dlPrefix: item.dlPrefix || '',
        dlSuffix: item.dlSuffix || '',
        webVersion: item.webVersion || '',
        searchNames: item.searchNames || [],
        category: item.mainCategory || '',
        hiddenCategory: item.hiddenCategory || '',
        tags: item.subCategories || [],
        formats: item.formats || [],
        os: item.os || [],
        description: item.description || '',
        installPaths: item.installPaths || [], // Manuelle Pfade bleiben unangetastet!
        autoPaths: [res.path], // Hier landet der neu gefundene Pfad
        links: item.links ? Object.fromEntries(item.links.map((l) => [l.label, l.url])) : {},
      };

      await window.electronAPI.saveMetaJson(item.path, data);
      foundCount++;
    }
  }

  el.scanPathText.textContent = 'Speichere neue Versionen...';
  await window.electronAPI.scanLocalVersions();
  await init();

  if (btn) {
    btn.disabled = false;
    btn.textContent = origText;
  }
  el.scanStatus.style.display = 'none';
  alert(`Auto-Detect abgeschlossen! Pfade gefunden: ${foundCount} von ${itemsToProcess.length}`);
}

async function checkWebVersionsUI() {
  if (!window.electronAPI) return;
  const btn = document.getElementById('btnWebVersions');
  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Prüfe Web...';
  }

  try {
    const res = await window.electronAPI.checkWebVersions();
    if (res.success) {
      await init(); // Lädt das Grid neu und malt die aktualisierten lila Karten!
      if (res.count > 0) alert(`Web-Prüfung abgeschlossen!\nEs wurden ${res.count} neue Updates im Netz gefunden.`);
    } else if (res.error) {
      alert(`Fehler beim Abrufen der Web-Versionen:\n${res.error}`);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

function renderTags() {
  const allTags = new Set();
  // forEach ohne automatischen Return via geschweifte Klammern
  catalog.forEach((item) => {
    // Filtere versteckte Kategorien auch für die Tag-Generierung raus
    const isHidden = item.hiddenCategory && item.hiddenCategory.trim() !== '';
    if (isHidden && !appSettings.visibleHiddenCats?.includes(item.hiddenCategory)) return;

    item.tags.forEach((t) => {
      allTags.add(t);
    });
  });

  el.tagContainer.innerHTML = `<div class="tag ${!activeTag ? 'active' : ''}" data-tag="all">Alle</div>`;

  Array.from(allTags)
    .sort()
    .forEach((tag) => {
      const isAct = activeTag === tag ? 'active' : '';
      el.tagContainer.innerHTML += `<div class="tag ${isAct}" data-tag="${escapeHTML(tag)}">${escapeHTML(tag)}</div>`;
    });
}

// Fuzzy Search Helpers
function getEditDistance(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const v0 = new Array(b.length + 1),
    v1 = new Array(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v1[b.length];
}

// Prüft, ob ein Suchwort (mit Toleranz für Tippfehler) im Text existiert
function fuzzyMatch(searchWord, fullText) {
  if (fullText.includes(searchWord)) return true;
  if (searchWord.length < 3) return false; // Sehr kurze Wörter müssen exakt passen

  const wordsInText = fullText.split(/[^a-z0-9äöüß]+/);
  for (const textWord of wordsInText) {
    if (textWord.length < 3) continue;
    if (getEditDistance(searchWord, textWord) <= (searchWord.length <= 5 ? 1 : 2)) return true;
  }
  return false;
}

async function toggleFav(id) {
  const idx = localFavorites.indexOf(id);
  if (idx > -1) localFavorites.splice(idx, 1);
  else localFavorites.push(id);

  // Speichere die Favoriten nun sauber in der lokalen state.json
  if (window.electronAPI) {
    await window.electronAPI.saveSettings({ favorites: localFavorites });
  }

  renderGrid();
}

function renderGrid() {
  const searchString = el.searchInput.value.toLowerCase().trim();
  const searchWords = searchString.split(/\s+/).filter((w) => w.length > 0);

  const filtered = catalog.filter((item) => {
    // Versteckte Kategorien filtern
    const isHidden = item.hiddenCategory && item.hiddenCategory.trim() !== '';
    if (isHidden && !appSettings.visibleHiddenCats?.includes(item.hiddenCategory)) return false;

    // Suchbereich: Name, Beschreibung, Formate und alle Tags zusammenfassen
    const searchText =
      `${item.name} ${item.description} ${item.tags.join(' ')} ${item.formats ? item.formats.join(' ') : ''}`.toLowerCase();
    const matchesTag = !activeTag || item.tags.includes(activeTag);

    // Multi-Word UND-Suche mit Fuzzy Matching
    let matchesSearch = true;
    for (const word of searchWords) {
      if (!fuzzyMatch(word, searchText)) {
        matchesSearch = false;
        break;
      }
    }
    return matchesSearch && matchesTag;
  });

  const sortMode = el.sortSelect.value;

  // Erweiterte Sortierung anwenden
  filtered.sort((a, b) => {
    // Favoriten immer ganz oben
    const aFav = localFavorites.includes(a.id);
    const bFav = localFavorites.includes(b.id);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;

    const depth = appSettings.versionCompareDepth !== undefined ? appSettings.versionCompareDepth : 3;
    const statA = getItemStatus(a);
    const statB = getItemStatus(b);

    if (sortMode === 'webnas') {
      const aIsNewer = statA.nasVersion && a.webVersion && compareVersions(a.webVersion, statA.nasVersion, depth) > 0;
      const bIsNewer = statB.nasVersion && b.webVersion && compareVersions(b.webVersion, statB.nasVersion, depth) > 0;
      if (aIsNewer && !bIsNewer) return -1;
      if (!aIsNewer && bIsNewer) return 1;
    } else if (sortMode === 'webpc') {
      // Wenn die Webversion neuer ist, als die auf dem PC (oder PC ist nicht installiert = Web ist implizit neuer)
      const aIsNewer =
        a.webVersion && (!statA.localVersion || compareVersions(a.webVersion, statA.localVersion, depth) > 0);
      const bIsNewer =
        b.webVersion && (!statB.localVersion || compareVersions(b.webVersion, statB.localVersion, depth) > 0);
      if (aIsNewer && !bIsNewer) return -1;
      if (!aIsNewer && bIsNewer) return 1;
    } else if (sortMode === 'update') {
      if (statA.status === 'update' && statB.status !== 'update') return -1;
      if (statA.status !== 'update' && statB.status === 'update') return 1;
    } else if (sortMode === 'installed') {
      if (a.isInstalled && !b.isInstalled) return -1;
      if (!a.isInstalled && b.isInstalled) return 1;
    } else if (sortMode === 'newest') {
      return (b.addedAt || 0) - (a.addedAt || 0);
    } else if (sortMode === 'updated') {
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    }

    return a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
  });

  if (filtered.length === 0) {
    el.grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text); opacity: 0.7;">Keine Einträge für diese Suche gefunden.</div>`;
  } else {
    el.grid.innerHTML = filtered
      .map((item) => {
        const isFav = localFavorites.includes(item.id);
        const { status, nasVersion, localVersion } = getItemStatus(item);

        let cardStatusClass = '';
        if (status === 'webupdate') cardStatusClass = 'status-webupdate';
        else if (status === 'update') cardStatusClass = 'status-update';
        else if (status === 'newer') cardStatusClass = 'status-newer';
        else if (status === 'installed') cardStatusClass = 'status-installed';

        const badgesHtml = getItemBadges(item).map(renderBadgeDot).join('');

        const versionTags = [];
        if (localVersion) versionTags.push(`<span>PC: v${escapeHTML(localVersion)}</span>`);
        if (nasVersion) versionTags.push(`<span>NAS: v${escapeHTML(nasVersion)}</span>`);
        if (item.webVersion) {
          versionTags.push(
            `<span style="background: rgba(203,166,247,0.25); color: #cba6f7;">Web: v${escapeHTML(item.webVersion)}</span>`
          );
        }
        const versionsHtml = versionTags.length > 0 ? `<div class="card-versions">${versionTags.join('')}</div>` : '';

        return `
      <div class="card ${cardStatusClass}" data-id="${item.id}">
        <div class="badges-container">${badgesHtml}</div>
        <div class="card-content">
          ${item.icon ? `<img src="file:///${item.icon.replace(/\\/g, '/')}" loading="lazy" decoding="async" alt="Icon">` : ''}
          <h3>${escapeHTML(item.name)}</h3>
          <small>${escapeHTML(item.tags.join(', '))}</small>
          ${versionsHtml}
        </div>
        <button class="fav-btn ${isFav ? 'active' : ''}" data-id="${item.id}" title="Favorit">★</button>
      </div>
    `;
      })
      .join('');
  }
}

// ==========================================
// MODAL & UI ACTIONS
// ==========================================
function openLightbox(itemId, index) {
  const item = catalog.find((i) => i.id === itemId);
  if (!item?.screenshots || item.screenshots.length === 0) return;

  currentLightboxMedia = item.screenshots;
  currentLightboxIndex = index;
  updateLightboxView();
  el.lightboxOverlay.style.display = 'flex';
}

function updateLightboxView() {
  const s = currentLightboxMedia[currentLightboxIndex];
  const fileUrl = `file:///${s.replace(/\\/g, '/')}`;
  const isVid = /\.(mp4|webm|ogg|mov|avi)$/i.test(s);

  if (isVid) {
    el.lightboxImg.style.display = 'none';
    el.lightboxVid.style.display = 'block';
    el.lightboxVid.src = fileUrl;
  } else {
    el.lightboxVid.style.display = 'none';
    el.lightboxVid.pause();
    el.lightboxVid.src = '';
    el.lightboxImg.style.display = 'block';
    el.lightboxImg.src = fileUrl;
  }

  const leftBtn = document.getElementById('lightboxBtnLeft');
  const rightBtn = document.getElementById('lightboxBtnRight');
  if (currentLightboxMedia.length <= 1) {
    leftBtn.style.display = 'none';
    rightBtn.style.display = 'none';
  } else {
    leftBtn.style.display = 'flex';
    rightBtn.style.display = 'flex';
  }
}

function lightboxNext() {
  if (currentLightboxMedia.length <= 1) return;
  currentLightboxIndex = (currentLightboxIndex + 1) % currentLightboxMedia.length;
  updateLightboxView();
}
function lightboxPrev() {
  if (currentLightboxMedia.length <= 1) return;
  currentLightboxIndex = (currentLightboxIndex - 1 + currentLightboxMedia.length) % currentLightboxMedia.length;
  updateLightboxView();
}
function closeLightbox() {
  el.lightboxOverlay.style.display = 'none';
  el.lightboxVid.pause();
  el.lightboxVid.src = '';
}

function openItemModal(id) {
  const item = catalog.find((i) => i.id === id);
  if (!item) return;

  isEditModalOpen = false;
  currentOpenModalId = id; // Tracken für Version-Select Update

  const { nasVersion, localVersion } = getItemStatus(item);
  const fullBadgesHtml = getItemBadges(item).map(renderBadgePill).join('');
  const badgesBarHtml = fullBadgesHtml ? `<div class="modal-badges-bar">${fullBadgesHtml}</div>` : '';

  const searchNamesHtml =
    item.searchNames?.length > 0
      ? `<span class="detail-search-names">(${escapeHTML(item.searchNames.join(', '))})</span>`
      : '';

  const detailVersionsHtml = `
    <div class="detail-versions">
      <span class="ver-pill ver-pc">PC: ${localVersion ? `v${escapeHTML(localVersion)}` : '–'}</span>
      <span class="ver-pill ver-nas">NAS: ${nasVersion ? `v${escapeHTML(nasVersion)}` : '–'}</span>
      <span class="ver-pill ver-web">Web: ${item.webVersion ? `v${escapeHTML(item.webVersion)}` : '–'}</span>
    </div>
  `;

  const osBadges =
    item.os?.length > 0 ? `<p style="margin:4px 0;"><strong>OS:</strong> ${escapeHTML(item.os.join(', '))}</p>` : '';
  const formatBadges =
    item.formats?.length > 0
      ? `<p style="margin:4px 0;"><strong>Formate:</strong> ${escapeHTML(item.formats.join(', '))}</p>`
      : '';
  const catText = item.mainCategory
    ? `<p style="margin:4px 0;"><strong>Kategorie:</strong> ${escapeHTML(item.mainCategory)} ${item.subCategories?.length > 0 ? `(${escapeHTML(item.subCategories.join(', '))})` : ''}</p>`
    : '';

  // Reihe 1: Explorer, Bearbeiten, Programm starten
  let runLocalHtml = '';
  if (item.isInstalled && item.validInstallPath) {
    runLocalHtml = `<button type="button" class="action-btn" style="background: #a6e3a1; color: #1e1e2e;" data-action="open-explorer" data-path="${escapeHTML(item.validInstallPath)}" title="Startet die installierte Software auf diesem PC">🚀 Programm starten</button>`;
  }

  // Reihe 2: Setup-Datei/Dropdown, Setup, Download, Web-Download
  let fileInfoOrSelectHtml = '';
  let installHtml = '';
  let downloadHtml = '';

  if (item.lastFiles?.length > 0) {
    if (item.lastFiles.length === 1) {
      const fileName = getBaseName(item.lastFiles[0]);
      fileInfoOrSelectHtml = `<span class="version-filename" title="${escapeHTML(fileName)}">${escapeHTML(fileName)}</span>`;
      installHtml = `<button type="button" class="action-btn" style="background: #fab387; color: #1e1e2e;" data-action="execute-temp" data-id="${item.id}" data-path="${escapeHTML(item.lastFiles[0])}" title="Kopiert die Datei lokal und führt sie aus">▶️ Setup</button>`;
      downloadHtml = `<button type="button" class="action-btn" style="background: var(--accent); color: var(--bg);" data-action="start-download" data-files='${escapeHTML(JSON.stringify(item.lastFiles))}'>⬇️ Download</button>`;
    } else {
      const optionsHtml = item.lastFiles
        .map((f, i) => `<option value="${i}">${escapeHTML(getBaseName(f))}</option>`)
        .join('');
      fileInfoOrSelectHtml = `<select id="versionSelector" class="version-selector">${optionsHtml}</select>`;
      installHtml = `<button type="button" id="dynamicInstallBtn" class="action-btn" style="background: #fab387; color: #1e1e2e;" data-action="execute-temp" data-id="${item.id}" data-path="${escapeHTML(item.lastFiles[0])}" title="Kopiert die Datei lokal und führt sie aus">▶️ Setup</button>`;
      downloadHtml = `<button type="button" id="dynamicDownloadBtn" class="action-btn" style="background: var(--accent); color: var(--bg);" data-action="start-download" data-files='${escapeHTML(JSON.stringify([item.lastFiles[0]]))}'>⬇️ Download</button>`;
    }
  }

  let webDownloadHtml = '';
  if (item.downloadUrl) {
    webDownloadHtml = `<button type="button" id="btnWebDl_${item.id}" class="action-btn" style="background: #cba6f7; color: var(--bg);" data-action="download-web" data-id="${item.id}" data-url="${escapeHTML(item.downloadUrl)}" data-pre="${escapeHTML(item.dlPrefix || '')}" data-suf="${escapeHTML(item.dlSuffix || '')}" data-path="${escapeHTML(item.path)}">🚀 Web-Download</button>`;
  }

  const row2Html =
    fileInfoOrSelectHtml || webDownloadHtml
      ? `<div class="modal-action-row">${fileInfoOrSelectHtml}${installHtml}${downloadHtml}${webDownloadHtml}</div>`
      : '';

  // Links generieren
  let linksHtml = '';
  if (item.links?.length > 0) {
    linksHtml = `<div style="margin-top: 15px;"><strong>Links:</strong><ul style="margin-top: 5px;">${item.links
      .map(
        (l) =>
          `<li><a href="#" style="color: var(--accent);" data-action="open-url" data-url="${escapeHTML(l.url)}">${escapeHTML(l.label)}</a></li>`
      )
      .join('')}</ul></div>`;
  }

  // Technische Details (NAS-Ordner, URL1, URL2, Auto- & Manuelle PC-Pfade)
  const techRows = [];
  techRows.push(
    `<div class="detail-tech-row"><span class="detail-tech-label">NAS-Ordner:</span><span class="detail-tech-value">${escapeHTML(item.path)}</span></div>`
  );
  if (item.webVersionUrl) {
    techRows.push(
      `<div class="detail-tech-row"><span class="detail-tech-label">Prüf-URL (URL1):</span><span class="detail-tech-value"><a href="#" data-action="open-url" data-url="${escapeHTML(item.webVersionUrl)}">${escapeHTML(item.webVersionUrl)}</a></span></div>`
    );
  }
  if (item.downloadUrl) {
    techRows.push(
      `<div class="detail-tech-row"><span class="detail-tech-label">Download-URL (URL2):</span><span class="detail-tech-value"><a href="#" data-action="open-url" data-url="${escapeHTML(item.downloadUrl)}">${escapeHTML(item.downloadUrl)}</a></span></div>`
    );
  }
  if (item.autoPaths?.length > 0) {
    techRows.push(
      `<div class="detail-tech-row"><span class="detail-tech-label">Auto-Pfad (PC):</span><span class="detail-tech-value">${item.autoPaths.map((p) => escapeHTML(p)).join('<br>')}</span></div>`
    );
  }
  if (item.installPaths?.length > 0) {
    techRows.push(
      `<div class="detail-tech-row"><span class="detail-tech-label">Manueller Pfad (PC):</span><span class="detail-tech-value">${item.installPaths.map((p) => escapeHTML(p)).join('<br>')}</span></div>`
    );
  }
  const techInfoHtml = `<div class="detail-tech-info">${techRows.join('')}</div>`;

  // Generierung der Thumbnails (Bilder + Videos mit Play-Overlay)
  let mediaHtml = '';
  if (item.screenshots?.length > 0) {
    mediaHtml = `<div style="margin-top: 20px; display: flex; gap: 15px; overflow-x: auto; padding-bottom: 10px;">${item.screenshots
      .map((s, idx) => {
        const fileUrl = `file:///${s.replace(/\\/g, '/')}`;
        const isVid = /\.(mp4|webm|ogg|mov|avi)$/i.test(s);

        if (isVid) {
          return `
            <div class="vid-container" style="position:relative; display:inline-block; cursor:pointer;" data-id="${item.id}" data-idx="${idx}" title="Video abspielen">
              <video src="${fileUrl}#t=1" class="img-zoomable" style="height: 120px; min-width: 150px; max-width: 250px; border-radius: 8px; border: 1px solid var(--border); object-fit: cover;" muted preload="metadata"></video>
              <div style="position:absolute; inset:0; display:flex; justify-content:center; align-items:center; background:rgba(0,0,0,0.3); border-radius:8px; pointer-events:none;">
                <span style="font-size:32px; color:white; text-shadow: 0 2px 4px rgba(0,0,0,0.5);">▶️</span>
              </div>
            </div>`;
        }
        return `<img src="${fileUrl}" class="img-zoomable" data-id="${item.id}" data-idx="${idx}" style="height: 120px; min-width: 150px; border-radius: 8px; border: 1px solid var(--border); object-fit: cover;">`;
      })
      .join('')}</div>`;
  }

  el.modalContent.innerHTML = `
    <button type="button" class="close-btn" data-action="close-modal" title="Schließen" aria-label="Schließen">&times;</button>
    ${badgesBarHtml}
    <div style="display: flex; gap: 20px; align-items: flex-start;">
      ${item.icon ? `<img src="file:///${item.icon.replace(/\\/g, '/')}" style="width: 80px; height: 80px; object-fit: contain;">` : ''}
      <div style="flex: 1; min-width: 0;">
        <h2 style="margin-bottom: 4px;">${escapeHTML(item.name)}${searchNamesHtml}</h2>
        ${detailVersionsHtml}
        ${osBadges}
        ${formatBadges}
        ${catText}
      </div>
    </div>
    <div style="margin-top: 20px;">
      <div style="line-height: 1.5; opacity: 0.9;">${item.description ? item.description : 'Keine Beschreibung vorhanden.'}</div>
      ${linksHtml}
      ${mediaHtml}
      ${techInfoHtml}
    </div>
    <div class="modal-actions">
      <div class="modal-action-row">
        <button type="button" class="action-btn" data-action="open-explorer" data-path="${escapeHTML(item.path)}">Im Explorer öffnen</button>
        <button type="button" class="action-btn" style="background: var(--surface); border: 1px solid var(--border); color: var(--text);" data-action="edit-software" data-id="${item.id}">✏️ Bearbeiten</button>
        ${runLocalHtml}
      </div>
      ${row2Html}
    </div>
  `;
  el.modalOverlay.style.display = 'flex';
}

function closeModal() {
  el.modalOverlay.style.display = 'none';
  currentOpenModalId = null;
  isEditModalOpen = false;
}

function openExternalUrl(url) {
  if (window.electronAPI) window.electronAPI.openUrl(url);
}
function openInExplorer(path) {
  if (window.electronAPI) window.electronAPI.openPath(path);
}

// ==========================================
// SETTINGS & UPDATE LOGIC
// ==========================================
async function performAutoUpdateCheck() {
  if (!window.electronAPI || hasCheckedForUpdates) return;
  hasCheckedForUpdates = true;

  const s = appSettings;
  if (s.updateInterval === -1) return;

  const now = Date.now();
  const msSinceLast = now - (s.lastUpdateCheck || 0);
  const intervalMs = (s.updateInterval || 0) * 60 * 60 * 1000;

  if (msSinceLast >= intervalMs) {
    const res = await window.electronAPI.checkUpdate();
    if (res && !res.error && res.updateAvailable) {
      el.appVersion.innerHTML = `(v${escapeHTML(res.currentVersion)}) <a href="#" id="inlineUpdateLink" style="color: #a6e3a1; font-size: 0.9em; text-decoration: none; margin-left: 10px;">🎁 Update verfügbar (v${escapeHTML(res.latestVersion)})!</a>`;
      document.getElementById('inlineUpdateLink').addEventListener('click', (e) => {
        e.preventDefault();
        openSettings();
      });
    }
  }
}

async function openSettings() {
  if (!window.electronAPI) return alert('Einstellungen sind nur in der Desktop-App verfügbar.');
  isEditModalOpen = false;
  const s = appSettings;
  const info = await window.electronAPI.getAppInfo();

  const hiddenCheckboxes =
    availableHiddenCats.length === 0
      ? '<p style="color: gray; font-size: 0.9em;">Bisher wurden keine versteckten Kategorien gefunden.</p>'
      : availableHiddenCats
          .map((cat) => {
            const isChecked = s.visibleHiddenCats?.includes(cat) ? 'checked' : '';
            return `<label class="checkbox-lbl"><input type="checkbox" name="hiddenCatCheck" value="${escapeHTML(cat)}" ${isChecked}> ${escapeHTML(cat)}</label>`;
          })
          .join('');

  el.modalContent.innerHTML = `
    <button type="button" class="close-btn" data-action="close-modal" title="Schließen">&times;</button>
    <h2>Einstellungen</h2>
    <div class="settings-group" style="border-top: none; margin-top: 0; padding-top: 0;">
      <h3>Dateipfade</h3>
      <div class="settings-row">
        <label style="width: 120px;">Software-Ordner:</label>
        <input type="text" id="cfgTarget" value="${escapeHTML(s.targetPath)}" readonly>
        <button type="button" class="action-btn" style="margin-top: 0; background: var(--surface); border: 1px solid var(--border); color: var(--text);" data-action="browse-file" data-type="dir" data-target="cfgTarget">Wählen</button>
      </div>
      <div class="settings-row">
        <label style="width: 120px;">Katalog (JSON):</label>
        <input type="text" id="cfgJson" value="${escapeHTML(s.jsonPath)}" readonly>
        <button type="button" class="action-btn" style="margin-top: 0; background: var(--surface); border: 1px solid var(--border); color: var(--text);" data-action="browse-file" data-type="file" data-ext="json" data-target="cfgJson">Wählen</button>
      </div>
      <div class="settings-row">
        <label style="width: 120px;">Scanner-Skript:</label>
        <input type="text" id="cfgScript" value="${escapeHTML(s.scriptPath)}" readonly>
        <button type="button" class="action-btn" style="margin-top: 0; background: var(--surface); border: 1px solid var(--border); color: var(--text);" data-action="browse-file" data-type="file" data-ext="js" data-target="cfgScript">Wählen</button>
      </div>
    </div>

    <div class="settings-group">
      <h3>Darstellung</h3>
      <div class="settings-row">
        <label style="width: 250px;">"NEU" Badge anzeigen für (Tage):</label>
        <input type="number" id="cfgNewBadgeDays" value="${s.newBadgeDays !== undefined ? s.newBadgeDays : 14}" min="0" style="width: 80px; flex: none;">
      </div>
      <div class="settings-row">
        <label style="width: 250px;">Versionsvergleich (Stellen):</label>
        <input type="number" id="cfgVersionCompareDepth" value="${s.versionCompareDepth !== undefined ? s.versionCompareDepth : 3}" min="1" max="10" style="width: 80px; flex: none;" title="Wie viele Stellen sollen verglichen werden? (z.B. 3 für X.X.X)">
      </div>
      <label class="checkbox-lbl" style="margin-top: 15px;">
        <input type="checkbox" id="cfgShowPathOriginBadges" ${s.showPathOriginBadges ? 'checked' : ''}>
        Pfad-Herkunft als Badge anzeigen (Manuell / Auto / Mix)
      </label>
    </div>

    <div class="settings-group">
      <h3>Scanner-Tiefe</h3>
      <label class="checkbox-lbl">
        <input type="checkbox" id="cfgScanNested" ${s.scanNested ? 'checked' : ''}>
        Nach Fund eines _metadata Ordners noch tiefere Ebenen durchsuchen
      </label>
      <div class="settings-row" style="margin-top: 10px;">
        <label style="width: 250px;">Maximale Ebenen tiefer suchen:</label>
        <input type="number" id="cfgNestedDepth" value="${s.nestedDepth || 1}" min="1" max="5" style="width: 80px; flex: none;">
      </div>
    </div>
    <div class="settings-group">
      <h3>Auto-Download & Installation</h3>
      <p style="font-size: 0.9em; margin-top: 0;">Wenn kein <code>_last</code>-Ordner existiert, sucht der Scanner im Hauptordner des Programms nach diesen Dateitypen.</p>
      <div class="settings-row">
        <label style="width: 250px;">Dateiendungen (Komma-getrennt):</label>
        <input type="text" id="cfgAutoExt" value="${escapeHTML((s.autoExtensions || ['.exe', '.msi', '.zip']).join(', '))}">
      </div>
    </div>
    <div class="settings-group">
      <h3>Sichtbarkeit versteckter Kategorien</h3>
      <div class="hidden-cats-list">${hiddenCheckboxes}</div>
    </div>
    <div class="settings-group">
      <h3>Updates</h3>
      <div class="settings-row">
        <label style="width: 250px;">Automatisch nach Updates suchen:</label>
        <select id="cfgUpdateInterval" style="flex: 1; padding: 10px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 6px;">
          <option value="0" ${s.updateInterval === 0 ? 'selected' : ''}>Bei jedem Start</option>
          <option value="24" ${s.updateInterval === 24 ? 'selected' : ''}>Täglich (alle 24h)</option>
          <option value="168" ${s.updateInterval === 168 ? 'selected' : ''}>Wöchentlich</option>
          <option value="720" ${s.updateInterval === 720 ? 'selected' : ''}>Monatlich</option>
          <option value="-1" ${s.updateInterval === -1 ? 'selected' : ''}>Nie</option>
        </select>
      </div>
    </div>

    <!-- NEU: Debug & Backup -->
    <div class="settings-group">
      <h3 style="color: #f38ba8;">🛠️ Debug & Backup</h3>

      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 15px;">
         <button type="button" class="action-btn" style="margin-top:0; background:var(--surface); border:1px solid #f38ba8; color:#f38ba8;" data-action="reset-paths" data-type="auto">Auto-Pfade löschen</button>
         <button type="button" class="action-btn" style="margin-top:0; background:var(--surface); border:1px solid #f38ba8; color:#f38ba8;" data-action="reset-paths" data-type="manual">Manuelle Pfade löschen</button>
         <button type="button" class="action-btn" style="margin-top:0; background:var(--surface); border:1px solid #f38ba8; color:#f38ba8;" data-action="reset-versions" data-type="local">PC-Versionen löschen</button>
         <button type="button" class="action-btn" style="margin-top:0; background:var(--surface); border:1px solid #f38ba8; color:#f38ba8;" data-action="reset-versions" data-type="nas">NAS-Versionen löschen</button>
      </div>

      <div style="display: flex; gap: 10px; flex-wrap: wrap;">
         <button type="button" class="action-btn" style="margin-top:0; background: #89b4fa; color: var(--bg);" data-action="create-backup">💾 Backup erstellen</button>
         <button type="button" class="action-btn" style="margin-top:0; background: #f9e2af; color: #1e1e2e;" data-action="restore-backup">📂 Backup laden</button>
      </div>
    </div>

    <div class="settings-group">
      <h3>Über & Daten</h3>
      <p style="margin-top: 5px; margin-bottom: 15px;">
        <strong>Software Katalog</strong> v${escapeHTML(info.version)}<br>
        Entwickelt von <strong>Felix Maywald / RaptorXilef</strong>
      </p>
      <div class="settings-row" style="align-items: center; justify-content: flex-start; flex-wrap: wrap;">
        <button type="button" class="action-btn" style="margin-top: 0; background: var(--surface); border: 1px solid var(--border); color: var(--text);" data-action="open-url" data-url="https://github.com/RaptorXilef/SoftwareKatalogApp">GitHub Repository</button>
        <!-- Explorer Shortcut für Favoriten (state.json) -->
        <button type="button" class="action-btn" style="margin-top: 0; margin-left: 10px; background: var(--surface); border: 1px solid var(--border); color: var(--text);" data-action="open-explorer" data-path="${escapeHTML(s.statePath)}">Lokal (Favoriten) im Explorer öffnen</button>

        <button type="button" id="btnManualUpdate" class="action-btn" style="margin-top: 0; margin-left: 10px; background: var(--surface); border: 1px solid var(--border); color: var(--text);" data-action="manual-update">Nach Updates suchen</button>
        <span id="updateContainer" style="margin-left: 10px;"></span>
      </div>
    </div>
    <div style="margin-top: 30px; text-align: right;">
      <button type="button" class="action-btn" data-action="save-settings">Speichern & Anwenden</button>
    </div>
  `;
  el.modalOverlay.style.display = 'flex';

  // Wenn bereits ein Download lief, re-initialisiere den UI-Fortschritt im Settings-Modal sofort!
  if (isUpdating) {
    renderUpdateProgressUI();
  } else {
    checkForUpdatesUI();
  }
}

// Hilfsfunktion, um den Fortschrittsbalken im Settings-Modal dauerhaft zu halten
function renderUpdateProgressUI() {
  const container = document.getElementById('updateContainer');
  const btn = document.getElementById('btnManualUpdate');
  if (!container) return;

  if (btn) btn.style.display = 'none';
  container.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:5px; align-items:flex-end;">
      <span style="color: #89b4fa; font-size: 0.9em; font-weight: bold;">Download: <span id="dlPercent">0</span>%</span>
      <div style="width: 250px; height: 6px; background: var(--surface); border-radius: 3px; overflow: hidden; border: 1px solid var(--border);">
        <div id="dlBar" style="width: 0%; height: 100%; background: #89b4fa; transition: width 0.2s;"></div>
      </div>
    </div>`;
}

// Verbesserte Update-UI für One-Click Self-Update
async function checkForUpdatesUI() {
  if (isUpdating) return; // Wenn er bereits lädt, nicht überschreiben

  const container = document.getElementById('updateContainer');
  const btn = document.getElementById('btnManualUpdate');
  if (!container || !window.electronAPI) return;

  if (btn) btn.disabled = true;
  container.innerHTML = '<span style="color: gray; font-size: 0.9em;">Suche nach Updates...</span>';

  const res = await window.electronAPI.checkUpdate();
  if (btn) btn.disabled = false;

  if (res.error) {
    container.innerHTML =
      '<span style="color: var(--text); opacity: 0.7; font-size: 0.9em;">Update-Prüfung fehlgeschlagen.</span>';
  } else if (res.updateAvailable) {
    // Prüfen, ob wir die App direkt aktualisieren können (Asset URL vorhanden)
    if (res.updateAssetUrl) {
      container.innerHTML = `
        <button type="button" class="action-btn" style="margin-top: 0; background: #a6e3a1; color: var(--bg);"
                data-action="install-update" data-url="${escapeHTML(res.updateAssetUrl)}" data-portable="${res.isPortable}">
          Auf v${escapeHTML(res.latestVersion)} aktualisieren (Neustart)
        </button>`;
    } else {
      // Fallback auf GitHub Seite, falls keine EXE/ZIP im Asset gefunden wurde
      container.innerHTML = `<button type="button" class="action-btn" style="margin-top: 0; background: #a6e3a1; color: var(--bg);" data-action="open-url" data-url="${escapeHTML(res.releaseUrl)}">Update verfügbar (v${escapeHTML(res.latestVersion)})</button>`;
    }
    if (btn) btn.style.display = 'none';
  } else {
    container.innerHTML = '<span style="color: #a6e3a1; font-size: 0.9em;">✓ App ist auf dem neuesten Stand</span>';
    if (btn) btn.style.display = 'none';
  }
}

async function installUpdate(assetUrl, isPortable) {
  isUpdating = true;
  renderUpdateProgressUI();

  if (window.electronAPI) {
    window.electronAPI.onUpdateProgress((pct) => {
      const dlPercent = document.getElementById('dlPercent');
      const dlBar = document.getElementById('dlBar');
      if (dlPercent) dlPercent.textContent = pct;
      if (dlBar) dlBar.style.width = `${pct}%`;
    });
  }

  try {
    // 1. Download in der App
    const res = await window.electronAPI.downloadUpdate(assetUrl);
    if (!res.success) throw new Error(res.error);

    // 2. CMD Austausch & Neustart
    const container = document.getElementById('updateContainer');
    if (container) {
      container.innerHTML = `
        <span style="color: #fab387; font-weight: bold; font-size: 0.95em;">
          Installiere Update & Neustart...
        </span>`;
    }
    await window.electronAPI.installUpdate(res.filePath, isPortable);
  } catch (err) {
    isUpdating = false;
    alert(`Fehler beim Update: ${err.message}`);
    const container = document.getElementById('updateContainer');
    if (container) container.innerHTML = '<span style="color: red;">Fehler!</span>';
  }
}

async function browseFile(inputId, isDir, filters) {
  const selectedPath = isDir
    ? await window.electronAPI.selectTargetDir()
    : await window.electronAPI.selectFile(filters);
  if (selectedPath) document.getElementById(inputId).value = selectedPath;
}

// Save Settings ohne dummen Alert und mit dynamischem Neu-Laden
async function saveSettings() {
  const checkedCats = Array.from(document.querySelectorAll('input[name="hiddenCatCheck"]:checked')).map(
    (cb) => cb.value
  );

  const newSettings = {
    targetPath: document.getElementById('cfgTarget').value,
    jsonPath: document.getElementById('cfgJson').value,
    scriptPath: document.getElementById('cfgScript').value,
    scanNested: document.getElementById('cfgScanNested').checked,
    nestedDepth: parseInt(document.getElementById('cfgNestedDepth').value, 10),
    visibleHiddenCats: checkedCats,
    updateInterval: parseInt(document.getElementById('cfgUpdateInterval').value, 10),
    autoExtensions: document
      .getElementById('cfgAutoExt')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith('.') ? s : `.${s}`)), // Garantiert, dass jede Eingabe z.B. '.exe' statt 'exe' ist
    newBadgeDays: parseInt(document.getElementById('cfgNewBadgeDays').value, 10) || 0,
    versionCompareDepth: parseInt(document.getElementById('cfgVersionCompareDepth').value, 10) || 3,
    showPathOriginBadges: document.getElementById('cfgShowPathOriginBadges').checked, // NEU
  };

  // Überprüfen, ob sich Pfade oder Ext-Listen im Vergleich zum alten State geändert haben
  const needsRescan =
    appSettings.targetPath !== newSettings.targetPath ||
    appSettings.jsonPath !== newSettings.jsonPath ||
    appSettings.autoExtensions.join(',') !== newSettings.autoExtensions.join(',');

  const res = await window.electronAPI.saveSettings(newSettings);
  if (res.success) {
    el.modalOverlay.style.display = 'none';
    appSettings = { ...appSettings, ...newSettings }; // Lokalen State sofort patchen

    if (needsRescan) {
      await startScan('quick'); // Führt den Scan und den Reload nahtlos aus!
    } else {
      renderBadgeLegend();
      renderGrid(); // Nur das Grid aktualisieren reicht für die neuen Badges
    }
  } else {
    alert(`Fehler beim Speichern:\n${res.error}`);
  }
}

async function addSoftwareFolder() {
  if (!window.electronAPI) return alert('Nur in der Desktop-App verfügbar.');
  const res = await window.electronAPI.addSoftware();
  if (res.success) {
    await startScan('quick');
    alert(
      'Der Ordner wurde erfolgreich hinzugefügt!\n\nSuche das Programm nun in der Liste und klicke auf "Bearbeiten".'
    );
  } else if (res.error) {
    alert(`Fehler beim Hinzufügen:\n${res.error}`);
  }
}

function editSoftware(id) {
  const item = catalog.find((i) => i.id === id);
  if (!item) return;

  isEditModalOpen = true;

  // Description is now pure HTML from the rich text editor
  const desc = item.description || '';

  // Links wieder in "Label | URL" Format konvertieren
  const linksStr = (item.links || []).map((l) => `${l.label} | ${l.url}`).join('\n');

  // Lokale Installationspfade
  const installPathsStr = (item.installPaths || []).join('\n');

  el.modalContent.innerHTML = `
    <button type="button" class="close-btn" data-action="close-modal" data-id="${item.id}" title="Zurück">&times;</button>
    <h2>Software bearbeiten: <span style="color: var(--accent);">${escapeHTML(item.name)}</span></h2>

    <div class="settings-group" style="border: none; padding: 0; margin: 0;">
      <div class="settings-row"><label style="width:150px;">Name:</label><input type="text" id="editName" value="${escapeHTML(item.name)}"></div>
      <div class="settings-row">
        <label style="width:150px;">Such-Namen (Komma):</label>
        <div style="display:flex; flex:1; gap:10px;">
          <input type="text" id="editSearchNames" value="${escapeHTML((item.searchNames || []).join(', '))}" placeholder="z.B. Bitdefender Antivirus Free" style="flex:1;">
          <button type="button" class="action-btn" style="margin:0; padding:4px 8px; font-size:12px; background:var(--surface); border:1px solid var(--border); color:var(--text);" data-action="fetch-installed-apps">📋 Liste laden</button>
        </div>
      </div>
      <div class="settings-row">
        <label style="width:150px;">Typ:</label>
        <select id="editSoftwareType" style="flex:1; padding:10px; background:var(--surface); color:var(--text); border:1px solid var(--border); border-radius:6px;">
          <option value="default" ${!item.softwareType || item.softwareType === 'default' ? 'selected' : ''}>Standard (Benötigt Pfad)</option>
          <option value="portable" ${item.softwareType === 'portable' ? 'selected' : ''}>Portabel 🧳</option>
          <option value="driver" ${item.softwareType === 'driver' ? 'selected' : ''}>Treiber / Addon ⚙️</option>
        </select>
      </div>
      <div class="settings-row"><label style="width:150px;">Hauptkategorie:</label><input type="text" id="editCat" value="${escapeHTML(item.mainCategory || '')}"></div>
      <div class="settings-row"><label style="width:150px;">Tags (Komma):</label><input type="text" id="editTags" value="${escapeHTML((item.subCategories || []).join(', '))}"></div>
      <div class="settings-row"><label style="width:150px;">Formate (Komma):</label><input type="text" id="editFormats" value="${escapeHTML((item.formats || []).join(', '))}"></div>
      <div class="settings-row"><label style="width:150px;">OS (Komma):</label><input type="text" id="editOS" value="${escapeHTML((item.os || []).join(', '))}"></div>
      <div class="settings-row"><label style="width:150px;">Versteckt-Kat.:</label><input type="text" id="editHidden" value="${escapeHTML(item.hiddenCategory || '')}" placeholder="Leer lassen für Standard"></div>

      <div style="margin-top: 15px;">
        <label style="display:block; margin-bottom:5px;">Beschreibung:</label>

        <!-- Nativer Rich Text Editor -->
        <div class="editor-toolbar" id="descToolbar">
          <button type="button" data-cmd="bold" title="Fett"><b>B</b></button>
          <button type="button" data-cmd="italic" title="Kursiv"><i>I</i></button>
          <button type="button" data-cmd="underline" title="Unterstrichen"><u>U</u></button>
          <button type="button" data-cmd="insertUnorderedList" title="Aufzählung">• Liste</button>
          <button type="button" data-cmd="createLink" title="Link einfügen">🔗 Link</button>
        </div>
        <div id="editDesc" class="rich-editor" contenteditable="true">${desc}</div>
      </div>

      <div class="settings-group" style="margin-top: 15px; padding-top: 15px; border-top: 1px solid var(--border);">
        <h3 style="margin-bottom: 10px; margin-top: 0; font-size: 14px; color: #cba6f7;">🌐 Web-Erkennung & Download</h3>

        <div class="settings-row">
          <label style="width:150px;">Prüf-URL (URL1):</label>
          <div style="display:flex; flex:1; gap:10px;">
            <input type="text" id="editWebVersionUrl" value="${escapeHTML(item.webVersionUrl || '')}" placeholder="z.B. https://github.com/nutzer/repo" title="GitHub-Links werden vollautomatisch ohne Programmierung getrackt." style="flex:1;" oninput="window.handleWebUrlChange(this)">
            <button type="button" class="action-btn" style="margin:0; padding:4px 8px; font-size:12px; background:var(--surface); border:1px solid var(--border); color:var(--text);" data-action="visual-scrape">🪄 Visuell markieren</button>
          </div>
        </div>

        <!-- Klappt sich dynamisch auf, wenn es KEIN GitHub Link ist -->
        <div id="webScrapeOpts" style="display: ${(item.webVersionUrl || '').toLowerCase().includes('github.com') ? 'none' : 'block'}; margin-left: 20px; padding-left: 15px; border-left: 2px solid #cba6f7; margin-top: 10px; margin-bottom: 15px; background: rgba(0,0,0,0.1); border-radius: 0 8px 8px 0; padding-top: 10px; padding-bottom: 10px;">
          <p style="margin-top:0; font-size:12px; color:var(--text); opacity:0.8; margin-bottom:10px;">Da dies keine GitHub URL ist, trage bitte den Text direkt vor und nach der Versionsnummer ein, um sie auf der Webseite zu finden:</p>
          <div class="settings-row" style="margin-top:0;"><label style="width:130px; font-size:13px;">Davor (Präfix):</label><input type="text" id="editWebPrefix" value="${escapeHTML(item.webVersionPrefix || '')}" placeholder="z.B. Version <span id='v'>"></div>
          <div class="settings-row"><label style="width:130px; font-size:13px;">Danach (Suffix):</label><input type="text" id="editWebSuffix" value="${escapeHTML(item.webVersionSuffix || '')}" placeholder="z.B. </span>"></div>
        </div>

        <div class="settings-row">
          <label style="width:150px;">Download (URL2):</label>
          <div style="display:flex; flex:1; gap:10px;">
            <input type="text" id="editDownloadUrl" value="${escapeHTML(item.downloadUrl || '')}" placeholder="Direkter Link oder Download-Seite" style="flex:1;">
            <button type="button" class="action-btn" style="margin:0; padding:4px 8px; font-size:12px; background:var(--surface); border:1px solid var(--border); color:var(--text);" data-action="visual-link-pick">🪄 URL suchen</button>
          </div>
        </div>

        <!-- Die dynamischen Felder für den Link-Picker! -->
        <div id="dlScrapeOpts" style="display: ${item.dlPrefix || item.dlSuffix ? 'block' : 'none'}; margin-left: 20px; padding-left: 15px; border-left: 2px solid #94e2d5; margin-top: 10px; margin-bottom: 15px; background: rgba(0,0,0,0.1); border-radius: 0 8px 8px 0; padding-top: 10px; padding-bottom: 10px;">
          <p style="margin-top:0; font-size:12px; color:var(--text); opacity:0.8; margin-bottom:10px;">💡 Die App nutzt dieses HTML-Muster, um den Downloadlink in der Webseite vollautomatisch zu finden:</p>
          <div class="settings-row" style="margin-top:0;"><label style="width:130px; font-size:13px;">Davor (Präfix):</label><input type="text" id="editDlPrefix" value="${escapeHTML(item.dlPrefix || '')}"></div>
          <div class="settings-row"><label style="width:130px; font-size:13px;">Danach (Suffix):</label><input type="text" id="editDlSuffix" value="${escapeHTML(item.dlSuffix || '')}"></div>
        </div>

        <div class="settings-row">
          <label style="width:150px;">Zuletzt erkannt:</label>
          <div style="display:flex; flex:1; gap:10px;">
            <input type="text" id="editWebVersion" value="${escapeHTML(item.webVersion || '')}" placeholder="Wird beim Klick auf 'Web-Versionen prüfen' automatisch gefüllt" readonly style="opacity:0.7; flex:1;">
            <button type="button" class="action-btn" style="margin:0; padding:4px 8px; font-size:12px; background:var(--surface); border:1px solid var(--accent); color:var(--accent);" data-action="check-single-web" data-id="${item.id}">🔄 Einzel-Prüfung</button>
          </div>
        </div>
      </div>

      <div style="margin-top: 15px;">
        <label style="display:block; margin-bottom:5px;">Links (Format: Name | https://...):</label>
        <textarea id="editLinks" style="width:100%; height:80px;">${escapeHTML(linksStr)}</textarea>
      </div>

      <!-- Gesplittete Pfad-Eingabe (Manuell vs. Auto) -->
      <div style="margin-top: 15px; display: flex; gap: 15px;">
        <div style="flex: 1;">
          <label style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:5px;">
            <span>Auto-Pfade:</span>
            <button type="button" class="action-btn" style="margin:0; padding:4px 8px; font-size:12px; background:var(--accent); color:var(--bg);" data-action="auto-detect-path" data-id="${item.id}" data-target="editAutoPaths">✨ Suchen</button>
          </label>
          <textarea id="editAutoPaths" style="width:100%; height:60px;" placeholder="Wird automatisch gefüllt...">${escapeHTML((item.autoPaths || []).join('\n'))}</textarea>
        </div>
        <div style="flex: 1;">
          <label style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:5px;">
            <span>Manuelle Pfade:</span>
            <button type="button" class="action-btn" style="margin:0; padding:4px 8px; font-size:12px;" data-action="browse-install-path" data-target="editInstallPaths">Wählen...</button>
          </label>
          <textarea id="editInstallPaths" style="width:100%; height:60px;" placeholder="z.B. C:\\Program Files\\...">${escapeHTML(installPathsStr)}</textarea>
        </div>
      </div>

      <div style="display: flex; gap: 15px; margin-top: 15px;">
        <div class="media-dropzone" data-path="${escapeHTML(item.path)}" data-id="${item.id}" data-type="icon" style="flex: 1; margin-top: 0; padding: 15px; border-color: var(--accent);">
          🖼️ <strong>Icon</strong> hier ablegen<br><small style="opacity: 0.7;">(Wird zu icon.* umbenannt)</small><br>
          <button type="button" class="action-btn" style="margin-top:15px; padding:6px 12px; font-size:12px; background:var(--surface); border:1px solid var(--border); color:var(--text);" data-action="extract-icon" data-id="${item.id}" title="Liest das Icon der .exe Datei aus, die bei Pfade eingetragen ist">🪄 Aus .exe extrahieren</button>
        </div>
        <div class="media-dropzone" data-path="${escapeHTML(item.path)}" data-id="${item.id}" data-type="media" style="flex: 2; margin-top: 0; padding: 15px;">
          📷 <strong>Bilder oder Videos</strong> hier ablegen...
        </div>
      </div>
    </div>

    <div style="margin-top: 25px; border-top: 1px solid var(--border); padding-top: 15px; display: flex; justify-content: space-between; align-items: center;">
      <button type="button" class="action-btn" style="margin-top:0; background: var(--surface); color: var(--text); border: 1px solid var(--border);" data-action="open-explorer" data-path="${escapeHTML(`${item.path}\\_metadata`)}">Bilderordner öffnen</button>
      <div>
        <button type="button" class="action-btn" style="margin-top:0; background: var(--surface); color: var(--text); border: 1px solid var(--border); margin-right: 10px;" data-action="open-item-modal" data-id="${item.id}">Abbrechen</button>
        <button type="button" class="action-btn" style="margin-top:0;" data-action="save-software" data-id="${item.id}">Speichern & Aktualisieren</button>
      </div>
    </div>
  `;
}

async function saveSoftware(id) {
  const item = catalog.find((i) => i.id === id);

  const data = {
    name: document.getElementById('editName').value.trim(),
    softwareType: document.getElementById('editSoftwareType').value,
    webVersionUrl: document.getElementById('editWebVersionUrl').value.trim(),
    webVersionPrefix: document.getElementById('editWebPrefix').value, // (trim entfernt, da Leerzeichen bei Prefix wichtig sein könnten!)
    webVersionSuffix: document.getElementById('editWebSuffix').value,
    downloadUrl: document.getElementById('editDownloadUrl').value.trim(),
    dlPrefix: document.getElementById('editDlPrefix').value,
    dlSuffix: document.getElementById('editDlSuffix').value,
    webVersion: document.getElementById('editWebVersion').value.trim(),
    searchNames: document
      .getElementById('editSearchNames')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    category: document.getElementById('editCat').value.trim(),
    hiddenCategory: document.getElementById('editHidden').value.trim(),
    tags: document
      .getElementById('editTags')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    formats: document
      .getElementById('editFormats')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    os: document
      .getElementById('editOS')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // Nativer HTML String statt Array mit \n Umbrüchen
    description: document.getElementById('editDesc').innerHTML.trim(),
    installPaths: document
      .getElementById('editInstallPaths')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    // Auto-Pfade getrennt speichern
    autoPaths: document
      .getElementById('editAutoPaths')
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    links: item.links ? Object.fromEntries(item.links.map((l) => [l.label, l.url])) : {},
  };

  // Links parsen
  const linksRaw = document.getElementById('editLinks').value.split('\n');
  data.links = {};
  for (const l of linksRaw) {
    const parts = l.split('|');
    if (parts.length >= 2) {
      data.links[parts[0].trim()] = parts.slice(1).join('|').trim();
    }
  }

  // Speichert meta.json UND aktualisiert die catalog.json im Main-Prozess
  const res = await window.electronAPI.saveMetaJson(item.path, data);
  if (res.success) {
    // Liest eventuelle neue lokale Installationspfade sofort aus
    await window.electronAPI.scanLocalVersions();

    // Katalog flink neu laden und die Tags für das Grid frisch generieren
    catalog = await window.electronAPI.loadCatalog();
    catalog.forEach((cItem) => {
      cItem.tags = [];
      if (cItem.mainCategory) cItem.tags.push(cItem.mainCategory);
      if (cItem.subCategories) cItem.tags.push(...cItem.subCategories);
    });

    renderGrid();
    openItemModal(id);
  } else {
    alert(`Fehler beim Speichern:\n${res.error}`);
  }
}

// Start app
init();
