import { openLightbox } from '../components/lightbox.js';
import { showToast } from '../components/toast.js';
import { getBaseName, getItemById, getItemStatus, isItemNew, state } from '../state.js';
import { escapeHTML, sanitizeRichHtml, toMediaUrl } from '../utils/sanitize.js';
import { closeModal, openEditModal, triggerCatalogReload } from './index.js';

const SOURCE_LABELS = {
  winget: 'Winget',
  github: 'GitHub',
  web: 'Webseite',
};

const STATUS_BADGES = {
  webupdate: { label: 'Web-Update verfügbar', cls: 'is-webupdate' },
  update: { label: 'Archiv-Update verfügbar', cls: 'is-update' },
  installed: { label: 'Aktuell installiert', cls: 'is-installed' },
  newer: { label: 'PC neuer als Archiv', cls: 'is-newer' },
};

function canDownloadOnline(item) {
  if (item.webSourceType === 'winget' && item.wingetId) return true;
  if (item.webSourceType === 'github' && item.webVersionUrl) return true;
  return Boolean(item.downloadUrl);
}

function buildHeroAction(item, st) {
  const onlineReady = canDownloadOnline(item);
  const firstFile = item.lastFiles?.[0] || null;

  if (st.hasWebUpdate && onlineReady) {
    return {
      action: 'web-download',
      label: `⬇️ Update v${st.webVersion} ins Archiv laden`,
      cls: 'btn-online',
      hint: 'Lädt die neuste Version aus dem Internet direkt in dein NAS-Archiv.',
    };
  }

  if (st.hasNasUpdate && firstFile) {
    return {
      action: 'install-file',
      file: firstFile,
      version: st.nasVersion,
      label: `⬆️ Jetzt aktualisieren (v${st.nasVersion})`,
      cls: 'btn-archive',
      hint: 'Kopiert das Setup lokal, startet es und prüft danach die neue Version.',
    };
  }

  if (!item.isInstalled && firstFile) {
    return {
      action: 'install-file',
      file: firstFile,
      version: st.nasVersion,
      label: st.nasVersion ? `▶️ Installieren (v${st.nasVersion})` : '▶️ Setup starten',
      cls: 'btn-primary',
      hint: 'Startet die aktuelle Setup-Datei aus dem Archiv.',
    };
  }

  if (item.isInstalled && item.validInstallPath) {
    return {
      action: 'launch-local',
      label: '🚀 Programm starten',
      cls: 'btn-local',
      hint: 'Startet die lokal installierte Version auf diesem PC.',
    };
  }

  return null;
}

