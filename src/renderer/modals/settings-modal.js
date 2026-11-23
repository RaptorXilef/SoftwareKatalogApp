import { buildArchiveFilename } from '../../shared/version.js';
import { showToast } from '../components/toast.js';
import { state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';

export async function renderSettingsModal() {
  state.currentModalId = null;
  state.isEditModalOpen = false;

  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();

  const [s, info, providersInfo, cacheStats] = await Promise.all([
    window.electronAPI.getSettings(),
    window.electronAPI.getAppInfo(),
    window.electronAPI.listProviders(),
    window.electronAPI.getProviderCacheStats(),
  ]);

  const providers = Array.isArray(providersInfo?.providers) ? providersInfo.providers : [];
  const plannedProviders = Array.isArray(providersInfo?.planned) ? providersInfo.planned : [];
  const enabledSet = new Set(
    (Array.isArray(s.enabledProviders) ? s.enabledProviders : ['winget', 'archive']).map((p) => p.toLowerCase())
  );
  const saveMode = s.archiveSaveMode || 'ask';
  const totalCacheEntries = Number(cacheStats?.totalEntries) || 0;
  const expiredCacheEntries = Number(cacheStats?.expiredEntries) || 0;

  const providerCheckboxes = providers
    .map((p) => {
      const checked = enabledSet.has(p.id) ? 'checked' : '';
      return `
        <label class="provider-setting-row">
          <input type="checkbox" name="enabledProviderCheck" value="${escapeHTML(p.id)}" ${checked}>
          <div class="provider-setting-info">
            <strong>${escapeHTML(p.name)}</strong>
            ${p.description ? `<span class="muted">${escapeHTML(p.description)}</span>` : ''}
          </div>
        </label>
      `;
    })
    .join('');

  const plannedHintText =
    plannedProviders.length > 0
      ? `Künftig erweiterbar um weitere Quellen wie ${plannedProviders
          .slice(0, 5)
          .map((p) => p.name)
          .join(', ')} u. a.`
      : '';

  const hiddenCheckboxes =
    state.availableHiddenCats.length === 0
      ? '<span class="muted">Keine versteckten Kategorien im Katalog vorhanden.</span>'
      : state.availableHiddenCats
          .map((cat) => {
            const checked = s.visibleHiddenCats?.includes(cat) ? 'checked' : '';
            return `<label class="check-row"><input type="checkbox" name="hiddenCatCheck" value="${escapeHTML(cat)}" ${checked}><span>${escapeHTML(cat)}</span></label>`;
          })
          .join('');

  modal.innerHTML = `
    <div class="modal-header">
      <h2>Einstellungen</h2>
      <button type="button" class="icon-btn" data-settings-action="close" title="Schließen" aria-label="Schließen">✕</button>
    </div>

    <div class="modal-body settings-body">
      <!-- 1. Paketmanager & Quellen -->
      <section class="settings-section">
        <h3>📦 Paketmanager & Quellen</h3>
        <div class="form-field">
          <span>Aktivierte Quellen</span>
          <div class="provider-settings-list">${providerCheckboxes}</div>
          ${plannedHintText ? `<p class="planned-providers-hint">${escapeHTML(plannedHintText)}</p>` : ''}
        </div>

        <label class="form-field">
          <span>Archiv-Speichermodus bei Erstinstallation/Update</span>
          <select id="cfgArchiveSaveMode">
            <option value="ask" ${saveMode === 'ask' ? 'selected' : ''}>Nachfragen (Standard)</option>
            <option value="auto-id" ${saveMode === 'auto-id' ? 'selected' : ''}>Automatisch im Archiv speichern (Ordnername = Paket-ID, Anzeigename = Softwarename)</option>
            <option value="none" ${saveMode === 'none' ? 'selected' : ''}>Nicht automatisch im Archiv speichern</option>
          </select>
        </label>

        <div class="cache-status-bar">
          <div class="cache-status-text">
            <strong>Provider-Offline-Cache (7 Tage)</strong>
            <span id="providerCacheCount" class="muted">
              ${totalCacheEntries} ${totalCacheEntries === 1 ? 'Eintrag' : 'Einträge'} gespeichert${expiredCacheEntries > 0 ? ` (${expiredCacheEntries} abgelaufen, offline verfügbar)` : ''}
            </span>
          </div>
          <button type="button" class="btn btn-ghost btn-xs" id="btnClearProviderCache" data-settings-action="clear-provider-cache" ${totalCacheEntries === 0 ? 'disabled' : ''}>
            🧹 Cache leeren
          </button>
        </div>
      </section>

      <!-- 2. Downloads & Dateibenennung -->
      <section class="settings-section">
        <h3>⬇️ Downloads & Dateibenennung</h3>
        <label class="check-row">
          <input type="checkbox" id="cfgAutoSave" ${s.autoSaveDownloads !== false && !s.askSaveDialog ? 'checked' : ''}>
          <span>Updates automatisch im Software-Ordner speichern (ohne "Speichern unter"-Dialog)</span>
        </label>
        <label class="check-row">
          <input type="checkbox" id="cfgKeepOriginal" ${s.keepOriginalNameIfVersioned !== false ? 'checked' : ''}>
          <span>Original-Dateinamen behalten, falls die Versionsnummer bereits enthalten ist</span>
        </label>
        <div class="form-grid-2">
          <label class="form-field">
            <span>Benennungs-Schema (bei fehlender Version)</span>
            <input type="text" id="cfgFilenamePattern" value="${escapeHTML(s.filenamePattern || '{Name}_v{Version}{Arch}{Ext}')}">
          </label>
          <div class="form-field">
            <span>Live-Vorschau (für "setup-x64.exe")</span>
            <div id="filenamePreview" class="filename-preview"></div>
          </div>
        </div>
        <p class="panel-hint">Platzhalter: <code>{Name}</code>, <code>{Version}</code>, <code>{Arch}</code>, <code>{Ext}</code></p>
      </section>

      <!-- 2. Archiv & Scanner -->
      <section class="settings-section">
        <h3>📂 Archiv & Scanner</h3>
        <div class="form-field">
          <span>Software-Verzeichnis (Archiv / Lokal)</span>
          <div class="input-action-row">
            <input type="text" id="cfgTarget" value="${escapeHTML(s.targetPath || '../software')}" readonly>
            <button type="button" class="btn btn-ghost" data-settings-action="browse-target">Ordner wählen</button>
          </div>
        </div>

        <div class="form-grid-2">
          <label class="form-field">
            <span>Setup-Dateiendungen (Priorität von links nach rechts)</span>
            <input type="text" id="cfgAutoExt" value="${escapeHTML((s.autoExtensions || ['.exe', '.msi', '.zip']).join(', '))}">
          </label>
          <label class="form-field">
            <span>Maximale Verschachtelungstiefe</span>
            <input type="number" id="cfgNestedDepth" value="${s.nestedDepth || 1}" min="1" max="5">
          </label>
        </div>

        <label class="check-row">
          <input type="checkbox" id="cfgScanNested" ${s.scanNested ? 'checked' : ''}>
          <span>Nach Fund eines <code>_metadata</code>-Ordners auch tiefere Unterordner durchsuchen</span>
        </label>
      </section>

      <!-- 3. Darstellung & Filter -->
      <section class="settings-section">
        <h3>🎨 Darstellung & Versionsvergleich</h3>
        <div class="form-grid-2">
          <label class="form-field">
            <span>"NEU"-Hinweis anzeigen für (Tage, 0 = aus)</span>
            <input type="number" id="cfgNewBadgeDays" value="${s.newBadgeDays ?? 14}" min="0" max="365">
          </label>
          <label class="form-field">
            <span>Versionsvergleich-Genauigkeit (Stellen, z. B. 3 = X.X.X)</span>
            <input type="number" id="cfgVersionDepth" value="${s.versionCompareDepth ?? 3}" min="1" max="10">
          </label>
        </div>
        <div class="form-field">
          <span>Versteckte Kategorien einblenden</span>
          <div class="hidden-cats-wrap">${hiddenCheckboxes}</div>
        </div>
      </section>

      <!-- 4. App-Updates & Info -->
      <section class="settings-section">
        <h3>🚀 App-Updates & Über</h3>
        <div class="form-grid-2">
          <label class="form-field">
            <span>Automatisch nach App-Updates suchen</span>
            <select id="cfgUpdateInterval">
              <option value="0" ${s.updateInterval === 0 ? 'selected' : ''}>Bei jedem Start</option>
              <option value="24" ${s.updateInterval === 24 ? 'selected' : ''}>Täglich (24h)</option>
              <option value="168" ${s.updateInterval === 168 ? 'selected' : ''}>Wöchentlich</option>
              <option value="720" ${s.updateInterval === 720 ? 'selected' : ''}>Monatlich</option>
              <option value="-1" ${s.updateInterval === -1 ? 'selected' : ''}>Nie</option>
            </select>
          </label>
          <div class="form-field">
            <span>Installierte App-Version</span>
            <div class="app-update-box">
              <strong>v${escapeHTML(info.version)}</strong>
              <span id="appUpdateStatus" class="muted">Prüfe...</span>
            </div>
          </div>
        </div>
        <div class="inline-btn-group">
          <button type="button" class="btn btn-ghost" data-settings-action="open-github">GitHub Repository</button>
          <button type="button" class="btn btn-ghost" data-settings-action="open-data-dir">📁 Datenordner (data/)</button>
          <button type="button" class="btn btn-ghost" data-settings-action="open-state">📁 Lokaler State (Favoriten)</button>
        </div>
      </section>

      <!-- 5. Wartung & Backup (eingeklappt) -->
      <details class="advanced-box">
        <summary>🛠️ Wartung, Backup & Zurücksetzen</summary>
        <div class="inline-btn-group">
          <button type="button" class="btn btn-primary" data-settings-action="backup-create">💾 Backup erstellen</button>
          <button type="button" class="btn btn-ghost" data-settings-action="backup-restore">📂 Backup wiederherstellen</button>
        </div>
        <hr class="menu-divider">
        <p class="panel-hint">Sicherheitsabfrage: Zum Ausführen der folgenden Aktionen bitte zweimal klicken.</p>
        <div class="inline-btn-group">
          <button type="button" class="btn btn-danger" data-danger-action="reset-auto-paths">Auto-Pfade zurücksetzen</button>
          <button type="button" class="btn btn-danger" data-danger-action="reset-manual-paths">Manuelle Pfade zurücksetzen</button>
          <button type="button" class="btn btn-danger" data-danger-action="reset-local-ver">PC-Versionen zurücksetzen</button>
        </div>
      </details>
    </div>

    <div class="modal-footer">
      <span class="muted">Software Katalog by © Felix Maywald</span>
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-settings-action="close">Abbrechen</button>
        <button type="button" class="btn btn-primary" data-settings-action="save">💾 Speichern & Anwenden</button>
      </div>
    </div>
  `;

  overlay.hidden = false;

  // Live-Vorschau für Dateinamen-Schema
  const updatePreview = () => {
    const pattern = modal.querySelector('#cfgFilenamePattern')?.value || '{Name}_v{Version}{Arch}{Ext}';
    const preview = buildArchiveFilename({
      softwareName: 'VLC Media Player',
      version: '3.0.21',
      originalFilename: 'setup-x64.exe',
      pattern,
      keepIfVersionPresent: false,
    });
    const el = modal.querySelector('#filenamePreview');
    if (el) el.textContent = preview;
  };
  updatePreview();
  modal.querySelector('#cfgFilenamePattern')?.addEventListener('input', updatePreview);

  // App-Update Status live laden
  window.electronAPI.checkAppUpdate().then((res) => {
    const box = modal.querySelector('#appUpdateStatus');
    if (!box) return;
    if (res.error) {
      box.textContent = 'Prüfung fehlgeschlagen';
    } else if (res.updateAvailable && res.updateAssetUrl) {
      box.innerHTML = `<button type="button" class="btn btn-local btn-xs" data-install-app-url="${escapeHTML(res.updateAssetUrl)}" data-portable="${res.isPortable}">⬆️ Auf v${escapeHTML(res.latestVersion)} updaten</button>`;
    } else if (res.updateAvailable) {
      box.innerHTML = `<button type="button" class="btn btn-local btn-xs" data-open-release="${escapeHTML(res.releaseUrl)}">🎁 v${escapeHTML(res.latestVersion)} auf GitHub</button>`;
    } else {
      box.innerHTML = '<span class="text-ok">✓ Aktuell</span>';
    }
  });

  modal.onclick = async (e) => {
    const installAppBtn = e.target.closest('[data-install-app-url]');
    if (installAppBtn) {
      installAppBtn.disabled = true;
      closeModal();
      showToast('App-Update wird im Hintergrund geladen...', { type: 'info' });
      const res = await window.electronAPI.installAppUpdate(
        installAppBtn.dataset.installAppUrl,
        installAppBtn.dataset.portable === 'true'
      );
      if (!res.success && !res.canceled) {
        showToast(`App-Update fehlgeschlagen: ${res.error}`, { type: 'error', duration: 6000 });
      }
      return;
    }

    const releaseBtn = e.target.closest('[data-open-release]');
    if (releaseBtn) {
      window.electronAPI.openUrl(releaseBtn.dataset.openRelease);
      return;
    }

    // Zwei-Klick-Bestätigung für destruktive Wartungsaktionen (kein confirm()!)
    const dangerBtn = e.target.closest('[data-danger-action]');
    if (dangerBtn) {
      if (dangerBtn.dataset.armed !== 'true') {
        dangerBtn.dataset.armed = 'true';
        dangerBtn.dataset.origText = dangerBtn.textContent;
        dangerBtn.textContent = '⚠️ Wirklich ausführen?';
        setTimeout(() => {
          if (dangerBtn.dataset.armed === 'true') {
            dangerBtn.dataset.armed = 'false';
            dangerBtn.textContent = dangerBtn.dataset.origText;
          }
        }, 4000);
        return;
      }

      dangerBtn.dataset.armed = 'false';
      dangerBtn.disabled = true;
      const dAct = dangerBtn.dataset.dangerAction;

      if (dAct === 'reset-auto-paths' || dAct === 'reset-manual-paths') {
        const res = await window.electronAPI.resetPaths(dAct === 'reset-auto-paths' ? 'auto' : 'manual');
        if (res.success) {
          await triggerCatalogReload();
          showToast(`${res.count} Programme bereinigt.`, { type: 'success' });
        }
      } else if (dAct === 'reset-local-ver') {
        await window.electronAPI.resetLocalVersions();
        await triggerCatalogReload();
        showToast('Lokale PC-Versionen zurückgesetzt.', { type: 'success' });
      }

      dangerBtn.disabled = false;
      dangerBtn.textContent = dangerBtn.dataset.origText;
      return;
    }

    const btn = e.target.closest('[data-settings-action]');
    if (!btn) return;
    const act = btn.dataset.settingsAction;

    if (act === 'close') closeModal();
    else if (act === 'open-github') window.electronAPI.openUrl('https://github.com/RaptorXilef/SoftwareKatalogApp');
    else if (act === 'open-data-dir') window.electronAPI.openPath(s.dataDir);
    else if (act === 'open-state') window.electronAPI.openPath(s.statePath);
    else if (act === 'browse-target') {
      const dir = await window.electronAPI.selectDir();
      if (dir) modal.querySelector('#cfgTarget').value = dir;
    } else if (act === 'clear-provider-cache') {
      btn.disabled = true;
      const res = await window.electronAPI.clearProviderCache();
      if (res?.success) {
        const countEl = modal.querySelector('#providerCacheCount');
        if (countEl) countEl.textContent = '0 Einträge gespeichert';
        showToast('Provider-Cache wurde geleert.', { type: 'success' });
      } else {
        btn.disabled = false;
        showToast('Cache konnte nicht geleert werden.', { type: 'error' });
      }
    } else if (act === 'backup-create') {
      const res = await window.electronAPI.createBackup();
      if (res.success) showToast('Backup erfolgreich gespeichert.', { type: 'success' });
      else if (res.error) showToast(res.error, { type: 'error' });
    } else if (act === 'backup-restore') {
      const res = await window.electronAPI.restoreBackup();
      if (res.success) {
        closeModal();
        await triggerCatalogReload();
        showToast('Backup wiederhergestellt.', { type: 'success' });
      } else if (res.error) {
        showToast(res.error, { type: 'error' });
      }
    } else if (act === 'save') {
      const checkedCats = Array.from(modal.querySelectorAll('input[name="hiddenCatCheck"]:checked')).map(
        (cb) => cb.value
      );
      const checkedProviders = Array.from(modal.querySelectorAll('input[name="enabledProviderCheck"]:checked')).map(
        (cb) => cb.value
      );
      const autoSave = modal.querySelector('#cfgAutoSave').checked;
      const newSettings = {
        enabledProviders: checkedProviders,
        archiveSaveMode: modal.querySelector('#cfgArchiveSaveMode')?.value || 'ask',
        targetPath: modal.querySelector('#cfgTarget').value,
        scanNested: modal.querySelector('#cfgScanNested').checked,
        nestedDepth: parseInt(modal.querySelector('#cfgNestedDepth').value, 10) || 1,
        visibleHiddenCats: checkedCats,
        updateInterval: parseInt(modal.querySelector('#cfgUpdateInterval').value, 10),
        autoExtensions: modal
          .querySelector('#cfgAutoExt')
          .value.split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => (x.startsWith('.') ? x : `.${x}`)),
        newBadgeDays: parseInt(modal.querySelector('#cfgNewBadgeDays').value, 10) || 0,
        versionCompareDepth: parseInt(modal.querySelector('#cfgVersionDepth').value, 10) || 3,
        autoSaveDownloads: autoSave,
        askSaveDialog: !autoSave,
        keepOriginalNameIfVersioned: modal.querySelector('#cfgKeepOriginal').checked,
        filenamePattern: modal.querySelector('#cfgFilenamePattern').value.trim() || '{Name}_v{Version}{Arch}{Ext}',
      };

      const needsRescan =
        s.targetPath !== newSettings.targetPath ||
        (s.autoExtensions || []).join(',') !== newSettings.autoExtensions.join(',');

      const res = await window.electronAPI.saveSettings(newSettings);
      if (res.success) {
        closeModal();
        if (needsRescan) {
          showToast('Einstellungen gespeichert - aktualisiere Archiv...', { type: 'info' });
          await window.electronAPI.runScan('smart');
        } else {
          showToast('Einstellungen gespeichert.', { type: 'success' });
        }
        await triggerCatalogReload();
      } else {
        showToast(`Speicherfehler: ${res.error}`, { type: 'error' });
      }
    }
  };
}
