import {
  detectAdwareSignals,
  normalizeInstallMode,
  sanitizeInnoInfFileName,
  sanitizeSilentArgs,
} from '../../shared/installer-logic.js';
import { showToast } from '../components/toast.js';
import { getBaseName, getCatalogItemById, getItemById, state } from '../state.js';
import { escapeHTML, sanitizeRichHtml, toMediaUrl } from '../utils/sanitize.js';
import { openDetailModal, resetModalContent, triggerCatalogReload } from './index.js';

function getInstallModeDescription(mode) {
  if (mode === 'silent') {
    return 'Opt-in: Wird bei Einzelinstallationen & Massen-Updates still mit den gesetzten Parametern ausgeführt.';
  }
  if (mode === 'interactive-required') {
    return '🛡️ Adware-Schutz: Silent-Parameter werden IMMER ignoriert (auch bei Massen-Updates & Bündeln), damit du Zusatzangebote abwählen kannst.';
  }
  return 'Standard: Das Setup-Fenster öffnet sich normal. Du klickst dich selbst durch den Assistenten.';
}

function detectInitialSourceType(item) {
  if (item.webSourceType && item.webSourceType !== 'none') return item.webSourceType;
  if (item.wingetId || (item.packageManager === 'winget' && item.packageId)) return 'winget';
  if (item.webVersionUrl?.toLowerCase().includes('github.com')) return 'github';
  if (item.webVersionUrl) return 'web';
  return 'none';
}

