import { showToast } from '../components/toast.js';
import { state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';
import { triggerCatalogReload } from './index.js';

function getDialogElements() {
  const overlay = document.getElementById('dialogOverlay');
  const dialog = document.getElementById('dialogContent');
  if (!overlay || !dialog) return null;
  return { overlay, dialog };
}

export function openNestedDialog({ html, onAction, defaultAction = 'cancel' }) {
  const els = getDialogElements();
  if (!els) return Promise.resolve(defaultAction);

  const { overlay, dialog } = els;
  dialog.innerHTML = html;
  overlay.hidden = false;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      overlay.hidden = true;
      dialog.innerHTML = '';
      dialog.onclick = null;
      overlay.onclick = null;
      document.removeEventListener('keydown', onKeyDown, true);
      resolve(value);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(defaultAction);
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        finish(defaultAction);
      }
    };

    dialog.onclick = (e) => {
      const btn = e.target.closest('[data-dialog-action]');
      if (!btn) return;
      const action = btn.dataset.dialogAction;
      const result = onAction ? onAction(action) : action;
      if (result !== undefined) {
        finish(result);
      }
    };
  });
}

/**
 * Zeigt ein In-App-Warnmodal bei einer `_metadata`-Kollision mit genau 4 Optionen:
 * 1. Verknüpfen (Bestehende Infos behalten)
 * 2. Überschreiben
 * 3. Anderen Ordner wählen
 * 4. Abbrechen
 */
export function showArchiveCollisionModal({ targetDir, existingMeta = null, softwareName = '', packageId = '' }) {
  const existingName = existingMeta?.name || 'Bestehender Eintrag';
  const existingPkgId = existingMeta?.packageId || existingMeta?.wingetId || '';
  const targetLabel = softwareName || packageId || 'Neue Software';

  return openNestedDialog({
    defaultAction: 'cancel',
    html: `
      <div class="modal-header">
        <h2>⚠️ Ordner enthält bereits Metadaten</h2>
        <button type="button" class="icon-btn" data-dialog-action="cancel" title="Abbrechen" aria-label="Abbrechen">✕</button>
      </div>

      <div class="modal-body collision-warning-body">
        <p>
          Im gewählten Zielordner existiert bereits ein <code>_metadata</code>-Verzeichnis.
          Wie möchtest du für <strong>${escapeHTML(targetLabel)}</strong> fortfahren?
        </p>

        <div class="collision-meta-card">
          <div class="tech-row">
            <span>Zielordner</span>
            <code>${escapeHTML(targetDir)}</code>
          </div>
          <div class="tech-row">
            <span>Vorhandener Eintrag</span>
            <strong>${escapeHTML(existingName)}</strong>
          </div>
          ${
            existingPkgId
              ? `<div class="tech-row"><span>Verknüpfte Paket-ID</span><code>${escapeHTML(existingPkgId)}</code></div>`
              : ''
          }
          ${
            existingMeta?.keepAllVersions
              ? '<div class="tech-row"><span>Aufräum-Schutz</span><strong>🔒 Alle Versionen behalten aktiv</strong></div>'
              : ''
          }
        </div>

        <div class="collision-actions-grid">
          <button type="button" class="btn btn-primary" data-dialog-action="link">🔗 Verknüpfen (Bestehende Infos behalten)</button>
          <button type="button" class="btn btn-danger" data-dialog-action="overwrite">⚠️ Überschreiben</button>
          <button type="button" class="btn btn-ghost" data-dialog-action="other">📂 Anderen Ordner wählen</button>
          <button type="button" class="btn btn-ghost" data-dialog-action="cancel">Abbrechen</button>
        </div>
      </div>
    `,
    onAction: (action) => (['link', 'overwrite', 'other', 'cancel'].includes(action) ? action : 'cancel'),
  });
}

/**
 * Warnt im In-App-Dialog, wenn der gewählte Ordner außerhalb des Archiv-Stammverzeichnisses liegt.
 */
