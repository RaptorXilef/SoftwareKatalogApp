import { getArchiveRootLabel, normalizeArchivePaths, normalizePathKey } from '../../shared/multi-archive-logic.js';
import { formatProviderStatusBadge, groupProvidersByUiCategory } from '../../shared/provider-lifecycle-logic.js';
import { normalizeStartTab } from '../../shared/unified-packages.js';
import { buildArchiveFilename } from '../../shared/version.js';
import { showToast } from '../components/toast.js';
import { state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openNestedDialog } from './archive-target-modal.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';
import { openProviderSourcesModal } from './provider-sources-modal.js';

let activeSettingsToken = 0;

function getInputEl(root, selector) {
  const el = root.querySelector(selector);
  return el instanceof HTMLInputElement ? el : null;
}

function getSelectEl(root, selector) {
  const el = root.querySelector(selector);
  return el instanceof HTMLSelectElement ? el : null;
}

function renderArchiveRootsListHtml(archiveItems) {
  if (!Array.isArray(archiveItems) || archiveItems.length === 0) {
    return '<div class="path-empty">Keine Archiv-Pfade konfiguriert.</div>';
  }

  const canDelete = archiveItems.length > 1;
  return archiveItems
    .map((entry, idx) => {
      const rankLabel = idx === 0 ? '#1 Primär' : `#${idx + 1}`;
      const statusCls = entry.online ? 'is-online' : 'is-offline';
      const statusText = entry.online ? '🟢 Online' : '🔴 Offline';
      const absHint = entry.absPath && entry.absPath !== entry.rawPath ? ` (${entry.absPath})` : '';

      return `
        <div class="archive-path-row" data-archive-idx="${idx}" draggable="${archiveItems.length > 1 ? 'true' : 'false'}">
          <span class="archive-drag-handle" title="Per Drag & Drop verschieben" aria-hidden="true">⋮⋮</span>
          <span class="archive-rank-pill ${idx === 0 ? 'is-primary' : ''}">${escapeHTML(rankLabel)}</span>
          <span class="archive-status-pill ${statusCls}" title="${entry.online ? 'Verzeichnis erreichbar' : 'Verzeichnis aktuell nicht erreichbar'}">${statusText}</span>
          <span class="archive-path-text" title="${escapeHTML(`${entry.rawPath}${absHint}`)}">
            <strong class="archive-path-name">${escapeHTML(entry.label || getArchiveRootLabel(entry.rawPath, idx))}</strong>
            <code class="archive-path-raw">${escapeHTML(entry.rawPath)}</code>
          </span>
          <div class="archive-path-actions">
            <button type="button" class="btn btn-ghost btn-xs" data-archive-move="up" data-archive-idx="${idx}" ${idx === 0 ? 'disabled' : ''} title="Priorität erhöhen">↑</button>
            <button type="button" class="btn btn-ghost btn-xs" data-archive-move="down" data-archive-idx="${idx}" ${idx === archiveItems.length - 1 ? 'disabled' : ''} title="Priorität verringern">↓</button>
            <button type="button" class="btn btn-ghost btn-xs" data-archive-remove="${idx}" ${canDelete ? '' : 'disabled'} title="${canDelete ? 'Archiv-Pfad entfernen' : 'Mindestens ein Archiv-Pfad ist erforderlich'}">🗑️</button>
          </div>
        </div>
      `;
    })
    .join('');
}

