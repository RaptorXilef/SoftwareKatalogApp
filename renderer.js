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

// SemVer / Regex Logic for "Update" Badges
function extractVersion(filename) {
  // FIX: Sucht ausschließlich nach dem ersten Zahl-Punkt-Zahl Block (z.B. 1.0 oder 2.8.0.0)
  // Ignoriert Anhänge wie -Win64, -German oder Präfixe wie _v.
  const match = filename.match(/(\d+(?:\.\d+)+)/);
  return match ? match[1] : null;
}

function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;
  const p1 = v1.split('.').map(Number);
  const p2 = v2.split('.').map(Number);
  // Vergleicht sicher 1.0.0.0 mit 1.0 (füllt kürzere Version dynamisch mit 0 auf)
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const n1 = p1[i] || 0;
    const n2 = p2[i] || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

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
  } else {
    // Nur anzeigen, wenn das Modal geschlossen ist
    if (el.modalOverlay.style.display !== 'flex') {
      el.dropOverlay.style.display = 'flex';
    }
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
        `Der Ordner wurde erfolgreich hinzugefügt!\n\nSuche das Programm nun in der Liste und klicke auf "Bearbeiten".`
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
  if (e.target === el.modalOverlay) closeModal();
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
document.getElementById('btnSettingsToggle').addEventListener('click', openSettings);
document.getElementById('btnAddSoftware').addEventListener('click', addSoftwareFolder);
document.getElementById('btnScan').addEventListener('click', () => startScan('quick'));
document.getElementById('btnUpdate').addEventListener('click', () => startScan('update'));
document.getElementById('btnFullScan').addEventListener('click', () => startScan('full'));

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
// EVENT DELEGATION (Clicks & Changes)
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

  // Modal Actions
  if (e.target.dataset.action === 'open-item-modal') openItemModal(e.target.dataset.id);
  if (e.target.dataset.action === 'close-modal') closeModal();
  if (e.target.dataset.action === 'open-explorer') openInExplorer(e.target.dataset.path);
  if (e.target.dataset.action === 'edit-software') editSoftware(e.target.dataset.id);
  if (e.target.dataset.action === 'save-software') saveSoftware(e.target.dataset.id);
  if (e.target.dataset.action === 'open-url') {
    e.preventDefault();
    openExternalUrl(e.target.dataset.url);
  }
  if (e.target.dataset.action === 'save-settings') saveSettings();
  if (e.target.dataset.action === 'browse-file') {
    const isDir = e.target.dataset.type === 'dir';
    const filterExt = e.target.dataset.ext;
    const inputId = e.target.dataset.target;
    browseFile(inputId, isDir, filterExt ? [{ name: filterExt, extensions: [filterExt] }] : undefined);
  }

  // Hinzufügen lokaler Installationspfade im Edit-Modal
  if (e.target.dataset.action === 'browse-install-path') {
    const inputId = e.target.dataset.target;
    const selectedPath = await window.electronAPI.selectFile([
      { name: 'Ausführbare Dateien', extensions: ['exe', 'bat', 'cmd', 'ps1'] },
    ]);
    if (selectedPath) {
      const textarea = document.getElementById(inputId);
      textarea.value = textarea.value ? `${textarea.value}\n${selectedPath}` : selectedPath;
    }
  }

  if (e.target.dataset.action === 'manual-update') checkForUpdatesUI();
  if (e.target.dataset.action === 'install-update') {
    installUpdate(e.target.dataset.url, e.target.dataset.portable === 'true');
  }

  // Installer via Temp-Ordner sicher ausführen
  if (e.target.dataset.action === 'execute-temp') {
    const btn = e.target;
    const originalText = btn.textContent;
    const itemId = btn.dataset.id;
    const filePath = btn.dataset.path;

    // Markiere Programm als installiert & merke dir die Setup-Versionsnummer
    const version = extractVersion(path.basename(filePath));
    if (version && itemId) {
      await window.electronAPI.markAsInstalled(itemId, version);
      const catItem = catalog.find((i) => i.id === itemId);
      if (catItem) {
        catItem.isInstalled = true;
        catItem.installedVersion = version;
        renderGrid();
      }
    }

    btn.textContent = '⏳ Kopiere & Starte...';
    btn.disabled = true;
    try {
      const res = await window.electronAPI.executeTempInstaller(filePath);
      if (!res.success) alert(`Fehler bei der Ausführung:\n${res.error}`);
    } catch (err) {
      alert(`Fehler:\n${err.message}`);
    }
    btn.textContent = originalText;
    btn.disabled = false;
  }

  if (e.target.dataset.action === 'start-download') {
    const btn = e.target;
    const originalText = btn.textContent;
    btn.textContent = 'Kopiere...';
    btn.disabled = true;
    try {
      const parsedFiles = JSON.parse(btn.dataset.files);
      const res = await window.electronAPI.downloadFiles(parsedFiles);
      if (res.success) alert(`Erfolgreich gespeichert unter:\n${res.dest}`);
      else if (res.error) alert(`Fehler beim Kopieren:\n${res.error}`);
    } catch (err) {
      alert(`Fehler: ${err.message}`);
    }
    btn.textContent = originalText;
    btn.disabled = false;
  }
  if (e.target.classList.contains('img-zoomable') || e.target.closest('.vid-container')) {
    const zoomTarget = e.target.classList.contains('img-zoomable') ? e.target : e.target.closest('.vid-container');
    if (zoomTarget.dataset.id) {
      openLightbox(zoomTarget.dataset.id, parseInt(zoomTarget.dataset.idx, 10));
    }
  }
});