export function showOutsideArchiveDialog({ targetDir, error = '' }) {
  return openNestedDialog({
    defaultAction: 'cancel',
    html: `
      <div class="modal-header">
        <h2>⚠️ Ungültiger Zielordner</h2>
        <button type="button" class="icon-btn" data-dialog-action="cancel" title="Abbrechen" aria-label="Abbrechen">✕</button>
      </div>

      <div class="modal-body collision-warning-body">
        <p>${escapeHTML(error || 'Der gewählte Ordner liegt nicht innerhalb des konfigurierten Archiv-Verzeichnisses.')}</p>
        ${targetDir ? `<div class="collision-meta-card"><div class="tech-row"><span>Gewählt</span><code>${escapeHTML(targetDir)}</code></div></div>` : ''}
      </div>

      <div class="modal-footer">
        <span></span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-dialog-action="cancel">Abbrechen</button>
          <button type="button" class="btn btn-primary" data-dialog-action="retry">📂 Anderen Ordner wählen</button>
        </div>
      </div>
    `,
    onAction: (action) => (action === 'retry' ? 'retry' : 'cancel'),
  });
}

/**
 * Öffnet die Ordnerauswahl im Archiv-Stammverzeichnis, prüft ob der Ordner im Archiv liegt
 * und klärt eine eventuelle `_metadata`-Kollision direkt im In-App-Dialog.
 */
export async function pickArchiveTargetFolder({ softwareName = '', packageId = '' } = {}) {
  const displayName = softwareName || packageId || 'Software';

  while (true) {
    const selectedDir = await window.electronAPI.selectDir({
      defaultToArchive: true,
      title: `Zielordner im Archiv für "${displayName}" wählen`,
    });
    if (!selectedDir) {
      return { canceled: true };
    }

    const checkRes = await window.electronAPI.checkArchiveCollision(selectedDir);
    if (!checkRes?.valid) {
      const retryDecision = await showOutsideArchiveDialog({
        targetDir: selectedDir,
        error: checkRes?.error,
      });
      if (retryDecision === 'retry') continue;
      return { canceled: true };
    }

    if (checkRes.hasMetadata) {
      const decision = await showArchiveCollisionModal({
        targetDir: checkRes.targetDir,
        existingMeta: checkRes.existingMeta,
        softwareName: displayName,
        packageId,
      });

      if (decision === 'other') continue;
      if (decision === 'cancel') return { canceled: true };
      return {
        canceled: false,
        targetDir: checkRes.targetDir,
        collisionMode: decision,
      };
    }

    return {
      canceled: false,
      targetDir: checkRes.targetDir,
      collisionMode: 'create',
    };
  }
}

/**
 * Ermittelt den Archiv-Zielordner entsprechend `archiveSaveMode` (`ask`, `auto-id`, `none`).
 */
export async function resolveArchiveSaveTarget(pkg, { mode = null } = {}) {
  const effectiveMode = mode || state.settings.archiveSaveMode || 'ask';
  const packageId = String(pkg?.packageId || pkg?.wingetId || '').trim();
  const softwareName = String(pkg?.name || packageId || 'Software').trim();

  if (effectiveMode === 'none') {
    return { skipped: true, canceled: false, saveMode: 'none' };
  }

  if (effectiveMode === 'auto-id' && packageId) {
    return {
      skipped: false,
      canceled: false,
      targetDir: '',
      saveMode: 'auto-id',
      collisionMode: 'create',
    };
  }

  const picked = await pickArchiveTargetFolder({ softwareName, packageId });
  if (picked.canceled) {
    return { skipped: false, canceled: true, saveMode: 'ask' };
  }

  return {
    skipped: false,
    canceled: false,
    targetDir: picked.targetDir,
    saveMode: 'ask',
    collisionMode: picked.collisionMode,
  };
}

/**
 * Führt die Archiv-Verknüpfung (inkl. optionalem Setup-Download) aus und behandelt
 * eventuelle Kollisionen im `auto-id`-Modus über denselben 4-Optionen-Dialog.
 */