export async function renderSettingsModal() {
  state.currentModalId = null;
  state.isEditModalOpen = false;

  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();
  const modalToken = ++activeSettingsToken;

  const [s, info, providersInfo, cacheStats] = await Promise.all([
    window.electronAPI.getSettings(),
    window.electronAPI.getAppInfo(),
    window.electronAPI.listProviders(),
    window.electronAPI.getProviderCacheStats(),
  ]);

  if (modalToken !== activeSettingsToken) return;

  let providers = Array.isArray(providersInfo?.providers) ? providersInfo.providers : [];
  const plannedProviders = Array.isArray(providersInfo?.planned) ? providersInfo.planned : [];
  const enabledSet = new Set(
    (Array.isArray(s.enabledProviders) ? s.enabledProviders : ['winget', 'archive']).map((p) => p.toLowerCase())
  );
  const availabilityById = new Map();
  for (const p of providers) {
    if (p.availability) availabilityById.set(p.id, p.availability);
  }
  const busyProviderIds = new Set();
  let vcpkgRootDraft = String(s.providerSettings?.vcpkgRoot || '').trim();
  const saveMode = s.archiveSaveMode || 'ask';
  const startTab = normalizeStartTab(s.startTab);
  const totalCacheEntries = Number(cacheStats?.totalEntries) || 0;
  const expiredCacheEntries = Number(cacheStats?.expiredEntries) || 0;

  const initialArchivePaths = normalizeArchivePaths(s);
  const initialStatusMap = new Map(
    (Array.isArray(s.archiveRootsStatus) ? s.archiveRootsStatus : []).map((st) => [st.rawPath, st])
  );
  /** @type {Array<{ rawPath: string, absPath: string, label: string, online: boolean }>} */
  const archiveItems = initialArchivePaths.map((rawPath, idx) => {
    const st = initialStatusMap.get(rawPath);
    return {
      rawPath,
      absPath: st?.absPath || rawPath,
      label: st?.label || getArchiveRootLabel(rawPath, idx),
      online: Boolean(st?.online),
    };
  });

  const renderProvidersHtml = () => {
    const groups = groupProvidersByUiCategory(providers);
    if (groups.length === 0) {
      return '<div class="path-empty">Keine Paketmanager registriert.</div>';
    }

    return groups
      .map((group) => {
        const rowsHtml = group.providers
          .map((p) => {
            const checked = enabledSet.has(p.id) ? 'checked' : '';
            const avail = availabilityById.get(p.id) || p.availability || null;
            const badge = formatProviderStatusBadge(p, avail);
            const isBusy = busyProviderIds.has(p.id);
            const showAdminPill = Boolean(
              avail && !avail.available && p.canInstallManager && p.requiresAdminForBootstrap
            );

            const actionBtns = [];
            const isConfigSourceMgr = ['npm', 'bun', 'pnpm', 'pip', 'uv'].includes(p.id);
            if (p.capabilities?.manageSources) {
              const sourcesDisabled = isBusy || (!isConfigSourceMgr && Boolean(avail && !avail.available));
              actionBtns.push(
                `<button type="button" class="btn btn-ghost btn-xs" data-provider-sources="${escapeHTML(p.id)}" ${sourcesDisabled ? 'disabled' : ''} title="Bezugsquellen verwalten">🌐 Quellen verwalten</button>`
              );
            }
            if (isBusy) {
              actionBtns.push('<button type="button" class="btn btn-ghost btn-xs" disabled>⏳ Läuft...</button>');
            } else if (avail && !avail.available && p.canInstallManager) {
              actionBtns.push(
                `<button type="button" class="btn btn-primary btn-xs" data-provider-install="${escapeHTML(p.id)}" title="Paketmanager direkt installieren">⬇️ Installieren</button>`
              );
            } else if (avail?.available && p.canUninstallManager) {
              actionBtns.push(
                `<button type="button" class="btn btn-danger btn-xs" data-provider-uninstall="${escapeHTML(p.id)}" title="Paketmanager deinstallieren (2x klicken)">🗑️ Deinstallieren</button>`
              );
            }
            const actionHtml = actionBtns.join('');

            const extraSettingHtml =
              p.id === 'vcpkg'
                ? `
                  <div class="provider-extra-setting">
                    <span class="provider-extra-label"><code>VCPKG_ROOT</code> Ordner:</span>
                    <div class="provider-extra-input-row">
                      <input type="text" id="cfgVcpkgRoot" data-vcpkg-root-input value="${escapeHTML(vcpkgRootDraft)}" placeholder="Pfad zum vcpkg-Ordner (leer = %VCPKG_ROOT% / PATH)">
                      <button type="button" class="btn btn-ghost btn-xs" data-settings-action="browse-vcpkg-root">📂 Ordner...</button>
                    </div>
                  </div>
                `
                : '';

            return `
              <div class="provider-setting-row ${checked ? '' : 'is-disabled'}" data-provider-row="${escapeHTML(p.id)}">
                <label class="provider-toggle-switch" title="${checked ? 'Quelle deaktivieren' : 'Quelle aktivieren'}">
                  <input type="checkbox" name="enabledProviderCheck" data-provider-toggle="${escapeHTML(p.id)}" value="${escapeHTML(p.id)}" ${checked}>
                  <span class="provider-toggle-slider" aria-hidden="true"></span>
                </label>
                <div class="provider-setting-info">
                  <div class="provider-setting-head">
                    <strong>${escapeHTML(p.name)}</strong>
                    <span class="provider-status-badge is-${escapeHTML(badge.kind)}" title="${escapeHTML(badge.title)}">${escapeHTML(badge.text)}</span>
                    ${showAdminPill ? '<span class="provider-admin-pill" title="Erfordert Administratorrechte (UAC)">🛡️ Admin</span>' : ''}
                  </div>
                  ${p.description ? `<span class="muted">${escapeHTML(p.description)}</span>` : ''}
                  ${extraSettingHtml}
                </div>
                ${actionHtml ? `<div class="provider-setting-actions">${actionHtml}</div>` : ''}
              </div>
            `;
          })
          .join('');

        return `
          <div class="provider-category-group">
            <h4 class="provider-category-title">${escapeHTML(group.label)}</h4>
            <div class="provider-settings-list">${rowsHtml}</div>
          </div>
        `;
      })
      .join('');
  };

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
        <div class="field-header-row">
          <h3>📦 Paketmanager & Quellen</h3>
          <button type="button" class="btn btn-ghost btn-xs" id="btnRecheckProviders" data-settings-action="recheck-providers">🔄 Status prüfen</button>
        </div>
        <div class="form-field">
          <div id="providerSettingsContainer" class="provider-groups-wrap">${renderProvidersHtml()}</div>
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

      <!-- 3. Archiv & Scanner -->
      <section class="settings-section">
        <h3>📂 Archiv & Scanner</h3>
        <div class="form-field">
          <div class="field-header-row">
            <span>Archiv-Pfade (Priorität von oben nach unten)</span>
            <button type="button" class="btn btn-ghost btn-xs" data-settings-action="add-archive-path">➕ Archiv-Pfad hinzufügen</button>
          </div>
          <div id="archivePathsList" class="archive-paths-list">
            ${renderArchiveRootsListHtml(archiveItems)}
          </div>
          <p class="panel-hint">
            Eintrag #1 hat höchste Priorität. Duplikate über mehrere Archiv-Orte werden automatisch zusammengeführt; nicht erreichbare Quellen bleiben im Cache erhalten.
          </p>
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

      <!-- 4. Darstellung & Filter -->
      <section class="settings-section">
        <h3>🎨 Darstellung & Versionsvergleich</h3>
        <div class="form-grid-2">
          <label class="form-field">
            <span>Start-Tab beim Öffnen der App</span>
            <select id="cfgStartTab">
              <option value="updates" ${startTab === 'updates' ? 'selected' : ''}>⬆️ Updates (Standard)</option>
              <option value="installed" ${startTab === 'installed' ? 'selected' : ''}>💻 Installiert</option>
              <option value="archive" ${startTab === 'archive' ? 'selected' : ''}>🗄️ Archiv</option>
              <option value="bundles" ${startTab === 'bundles' ? 'selected' : ''}>📦 Bündel</option>
              <option value="discover" ${startTab === 'discover' ? 'selected' : ''}>🛍️ Neu installieren</option>
            </select>
          </label>
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

      <!-- 5. App-Updates & Info -->
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

      <!-- 6. Wartung & Backup (eingeklappt) -->
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

  const refreshProvidersSectionUi = () => {
    if (modalToken !== activeSettingsToken || overlay.hidden) return;
    const container = modal.querySelector('#providerSettingsContainer');
    if (container) {
      container.innerHTML = renderProvidersHtml();
    }
  };

  const runProvidersAvailabilityCheck = async () => {
    const recheckBtn = modal.querySelector('#btnRecheckProviders');
    if (recheckBtn instanceof HTMLButtonElement) recheckBtn.disabled = true;
    try {
      const res = await window.electronAPI.checkAllProvidersAvailability();
      if (modalToken !== activeSettingsToken || overlay.hidden) return;
      if (Array.isArray(res?.providers)) {
        providers = res.providers;
      }
      if (res?.results && typeof res.results === 'object') {
        for (const [id, status] of Object.entries(res.results)) {
          availabilityById.set(id, status);
        }
      }
      refreshProvidersSectionUi();
    } catch {
      // Status-Anzeige bleibt unverändert
    } finally {
      if (recheckBtn instanceof HTMLButtonElement) recheckBtn.disabled = false;
    }
  };

  void runProvidersAvailabilityCheck();

  const refreshArchivePathsUi = () => {
    const listEl = modal.querySelector('#archivePathsList');
    if (listEl) {
      listEl.innerHTML = renderArchiveRootsListHtml(archiveItems);
    }
  };

  // Drag & Drop zum Umsortieren der Archiv-Priorität
  const listEl = modal.querySelector('#archivePathsList');
  let draggedIdx = -1;
  if (listEl instanceof HTMLElement) {
    listEl.addEventListener('dragstart', (e) => {
      if (!(e.target instanceof Element)) return;
      const row = e.target.closest('.archive-path-row');
      if (!(row instanceof HTMLElement)) return;
      draggedIdx = parseInt(row.dataset.archiveIdx || '-1', 10);
      row.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(draggedIdx));
      }
    });

    listEl.addEventListener('dragover', (e) => {
      if (draggedIdx < 0 || !(e.target instanceof Element)) return;
      const row = e.target.closest('.archive-path-row');
      if (!(row instanceof HTMLElement)) return;
      e.preventDefault();
      listEl.querySelectorAll('.archive-path-row').forEach((el) => {
        el.classList.remove('is-drag-over');
      });
      row.classList.add('is-drag-over');
    });

    listEl.addEventListener('dragleave', (e) => {
      if (!(e.target instanceof Element)) return;
      const row = e.target.closest('.archive-path-row');
      if (row instanceof HTMLElement) row.classList.remove('is-drag-over');
    });

    listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!(e.target instanceof Element)) return;
      const targetRow = e.target.closest('.archive-path-row');
      const targetIdx = targetRow instanceof HTMLElement ? parseInt(targetRow.dataset.archiveIdx || '-1', 10) : -1;
      if (draggedIdx >= 0 && targetIdx >= 0 && draggedIdx !== targetIdx) {
        const [moved] = archiveItems.splice(draggedIdx, 1);
        archiveItems.splice(targetIdx, 0, moved);
        refreshArchivePathsUi();
      }
      draggedIdx = -1;
    });

    listEl.addEventListener('dragend', () => {
      draggedIdx = -1;
      listEl.querySelectorAll('.archive-path-row').forEach((el) => {
        el.classList.remove('is-dragging', 'is-drag-over');
      });
    });
  }

  // Live-Vorschau für Dateinamen-Schema
  const updatePreview = () => {
    const patternInput = getInputEl(modal, '#cfgFilenamePattern');
    const pattern = patternInput?.value || '{Name}_v{Version}{Arch}{Ext}';
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

  modal.oninput = (e) => {
    if (!(e.target instanceof HTMLInputElement)) return;
    if (e.target.matches('[data-vcpkg-root-input]')) {
      vcpkgRootDraft = e.target.value;
    }
  };

  modal.onchange = async (e) => {
    if (!(e.target instanceof Element)) return;
    const toggle = e.target.closest('[data-provider-toggle]');
    if (!(toggle instanceof HTMLInputElement)) return;

    const providerId = toggle.dataset.providerToggle;
    if (!providerId) return;

    const nextEnabled = toggle.checked;
    toggle.disabled = true;
    const res = await window.electronAPI.setProviderEnabled(providerId, nextEnabled);
    if (modalToken !== activeSettingsToken) return;

    if (res?.success) {
      enabledSet.clear();
      for (const id of res.enabledProviders || []) {
        enabledSet.add(String(id).toLowerCase());
      }
      refreshProvidersSectionUi();
      await triggerCatalogReload({ rescanInstalled: nextEnabled });
      const providerName = providers.find((p) => p.id === providerId)?.name || providerId;
      showToast(`${providerName} ${nextEnabled ? 'aktiviert' : 'deaktiviert'}.`, { type: 'info' });
    } else {
      toggle.checked = !nextEnabled;
      toggle.disabled = false;
      showToast(res?.error || 'Quelle konnte nicht umgeschaltet werden.', { type: 'error' });
    }
  };

  modal.onclick = async (e) => {
    if (!(e.target instanceof Element)) return;

    const sourcesBtn = e.target.closest('[data-provider-sources]');
    if (sourcesBtn instanceof HTMLButtonElement) {
      const providerId = sourcesBtn.dataset.providerSources;
      if (!providerId || busyProviderIds.has(providerId)) return;
      const providerObj = providers.find((p) => p.id === providerId) || { id: providerId, name: providerId };
      const res = await openProviderSourcesModal(providerObj);
      if (modalToken !== activeSettingsToken) return;
      if (res?.changed) {
        const refreshedSettings = await window.electronAPI.getSettings();
        if (modalToken !== activeSettingsToken) return;
        s.providerSettings = refreshedSettings?.providerSettings || s.providerSettings;
      }
      return;
    }

    const installProviderBtn = e.target.closest('[data-provider-install]');
    if (installProviderBtn instanceof HTMLButtonElement) {
      const providerId = installProviderBtn.dataset.providerInstall;
      if (!providerId || busyProviderIds.has(providerId)) return;
      const providerName = providers.find((p) => p.id === providerId)?.name || providerId;

      busyProviderIds.add(providerId);
      refreshProvidersSectionUi();
      showToast(`Installiere ${providerName}...`, { type: 'info' });

      const res = await window.electronAPI.installProviderManager(providerId);
      if (modalToken !== activeSettingsToken) return;
      busyProviderIds.delete(providerId);
      if (providerId === 'vcpkg') {
        const refreshedSettings = await window.electronAPI.getSettings();
        if (modalToken !== activeSettingsToken) return;
        vcpkgRootDraft = String(refreshedSettings?.providerSettings?.vcpkgRoot || '').trim();
        s.providerSettings = { ...(s.providerSettings || {}), vcpkgRoot: vcpkgRootDraft };
      }
      if (res?.availability) {
        availabilityById.set(providerId, res.availability);
      }
      refreshProvidersSectionUi();
      await triggerCatalogReload({ rescanInstalled: Boolean(res?.success) });

      if (res?.canceled) {
        showToast(`${providerName}-Installation abgebrochen.`, { type: 'info' });
      } else if (res?.success) {
        showToast(`${providerName} erfolgreich installiert.`, { type: 'success' });
      } else {
        showToast(res?.error || `${providerName} konnte nicht installiert werden.`, { type: 'error', duration: 6000 });
      }
      return;
    }

    const uninstallProviderBtn = e.target.closest('[data-provider-uninstall]');
    if (uninstallProviderBtn instanceof HTMLButtonElement) {
      const providerId = uninstallProviderBtn.dataset.providerUninstall;
      if (!providerId || busyProviderIds.has(providerId)) return;

      const providerObj = providers.find((p) => p.id === providerId);
      const providerName = providerObj?.name || providerId;
      const customWarning = providerObj?.uninstallWarning || '';

      if (customWarning) {
        const decision = await openNestedDialog({
          defaultAction: 'cancel',
          html: `
            <div class="modal-header">
              <h2>⚠️ ${escapeHTML(providerName)} deinstallieren</h2>
              <button type="button" class="icon-btn" data-dialog-action="cancel" title="Abbrechen" aria-label="Abbrechen">✕</button>
            </div>
            <div class="modal-body collision-warning-body">
              <p>${escapeHTML(customWarning)}</p>
              <div class="collision-actions-grid">
                <button type="button" class="btn btn-ghost" data-dialog-action="cancel">Abbrechen</button>
                <button type="button" class="btn btn-danger" data-dialog-action="confirm">🗑️ Trotzdem deinstallieren</button>
              </div>
            </div>
          `,
          onAction: (act) => (act === 'confirm' ? 'confirm' : 'cancel'),
        });
        if (decision !== 'confirm') return;
      } else {
        if (uninstallProviderBtn.dataset.armed !== 'true') {
          uninstallProviderBtn.dataset.armed = 'true';
          uninstallProviderBtn.dataset.origText = uninstallProviderBtn.textContent || '';
          uninstallProviderBtn.textContent = '⚠️ Wirklich deinstallieren?';
          setTimeout(() => {
            if (uninstallProviderBtn.isConnected && uninstallProviderBtn.dataset.armed === 'true') {
              uninstallProviderBtn.dataset.armed = 'false';
              uninstallProviderBtn.textContent = uninstallProviderBtn.dataset.origText || '🗑️ Deinstallieren';
            }
          }, 4000);
          return;
        }
        uninstallProviderBtn.dataset.armed = 'false';
      }

      busyProviderIds.add(providerId);
      refreshProvidersSectionUi();
      showToast(`Deinstalliere ${providerName}...`, { type: 'info' });

      const res = await window.electronAPI.uninstallProviderManager(providerId);
      if (modalToken !== activeSettingsToken) return;
      busyProviderIds.delete(providerId);
      if (providerId === 'vcpkg') {
        const refreshedSettings = await window.electronAPI.getSettings();
        if (modalToken !== activeSettingsToken) return;
        vcpkgRootDraft = String(refreshedSettings?.providerSettings?.vcpkgRoot || '').trim();
        s.providerSettings = { ...(s.providerSettings || {}), vcpkgRoot: vcpkgRootDraft };
      }
      if (res?.availability) {
        availabilityById.set(providerId, res.availability);
      }
      refreshProvidersSectionUi();
      await triggerCatalogReload({ rescanInstalled: Boolean(res?.success) });

      if (res?.canceled) {
        showToast(`${providerName}-Deinstallation abgebrochen.`, { type: 'info' });
      } else if (res?.success) {
        showToast(`${providerName} erfolgreich deinstalliert.`, { type: 'success' });
      } else {
        showToast(res?.error || `${providerName} konnte nicht deinstalliert werden.`, {
          type: 'error',
          duration: 6000,
        });
      }
      return;
    }

    const moveBtn = e.target.closest('[data-archive-move]');
    if (moveBtn instanceof HTMLButtonElement) {
      const idx = parseInt(moveBtn.dataset.archiveIdx || '-1', 10);
      const dir = moveBtn.dataset.archiveMove;
      if (dir === 'up' && idx > 0) {
        [archiveItems[idx - 1], archiveItems[idx]] = [archiveItems[idx], archiveItems[idx - 1]];
        refreshArchivePathsUi();
      } else if (dir === 'down' && idx >= 0 && idx < archiveItems.length - 1) {
        [archiveItems[idx], archiveItems[idx + 1]] = [archiveItems[idx + 1], archiveItems[idx]];
        refreshArchivePathsUi();
      }
      return;
    }

    const removeBtn = e.target.closest('[data-archive-remove]');
    if (removeBtn instanceof HTMLButtonElement) {
      if (archiveItems.length <= 1) return;
      const idx = parseInt(removeBtn.dataset.archiveRemove || '-1', 10);
      if (idx >= 0 && idx < archiveItems.length) {
        archiveItems.splice(idx, 1);
        refreshArchivePathsUi();
      }
      return;
    }

    const installAppBtn = e.target.closest('[data-install-app-url]');
    if (installAppBtn instanceof HTMLButtonElement) {
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
    if (releaseBtn instanceof HTMLElement) {
      window.electronAPI.openUrl(releaseBtn.dataset.openRelease);
      return;
    }

    // Zwei-Klick-Bestätigung für destruktive Wartungsaktionen (kein confirm()!)
    const dangerBtn = e.target.closest('[data-danger-action]');
    if (dangerBtn instanceof HTMLButtonElement) {
      if (dangerBtn.dataset.armed !== 'true') {
        dangerBtn.dataset.armed = 'true';
        dangerBtn.dataset.origText = dangerBtn.textContent || '';
        dangerBtn.textContent = '⚠️ Wirklich ausführen?';
        setTimeout(() => {
          if (dangerBtn.dataset.armed === 'true') {
            dangerBtn.dataset.armed = 'false';
            dangerBtn.textContent = dangerBtn.dataset.origText || '';
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
      dangerBtn.textContent = dangerBtn.dataset.origText || '';
      return;
    }

    const btn = e.target.closest('[data-settings-action]');
    if (!(btn instanceof HTMLElement)) return;
    const act = btn.dataset.settingsAction;

    if (act === 'close') closeModal();
    else if (act === 'browse-vcpkg-root') {
      const dir = await window.electronAPI.selectDir({
        title: 'VCPKG_ROOT Ordner auswählen',
        defaultPath: vcpkgRootDraft || undefined,
      });
      if (!dir || modalToken !== activeSettingsToken) return;
      vcpkgRootDraft = dir.trim();
      await window.electronAPI.saveSettings({ providerSettings: { vcpkgRoot: vcpkgRootDraft } });
      s.providerSettings = { ...(s.providerSettings || {}), vcpkgRoot: vcpkgRootDraft };
      const avail = await window.electronAPI.checkProviderAvailability('vcpkg');
      if (modalToken !== activeSettingsToken) return;
      if (avail) availabilityById.set('vcpkg', avail);
      refreshProvidersSectionUi();
      await triggerCatalogReload({ rescanInstalled: enabledSet.has('vcpkg') });
      showToast('VCPKG_ROOT gespeichert und Status geprüft.', { type: 'success' });
    } else if (act === 'recheck-providers') {
      await runProvidersAvailabilityCheck();
      await triggerCatalogReload();
      showToast('Paketmanager-Status aktualisiert.', { type: 'info' });
    } else if (act === 'open-github') window.electronAPI.openUrl('https://github.com/RaptorXilef/SoftwareKatalogApp');
    else if (act === 'open-data-dir') window.electronAPI.openPath(s.dataDir);
    else if (act === 'open-state') window.electronAPI.openPath(s.statePath);
    else if (act === 'add-archive-path') {
      const dir = await window.electronAPI.selectDir({ title: 'Archiv-Pfad hinzufügen' });
      if (!dir) return;
      const newKey = normalizePathKey(dir);
      const duplicate = archiveItems.some(
        (item) => normalizePathKey(item.rawPath) === newKey || normalizePathKey(item.absPath) === newKey
      );
      if (duplicate) {
        showToast('Dieser Archiv-Pfad ist bereits in der Liste enthalten.', { type: 'info' });
        return;
      }
      const checked = await window.electronAPI.checkArchivePath(dir, archiveItems.length);
      archiveItems.push({
        rawPath: dir,
        absPath: checked?.absPath || dir,
        label: checked?.label || getArchiveRootLabel(dir, archiveItems.length),
        online: checked?.online ?? true,
      });
      refreshArchivePathsUi();
    } else if (act === 'clear-provider-cache') {
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      const res = await window.electronAPI.clearProviderCache();
      if (res?.success) {
        const countEl = modal.querySelector('#providerCacheCount');
        if (countEl) countEl.textContent = '0 Einträge gespeichert';
        showToast('Provider-Cache wurde geleert.', { type: 'success' });
      } else {
        if (btn instanceof HTMLButtonElement) btn.disabled = false;
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
      const checkedCats = Array.from(modal.querySelectorAll('input[name="hiddenCatCheck"]:checked'))
        .filter((cb) => cb instanceof HTMLInputElement)
        .map((cb) => cb.value);
      const checkedProviders = Array.from(modal.querySelectorAll('input[name="enabledProviderCheck"]:checked'))
        .filter((cb) => cb instanceof HTMLInputElement)
        .map((cb) => cb.value);

      const autoSave = Boolean(getInputEl(modal, '#cfgAutoSave')?.checked);
      const startTabEl = getSelectEl(modal, '#cfgStartTab');
      const saveModeEl = getSelectEl(modal, '#cfgArchiveSaveMode');
      const updateIntervalEl = getSelectEl(modal, '#cfgUpdateInterval');
      const nextArchivePaths = archiveItems.map((entry) => entry.rawPath);

      const newSettings = {
        enabledProviders: checkedProviders,
        providerSettings: {
          ...(s.providerSettings || {}),
          vcpkgRoot: vcpkgRootDraft.trim(),
        },
        archiveSaveMode: saveModeEl?.value || 'ask',
        archivePaths: nextArchivePaths,
        targetPath: nextArchivePaths[0] || '../software',
        scanNested: Boolean(getInputEl(modal, '#cfgScanNested')?.checked),
        nestedDepth: parseInt(getInputEl(modal, '#cfgNestedDepth')?.value || '1', 10) || 1,
        visibleHiddenCats: checkedCats,
        updateInterval: parseInt(updateIntervalEl?.value || '24', 10),
        autoExtensions: (getInputEl(modal, '#cfgAutoExt')?.value || '.exe, .msi, .zip')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => (x.startsWith('.') ? x : `.${x}`)),
        newBadgeDays: parseInt(getInputEl(modal, '#cfgNewBadgeDays')?.value || '0', 10) || 0,
        versionCompareDepth: parseInt(getInputEl(modal, '#cfgVersionDepth')?.value || '3', 10) || 3,
        startTab: normalizeStartTab(startTabEl?.value || 'updates'),
        autoSaveDownloads: autoSave,
        askSaveDialog: !autoSave,
        keepOriginalNameIfVersioned: Boolean(getInputEl(modal, '#cfgKeepOriginal')?.checked),
        filenamePattern: getInputEl(modal, '#cfgFilenamePattern')?.value.trim() || '{Name}_v{Version}{Arch}{Ext}',
      };

      const oldArchivePaths = normalizeArchivePaths(s);
      const needsRescan =
        oldArchivePaths.join('|') !== newSettings.archivePaths.join('|') ||
        (s.autoExtensions || []).join(',') !== newSettings.autoExtensions.join(',');

      const oldProviders = new Set(
        (Array.isArray(s.enabledProviders) ? s.enabledProviders : []).map((p) => p.toLowerCase())
      );
      const newlyEnabledProvider = checkedProviders.some((p) => !oldProviders.has(p.toLowerCase()));
      const vcpkgRootChanged = (s.providerSettings?.vcpkgRoot || '') !== vcpkgRootDraft.trim();

      const res = await window.electronAPI.saveSettings(newSettings);
      if (res.success) {
        closeModal();
        if (needsRescan) {
          showToast('Einstellungen gespeichert - aktualisiere Archiv...', { type: 'info' });
          await window.electronAPI.runScan('smart');
        } else {
          showToast('Einstellungen gespeichert.', { type: 'success' });
        }
        await triggerCatalogReload({
          rescanInstalled: newlyEnabledProvider || (vcpkgRootChanged && checkedProviders.includes('vcpkg')),
        });
      } else {
        showToast(`Speicherfehler: ${res.error}`, { type: 'error' });
      }
    }
  };
}