export function renderEditModal(id, initialTab = 'general') {
  const item = getCatalogItemById(id);
  if (!item) return;

  state.currentModalId = id;
  state.isEditModalOpen = true;

  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();

  const unifiedItem = getItemById(id);
  const itemPublisher = unifiedItem?.publisher || item.publisher || '';

  // Lokaler Arbeitszustand für Pfade & Quelle (bleibt beim Tab-Wechsel erhalten)
  const draftPaths = [
    ...(item.autoPaths || []).map((p) => ({ path: p, origin: 'auto' })),
    ...(item.installPaths || []).map((p) => ({ path: p, origin: 'manual' })),
  ];
  let currentSourceType = detectInitialSourceType(item);
  const initialWingetId = item.wingetId || (item.packageManager === 'winget' ? item.packageId : '') || '';
  let currentInstallMode = normalizeInstallMode(item.installMode);
  let detectedInstallerType = '';
  let infExists = Boolean(item.innoInfExists);
  let recordedInfName = item.innoInfFile || '';
  const primarySetupFile = item.lastFiles?.[0] || '';
  const currentAdwareWarning = detectAdwareSignals({
    name: item.name,
    fileName: primarySetupFile ? getBaseName(primarySetupFile) : '',
    packageId: initialWingetId || item.packageId || '',
    publisher: itemPublisher,
  });
  const linksStr = (item.links || []).map((l) => `${l.label} | ${l.url}`).join('\n');
  const cleanDesc = sanitizeRichHtml(item.description || '');

  modal.innerHTML = `
    <div class="modal-header">
      <div>
        <h2>Bearbeiten: <span class="text-accent">${escapeHTML(item.name)}</span></h2>
      </div>
      <button type="button" class="icon-btn" data-edit-action="cancel" title="Abbrechen" aria-label="Abbrechen">✕</button>
    </div>

    <nav class="modal-tabs" role="tablist">
      <button type="button" class="tab-btn ${initialTab === 'general' ? 'active' : ''}" data-tab="general">📝 Allgemein</button>
      <button type="button" class="tab-btn ${initialTab === 'online' ? 'active' : ''}" data-tab="online">🌐 Online-Updates</button>
      <button type="button" class="tab-btn ${initialTab === 'local' ? 'active' : ''}" data-tab="local">💻 PC-Erkennung</button>
      <button type="button" class="tab-btn ${initialTab === 'media' ? 'active' : ''}" data-tab="media">🖼️ Medien</button>
    </nav>

    <div class="modal-body edit-body">
      <!-- TAB 1: ALLGEMEIN -->
      <section class="tab-panel" data-panel="general" ${initialTab === 'general' ? '' : 'hidden'}>
      <div class="autofill-bar">
        <span class="muted">Beschreibung, Tags & Links automatisch aus der Online-Quelle (Winget / GitHub / Web) laden:</span>
        <button type="button" class="btn btn-ghost" data-edit-action="autofill-fetch">✨ Infos automatisch laden</button>
      </div>
      <div id="autofillPreviewBox" class="autofill-preview" hidden></div>
        <div class="form-grid-2">
          <label class="form-field">
            <span>Name</span>
            <input type="text" id="editName" value="${escapeHTML(item.name)}">
          </label>
          <label class="form-field">
            <span>Software-Typ</span>
            <select id="editSoftwareType">
              <option value="default" ${!item.softwareType || item.softwareType === 'default' ? 'selected' : ''}>Standard (wird installiert)</option>
              <option value="portable" ${item.softwareType === 'portable' ? 'selected' : ''}>Portabel (kein PC-Pfad nötig)</option>
              <option value="driver" ${item.softwareType === 'driver' ? 'selected' : ''}>Treiber / Systemkomponente</option>
            </select>
          </label>
          <label class="form-field">
            <span>Hauptkategorie</span>
            <input type="text" id="editCat" value="${escapeHTML(item.mainCategory || '')}" placeholder="z. B. Multimedia">
          </label>
          <label class="form-field">
            <span>Versteckte Kategorie (optional)</span>
            <input type="text" id="editHidden" value="${escapeHTML(item.hiddenCategory || '')}" placeholder="Leer = immer sichtbar">
          </label>
          <label class="form-field">
            <span>Tags (kommagetrennt)</span>
            <input type="text" id="editTags" value="${escapeHTML((item.subCategories || []).join(', '))}" placeholder="z. B. Video, Player, Open Source">
          </label>
          <label class="form-field">
            <span>Unterstützte Formate (kommagetrennt)</span>
            <input type="text" id="editFormats" value="${escapeHTML((item.formats || []).join(', '))}" placeholder="z. B. .mp4, .mkv">
          </label>
        </div>

        <label class="form-field">
          <span>Betriebssysteme (kommagetrennt)</span>
          <input type="text" id="editOS" value="${escapeHTML((item.os || []).join(', '))}" placeholder="Windows 10, Windows 11">
        </label>

        <label class="check-row edit-keep-versions-row">
          <input type="checkbox" id="editKeepAllVersions" ${item.keepAllVersions ? 'checked' : ''}>
          <span>🔒 Alle Versionen im Archiv behalten (vom Aufräumer ausschließen)</span>
        </label>

        <div class="form-field">
          <span>Beschreibung</span>
          <div class="editor-toolbar" id="descToolbar">
            <button type="button" data-cmd="bold" title="Fett"><b>B</b></button>
            <button type="button" data-cmd="italic" title="Kursiv"><i>I</i></button>
            <button type="button" data-cmd="underline" title="Unterstrichen"><u>U</u></button>
            <button type="button" data-cmd="insertUnorderedList" title="Aufzählung">• Liste</button>
            <button type="button" data-cmd="toggleLinkBar" title="Link einfügen">🔗 Link</button>
          </div>
          <div id="inlineLinkBar" class="inline-link-bar" hidden>
            <input type="url" id="inlineLinkUrl" placeholder="https://...">
            <button type="button" class="btn btn-primary" data-edit-action="apply-link">Einfügen</button>
            <button type="button" class="btn btn-ghost" data-edit-action="cancel-link">✕</button>
          </div>
          <div id="editDesc" class="rich-editor" contenteditable="true">${cleanDesc}</div>
        </div>

        <label class="form-field">
          <span>Info-Links (eine Zeile pro Link: <code>Name | https://...</code>)</span>
          <textarea id="editLinks" rows="3" placeholder="Homepage | https://example.org">${escapeHTML(linksStr)}</textarea>
        </label>
      </section>

      <!-- TAB 2: ONLINE-UPDATES -->
      <section class="tab-panel" data-panel="online" ${initialTab === 'online' ? '' : 'hidden'}>
        <div class="form-field">
          <span>Quelle für automatische Update-Prüfung</span>
          <div class="source-switcher" id="sourceSwitcher">
            <button type="button" class="source-opt ${currentSourceType === 'none' ? 'active' : ''}" data-source="none">Aus</button>
            <button type="button" class="source-opt ${currentSourceType === 'winget' ? 'active' : ''}" data-source="winget">📦 Winget (Empfohlen)</button>
            <button type="button" class="source-opt ${currentSourceType === 'github' ? 'active' : ''}" data-source="github">🐙 GitHub Releases</button>
            <button type="button" class="source-opt ${currentSourceType === 'web' ? 'active' : ''}" data-source="web">🌐 Webseite (Assistent)</button>
          </div>
        </div>

        <!-- WINGET PANEL -->
        <div class="source-panel" data-source-panel="winget" ${currentSourceType === 'winget' ? '' : 'hidden'}>
          <p class="panel-hint">Winget liefert zuverlässig die neuste Version, den offiziellen Installer-Link und eine SHA-256 Prüfsumme - ganz ohne HTML-Scraper.</p>
          <div class="input-action-row">
            <input type="text" id="wingetQueryInput" value="${escapeHTML(item.name)}" placeholder="Programm in Winget suchen...">
            <button type="button" class="btn btn-primary" data-edit-action="search-winget">🔎 In Winget suchen</button>
          </div>
          <div id="wingetResults" class="winget-results" hidden></div>

          <label class="form-field">
            <span>Ausgewählte Winget-ID</span>
            <input type="text" id="editWingetId" value="${escapeHTML(initialWingetId)}" placeholder="z. B. VideoLAN.VLC">
          </label>
        </div>

        <!-- GITHUB PANEL -->
        <div class="source-panel" data-source-panel="github" ${currentSourceType === 'github' ? '' : 'hidden'}>
          <p class="panel-hint">Füge einfach den Link zum GitHub-Repository ein. Version und Release-Download werden automatisch erkannt.</p>
          <label class="form-field">
            <span>GitHub Repository-URL</span>
            <input type="url" id="editGithubUrl" value="${escapeHTML(currentSourceType === 'github' ? item.webVersionUrl || '' : '')}" placeholder="https://github.com/nutzer/projekt">
          </label>
          <label class="form-field">
            <span>Optionaler Datei-Filter für Direkt-Download</span>
            <input type="text" id="editGithubAssetPattern" value="${escapeHTML(item.githubAssetPattern || '')}" placeholder="z. B. x64.exe oder win64.msi (leer = automatisch erste Windows-Setup)">
          </label>
        </div>

        <!-- WEBSEITE / VISUELLER ASSISTENT PANEL -->
        <div class="source-panel" data-source-panel="web" ${currentSourceType === 'web' ? '' : 'hidden'}>
          <div class="wizard-step">
            <div class="wizard-step-head">
              <span class="step-num">1</span>
              <strong>Versionsnummer erkennen</strong>
            </div>
            <div class="input-action-row">
              <input type="url" id="editWebUrl" value="${escapeHTML(currentSourceType === 'web' ? item.webVersionUrl || '' : '')}" placeholder="https://hersteller.de/downloads">
              <button type="button" class="btn btn-online" data-edit-action="visual-scrape">🎯 Version auf Seite markieren</button>
            </div>
          </div>

          <div class="wizard-step">
            <div class="wizard-step-head">
              <span class="step-num">2</span>
              <strong>Download-Link festlegen</strong>
              <span class="muted">(Tipp: Unterstützt <code>{version}</code> als Platzhalter)</span>
            </div>
            <div class="input-action-row">
              <input type="url" id="editDownloadUrl" value="${escapeHTML(item.downloadUrl || '')}" placeholder="Download-Seite oder direkter Link">
              <button type="button" class="btn btn-primary" data-edit-action="visual-link-pick">🎯 Download-Button anklicken</button>
            </div>
          </div>

          <details class="advanced-box">
            <summary>Erweitert: Automatisch erkannte HTML-Regeln bearbeiten</summary>
            <div class="form-grid-2">
              <label class="form-field">
                <span>Version - Davor (Präfix)</span>
                <input type="text" id="editWebPrefix" value="${escapeHTML(item.webVersionPrefix || '')}">
              </label>
              <label class="form-field">
                <span>Version - Danach (Suffix)</span>
                <input type="text" id="editWebSuffix" value="${escapeHTML(item.webVersionSuffix || '')}">
              </label>
              <label class="form-field">
                <span>Download-Link - Davor (Präfix)</span>
                <input type="text" id="editDlPrefix" value="${escapeHTML(item.dlPrefix || '')}">
              </label>
              <label class="form-field">
                <span>Download-Link - Danach (Suffix)</span>
                <input type="text" id="editDlSuffix" value="${escapeHTML(item.dlSuffix || '')}">
              </label>
            </div>
          </details>
        </div>

        <!-- LIVE-TEST LEISTE -->
        <div class="online-test-bar" id="onlineTestBar" ${currentSourceType === 'none' ? 'hidden' : ''}>
          <div class="test-bar-info">
            <label class="inline-ver-field">
              <span>Erkannte Web-Version:</span>
              <input type="text" id="editWebVersion" value="${escapeHTML(item.webVersion || '')}" placeholder="Noch nicht geprüft" readonly>
            </label>
            <span id="onlineTestFeedback" class="test-feedback"></span>
          </div>
          <button type="button" class="btn btn-ghost" data-edit-action="test-online">🔄 Jetzt testen</button>
        </div>
      </section>

      <!-- TAB 3: PC-ERKENNUNG -->
      <section class="tab-panel" data-panel="local" ${initialTab === 'local' ? '' : 'hidden'}>
        <p class="panel-hint">Damit die App erkennt, ob und in welcher Version dieses Programm auf deinem PC installiert ist.</p>

        <div class="form-field">
          <span>Alternative Such-Namen in Windows "Apps & Features" (kommagetrennt)</span>
          <div class="input-action-row">
            <input type="text" id="editSearchNames" value="${escapeHTML((item.searchNames || []).join(', '))}" placeholder="z. B. VLC media player">
            <div id="installedAppsSlot">
              <button type="button" class="btn btn-ghost" data-edit-action="load-installed-apps">📋 PC-Programme laden</button>
            </div>
          </div>
        </div>

        <div class="form-field">
          <div class="field-header-row">
            <span>Zugeordnete Programm-Pfade (.exe)</span>
            <div class="field-header-btns">
              <button type="button" class="btn btn-primary" data-edit-action="auto-detect-path">✨ Automatisch suchen</button>
              <button type="button" class="btn btn-ghost" data-edit-action="browse-path">📂 Datei wählen...</button>
            </div>
          </div>
          <div id="unifiedPathList" class="path-list"></div>
        </div>

        <div class="install-mode-section">
          <div class="field-header-row">
            <span>⚙️ Installationsmodus & Adware-Schutz</span>
          </div>

          <div id="adwareWarningBox" class="adware-warning-banner" ${currentAdwareWarning.flagged ? '' : 'hidden'}>
            <div class="adware-warning-text">
              <strong class="adware-warning-title">⚠️ Adware-/Bundle-Hinweis</strong>
              <span id="adwareWarningReason">${escapeHTML(currentAdwareWarning.reason || '')}</span>
            </div>
            <button type="button" class="btn btn-ghost btn-xs" data-edit-action="apply-adware-protection" id="btnApplyAdwareProtection" ${currentInstallMode === 'interactive-required' ? 'hidden' : ''}>🛡️ Adware-Schutz aktivieren</button>
          </div>

          <div class="install-mode-switcher" id="installModeSwitcher">
            <button type="button" class="install-mode-opt ${currentInstallMode === 'interactive' ? 'active' : ''}" data-install-mode="interactive">🖱️ Interaktiv</button>
            <button type="button" class="install-mode-opt ${currentInstallMode === 'silent' ? 'active' : ''}" data-install-mode="silent">⚡ Stille Installation</button>
            <button type="button" class="install-mode-opt is-protected ${currentInstallMode === 'interactive-required' ? 'active' : ''}" data-install-mode="interactive-required">🛡️ Immer Interaktiv (Adware-Schutz)</button>
          </div>
          <p class="panel-hint" id="installModeDesc">${escapeHTML(getInstallModeDescription(currentInstallMode))}</p>

          <div id="silentConfigBox" class="silent-config-box ${currentInstallMode === 'interactive-required' ? 'is-ignored' : ''}">
            <div class="silent-setup-meta">
              <span class="muted">${primarySetupFile ? `Setup-Datei: <code>${escapeHTML(getBaseName(primarySetupFile))}</code>` : 'Noch keine Setup-Datei im Archiv – beim Erkennen/Testen kann eine lokale Datei gewählt werden.'}</span>
              <span id="silentIgnoredHint" class="silent-ignored-hint" ${currentInstallMode === 'interactive-required' ? '' : 'hidden'}>🛡️ Im Adware-Schutz-Modus werden Silent-Parameter bei der Ausführung ignoriert.</span>
            </div>

            <div class="form-field">
              <span>Silent-Parameter (z. B. <code>/VERYSILENT /NORESTART /SP-</code>)</span>
              <div class="input-action-row">
                <input type="text" id="editSilentArgs" value="${escapeHTML(item.silentArgs || '')}" placeholder="z. B. /VERYSILENT /NORESTART /SP- oder /qn /norestart">
                <button type="button" class="btn btn-ghost" data-edit-action="detect-installer">🔍 Setup-Typ erkennen</button>
                <button type="button" class="btn btn-ghost" data-edit-action="test-installer">▶️ Testen</button>
              </div>
            </div>

            <div id="installerDetectFeedback" class="installer-detect-feedback" hidden></div>

            <div id="innoInfBox" class="inno-inf-box" ${item.innoInfFile || currentInstallMode === 'silent' ? '' : 'hidden'}>
              <div class="form-field">
                <span>Inno-Setup Antwortdatei (<code>.inf</code> im <code>_metadata/</code>-Ordner)</span>
                <div class="input-action-row">
                  <input type="text" id="editInnoInfFile" value="${escapeHTML(item.innoInfFile || '')}" placeholder="silent.inf">
                  <button type="button" class="btn btn-ghost" data-edit-action="record-inno-inf">📝 Antwortdatei (.inf) aufzeichnen</button>
                </div>
              </div>
              <span id="innoInfStatus" class="muted"></span>
            </div>
          </div>
        </div>
      </section>

      <!-- TAB 4: MEDIEN -->
      <section class="tab-panel" data-panel="media" ${initialTab === 'media' ? '' : 'hidden'}>
        <div class="media-editor-grid">
          <div class="media-card">
            <h4>Programm-Icon</h4>
            <div class="icon-preview-row">
              <div id="editIconPreview" class="icon-preview-box"></div>
              <div class="icon-preview-actions">
                <div class="media-dropzone" data-drop-type="icon">
                  🖼️ Neues Icon hier ablegen
                </div>
                <button type="button" class="btn btn-ghost" data-edit-action="extract-icon">🪄 Aus .exe extrahieren</button>
              </div>
            </div>
          </div>

          <div class="media-card">
            <h4>Screenshots & Videos</h4>
            <div class="media-dropzone" data-drop-type="media">
              📷 Bilder oder Videos hier ablegen, um sie hinzuzufügen
            </div>
            <div id="editMediaGallery" class="edit-media-gallery"></div>
          </div>
        </div>
      </section>
    </div>

    <div class="modal-footer">
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-edit-action="open-meta-dir">📂 _metadata Ordner</button>
      </div>
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-edit-action="cancel">Abbrechen</button>
        <button type="button" class="btn btn-primary" data-edit-action="save">💾 Speichern</button>
      </div>
    </div>
  `;

  overlay.hidden = false;

  // Hilfs-Renderer für Pfadliste & Medien (aktualisieren nur ihren Teilbereich!)
  const renderPathList = () => {
    const listEl = modal.querySelector('#unifiedPathList');
    if (!listEl) return;
    if (draftPaths.length === 0) {
      listEl.innerHTML =
        '<div class="path-empty">Noch kein Pfad hinterlegt. Klicke oben auf <strong>✨ Automatisch suchen</strong> oder wähle eine <code>.exe</code> aus.</div>';
      return;
    }
    listEl.innerHTML = draftPaths
      .map(
        (entry, idx) => `
        <div class="path-row">
          <span class="path-origin-pill is-${entry.origin}">${entry.origin === 'auto' ? 'Auto' : 'Manuell'}</span>
          <code class="path-text" title="${escapeHTML(entry.path)}">${escapeHTML(entry.path)}</code>
          <button type="button" class="icon-btn path-remove-btn" data-remove-path="${idx}" title="Entfernen">✕</button>
        </div>
      `
      )
      .join('');
  };

  const renderMediaSection = () => {
    const freshItem = getCatalogItemById(id) || item;
    const iconBox = modal.querySelector('#editIconPreview');
    const galleryEl = modal.querySelector('#editMediaGallery');
    const bust = Date.now();

    if (iconBox) {
      iconBox.innerHTML = freshItem.icon
        ? `<img src="${escapeHTML(toMediaUrl(freshItem.icon))}&t=${bust}" alt="Icon">`
        : '<span class="muted">Kein Icon</span>';
    }

    if (galleryEl) {
      if (!freshItem.screenshots?.length) {
        galleryEl.innerHTML = '<p class="muted">Noch keine Screenshots oder Videos vorhanden.</p>';
      } else {
        galleryEl.innerHTML = freshItem.screenshots
          .map((s) => {
            const url = `${escapeHTML(toMediaUrl(s))}&t=${bust}`;
            const isVid = /\.(mp4|webm|ogg|mov|avi)$/i.test(s);
            return `
              <div class="edit-media-item">
                ${isVid ? `<video src="${url}#t=1" muted preload="metadata"></video>` : `<img src="${url}" alt="">`}
                <button type="button" class="media-delete-btn" data-delete-media="${escapeHTML(s)}" title="${escapeHTML(getBaseName(s))} löschen">🗑️</button>
              </div>
            `;
          })
          .join('');
      }
    }
  };

  const updateInnoInfStatus = () => {
    const statusEl = modal.querySelector('#innoInfStatus');
    const infInput = modal.querySelector('#editInnoInfFile');
    if (!statusEl || !infInput) return;
    const val = sanitizeInnoInfFileName(infInput.value.trim());
    if (!val) {
      statusEl.textContent = 'Optional: Zeichnet deine Setup-Häkchen einmalig über /SAVEINF auf.';
      return;
    }
    if (infExists && val.toLowerCase() === recordedInfName.toLowerCase()) {
      statusEl.textContent = `✓ Antwortdatei "${val}" im _metadata/-Ordner vorhanden (wird als /LOADINF mitgegeben).`;
    } else {
      statusEl.textContent = `⚠️ Datei "${val}" noch nicht im _metadata/-Ordner aufgezeichnet.`;
    }
  };

  const switchInstallMode = (mode) => {
    currentInstallMode = normalizeInstallMode(mode);
    modal.querySelectorAll('.install-mode-opt').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.installMode === currentInstallMode);
    });
    const descEl = modal.querySelector('#installModeDesc');
    if (descEl) descEl.textContent = getInstallModeDescription(currentInstallMode);

    const configBox = modal.querySelector('#silentConfigBox');
    if (configBox) configBox.classList.toggle('is-ignored', currentInstallMode === 'interactive-required');

    const ignoredHint = modal.querySelector('#silentIgnoredHint');
    if (ignoredHint) ignoredHint.hidden = currentInstallMode !== 'interactive-required';

    const applyAdwareBtn = modal.querySelector('#btnApplyAdwareProtection');
    if (applyAdwareBtn) applyAdwareBtn.hidden = currentInstallMode === 'interactive-required';

    const innoBox = modal.querySelector('#innoInfBox');
    const infVal = modal.querySelector('#editInnoInfFile')?.value.trim();
    if (innoBox) {
      innoBox.hidden = !(detectedInstallerType === 'inno' || Boolean(infVal) || currentInstallMode === 'silent');
    }
  };

  const resolveTargetSetupFile = async () => {
    if (primarySetupFile) return primarySetupFile;
    return window.electronAPI.selectFile([{ name: 'Installer (.exe, .msi)', extensions: ['exe', 'msi'] }], true);
  };

  const refreshAdwareBanner = () => {
    const signal = detectAdwareSignals({
      name: modal.querySelector('#editName')?.value.trim() || item.name,
      fileName: primarySetupFile ? getBaseName(primarySetupFile) : '',
      packageId: modal.querySelector('#editWingetId')?.value.trim() || item.packageId || '',
      publisher: itemPublisher,
    });
    const warnBox = modal.querySelector('#adwareWarningBox');
    const warnReason = modal.querySelector('#adwareWarningReason');
    const applyBtn = modal.querySelector('#btnApplyAdwareProtection');
    if (signal.flagged) {
      if (warnReason) warnReason.textContent = signal.reason;
      if (warnBox) warnBox.hidden = false;
      if (applyBtn) applyBtn.hidden = currentInstallMode === 'interactive-required';
    } else if (warnBox) {
      warnBox.hidden = true;
    }
  };

  modal.querySelector('#editInnoInfFile')?.addEventListener('input', updateInnoInfStatus);
  modal.querySelector('#editName')?.addEventListener('input', refreshAdwareBanner);
  modal.querySelector('#editWingetId')?.addEventListener('input', refreshAdwareBanner);

  renderPathList();
  renderMediaSection();
  updateInnoInfStatus();

  // Tab-Wechsel
  const switchTab = (tabName) => {
    modal.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    modal.querySelectorAll('.tab-panel').forEach((p) => {
      p.hidden = p.dataset.panel !== tabName;
    });
  };

  // Quell-Wechsel in Tab 2
  const switchSource = (src) => {
    currentSourceType = src;
    modal.querySelectorAll('.source-opt').forEach((b) => {
      b.classList.toggle('active', b.dataset.source === src);
    });
    modal.querySelectorAll('.source-panel').forEach((p) => {
      p.hidden = p.dataset.sourcePanel !== src;
    });
    const testBar = modal.querySelector('#onlineTestBar');
    if (testBar) testBar.hidden = src === 'none';
  };

  // Drag & Drop für Icon & Medien im Tab 4
  modal.querySelectorAll('.media-dropzone').forEach((zone) => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dragover');
    });
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dragover');

      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length === 0) return;
      const paths = files.map((f) => window.electronAPI.getFilePath(f)).filter(Boolean);
      if (paths.length === 0) return;

      const dropType = zone.dataset.dropType;
      const res =
        dropType === 'icon'
          ? await window.electronAPI.addIcon(item.path, paths[0])
          : await window.electronAPI.addMedia(item.path, paths);

      if (res.success) {
        await triggerCatalogReload();
        renderMediaSection();
        showToast(dropType === 'icon' ? 'Icon aktualisiert.' : `${paths.length} Datei(en) hinzugefügt.`, {
          type: 'success',
        });
      } else {
        showToast(res.error || 'Fehler beim Hinzufügen.', { type: 'error' });
      }
    });
  });

  // Rich-Text-Selection merken, falls Link eingefügt wird
  let savedSelectionRange = null;

  modal.onchange = (e) => {
    if (e.target.id === 'installedAppsSelect') {
      const val = e.target.value;
      if (!val) return;
      const input = modal.querySelector('#editSearchNames');
      const list = input.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!list.includes(val)) {
        list.push(val);
        input.value = list.join(', ');
      }
      e.target.value = '';
    }
  };

  modal.onclick = async (e) => {
    // Tab Klick
    const tabBtn = e.target.closest('.tab-btn');
    if (tabBtn) {
      switchTab(tabBtn.dataset.tab);
      return;
    }

    // Online-Quelle Klick
    const srcBtn = e.target.closest('.source-opt');
    if (srcBtn) {
      switchSource(srcBtn.dataset.source);
      return;
    }

    // Installationsmodus Klick
    const modeBtn = e.target.closest('[data-install-mode]');
    if (modeBtn) {
      switchInstallMode(modeBtn.dataset.installMode);
      return;
    }

    // Winget-Treffer übernehmen
    const wgPick = e.target.closest('[data-winget-pick]');
    if (wgPick) {
      modal.querySelector('#editWingetId').value = wgPick.dataset.wingetPick;
      if (wgPick.dataset.wingetVer) {
        modal.querySelector('#editWebVersion').value = wgPick.dataset.wingetVer;
      }
      modal.querySelector('#wingetResults').hidden = true;
      refreshAdwareBanner();
      showToast(`Winget-ID "${wgPick.dataset.wingetPick}" übernommen.`, { type: 'success' });
      return;
    }

    // Pfad entfernen
    const rmPath = e.target.closest('[data-remove-path]');
    if (rmPath) {
      draftPaths.splice(parseInt(rmPath.dataset.removePath, 10), 1);
      renderPathList();
      return;
    }

    // Medium löschen
    const delMedia = e.target.closest('[data-delete-media]');
    if (delMedia) {
      const res = await window.electronAPI.deleteMedia(item.path, delMedia.dataset.deleteMedia);
      if (res.success) {
        await triggerCatalogReload();
        renderMediaSection();
        showToast('Datei entfernt.', { type: 'info' });
      } else {
        showToast(res.error || 'Konnte Datei nicht löschen.', { type: 'error' });
      }
      return;
    }

    // Rich-Text-Toolbar
    const cmdBtn = e.target.closest('#descToolbar button');
    if (cmdBtn) {
      e.preventDefault();
      const cmd = cmdBtn.dataset.cmd;
      if (cmd === 'toggleLinkBar') {
        const sel = window.getSelection();
        if (sel?.rangeCount > 0) savedSelectionRange = sel.getRangeAt(0).cloneRange();
        const bar = modal.querySelector('#inlineLinkBar');
        bar.hidden = !bar.hidden;
        if (!bar.hidden) modal.querySelector('#inlineLinkUrl')?.focus();
      } else {
        document.execCommand(cmd, false, null);
      }
      return;
    }

    const actionBtn = e.target.closest('[data-edit-action]');
    if (!actionBtn) return;
    const act = actionBtn.dataset.editAction;

    if (act === 'cancel') {
      openDetailModal(item.id);
      return;
    }

    if (act === 'open-meta-dir') {
      window.electronAPI.openPath(`${item.path}\\_metadata`);
      return;
    }

    if (act === 'apply-link') {
      const url = modal.querySelector('#inlineLinkUrl').value.trim();
      modal.querySelector('#inlineLinkBar').hidden = true;
      if (url) {
        const editor = modal.querySelector('#editDesc');
        editor.focus();
        if (savedSelectionRange) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedSelectionRange);
        }
        document.execCommand('createLink', false, url);
      }
      return;
    }

    if (act === 'cancel-link') {
      modal.querySelector('#inlineLinkBar').hidden = true;
      return;
    }

    // Winget-Suche
    if (act === 'search-winget') {
      const query = modal.querySelector('#wingetQueryInput').value.trim();
      const box = modal.querySelector('#wingetResults');
      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = '⏳ Suche...';

      const res = await window.electronAPI.searchWinget(query);
      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (!res.success) {
        showToast(res.error || 'Winget-Suche fehlgeschlagen.', { type: 'error' });
        return;
      }

      box.hidden = false;
      if (!res.results?.length) {
        box.innerHTML = `<div class="winget-empty">${escapeHTML(res.hint || 'Keine Treffer gefunden.')}</div>`;
      } else {
        box.innerHTML = res.results
          .map(
            (r) => `
            <button type="button" class="winget-row" data-winget-pick="${escapeHTML(r.id)}" data-winget-ver="${escapeHTML(r.version)}">
              <strong>${escapeHTML(r.name)}</strong>
              <code>${escapeHTML(r.id)}</code>
              <span class="muted">${escapeHTML(r.version)}</span>
            </button>
          `
          )
          .join('');
      }
      return;
    }

    // Visueller Versions-Highlighter
    if (act === 'visual-scrape') {
      const url = modal.querySelector('#editWebUrl').value.trim();
      if (!url) return showToast('Bitte zuerst eine Webseite eingeben.', { type: 'warn' });

      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = '⏳ Fenster offen...';
      const res = await window.electronAPI.openVisualScraper(url);
      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (res.success) {
        modal.querySelector('#editWebPrefix').value = res.prefix || '';
        modal.querySelector('#editWebSuffix').value = res.suffix || '';
        modal.querySelector('#editWebVersion').value = res.version || '';
        showToast(`Version v${res.version} erfolgreich markiert!`, { type: 'success' });
      } else if (!res.canceled) {
        showToast(res.error || 'Markierung fehlgeschlagen.', { type: 'error' });
      }
      return;
    }

    // Gefixter Visueller Link-Picker (mit will-download Abfangnetz!)
    if (act === 'visual-link-pick') {
      const dlInput = modal.querySelector('#editDownloadUrl');
      const webInput = modal.querySelector('#editWebUrl');
      const startUrl = dlInput.value.trim() || webInput.value.trim();
      if (!startUrl) {
        return showToast('Bitte zuerst eine Webseite als Start-URL eingeben.', { type: 'warn' });
      }

      const knownVer = modal.querySelector('#editWebVersion').value.trim();
      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = '⏳ Fenster offen...';
      const res = await window.electronAPI.openVisualLinkPicker(startUrl, knownVer);
      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (res.success) {
        dlInput.value = res.url || '';
        modal.querySelector('#editDlPrefix').value = res.prefix || '';
        modal.querySelector('#editDlSuffix').value = res.suffix || '';

        if (res.mode === 'template') {
          showToast('Download-URL erkannt und automatisch als {version}-Vorlage gespeichert!', { type: 'success' });
        } else if (res.mode === 'direct-intercept') {
          showToast('JS-Download sauber abgefangen - direkte URL übernommen!', { type: 'success' });
        } else {
          showToast('Download-Button erfolgreich erkannt!', { type: 'success' });
        }
      } else if (!res.canceled) {
        showToast(res.error || 'Link-Erkennung fehlgeschlagen.', { type: 'error' });
      }
      return;
    }

    // Live-Test Online-Quelle (kein alert, direktes Inline-Feedback!)
    if (act === 'test-online') {
      const fb = modal.querySelector('#onlineTestFeedback');
      const wingetIdVal = modal.querySelector('#editWingetId').value.trim();
      const payload = {
        itemId: item.id,
        sourceType: currentSourceType,
        packageManager: currentSourceType === 'winget' ? 'winget' : '',
        packageId: currentSourceType === 'winget' ? wingetIdVal : '',
        wingetId: wingetIdVal,
        githubAssetPattern: modal.querySelector('#editGithubAssetPattern').value.trim(),
        url:
          currentSourceType === 'github'
            ? modal.querySelector('#editGithubUrl').value.trim()
            : modal.querySelector('#editWebUrl').value.trim(),
        prefix: modal.querySelector('#editWebPrefix').value,
        suffix: modal.querySelector('#editWebSuffix').value,
        persist: false,
      };

      actionBtn.disabled = true;
      fb.className = 'test-feedback';
      fb.textContent = 'Prüfe...';

      const res = await window.electronAPI.checkSingleWeb(payload);
      actionBtn.disabled = false;

      if (res.success) {
        modal.querySelector('#editWebVersion').value = res.version;
        const dlInfo = res.downloadUrl ? ' · Direkt-Download bereit' : '';
        fb.className = 'test-feedback is-ok';
        fb.textContent = `✓ Gefunden: v${res.version}${dlInfo}`;
      } else {
        fb.className = 'test-feedback is-err';
        fb.textContent = `✕ ${res.error || 'Fehlgeschlagen'}`;
      }
      return;
    }

    // PC-Programme für Suchnamen laden
    if (act === 'load-installed-apps') {
      actionBtn.disabled = true;
      actionBtn.textContent = '⏳ Lade...';
      const apps = await window.electronAPI.getInstalledApps();
      const slot = modal.querySelector('#installedAppsSlot');
      if (apps?.length > 0 && slot) {
        slot.innerHTML = `
          <select id="installedAppsSelect" class="apps-select">
            <option value="">+ App-Name übernehmen...</option>
            ${apps.map((a) => `<option value="${escapeHTML(a)}">${escapeHTML(a)}</option>`).join('')}
          </select>
        `;
      } else {
        actionBtn.disabled = false;
        actionBtn.textContent = '📋 PC-Programme laden';
        showToast('Keine installierten Programme gefunden.', { type: 'warn' });
      }
      return;
    }

    // Auto-Detect Pfad
    if (act === 'auto-detect-path') {
      const mainName = modal.querySelector('#editName').value.trim();
      const extras = modal
        .querySelector('#editSearchNames')
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = '⏳ Suche...';
      const res = await window.electronAPI.autoDetectPath([mainName, ...extras]);
      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (res.success && res.path) {
        if (!draftPaths.some((p) => p.path.toLowerCase() === res.path.toLowerCase())) {
          draftPaths.unshift({ path: res.path, origin: 'auto' });
          renderPathList();
        }
        showToast('Installationspfad gefunden!', { type: 'success' });
      } else {
        showToast('Kein Registry-Eintrag gefunden - ggf. Such-Namen ergänzen.', { type: 'warn' });
      }
      return;
    }

    // Manuellen Pfad wählen
    if (act === 'browse-path') {
      const selected = await window.electronAPI.selectFile(
        [{ name: 'Ausführbare Dateien', extensions: ['exe', 'bat', 'cmd', 'ps1'] }],
        true
      );
      if (selected && !draftPaths.some((p) => p.path.toLowerCase() === selected.toLowerCase())) {
        draftPaths.push({ path: selected, origin: 'manual' });
        renderPathList();
      }
      return;
    }

    if (act === 'apply-adware-protection') {
      switchInstallMode('interactive-required');
      showToast('Adware-Schutz („Immer Interaktiv“) aktiviert.', { type: 'success' });
      return;
    }

    // Setup-Typ automatisch erkennen
    if (act === 'detect-installer') {
      const targetFile = await resolveTargetSetupFile();
      if (!targetFile) return;

      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = '⏳ Analysiere...';

      const res = await window.electronAPI.detectInstaller({
        filePath: targetFile,
        name: modal.querySelector('#editName').value.trim() || item.name,
        packageId: modal.querySelector('#editWingetId')?.value.trim() || item.packageId || '',
        publisher: itemPublisher,
      });

      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (!res?.success) {
        showToast(res?.error || 'Setup-Typ konnte nicht erkannt werden.', { type: 'error' });
        return;
      }

      detectedInstallerType = res.type || 'unknown';
      const argsInput = modal.querySelector('#editSilentArgs');
      if (argsInput && res.suggestedArgs) {
        argsInput.value = res.suggestedArgs;
      }

      const fb = modal.querySelector('#installerDetectFeedback');
      if (fb) {
        fb.hidden = false;
        fb.innerHTML = `
          <strong>Erkannter Setup-Typ: ${escapeHTML(res.label)}</strong>
          ${res.matchedSignature ? `<code>${escapeHTML(res.matchedSignature)}</code>` : ''}
          <p class="muted">${escapeHTML(res.hint || '')}</p>
        `;
      }

      if (res.type === 'inno') {
        const innoBox = modal.querySelector('#innoInfBox');
        if (innoBox) innoBox.hidden = false;
      }

      if (res.adwareWarning?.flagged) {
        const warnBox = modal.querySelector('#adwareWarningBox');
        const warnReason = modal.querySelector('#adwareWarningReason');
        const applyBtn = modal.querySelector('#btnApplyAdwareProtection');
        if (warnReason) warnReason.textContent = res.adwareWarning.reason;
        if (warnBox) warnBox.hidden = false;
        if (applyBtn) applyBtn.hidden = currentInstallMode === 'interactive-required';
      }

      if (res.suggestedArgs) {
        showToast(`Typ „${res.label}“ erkannt – Parameter übernommen.`, { type: 'success' });
      } else {
        showToast(`Typ „${res.label}“ erkannt – bitte Parameter manuell prüfen.`, { type: 'info' });
      }
      return;
    }

    // Installer mit aktuellem Modus testen
    if (act === 'test-installer') {
      const argsVal = modal.querySelector('#editSilentArgs')?.value.trim() || '';
      if (currentInstallMode === 'silent' && !argsVal) {
        return showToast('Bitte zuerst Silent-Parameter eingeben oder per „Setup-Typ erkennen“ ermitteln.', {
          type: 'warn',
        });
      }

      const targetFile = await resolveTargetSetupFile();
      if (!targetFile) return;

      const infVal = sanitizeInnoInfFileName(modal.querySelector('#editInnoInfFile')?.value.trim() || '');
      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = '⏳ Läuft...';

      const res = await window.electronAPI.executeInstaller({
        itemId: item.id,
        itemName: modal.querySelector('#editName').value.trim() || item.name,
        sourcePath: targetFile,
        itemPath: item.path,
        allowSilent: currentInstallMode === 'silent',
        installMode: currentInstallMode,
        silentArgs: argsVal,
        innoInfFile: infVal,
      });

      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (res?.alreadyRunning) {
        showToast('Für dieses Programm läuft bereits eine Installation.', { type: 'warn' });
      } else if (res?.canceled) {
        showToast('Testlauf wurde abgebrochen.', { type: 'info' });
      } else if (res?.success) {
        await triggerCatalogReload({ rescanInstalled: true });
        const msg = res.adwareProtected
          ? 'Testlauf im Adware-Schutz (Immer Interaktiv) abgeschlossen – Silent-Parameter wurden ignoriert.'
          : res.effectiveSilent
            ? 'Stiller Testlauf erfolgreich abgeschlossen.'
            : 'Interaktiver Testlauf abgeschlossen.';
        showToast(msg, { type: 'success' });
      } else if (res?.error) {
        showToast(`Testlauf fehlgeschlagen: ${res.error}`, { type: 'error', duration: 6000 });
      }
      return;
    }

    // Inno Setup Antwortdatei (.inf) aufzeichnen
    if (act === 'record-inno-inf') {
      const targetFile = await resolveTargetSetupFile();
      if (!targetFile) return;

      if (!targetFile.toLowerCase().endsWith('.exe')) {
        return showToast('Antwortdateien (.inf) werden nur für Inno-Setup-.exe-Dateien unterstützt.', { type: 'warn' });
      }

      const infInput = modal.querySelector('#editInnoInfFile');
      const desiredName = sanitizeInnoInfFileName(infInput?.value.trim() || '') || 'silent.inf';

      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = '⏳ Aufzeichnung...';

      const res = await window.electronAPI.recordInnoInf({
        itemId: item.id,
        itemName: modal.querySelector('#editName').value.trim() || item.name,
        itemPath: item.path,
        sourcePath: targetFile,
        infFileName: desiredName,
      });

      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (res?.alreadyRunning) {
        showToast('Für dieses Programm läuft bereits eine Installation.', { type: 'warn' });
      } else if (res?.success) {
        if (infInput) infInput.value = res.infFile;
        infExists = true;
        recordedInfName = res.infFile;
        updateInnoInfStatus();
        await triggerCatalogReload();
        showToast(`Antwortdatei „${res.infFile}“ im _metadata/-Ordner gespeichert!`, { type: 'success' });
      } else if (res?.canceled) {
        showToast('Aufzeichnung abgebrochen.', { type: 'info' });
      } else {
        showToast(res?.error || 'Antwortdatei konnte nicht aufgezeichnet werden.', { type: 'error', duration: 6000 });
      }
      return;
    }

    // Icon aus .exe extrahieren
    if (act === 'extract-icon') {
      const exeEntry = draftPaths.find((p) => p.path.toLowerCase().endsWith('.exe'));
      if (!exeEntry) {
        return showToast('Bitte zuerst unter "PC-Erkennung" einen .exe Pfad hinterlegen.', { type: 'warn' });
      }
      actionBtn.disabled = true;
      const res = await window.electronAPI.extractExeIcon(exeEntry.path, item.path);
      actionBtn.disabled = false;
      if (res.success) {
        await triggerCatalogReload();
        renderMediaSection();
        showToast('Icon erfolgreich extrahiert!', { type: 'success' });
      } else {
        showToast(res.error || 'Icon konnte nicht extrahiert werden.', { type: 'error' });
      }
      return;
    }

    // Auto-Fill abrufen (überschreibt nichts automatisch -> zeigt Checkliste!)
    if (act === 'autofill-fetch') {
      const wingetIdVal = modal.querySelector('#editWingetId').value.trim();
      const payload = {
        sourceType: currentSourceType,
        packageManager: currentSourceType === 'winget' ? 'winget' : '',
        packageId: currentSourceType === 'winget' ? wingetIdVal : '',
        wingetId: wingetIdVal,
        url:
          currentSourceType === 'github'
            ? modal.querySelector('#editGithubUrl').value.trim()
            : modal.querySelector('#editWebUrl').value.trim(),
      };

      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = '⏳ Lade Infos...';
      const res = await window.electronAPI.fetchSoftwareMetadata(payload);
      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (!res.success) {
        return showToast(res.error || 'Konnte keine Details laden.', { type: 'warn', duration: 5000 });
      }

      const m = res.metadata;
      const box = modal.querySelector('#autofillPreviewBox');
      const hasDesc = Boolean(modal.querySelector('#editDesc').textContent.trim());
      const hasTags = Boolean(modal.querySelector('#editTags').value.trim());
      const hasLinks = Boolean(modal.querySelector('#editLinks').value.trim());

      const rows = [];
      if (m.description) {
        rows.push(`
      <label class="autofill-row">
        <input type="checkbox" data-af-field="description" ${hasDesc ? '' : 'checked'}>
        <div>
          <strong>Beschreibung</strong> ${hasDesc ? '<span class="muted">(vorhanden - überschreiben?)</span>' : '<span class="text-ok">(leer)</span>'}
          <p class="autofill-snippet">${escapeHTML(m.description)}</p>
        </div>
      </label>
    `);
      }
      if (m.tags?.length) {
        rows.push(`
      <label class="autofill-row">
        <input type="checkbox" data-af-field="tags" ${hasTags ? '' : 'checked'}>
        <div>
          <strong>Tags ergänzen</strong>
          <p class="autofill-snippet">${escapeHTML(m.tags.join(', '))}</p>
        </div>
      </label>
    `);
      }
      if (m.links && Object.keys(m.links).length > 0) {
        const linkSummary = Object.entries(m.links)
          .map(([k, v]) => `${k} | ${v}`)
          .join(' · ');
        rows.push(`
      <label class="autofill-row">
        <input type="checkbox" data-af-field="links" ${hasLinks ? '' : 'checked'}>
        <div>
          <strong>Links ergänzen</strong>
          <p class="autofill-snippet">${escapeHTML(linkSummary)}</p>
        </div>
      </label>
    `);
      }

      if (rows.length === 0) {
        return showToast(`Quelle "${res.sourceLabel}" liefert keine zusätzlichen Details.`, { type: 'info' });
      }

      box.dataset.payload = JSON.stringify(m);
      box.hidden = false;
      box.innerHTML = `
    <div class="autofill-head">
      <strong>Gefundene Details (${escapeHTML(res.sourceLabel)})</strong>
      <div class="footer-group">
        <button type="button" class="btn btn-primary btn-xs" data-edit-action="autofill-apply">Ausgewählte übernehmen</button>
        <button type="button" class="btn btn-ghost btn-xs" data-edit-action="autofill-close">Schließen</button>
      </div>
    </div>
    <div class="autofill-list">${rows.join('')}</div>
  `;
      return;
    }

    if (act === 'autofill-close') {
      const box = modal.querySelector('#autofillPreviewBox');
      if (box) box.hidden = true;
      return;
    }

    if (act === 'autofill-apply') {
      const box = modal.querySelector('#autofillPreviewBox');
      if (!box?.dataset.payload) return;
      const m = JSON.parse(box.dataset.payload);
      let applied = 0;

      if (box.querySelector('[data-af-field="description"]')?.checked && m.description) {
        modal.querySelector('#editDesc').textContent = m.description;
        applied++;
      }

      if (box.querySelector('[data-af-field="tags"]')?.checked && m.tags?.length) {
        const tagsInput = modal.querySelector('#editTags');
        const existing = tagsInput.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const merged = [...existing];
        for (const t of m.tags) {
          if (!merged.some((e) => e.toLowerCase() === t.toLowerCase())) merged.push(t);
        }
        tagsInput.value = merged.join(', ');
        applied++;
      }

      if (box.querySelector('[data-af-field="links"]')?.checked && m.links) {
        const linksEl = modal.querySelector('#editLinks');
        const currentLines = linksEl.value
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        for (const [label, url] of Object.entries(m.links)) {
          if (!currentLines.some((l) => l.includes(url))) {
            currentLines.push(`${label} | ${url}`);
          }
        }
        linksEl.value = currentLines.join('\n');
        applied++;
      }

      box.hidden = true;
      showToast(applied > 0 ? `${applied} Bereich(e) übernommen.` : 'Nichts ausgewählt.', {
        type: applied > 0 ? 'success' : 'info',
      });
      return;
    }

    // SPEICHERN
    if (act === 'save') {
      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = '⏳ Speichere...';

      const linksObj = {};
      for (const line of modal.querySelector('#editLinks').value.split('\n')) {
        const parts = line.split('|');
        if (parts.length >= 2) {
          const label = parts[0].trim();
          const url = parts.slice(1).join('|').trim();
          if (label && url) linksObj[label] = url;
        }
      }

      const webUrl =
        currentSourceType === 'github'
          ? modal.querySelector('#editGithubUrl').value.trim()
          : currentSourceType === 'web'
            ? modal.querySelector('#editWebUrl').value.trim()
            : '';

      const savedWingetId = currentSourceType === 'winget' ? modal.querySelector('#editWingetId').value.trim() : '';
      const hasNonWingetPkg = Boolean(item.packageManager && item.packageManager !== 'winget' && item.packageId);
      const nextPackageManager =
        currentSourceType === 'winget' && savedWingetId ? 'winget' : hasNonWingetPkg ? item.packageManager : '';
      const nextPackageId =
        currentSourceType === 'winget' && savedWingetId ? savedWingetId : hasNonWingetPkg ? item.packageId : '';

      const payload = {
        name: modal.querySelector('#editName').value.trim() || item.name,
        softwareType: modal.querySelector('#editSoftwareType').value,
        category: modal.querySelector('#editCat').value.trim(),
        hiddenCategory: modal.querySelector('#editHidden').value.trim(),
        tags: modal
          .querySelector('#editTags')
          .value.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        formats: modal
          .querySelector('#editFormats')
          .value.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        os: modal
          .querySelector('#editOS')
          .value.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        keepAllVersions: Boolean(modal.querySelector('#editKeepAllVersions')?.checked),
        description: sanitizeRichHtml(modal.querySelector('#editDesc').innerHTML.trim()),
        searchNames: modal
          .querySelector('#editSearchNames')
          .value.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        autoPaths: draftPaths.filter((p) => p.origin === 'auto').map((p) => p.path),
        installPaths: draftPaths.filter((p) => p.origin === 'manual').map((p) => p.path),
        installMode: currentInstallMode,
        silentArgs: sanitizeSilentArgs(modal.querySelector('#editSilentArgs')?.value || ''),
        innoInfFile: sanitizeInnoInfFileName(modal.querySelector('#editInnoInfFile')?.value.trim() || ''),
        webSourceType: currentSourceType,
        packageManager: nextPackageManager,
        packageId: nextPackageId,
        wingetId: savedWingetId,
        githubAssetPattern:
          currentSourceType === 'github' ? modal.querySelector('#editGithubAssetPattern').value.trim() : '',
        webVersionUrl: webUrl,
        webVersionPrefix: currentSourceType === 'web' ? modal.querySelector('#editWebPrefix').value : '',
        webVersionSuffix: currentSourceType === 'web' ? modal.querySelector('#editWebSuffix').value : '',
        downloadUrl: currentSourceType === 'web' ? modal.querySelector('#editDownloadUrl').value.trim() : '',
        dlPrefix: currentSourceType === 'web' ? modal.querySelector('#editDlPrefix').value : '',
        dlSuffix: currentSourceType === 'web' ? modal.querySelector('#editDlSuffix').value : '',
        webVersion: currentSourceType === 'none' ? '' : modal.querySelector('#editWebVersion').value.trim(),
        links: linksObj,
      };

      const res = await window.electronAPI.saveMetaJson(item.path, payload);
      if (res.success) {
        await window.electronAPI.scanLocalVersions({ itemIds: [item.id], silent: true });
        await triggerCatalogReload();
        showToast('Änderungen gespeichert.', { type: 'success' });
        openDetailModal(item.id);
      } else {
        actionBtn.disabled = false;
        actionBtn.textContent = orig;
        showToast(`Fehler beim Speichern: ${res.error}`, { type: 'error', duration: 6000 });
      }
    }
  };
}