export async function executeArchiveLink(pkg, targetSpec, { downloadSetup = true, onLinked = null } = {}) {
  if (!targetSpec || targetSpec.skipped || targetSpec.canceled) {
    return { success: false, canceled: Boolean(targetSpec?.canceled), skipped: Boolean(targetSpec?.skipped) };
  }

  const packageId = String(pkg?.packageId || pkg?.wingetId || '').trim();
  const packageManager = packageId ? pkg?.packageManager || pkg?.providerId || 'winget' : '';
  const softwareName = String(pkg?.name || packageId || 'Software').trim();

  let currentTargetDir = targetSpec.targetDir || '';
  let currentSaveMode = targetSpec.saveMode || 'ask';
  let currentCollisionMode = targetSpec.collisionMode || 'create';

  while (true) {
    const res = await window.electronAPI.linkPackageToArchive({
      packageManager,
      packageId,
      softwareName,
      targetDir: currentTargetDir,
      saveMode: currentSaveMode,
      collisionMode: currentCollisionMode,
      downloadSetup: Boolean(downloadSetup && packageId),
      metadata: pkg,
    });

    if (res?.collision) {
      const decision = await showArchiveCollisionModal({
        targetDir: res.targetDir,
        existingMeta: res.existingMeta,
        softwareName,
        packageId,
      });

      if (decision === 'cancel') {
        return { success: false, canceled: true };
      }
      if (decision === 'other') {
        const picked = await pickArchiveTargetFolder({ softwareName, packageId });
        if (picked.canceled) return { success: false, canceled: true };
        currentTargetDir = picked.targetDir;
        currentSaveMode = 'ask';
        currentCollisionMode = picked.collisionMode;
        continue;
      }

      currentTargetDir = res.targetDir;
      currentSaveMode = 'ask';
      currentCollisionMode = decision;
      continue;
    }

    if (!res?.success) {
      showToast(res?.error || 'Aufnahme ins Archiv fehlgeschlagen.', { type: 'error', duration: 6000 });
      return res || { success: false };
    }

    await triggerCatalogReload();
    showToast(`${softwareName} wurde erfolgreich im Archiv aufgenommen.`, { type: 'success' });
    onLinked?.(res);
    return res;
  }
}

/**
 * Komfort-Einstieg: Löst Ziel gemäß `archiveSaveMode` auf und speichert direkt im Archiv.
 */
export async function savePackageToArchive(pkg, { mode = null, downloadSetup = true, onLinked = null } = {}) {
  const targetSpec = await resolveArchiveSaveTarget(pkg, { mode });
  if (targetSpec.canceled || targetSpec.skipped) {
    return { success: false, canceled: targetSpec.canceled, skipped: targetSpec.skipped };
  }

  const softwareName = String(pkg?.name || pkg?.packageId || 'Software').trim();
  if (downloadSetup && (pkg?.packageId || pkg?.wingetId)) {
    showToast(`Speichere ${softwareName} im Archiv...`, { type: 'info' });
  }

  return executeArchiveLink(pkg, targetSpec, { downloadSetup, onLinked });
}

/**
 * Fragt bei einer Massenaktualisierung im Modus `archiveSaveMode === 'ask'`
 * für ein Nicht-Archiv-Programm nach dem Umgang mit dem Archiv.
 */
export function askBatchArchiveSaveChoice({ softwareName = '', packageId = '', index = 1, total = 1 } = {}) {
  const titleLabel = softwareName || packageId || 'Programm';
  return openNestedDialog({
    defaultAction: 'cancel',
    html: `
      <div class="modal-header">
        <h2>📥 Archiv-Speicherung (${index}/${total})</h2>
        <button type="button" class="icon-btn" data-dialog-action="cancel" title="Abbrechen" aria-label="Abbrechen">✕</button>
      </div>

      <div class="modal-body collision-warning-body">
        <p>
          <strong>${escapeHTML(titleLabel)}</strong> ist noch nicht im Archiv hinterlegt.
          In den Einstellungen ist für neue Pakete „Jedes Mal fragen“ aktiviert.
        </p>
        ${packageId ? `<div class="collision-meta-card"><div class="tech-row"><span>Paket-ID</span><code>${escapeHTML(packageId)}</code></div></div>` : ''}
        <div class="collision-actions-grid">
          <button type="button" class="btn btn-primary" data-dialog-action="pick">📂 Zielordner im Archiv wählen</button>
          <button type="button" class="btn btn-ghost" data-dialog-action="skip-archive">⏭️ Nur auf PC aktualisieren</button>
          <button type="button" class="btn btn-ghost" data-dialog-action="cancel">Abbrechen</button>
        </div>
      </div>
    `,
    onAction: (action) => (['pick', 'skip-archive', 'cancel'].includes(action) ? action : 'cancel'),
  });
}
