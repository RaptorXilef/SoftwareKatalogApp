import fs from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import {
  ARCHIVE_SUBDIR_NAME,
  buildCleanupPlan,
  clampKeepVersions,
  formatBytes,
} from '../shared/archive-cleaner-logic.js';
import {
  moveFileSafe,
  readLiveKeepAllVersions,
  resolveUniqueArchiveDest,
  scanArchiveFolderForCleanup,
} from './archive-cleaner-core.js';
import { loadCatalogWithLiveStatus } from './catalog-service.js';
import { getConfig, isInsideTargetDir } from './config.js';
import { createJob } from './jobs.js';
import { scanSingleFolder } from './scanner-bridge.js';

async function collectLiveArchiveProgramEntries() {
  const cfg = getConfig();
  const autoExtensions = Array.isArray(cfg.autoExtensions) ? cfg.autoExtensions : ['.exe', '.msi', '.zip'];
  const catalog = loadCatalogWithLiveStatus();
  const entries = [];

  for (const item of catalog) {
    if (!item?.path) continue;
    const resolvedDir = path.resolve(item.path);
    if (!isInsideTargetDir(resolvedDir) || !fs.existsSync(resolvedDir)) continue;

    entries.push(
      await scanArchiveFolderForCleanup(resolvedDir, {
        id: item.id,
        name: item.name,
        autoExtensions,
        hasPinnedLast: Boolean(item.hasPinnedLast),
        keepAllVersions: Boolean(item.keepAllVersions),
      })
    );
  }

  return entries;
}

/**
 * Erzeugt eine reine Vorschau für den manuellen Archiv-Aufräumer (verändert keine Dateien).
 */
export async function previewArchiveCleanup({ keepVersions = 2 } = {}) {
  try {
    const entries = await collectLiveArchiveProgramEntries();
    const plan = buildCleanupPlan(entries, { keepVersions });
    return { success: true, plan };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Setzt `keepAllVersions` für einen Archiv-Ordner sofort dauerhaft in `meta.json`
 * und synchronisiert `catalog.json`.
 */
export async function setKeepAllVersions(itemPath, keepAllVersions = true) {
  try {
    if (!itemPath) throw new Error('Kein Programm-Ordner angegeben.');
    const resolvedPath = path.resolve(itemPath);
    if (!isInsideTargetDir(resolvedPath)) {
      throw new Error('Sicherheitsverletzung: Ordner liegt außerhalb des Archivs.');
    }

    const metaDir = path.join(resolvedPath, '_metadata');
    const metaFile = path.join(metaDir, 'meta.json');
    if (!fs.existsSync(metaDir)) {
      fs.mkdirSync(metaDir, { recursive: true });
    }

    let meta = { name: path.basename(resolvedPath) };
    if (fs.existsSync(metaFile)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      } catch {
        meta = { name: path.basename(resolvedPath) };
      }
    }

    meta.keepAllVersions = Boolean(keepAllVersions);
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
    await scanSingleFolder(resolvedPath);

    return { success: true, keepAllVersions: meta.keepAllVersions };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Führt das Aufräumen AUSSCHLIESSLICH nach manueller Benutzer-Bestätigung aus.
 * Überspringt zwingend alle `_last`-Ordner und `keepAllVersions: true`-Programme.
 */
export async function executeArchiveCleanup({ keepVersions = 2, action = 'archive', excludeItemIds = [] } = {}) {
  const cleanAction = action === 'trash' ? 'trash' : 'archive';
  const clampedKeep = clampKeepVersions(keepVersions);

  const job = createJob({
    type: 'archive-cleanup',
    title: 'Archiv aufräumen',
    dedupeKey: 'archive-cleanup',
    cancelable: true,
  });
  if (!job) {
    return { success: false, alreadyRunning: true, error: 'Ein Aufräumvorgang läuft bereits.' };
  }

  try {
    const entries = await collectLiveArchiveProgramEntries();
    const excludedSet = new Set(Array.isArray(excludeItemIds) ? excludeItemIds : []);
    const filteredEntries = entries.filter((e) => !excludedSet.has(e.id));
    const plan = buildCleanupPlan(filteredEntries, { keepVersions: clampedKeep });

    if (plan.totalFilesToRemove === 0) {
      job.finish('done', 'Keine alten Versionen zum Aufräumen gefunden.');
      return { success: true, processedFiles: 0, freedBytes: 0, errors: [], canceled: false };
    }

    let processedFiles = 0;
    let freedBytes = 0;
    const errors = [];
    const touchedFolders = new Set();

    for (const candidate of plan.candidates) {
      if (job.signal.aborted) break;

      // Doppelte Sicherheitsprüfung direkt vor Schreiboperationen
      if (fs.existsSync(path.join(candidate.path, '_last')) || readLiveKeepAllVersions(candidate.path, false)) {
        continue;
      }

      const archiveDir = path.join(candidate.path, ARCHIVE_SUBDIR_NAME);
      if (cleanAction === 'archive' && !fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }

      for (const file of candidate.filesToRemove) {
        if (job.signal.aborted) break;

        const resolvedFile = path.resolve(file.filePath);
        if (!isInsideTargetDir(resolvedFile) || path.dirname(resolvedFile) !== path.resolve(candidate.path)) {
          errors.push(`${file.name}: Ungültiger Dateipfad.`);
          continue;
        }
        if (!fs.existsSync(resolvedFile)) continue;

        job.update(
          (processedFiles / plan.totalFilesToRemove) * 100,
          `${cleanAction === 'trash' ? 'Papierkorb' : '_archive'}: ${candidate.name} (${file.name})`
        );

        try {
          if (cleanAction === 'trash') {
            await shell.trashItem(resolvedFile);
          } else {
            const destPath = resolveUniqueArchiveDest(archiveDir, file.name);
            await moveFileSafe(resolvedFile, destPath);
          }
          processedFiles++;
          freedBytes += Number(file.size) || 0;
          touchedFolders.add(candidate.path);
        } catch (err) {
          errors.push(`${candidate.name} (${file.name}): ${err.message}`);
        }
      }
    }

    for (const folder of touchedFolders) {
      await scanSingleFolder(folder);
    }

    if (job.signal.aborted) {
      return { success: false, canceled: true, processedFiles, freedBytes, errors };
    }

    const msg = `${processedFiles} Datei(en) bereinigt (${formatBytes(freedBytes)}).`;
    job.finish(errors.length > 0 && processedFiles === 0 ? 'error' : 'done', msg, { autoRemoveMs: 5000 });
    return { success: true, processedFiles, freedBytes, errors, canceled: false };
  } catch (e) {
    if (e.name === 'AbortError' || job.signal.aborted) {
      return { success: false, canceled: true, processedFiles: 0, freedBytes: 0, errors: [] };
    }
    job.finish('error', e.message, { autoRemoveMs: 6000 });
    return { success: false, error: e.message };
  }
}
