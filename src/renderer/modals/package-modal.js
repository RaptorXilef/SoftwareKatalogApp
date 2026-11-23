import { showToast } from '../components/toast.js';
import { state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';
import { closeModal, openDetailModal, triggerCatalogReload } from './index.js';

function findArchiveLinkInState(packageManager, packageId) {
  const cleanPm = String(packageManager || '')
    .trim()
    .toLowerCase();
  const cleanPid = String(packageId || '')
    .trim()
    .toLowerCase();
  if (!cleanPid) return null;

  return (
    state.packages.find((p) => {
      if (!p.inArchive) return false;
      const pId = String(p.packageId || p.wingetId || '')
        .trim()
        .toLowerCase();
      const pPm = String(p.packageManager || (p.wingetId ? 'winget' : ''))
        .trim()
        .toLowerCase();
      if (!pId) return false;
      return cleanPm ? pPm === cleanPm && pId === cleanPid : pId === cleanPid;
    }) || null
  );
}

export async function renderProviderPackageModal(providerId, packageId, summary = {}) {
  state.currentModalId = null;
  state.isEditModalOpen = false;

  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;

  const pkgTitle = summary.name || packageId;
  const providerObj = state.providers.find((p) => p.id === providerId);
  const providerLabel = providerObj?.name || providerId;
  const archiveMatch = findArchiveLinkInState(providerId, packageId);

  const renderContent = (pkg = null, meta = {}) => {
    const displayName = pkg?.name || pkgTitle;
    const version = pkg?.version || summary.version || '';
    const publisher = pkg?.publisher || '';
    const license = pkg?.license || '';
    const installerType = pkg?.installerType || '';
    const description = pkg?.description || pkg?.shortDescription || summary.shortDescription || '';
    const tags = Array.isArray(pkg?.tags) ? pkg.tags : [];
    const homepage = pkg?.homepage || '';
    const releaseNotesUrl = pkg?.releaseNotesUrl || '';

    const archiveBtnHtml = archiveMatch
      ? `<button type="button" class="btn btn-ghost" data-pkg-action="open-archive">📂 Im Archiv öffnen</button>`
      : providerObj?.capabilities?.supportsArchiveDownload
        ? `<button type="button" class="btn btn-archive" data-pkg-action="link-archive">🗄️ Ins Archiv laden</button>`
        : '';

    const metaBoxes = [
      `<div class="pkg-meta-box"><span>Paket-ID</span><code>${escapeHTML(packageId)}</code></div>`,
      `<div class="pkg-meta-box"><span>Version</span><strong>${version ? `v${escapeHTML(version)}` : 'Unbekannt'}</strong></div>`,
      `<div class="pkg-meta-box"><span>Quelle</span><strong>${escapeHTML(providerLabel)}</strong></div>`,
    ];
    if (publisher) {
      metaBoxes.push(
        `<div class="pkg-meta-box"><span>Herausgeber</span><strong>${escapeHTML(publisher)}</strong></div>`
      );
    }
    if (license) {
      metaBoxes.push(`<div class="pkg-meta-box"><span>Lizenz</span><strong>${escapeHTML(license)}</strong></div>`);
    }
    if (installerType) {
      metaBoxes.push(
        `<div class="pkg-meta-box"><span>Installer-Typ</span><strong>${escapeHTML(installerType)}</strong></div>`
      );
    }

    const links = [];
    if (homepage) {
      links.push(
        `<button type="button" class="link-chip" data-open-url="${escapeHTML(homepage)}">🔗 Homepage</button>`
      );
    }
    if (releaseNotesUrl) {
      links.push(
        `<button type="button" class="link-chip" data-open-url="${escapeHTML(releaseNotesUrl)}">📋 Release Notes</button>`
      );
    }

    let statusLine = '';
    if (meta.loading) {
      statusLine = '<p class="muted">⏳ Lade vollständige Paketdetails...</p>';
    } else if (meta.error) {
      statusLine = `<p class="muted">Hinweis: ${escapeHTML(meta.error)}</p>`;
    }

    modal.innerHTML = `
      <div class="modal-header detail-header">
        <div class="detail-head-main">
          <div class="detail-icon-fallback">🛍️</div>
          <div class="detail-head-text">
            <div class="detail-title-row">
              <h2>${escapeHTML(displayName)}</h2>
              <span class="provider-badge">${escapeHTML(providerLabel)}</span>
              ${archiveMatch ? '<span class="discover-status-badge">Im Archiv</span>' : ''}
            </div>
            <div class="detail-meta-inline">
              ${tags.length > 0 ? `<span><strong>Tags:</strong> ${escapeHTML(tags.slice(0, 6).join(', '))}</span>` : ''}
            </div>
          </div>
        </div>
        <button type="button" class="icon-btn" data-pkg-action="close" title="Schließen" aria-label="Schließen">✕</button>
      </div>

      <div class="modal-body detail-body">
        <div class="pkg-detail-meta">${metaBoxes.join('')}</div>
        ${statusLine}
        <div class="detail-hero-bar">
          <button type="button" class="btn btn-lg btn-primary" data-pkg-action="install">⬇️ Jetzt installieren</button>
          ${archiveBtnHtml}
        </div>
        <div class="detail-section">
          <h4>Beschreibung</h4>
          <div class="detail-description">${description ? escapeHTML(description) : '<span class="muted">Keine Beschreibung hinterlegt.</span>'}</div>
        </div>
        ${
          links.length > 0
            ? `<div class="detail-section"><h4>Links</h4><div class="detail-links">${links.join('')}</div></div>`
            : ''
        }
      </div>

      <div class="modal-footer">
        <span class="muted">${meta.fromCache ? 'Aus lokalem Provider-Cache' : ''}</span>
        <div class="footer-group">
          <button type="button" class="btn btn-primary" data-pkg-action="close">Schließen</button>
        </div>
      </div>
    `;
  };

  renderContent(null, { loading: true });
  overlay.hidden = false;

  let loadedPkg = null;

  modal.onclick = async (e) => {
    const urlBtn = e.target.closest('[data-open-url]');
    if (urlBtn) {
      window.electronAPI.openUrl(urlBtn.dataset.openUrl);
      return;
    }

    const btn = e.target.closest('[data-pkg-action]');
    if (!btn) return;
    const act = btn.dataset.pkgAction;

    if (act === 'close') {
      closeModal();
    } else if (act === 'open-archive' && archiveMatch) {
      openDetailModal(archiveMatch.id);
    } else if (act === 'link-archive') {
      renderArchiveLinkModal({
        packageManager: providerId,
        packageId,
        name: loadedPkg?.name || pkgTitle,
        version: loadedPkg?.version || summary.version || '',
        description: loadedPkg?.description || loadedPkg?.shortDescription || '',
        tags: loadedPkg?.tags || [],
        homepage: loadedPkg?.homepage || '',
        releaseNotesUrl: loadedPkg?.releaseNotesUrl || '',
      });
    } else if (act === 'install') {
      btn.disabled = true;
      btn.textContent = '⏳ Installiere...';
      showToast(`Starte Installation für ${loadedPkg?.name || pkgTitle}...`, { type: 'info' });
      const res = await window.electronAPI.installPackage(providerId, packageId, {
        silent: false,
        itemName: loadedPkg?.name || pkgTitle,
      });
      btn.disabled = false;
      btn.textContent = '⬇️ Jetzt installieren';

      if (res?.alreadyRunning) {
        showToast('Für dieses Paket läuft bereits eine Installation.', { type: 'warn' });
      } else if (res?.canceled) {
        showToast('Installation wurde abgebrochen.', { type: 'info' });
      } else if (res?.success) {
        showToast(`${loadedPkg?.name || pkgTitle} erfolgreich installiert!`, { type: 'success' });
        await triggerCatalogReload({ rescanInstalled: true });
      } else {
        showToast(`Installationsfehler: ${res?.error || 'Unbekannter Fehler'}`, { type: 'error', duration: 6000 });
      }
    }
  };

  const res = await window.electronAPI.showPackage(providerId, packageId);
  if (overlay.hidden) return;
  if (res?.success && res.package) {
    loadedPkg = res.package;
    renderContent(loadedPkg, { fromCache: res.fromCache });
  } else {
    renderContent(null, { error: res?.error || 'Details konnten nicht abgerufen werden.' });
  }
}

export function renderArchiveLinkModal(pkg, { onLinked } = {}) {
  state.currentModalId = null;
  state.isEditModalOpen = false;

  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;

  const packageManager = pkg.packageManager || pkg.providerId || 'winget';
  const packageId = pkg.packageId || pkg.id;
  const softwareName = pkg.name || packageId;
  const defaultAutoMode = state.settings.archiveSaveMode === 'auto-id';

  let selectedMode = defaultAutoMode ? 'auto-id' : 'custom';
  let customTargetDir = '';

  modal.innerHTML = `
    <div class="modal-header">
      <h2>🗄️ Ins Archiv aufnehmen</h2>
      <button type="button" class="icon-btn" data-link-action="close" title="Abbrechen" aria-label="Abbrechen">✕</button>
    </div>

    <div class="modal-body">
      <div class="pkg-detail-meta">
        <div class="pkg-meta-box"><span>Programm</span><strong>${escapeHTML(softwareName)}</strong></div>
        <div class="pkg-meta-box"><span>Paket-ID</span><code>${escapeHTML(packageId)}</code></div>
        <div class="pkg-meta-box"><span>Quelle</span><strong>${escapeHTML(packageManager)}</strong></div>
      </div>

      <div class="archive-link-form">
        <div class="archive-link-options">
          <label class="radio-card">
            <input type="radio" name="archiveLinkMode" value="auto-id" ${selectedMode === 'auto-id' ? 'checked' : ''}>
            <div>
              <strong>Automatischer Ordner nach Paket-ID</strong>
              <p>Legt unter dem Archiv-Stammverzeichnis automatisch den Ordner <code>${escapeHTML(packageId)}</code> an.</p>
            </div>
          </label>
          <label class="radio-card">
            <input type="radio" name="archiveLinkMode" value="custom" ${selectedMode === 'custom' ? 'checked' : ''}>
            <div>
              <strong>Zielordner im Archiv manuell wählen</strong>
              <p>Wähle einen neuen oder bestehenden Software-Ordner innerhalb deines Archivs aus.</p>
            </div>
          </label>
        </div>

        <div id="archiveCustomDirRow" class="input-action-row" ${selectedMode === 'custom' ? '' : 'hidden'}>
          <input type="text" id="archiveCustomDirInput" value="" placeholder="Ordner im Archiv auswählen..." readonly>
          <button type="button" class="btn btn-ghost" data-link-action="browse-dir">📂 Ordner wählen</button>
        </div>

        <label class="check-row">
          <input type="checkbox" id="archiveDownloadSetupCheck" checked>
          <span>Setup-Datei direkt herunterladen und im Archiv speichern</span>
        </label>

        <div id="archiveCollisionBox" class="collision-box" hidden></div>
      </div>
    </div>

    <div class="modal-footer">
      <span class="muted">Speichert <code>_metadata/meta.json</code> sauber im Archiv</span>
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-link-action="close">Abbrechen</button>
        <button type="button" class="btn btn-archive" data-link-action="submit">🗄️ Im Archiv speichern</button>
      </div>
    </div>
  `;

  overlay.hidden = false;

  const submitLink = async (collisionMode = 'create') => {
    if (selectedMode === 'custom' && !customTargetDir) {
      showToast('Bitte zuerst einen Zielordner im Archiv auswählen.', { type: 'warn' });
      return;
    }

    const submitBtn = modal.querySelector('[data-link-action="submit"]');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ Speichere im Archiv...';
    }

    const downloadSetup = Boolean(modal.querySelector('#archiveDownloadSetupCheck')?.checked);
    const res = await window.electronAPI.linkPackageToArchive({
      packageManager,
      packageId,
      softwareName,
      targetDir: selectedMode === 'custom' ? customTargetDir : '',
      saveMode: selectedMode === 'auto-id' ? 'auto-id' : 'ask',
      collisionMode,
      downloadSetup,
      metadata: pkg.version || pkg.description ? pkg : null,
    });

    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = '🗄️ Im Archiv speichern';
    }

    if (res?.collision) {
      const box = modal.querySelector('#archiveCollisionBox');
      if (box) {
        box.hidden = false;
        const existingName = res.existingMeta?.name || 'Bestehender Eintrag';
        box.innerHTML = `
          <p><strong>⚠️ Ordner enthält bereits Metadaten (${escapeHTML(existingName)}):</strong></p>
          <div class="inline-btn-group">
            <button type="button" class="btn btn-primary btn-xs" data-link-action="resolve-link">🔗 Mit bestehendem Ordner verknüpfen</button>
            <button type="button" class="btn btn-danger btn-xs" data-link-action="resolve-overwrite">♻️ Metadaten überschreiben</button>
            <button type="button" class="btn btn-ghost btn-xs" data-link-action="resolve-cancel">Abbrechen</button>
          </div>
        `;
      }
      return;
    }

    if (!res?.success) {
      showToast(res?.error || 'Aufnahme ins Archiv fehlgeschlagen.', { type: 'error', duration: 6000 });
      return;
    }

    closeModal();
    await triggerCatalogReload();
    showToast(`${softwareName} wurde erfolgreich im Archiv aufgenommen.`, { type: 'success' });
    onLinked?.(res);
  };

  modal.onchange = (e) => {
    if (e.target.name === 'archiveLinkMode') {
      selectedMode = e.target.value;
      const dirRow = modal.querySelector('#archiveCustomDirRow');
      if (dirRow) dirRow.hidden = selectedMode !== 'custom';
      const box = modal.querySelector('#archiveCollisionBox');
      if (box) box.hidden = true;
    }
  };

  modal.onclick = async (e) => {
    const btn = e.target.closest('[data-link-action]');
    if (!btn) return;
    const act = btn.dataset.linkAction;

    if (act === 'close') {
      closeModal();
    } else if (act === 'browse-dir') {
      const dir = await window.electronAPI.selectDir();
      if (dir) {
        customTargetDir = dir;
        const input = modal.querySelector('#archiveCustomDirInput');
        if (input) input.value = dir;
        const box = modal.querySelector('#archiveCollisionBox');
        if (box) box.hidden = true;
      }
    } else if (act === 'submit') {
      await submitLink('create');
    } else if (act === 'resolve-link') {
      await submitLink('link');
    } else if (act === 'resolve-overwrite') {
      await submitLink('overwrite');
    } else if (act === 'resolve-cancel') {
      const box = modal.querySelector('#archiveCollisionBox');
      if (box) box.hidden = true;
    }
  };
}