// Reagiert auf die VersionSelector-Änderung (um die Buttons im Modal dynamisch anzupassen)
document.body.addEventListener('change', (e) => {
  if (e.target.id === 'versionSelector') {
    const selectedIdx = e.target.value;
    const activeItem = catalog.find((i) => i.id === currentOpenModalId);

    if (activeItem?.lastFiles[selectedIdx]) {
      const file = activeItem.lastFiles[selectedIdx];
      const installBtn = document.getElementById('dynamicInstallBtn');
      const dlBtn = document.getElementById('dynamicDownloadBtn');

      if (installBtn) installBtn.dataset.path = file.replace(/\\/g, '\\\\');
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

  // Erweiterte Sortierung anwenden
  filtered.sort((a, b) => {
    // Favoriten immer ganz oben
    const aFav = localFavorites.includes(a.id);
    const bFav = localFavorites.includes(b.id);
    if (aFav && !bFav) return -1;
    if (!aFav && bFav) return 1;

    const sortMode = el.sortSelect.value;
    if (sortMode === 'newest') return (b.addedAt || 0) - (a.addedAt || 0);
    if (sortMode === 'updated') return (b.updatedAt || 0) - (a.updatedAt || 0);

    // Standard: A-Z
    return a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
  });

  if (filtered.length === 0) {
    el.grid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text); opacity: 0.7;">Keine Einträge für diese Suche gefunden.</div>`;
  } else {
    // Hole konfigurierte Anzahl an Tagen (Standard: 14)
    const badgeDays = appSettings.newBadgeDays !== undefined ? appSettings.newBadgeDays : 14;
    const TIME_WINDOW = badgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    el.grid.innerHTML = filtered
      .map((item) => {
        const isFav = localFavorites.includes(item.id);
        const itemTimestamp = item.updatedAt || item.addedAt || 0;

        let badgesHtml = '';

        // Update- oder Install-Badge Rendering
        if (item.isInstalled) {
          let hasUpdate = false;
          // Wenn wir eine Setup-Datei haben und eine lokale Version registriert ist, vergleichen
          if (item.lastFiles && item.lastFiles.length > 0 && item.installedVersion) {
            const latestFile = path.basename(item.lastFiles[0]);
            const latestNasVersion = extractVersion(latestFile);
            if (latestNasVersion && compareVersions(latestNasVersion, item.installedVersion) > 0) {
              hasUpdate = true;
            }
          }
          if (hasUpdate)
            badgesHtml += '<div class="badge badge-update" title="Neue Version auf dem NAS verfügbar">Update 🎁</div>';
          else
            badgesHtml +=
              '<div class="badge badge-installed" title="Programm ist auf diesem PC installiert">Installiert ✓</div>';
        }

        // Dynamisches NEU Badge
        if (itemTimestamp > 0 && badgeDays > 0 && now - itemTimestamp < TIME_WINDOW) {
          badgesHtml += '<div class="badge badge-new" title="Kürzlich hinzugefügt/bearbeitet">NEU</div>';
        }

        return `
      <div class="card" data-id="${item.id}">
        <div class="badges-container">${badgesHtml}</div>
        <button class="fav-btn ${isFav ? 'active' : ''}" data-id="${item.id}" title="Favorit">★</button>
        ${item.icon ? `<img src="file:///${item.icon.replace(/\\/g, '/')}" loading="lazy" decoding="async" alt="Icon">` : ''}
        <h3>${escapeHTML(item.name)}</h3>
        <small>${escapeHTML(item.tags.join(', '))}</small>
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

  currentOpenModalId = id; // Tracken für Version-Select Update

  const osBadges = item.os.length > 0 ? `<p><strong>OS:</strong> ${escapeHTML(item.os.join(', '))}</p>` : '';
  const formatBadges =
    item.formats && item.formats.length > 0
      ? `<p><strong>Formate:</strong> ${escapeHTML(item.formats.join(', '))}</p>`
      : '';
  const catText = item.mainCategory
    ? `<p><strong>Kategorie:</strong> ${escapeHTML(item.mainCategory)} ${item.subCategories.length > 0 ? `(${escapeHTML(item.subCategories.join(', '))})` : ''}</p>`
    : '';

  let downloadHtml = '';
  let installHtml = '';
  let versionSelectHtml = '';

  // Wenn es einen verifizierten lokalen Installationspfad gibt -> extra Start Button!
  let runLocalHtml = '';
  if (item.isInstalled && item.validInstallPath) {
    runLocalHtml = `<button type="button" class="action-btn" style="background: #a6e3a1; color: #1e1e2e; margin-right: 10px;" data-action="open-explorer" data-path="${item.validInstallPath.replace(/\\/g, '\\\\')}" title="Startet die installierte Software auf diesem PC">🚀 Programm starten</button>`;
  }

  if (item.lastFiles && item.lastFiles.length > 0) {
    // Wenn es genau EINE Datei zum Herunterladen/Ausführen gibt, zeige den Installations-Button
    if (item.lastFiles.length === 1) {
      const fileName = item.lastFiles[0].split('\\').pop().split('/').pop();
      installHtml = `
        <button type="button" class="action-btn" style="background: #fab387; color: #1e1e2e; margin-left: 10px;"
                data-action="execute-temp" data-id="${item.id}" data-path="${item.lastFiles[0].replace(/\\/g, '\\\\')}" title="Kopiert die Datei lokal und führt sie aus">
          ▶️ Setup / Installieren (${escapeHTML(fileName)})
        </button>`;
      downloadHtml = `
        <button type="button" class="action-btn" style="background: var(--accent); color: var(--bg); margin-left: 10px;"
                data-action="start-download" data-files='${escapeHTML(JSON.stringify(item.lastFiles))}'>
          ⬇️ Download</button>`;
    } else {
      // Versionsauswahl Dropdown, wenn es mehrere Installer/Dateien gibt!
      const optionsHtml = item.lastFiles
        .map((f, i) => {
          const name = f.split('\\').pop().split('/').pop();
          return `<option value="${i}">${escapeHTML(name)}</option>`;
        })
        .join('');

      versionSelectHtml = `<select id="versionSelector" class="version-selector">${optionsHtml}</select>`;

      installHtml = `<button type="button" id="dynamicInstallBtn" class="action-btn" style="background: #fab387; color: #1e1e2e; margin-left: 10px;" data-action="execute-temp" data-id="${item.id}" data-path="${item.lastFiles[0].replace(/\\/g, '\\\\')}" title="Kopiert die Datei lokal und führt sie aus">▶️ Setup</button>`;
      downloadHtml = `<button type="button" id="dynamicDownloadBtn" class="action-btn" style="background: var(--accent); color: var(--bg); margin-left: 10px;" data-action="start-download" data-files='${escapeHTML(JSON.stringify([item.lastFiles[0]]))}'>⬇️ Download</button>`;
    }
  }

  // Links generieren
  let linksHtml = '';
  if (item.links && item.links.length > 0) {
    linksHtml =
      `<div style="margin-top: 15px;"><strong>Links:</strong><ul style="margin-top: 5px;">` +
      item.links
        .map(
          (l) =>
            `<li><a href="#" style="color: var(--accent);" data-action="open-url" data-url="${escapeHTML(l.url)}">${escapeHTML(l.label)}</a></li>`
        )
        .join('') +
      `</ul></div>`;
  }

  // Generierung der Thumbnails (Bilder + Videos mit Play-Overlay)
  let mediaHtml = '';
  if (item.screenshots && item.screenshots.length > 0) {
    mediaHtml =
      `<div style="margin-top: 20px; display: flex; gap: 15px; overflow-x: auto; padding-bottom: 10px;">` +
      item.screenshots
        .map((s, idx) => {
          const fileUrl = `file:///${s.replace(/\\/g, '/')}`;
          const isVid = /\.(mp4|webm|ogg|mov|avi)$/i.test(s);

          if (isVid) {
            // #t=1 springt bei der Vorschau auf Sekunde 1 (überspringt schwarze Anfangsbilder)
            return `
            <div class="vid-container" style="position:relative; display:inline-block; cursor:pointer;" data-id="${item.id}" data-idx="${idx}" title="Video abspielen">
              <video src="${fileUrl}#t=1" class="img-zoomable" style="height: 120px; min-width: 150px; max-width: 250px; border-radius: 8px; border: 1px solid var(--border); object-fit: cover;" muted preload="metadata"></video>
              <div style="position:absolute; inset:0; display:flex; justify-content:center; align-items:center; background:rgba(0,0,0,0.3); border-radius:8px; pointer-events:none;">
                <span style="font-size:32px; color:white; text-shadow: 0 2px 4px rgba(0,0,0,0.5);">▶️</span>
              </div>
            </div>`;
          } else {
            return `<img src="${fileUrl}" class="img-zoomable" data-id="${item.id}" data-idx="${idx}" style="height: 120px; min-width: 150px; border-radius: 8px; border: 1px solid var(--border); object-fit: cover;">`;
          }
        })
        .join('') +
      `</div>`;
  }

  // Wichtig für den Editor-Fallback (HTML darf nicht ent-escapt werden)
  // Das Modal rendert item.description wie bisher 1:1, da wir es im Custom Editor als reines HTML speichern
  el.modalContent.innerHTML = `
    <button type="button" class="close-btn" data-action="close-modal" title="Schließen" aria-label="Schließen">&times;</button>
    <div style="display: flex; gap: 20px; align-items: flex-start;">
      ${item.icon ? `<img src="file:///${item.icon.replace(/\\/g, '/')}" style="width: 80px; height: 80px; object-fit: contain;">` : ''}
      <div>
        <h2>${escapeHTML(item.name)}</h2>
        ${osBadges}
        ${formatBadges}
        ${catText}
      </div>
    </div>
    <div style="margin-top: 20px;">
      <div style="line-height: 1.5; opacity: 0.9;">${item.description ? item.description : 'Keine Beschreibung vorhanden.'}</div>
      ${linksHtml}
      ${mediaHtml}
      <p><small style="color: gray;">Netzwerk-Pfad: ${escapeHTML(item.path)}</small></p>
    </div>
    <div style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 15px; display: flex; align-items: center; justify-content: space-between;">
      <div>
        <button type="button" class="action-btn" style="margin-top: 0;" data-action="open-explorer" data-path="${item.path.replace(/\\/g, '\\\\')}">Im Explorer öffnen</button>
        <button type="button" class="action-btn" style="margin-top: 0; margin-left: 10px; background: var(--surface); border: 1px solid var(--border); color: var(--text);" data-action="edit-software" data-id="${item.id}">✏️ Bearbeiten</button>
      </div>
      <div style="display: flex; align-items: center;">
        ${runLocalHtml}
        ${versionSelectHtml}
        ${installHtml}
        ${downloadHtml}
      </div>
    </div>
  `;
  el.modalOverlay.style.display = 'flex';
}

function closeModal() {
  el.modalOverlay.style.display = 'none';
  currentOpenModalId = null;
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

  // Starte die Update-Prüfung im Hintergrund
  checkForUpdatesUI();
}

// Verbesserte Update-UI für One-Click Self-Update
async function checkForUpdatesUI() {
  const container = document.getElementById('updateContainer');
  const btn = document.getElementById('btnManualUpdate');
  if (!container || !window.electronAPI) return;

  if (btn) btn.disabled = true;
  container.innerHTML = '<span style="color: gray; font-size: 0.9em;">Suche nach Updates...</span>';

  const res = await window.electronAPI.checkUpdate();
  if (btn) btn.disabled = false;

  if (res.error) {
    container.innerHTML = `<span style="color: var(--text); opacity: 0.7; font-size: 0.9em;">Update-Prüfung fehlgeschlagen.</span>`;
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
  const container = document.getElementById('updateContainer');
  container.innerHTML = `
    <span style="color: #fab387; font-weight: bold; font-size: 0.95em;">
      Update wird geladen & installiert... App schließt sich gleich.
    </span>`;
  try {
    await window.electronAPI.installUpdate(assetUrl, isPortable);
  } catch (err) {
    alert(`Fehler beim Vorbereiten des Updates: ${err.message}`);
    container.innerHTML = `<span style="color: red;">Fehler!</span>`;
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
      await init(); // Nur UI aktualisieren (z.B. versteckte Kategorien)
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
      `Der Ordner wurde erfolgreich hinzugefügt!\n\nSuche das Programm nun in der Liste und klicke auf "Bearbeiten".`
    );
  } else if (res.error) {
    alert(`Fehler beim Hinzufügen:\n${res.error}`);
  }
}

function editSoftware(id) {
  const item = catalog.find((i) => i.id === id);
  if (!item) return;

  // Description is now pure HTML from the rich text editor
  const desc = item.description || '';

  // Links wieder in "Label | URL" Format konvertieren
  const linksStr = (item.links || []).map((l) => `${l.label} | ${l.url}`).join('\n');

  // Lokale Installationspfade
  const installPathsStr = (item.installPaths || []).join('\n');

  el.modalContent.innerHTML = `
    <button type="button" class="close-btn" data-action="close-modal" title="Schließen">&times;</button>
    <h2>Software bearbeiten: <span style="color: var(--accent);">${escapeHTML(item.name)}</span></h2>

    <div class="settings-group" style="border: none; padding: 0; margin: 0;">
      <div class="settings-row"><label style="width:150px;">Name:</label><input type="text" id="editName" value="${escapeHTML(item.name)}"></div>
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

      <div style="margin-top: 15px;">
        <label style="display:block; margin-bottom:5px;">Links (Format: Name | https://...):</label>
        <textarea id="editLinks" style="width:100%; height:80px;">${escapeHTML(linksStr)}</textarea>
      </div>

      <!-- Lokale Installationspfade -->
      <div style="margin-top: 15px;">
        <label style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:5px;">
          <span>Lokale Installationspfade (Einer pro Zeile):</span>
          <button type="button" class="action-btn" style="margin:0; padding:4px 8px; font-size:12px;" data-action="browse-install-path" data-target="editInstallPaths">Suchen...</button>
        </label>
        <textarea id="editInstallPaths" style="width:100%; height:60px;" placeholder="z.B. C:\\Program Files\\VLC\\vlc.exe">${escapeHTML(installPathsStr)}</textarea>
      </div>

      <div style="display: flex; gap: 15px; margin-top: 15px;">
        <div class="media-dropzone" data-path="${escapeHTML(item.path)}" data-id="${item.id}" data-type="icon" style="flex: 1; margin-top: 0; padding: 15px; border-color: var(--accent);">
          🖼️ <strong>Icon</strong> hier ablegen<br><small style="opacity: 0.7;">(Wird zu icon.* umbenannt)</small>
        </div>
        <div class="media-dropzone" data-path="${escapeHTML(item.path)}" data-id="${item.id}" data-type="media" style="flex: 2; margin-top: 0; padding: 15px;">
          📷 <strong>Bilder oder Videos</strong> hier ablegen...
        </div>
      </div>
    </div>

    <div style="margin-top: 25px; border-top: 1px solid var(--border); padding-top: 15px; display: flex; justify-content: space-between; align-items: center;">
      <button type="button" class="action-btn" style="margin-top:0; background: var(--surface); color: var(--text); border: 1px solid var(--border);" data-action="open-explorer" data-path="${item.path.replace(/\\/g, '\\\\')}\\\\_metadata">Bilderordner öffnen</button>
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
    links: {},
  };

  // Links parsen
  const linksRaw = document.getElementById('editLinks').value.split('\n');
  for (const l of linksRaw) {
    const parts = l.split('|');
    if (parts.length >= 2) {
      data.links[parts[0].trim()] = parts.slice(1).join('|').trim();
    }
  }

  // Speichert meta.json UND aktualisiert die catalog.json im Main-Prozess
  const res = await window.electronAPI.saveMetaJson(item.path, data);
  if (res.success) {
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
