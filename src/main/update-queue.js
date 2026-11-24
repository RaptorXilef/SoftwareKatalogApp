import { BrowserWindow } from 'electron';
import { canDownloadOnline } from '../shared/unified-packages.js';
import { createUpdateQueueManager } from '../shared/update-queue-core.js';
import { extractVersion } from '../shared/version.js';
import { checkArchiveTargetCollision, linkPackageToArchive } from './archive-linker.js';
import { loadCatalogWithLiveStatus } from './catalog-service.js';
import { getConfig } from './config.js';
import { wingetProvider } from './providers/winget-provider.js';
import { downloadWebUpdate } from './web-updater.js';
import { executeAndVerifyInstaller } from './windows-tools.js';

function broadcastQueueState(snapshot) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('queue-updated', snapshot);
    }
  }
}

async function saveUpdatedWingetPackageToArchive(entry, saveSpec, signal) {
  const cfg = getConfig();
  const mode = saveSpec?.saveMode || cfg.archiveSaveMode || 'none';
  if (mode === 'none') return { skipped: true };

  let targetDir = saveSpec?.targetDir || '';
  let collisionMode = saveSpec?.collisionMode || 'create';

  if (mode === 'auto-id' && !targetDir) {
    const check = await linkPackageToArchive({
      packageManager: 'winget',
      packageId: entry.packageId,
      softwareName: entry.name,
      saveMode: 'auto-id',
      collisionMode: 'create',
      downloadSetup: false,
      metadata: entry,
    });

    if (check?.collision && check.targetDir) {
      const col = checkArchiveTargetCollision(check.targetDir);
      targetDir = check.targetDir;
      collisionMode = col.hasMetadata ? 'link' : 'create';
    } else if (check?.success && check.item) {
      return downloadWebUpdate(check.item, { useJob: false, signal });
    } else {
      return check;
    }
  }

  if (!targetDir && mode !== 'auto-id') {
    return { skipped: true };
  }

  return linkPackageToArchive({
    packageManager: 'winget',
    packageId: entry.packageId,
    softwareName: entry.name,
    targetDir,
    saveMode: targetDir ? 'ask' : mode,
    collisionMode,
    downloadSetup: true,
    downloadUseJob: false,
    signal,
    metadata: entry,
  });
}

async function executeQueueItem(entry, { signal, onProgress }) {
  if (signal?.aborted) {
    return { success: false, canceled: true };
  }

  const useSilent = !entry.interactiveRequired && entry.mode === 'silent';

  if (entry.inArchive) {
    let catItem = loadCatalogWithLiveStatus().find((c) => c.id === entry.itemId);
    if (!catItem) {
      return { success: false, error: 'Archiv-Eintrag nicht gefunden.' };
    }

    let setupFile = catItem.lastFiles?.[0] || '';
    let targetVersion = setupFile ? extractVersion(setupFile) : null;

    if (entry.hasWebUpdate && canDownloadOnline({ ...catItem, inArchive: true })) {
      onProgress?.(null, 'Lade Online-Update ins Archiv...');
      const dlRes = await downloadWebUpdate(catItem, {
        useJob: false,
        signal,
        onProgress: (pct, detail) => onProgress?.(pct, detail),
      });

      if (signal?.aborted || dlRes?.canceled) {
        return { success: false, canceled: true };
      }
      if (!dlRes?.success) {
        return { success: false, error: dlRes?.error || 'Download fehlgeschlagen' };
      }

      setupFile = dlRes.filePath || setupFile;
      targetVersion = dlRes.version || targetVersion;
      catItem = loadCatalogWithLiveStatus().find((c) => c.id === entry.itemId) || catItem;
      if (!setupFile && catItem.lastFiles?.[0]) {
        setupFile = catItem.lastFiles[0];
      }
    }

    if (entry.isInstalled || catItem.isInstalled) {
      if (!setupFile) {
        return { success: false, error: 'Keine Setup-Datei im Archiv vorhanden.' };
      }

      onProgress?.(null, useSilent ? '⚡ Starte stillen Installer...' : '🖱️ Starte Installer...');
      return executeAndVerifyInstaller({
        itemId: catItem.id,
        itemName: catItem.name,
        sourcePath: setupFile,
        targetVersion: targetVersion || catItem.webVersion || entry.toVersion || null,
        useJob: false,
        signal,
        allowSilent: useSilent,
        silent: useSilent,
        onProgress: (pct, detail) => onProgress?.(pct, detail),
      });
    }

    return { success: true };
  }

  if (entry.packageManager === 'winget' && entry.packageId) {
    onProgress?.(null, useSilent ? '⚡ Aktualisiere still über Winget...' : '🖱️ Aktualisiere über Winget...');
    const wgRes = await wingetProvider.install(entry.packageId, {
      silent: useSilent,
      itemName: entry.name,
      signal,
      useJob: false,
    });

    if (signal?.aborted || wgRes?.canceled) {
      return { success: false, canceled: true };
    }
    if (!wgRes?.success) {
      return { success: false, error: wgRes?.error || 'Winget-Update fehlgeschlagen' };
    }

    const saveMode = entry.archiveSaveSpec?.saveMode || getConfig().archiveSaveMode || 'none';
    if (saveMode !== 'none') {
      onProgress?.(null, 'Speichere Setup im Archiv...');
      await saveUpdatedWingetPackageToArchive(entry, entry.archiveSaveSpec, signal);
      if (signal?.aborted) return { success: false, canceled: true };
    }

    return { success: true };
  }

  return { success: false, error: 'Keine unterstützte Update-Quelle vorhanden.' };
}

const queueManager = createUpdateQueueManager({
  executor: executeQueueItem,
  onUpdate: (snapshot) => broadcastQueueState(snapshot),
});

export function enqueueUpdates(items = [], opts = {}) {
  return queueManager.enqueueUpdates(items, opts);
}

export function reorderQueue(fromIndex, toIndex) {
  return queueManager.reorderQueue(fromIndex, toIndex);
}

export function cancelQueueItem(queueId) {
  return queueManager.cancelQueueItem(queueId);
}

export function cancelAllQueue() {
  return queueManager.cancelAllQueue();
}

export function getQueueState() {
  return queueManager.getQueueState();
}