export function renderDetailModal(id, { freshDownload = null } = {}) {
  const item = getItemById(id);
  if (!item) return;

  state.currentModalId = id;
  state.isEditModalOpen = false;

  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;

  const st = getItemStatus(item);
  const statusBadge = STATUS_BADGES[st.status];
  const hero = buildHeroAction(item, st);
  const onlineReady = canDownloadOnline(item);
  const sourceLabel = SOURCE_LABELS[item.webSourceType] || '';

  const iconHtml = item.icon
    ? `<img class="detail-icon" src="${escapeHTML(toMediaUrl(item.icon))}" alt="">`
    : '<div class="detail-icon-fallback">📦</div>';

  const typeChip =
    item.softwareType === 'portable'
      ? '<span class="card-chip">Portabel</span>'
      : item.softwareType === 'driver'
        ? '<span class="card-chip">Treiber</span>'
        : '';

  const newChip = isItemNew(item) ? '<span class="card-chip chip-new">NEU</span>' : '';

  const postDownloadBanner = freshDownload
    ? `
      <div class="detail-inline-banner is-success">
        <div class="banner-text">
          <strong>✅ Download im Archiv gespeichert!</strong>
          <span>Datei: <code>${escapeHTML(getBaseName(freshDownload.filePath))}</code></span>
        </div>
        <button type="button" class="btn btn-local" data-detail-action="install-fresh" data-file="${escapeHTML(freshDownload.filePath)}" data-version="${escapeHTML(freshDownload.version || '')}">
          ▶️ Jetzt installieren
        </button>
      </div>
    `
    : '';

  const pinnedNotice =
    item.hasPinnedLast && onlineReady
      ? `
      <label class="detail-pin-choice">
        <input type="checkbox" id="detailSaveIntoLast">
        <span><code>_last</code>-Ordner ist aktiv (gepinnte Version). Neuen Web-Download ebenfalls in <code>_last</code> speichern?</span>
      </label>
    `
      : '';

  // Archiv-Dateiauswahl (immer zugänglich für Setup oder Kopie auf PC)
  let archiveFilesHtml = '';
  if (item.lastFiles?.length > 0) {
    const firstFile = item.lastFiles[0];
    const selectorHtml =
      item.lastFiles.length > 1
        ? `<select id="detailFileSelect" class="detail-file-select">${item.lastFiles
            .map((f, idx) => `<option value="${idx}">${escapeHTML(getBaseName(f))}</option>`)
            .join('')}</select>`
        : `<span class="detail-file-name" title="${escapeHTML(getBaseName(firstFile))}">${escapeHTML(getBaseName(firstFile))}</span>`;

    archiveFilesHtml = `
      <div class="detail-archive-bar">
        <span class="detail-archive-label">Archiv-Datei:</span>
        ${selectorHtml}
        <div class="detail-archive-btns">
          <button type="button" class="btn btn-ghost" data-detail-action="run-selected">▶️ Ausführen</button>
          <button type="button" class="btn btn-ghost" data-detail-action="copy-selected">💾 Auf PC kopieren</button>
        </div>
      </div>
    `;
  }

  // Sekundäre Schnellaktionen neben dem Hero-Button
  const secondaryHeroBtns = [];
  if (item.isInstalled && item.validInstallPath && hero?.action !== 'launch-local') {
    secondaryHeroBtns.push(
      '<button type="button" class="btn btn-ghost" data-detail-action="launch-local">🚀 Programm starten</button>'
    );
  }
  if (onlineReady && hero?.action !== 'web-download') {
    secondaryHeroBtns.push(
      '<button type="button" class="btn btn-ghost" data-detail-action="web-download">🌐 Aus Web laden</button>'
    );
  }

  // Metadaten-Pills (Kategorie, OS, Formate)
  const metaPills = [];
  if (item.mainCategory) metaPills.push(`<span><strong>Kategorie:</strong> ${escapeHTML(item.mainCategory)}</span>`);
  if (item.subCategories?.length)
    metaPills.push(`<span><strong>Tags:</strong> ${escapeHTML(item.subCategories.join(', '))}</span>`);
  if (item.os?.length) metaPills.push(`<span><strong>OS:</strong> ${escapeHTML(item.os.join(', '))}</span>`);
  if (item.formats?.length)
    metaPills.push(`<span><strong>Formate:</strong> ${escapeHTML(item.formats.join(', '))}</span>`);

  // Beschreibung (XSS-sicher über DOMPurify)
  const cleanDesc = sanitizeRichHtml(item.description);

  // Links
  const linksHtml =
    item.links?.length > 0
      ? `
      <div class="detail-section">
        <h4>Links</h4>
        <div class="detail-links">
          ${item.links
            .map(
              (l) =>
                `<button type="button" class="link-chip" data-open-url="${escapeHTML(l.url)}">🔗 ${escapeHTML(l.label)}</button>`
            )
            .join('')}
        </div>
      </div>
    `
      : '';

  // Medien-Galerie
  const mediaHtml =
    item.screenshots?.length > 0
      ? `
      <div class="detail-section">
        <h4>Vorschau (${item.screenshots.length})</h4>
        <div class="detail-media-strip">
          ${item.screenshots
            .map((s, idx) => {
              const url = escapeHTML(toMediaUrl(s));
              const isVid = /\.(mp4|webm|ogg|mov|avi)$/i.test(s);
              if (isVid) {
                return `
                  <button type="button" class="media-thumb is-video" data-lightbox-idx="${idx}" title="Video abspielen">
                    <video src="${url}#t=1" muted preload="metadata"></video>
                    <span class="play-badge">▶</span>
                  </button>
                `;
              }
              return `
                <button type="button" class="media-thumb" data-lightbox-idx="${idx}" title="Vergrößern">
                  <img src="${url}" loading="lazy" alt="Screenshot">
                </button>
              `;
            })
            .join('')}
        </div>
      </div>
    `
      : '';

  // Eingeklappte Technik-Details
  const techRows = [`<div class="tech-row"><span>NAS-Ordner</span><code>${escapeHTML(item.path)}</code></div>`];
  if (item.wingetId) {
    techRows.push(`<div class="tech-row"><span>Winget-ID</span><code>${escapeHTML(item.wingetId)}</code></div>`);
  }
  if (item.webVersionUrl) {
    techRows.push(
      `<div class="tech-row"><span>Versions-Quelle</span><button type="button" class="inline-link" data-open-url="${escapeHTML(item.webVersionUrl)}">${escapeHTML(item.webVersionUrl)}</button></div>`
    );
  }
  if (item.downloadUrl) {
    techRows.push(
      `<div class="tech-row"><span>Download-Quelle</span><button type="button" class="inline-link" data-open-url="${escapeHTML(item.downloadUrl)}">${escapeHTML(item.downloadUrl)}</button></div>`
    );
  }
  if (item.autoPaths?.length) {
    techRows.push(
      `<div class="tech-row"><span>PC-Pfad (Auto)</span><code>${item.autoPaths.map(escapeHTML).join('<br>')}</code></div>`
    );
  }
  if (item.installPaths?.length) {
    techRows.push(
      `<div class="tech-row"><span>PC-Pfad (Manuell)</span><code>${item.installPaths.map(escapeHTML).join('<br>')}</code></div>`
    );
  }
  if (item.searchNames?.length) {
    techRows.push(
      `<div class="tech-row"><span>Such-Namen</span><code>${escapeHTML(item.searchNames.join(', '))}</code></div>`
    );
  }

  modal.innerHTML = `
    <div class="modal-header detail-header">
      <div class="detail-head-main">
        ${iconHtml}
        <div class="detail-head-text">
          <div class="detail-title-row">
            <h2>${escapeHTML(item.name)}</h2>
            ${statusBadge ? `<span class="status-pill ${statusBadge.cls}">${escapeHTML(statusBadge.label)}</span>` : ''}
            ${newChip}
            ${typeChip}
          </div>
          <div class="detail-meta-inline">${metaPills.join('')}</div>
        </div>
      </div>
      <button type="button" class="icon-btn" data-detail-action="close" title="Schließen" aria-label="Schließen">✕</button>
    </div>

    <div class="modal-body detail-body">
      <!-- 3-Spalten Versionsübersicht -->
      <div class="detail-version-grid">
        <div class="detail-ver-box ${st.isPcNewer ? 'is-newer' : st.localVersion && !st.hasNasUpdate ? 'is-ok' : ''}">
          <span class="ver-box-lbl">Installiert (PC)</span>
          <strong class="ver-box-val">${st.localVersion ? `v${escapeHTML(st.localVersion)}` : 'Nicht erkannt'}</strong>
        </div>
        <div class="detail-ver-box ${st.hasNasUpdate ? 'is-nas-update' : ''}">
          <span class="ver-box-lbl">Archiv (NAS)${item.hasPinnedLast ? ' · _last gepinnt' : ''}</span>
          <strong class="ver-box-val">${st.nasVersion ? `v${escapeHTML(st.nasVersion)}` : 'Keine Version'}</strong>
        </div>
        <div class="detail-ver-box ${st.hasWebUpdate ? 'is-web-update' : ''}">
          <span class="ver-box-lbl">Online${sourceLabel ? ` · ${escapeHTML(sourceLabel)}` : ''}</span>
          <strong class="ver-box-val">${st.webVersion ? `v${escapeHTML(st.webVersion)}` : 'Nicht eingerichtet'}</strong>
        </div>
      </div>

      ${postDownloadBanner}

      <!-- Haupt-Aktionsbereich -->
      ${
        hero || secondaryHeroBtns.length > 0
          ? `
        <div class="detail-hero-bar">
          ${
            hero
              ? `<button type="button" class="btn btn-lg ${hero.cls}" data-detail-action="${hero.action}" data-file="${escapeHTML(hero.file || '')}" data-version="${escapeHTML(hero.version || '')}">${escapeHTML(hero.label)}</button>`
              : ''
          }
          ${secondaryHeroBtns.join('')}
        </div>
        ${pinnedNotice}
      `
          : ''
      }

      ${archiveFilesHtml}

      <div class="detail-section">
        <h4>Beschreibung</h4>
        <div class="detail-description">${cleanDesc || '<span class="muted">Keine Beschreibung vorhanden.</span>'}</div>
      </div>

      ${linksHtml}
      ${mediaHtml}

      <details class="detail-tech-drawer">
        <summary>Technische Details & Pfade</summary>
        <div class="detail-tech-list">${techRows.join('')}</div>
      </details>
    </div>

    <div class="modal-footer">
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-detail-action="open-folder">📂 Archiv-Ordner</button>
      </div>
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-detail-action="edit">✏️ Bearbeiten</button>
        <button type="button" class="btn btn-primary" data-detail-action="close">Schließen</button>
      </div>
    </div>
  `;

  overlay.hidden = false;

  const getSelectedArchiveFile = () => {
    const sel = modal.querySelector('#detailFileSelect');
    const idx = sel ? parseInt(sel.value, 10) : 0;
    return item.lastFiles?.[idx] || item.lastFiles?.[0] || null;
  };

  const runInstallerFlow = async (filePath, targetVersion) => {
    if (!filePath) return;
    showToast(`Starte Setup für ${item.name}...`, { type: 'info' });
    const res = await window.electronAPI.executeInstaller({
      itemId: item.id,
      itemName: item.name,
      sourcePath: filePath,
      targetVersion: targetVersion || null,
    });

    if (res.alreadyRunning) {
      showToast('Für dieses Programm läuft bereits eine Installation.', { type: 'warn' });
      return;
    }

    await triggerCatalogReload();
    if (state.currentModalId === item.id) {
      renderDetailModal(item.id);
    }

    if (res.success && res.verified) {
      showToast(`${item.name} erfolgreich auf v${res.newVersion} aktualisiert!`, { type: 'success' });
    } else if (res.canceled) {
      showToast('Installation wurde abgebrochen.', { type: 'info' });
    } else if (res.success && res.status === 'opened') {
      showToast('Archiv-Datei wurde geöffnet.', { type: 'info' });
    } else if (!res.success && res.error) {
      showToast(`Installationsfehler: ${res.error}`, { type: 'error', duration: 6000 });
    }
  };

  const runWebDownloadFlow = async () => {
    const saveIntoLastFolder = Boolean(modal.querySelector('#detailSaveIntoLast')?.checked);
    const res = await window.electronAPI.downloadWebUpdate(item, { saveIntoLastFolder });

    if (res.alreadyRunning) {
      showToast('Download läuft bereits.', { type: 'info' });
      return;
    }
    if (res.canceled) return;
    if (!res.success) {
      showToast(`Download fehlgeschlagen: ${res.error}`, { type: 'error', duration: 6000 });
      return;
    }

    await triggerCatalogReload();
    showToast(`${item.name} wurde im Archiv gespeichert.`, { type: 'success' });
    if (state.currentModalId === item.id) {
      renderDetailModal(item.id, { freshDownload: { filePath: res.filePath, version: res.version } });
    }
  };

  modal.onclick = async (e) => {
    const urlBtn = e.target.closest('[data-open-url]');
    if (urlBtn) {
      window.electronAPI.openUrl(urlBtn.dataset.openUrl);
      return;
    }

    const thumb = e.target.closest('[data-lightbox-idx]');
    if (thumb) {
      openLightbox(item.id, parseInt(thumb.dataset.lightboxIdx, 10));
      return;
    }

    const btn = e.target.closest('[data-detail-action]');
    if (!btn) return;

    const action = btn.dataset.detailAction;
    if (action === 'close') closeModal();
    else if (action === 'edit') openEditModal(item.id);
    else if (action === 'open-folder') window.electronAPI.openPath(item.path);
    else if (action === 'launch-local' && item.validInstallPath) window.electronAPI.openPath(item.validInstallPath);
    else if (action === 'web-download') await runWebDownloadFlow();
    else if (action === 'install-file' || action === 'install-fresh') {
      await runInstallerFlow(btn.dataset.file, btn.dataset.version);
    } else if (action === 'run-selected') {
      await runInstallerFlow(getSelectedArchiveFile(), null);
    } else if (action === 'copy-selected') {
      const file = getSelectedArchiveFile();
      if (!file) return;
      btn.disabled = true;
      const res = await window.electronAPI.copyFilesToPc([file]);
      btn.disabled = false;
      if (res.success) showToast(`Gespeichert unter: ${res.dest}`, { type: 'success' });
      else if (res.error) showToast(`Kopierfehler: ${res.error}`, { type: 'error' });
    }
  };
}
