import fs from 'node:fs';
import path from 'node:path';
import {
  ARCHIVE_SUBDIR_NAME,
  buildCleanupPlan,
  clampKeepVersions,
  isCleanupCandidateFile,
} from '../shared/archive-cleaner-logic.js';

export function readLiveKeepAllVersions(folderPath, fallbackValue = false) {
  const metaFile = path.join(folderPath, '_metadata', 'meta.json');
  if (!fs.existsSync(metaFile)) return Boolean(fallbackValue);
  try {
    const raw = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    if (typeof raw.keepAllVersions === 'boolean') {
      return raw.keepAllVersions;
    }
  } catch {
    // Fallback verwenden
  }
  return Boolean(fallbackValue);
}

export async function scanArchiveFolderForCleanup(
  folderPath,
  { id = '', name = '', autoExtensions = ['.exe', '.msi', '.zip'], hasPinnedLast = false, keepAllVersions = false } = {}
) {
  const resolvedDir = path.resolve(folderPath);
  const hasLastDir = Boolean(hasPinnedLast) || fs.existsSync(path.join(resolvedDir, '_last'));
  const effectiveKeepAll = readLiveKeepAllVersions(resolvedDir, keepAllVersions);

  const files = [];
  if (fs.existsSync(resolvedDir)) {
    try {
      const dirEntries = await fs.promises.readdir(resolvedDir, { withFileTypes: true });
      for (const dirEntry of dirEntries) {
        if (!dirEntry.isFile()) continue;
        if (!isCleanupCandidateFile(dirEntry.name, autoExtensions)) continue;
        const filePath = path.join(resolvedDir, dirEntry.name);
        try {
          const st = await fs.promises.stat(filePath);
          files.push({
            name: dirEntry.name,
            filePath,
            size: st.size,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          // Datei zwischenzeitlich nicht lesbar
        }
      }
    } catch {
      // Ordner nicht lesbar
    }
  }

  return {
    id: id || path.basename(resolvedDir),
    name: name || path.basename(resolvedDir),
    path: resolvedDir,
    hasLastDir,
    keepAllVersions: effectiveKeepAll,
    files,
  };
}

export async function collectCleanupPlanFromFolders(
  folderEntries = [],
  { keepVersions = 2, autoExtensions = ['.exe', '.msi', '.zip'] } = {}
) {
  const entries = [];
  for (const raw of folderEntries || []) {
    const folderPath = typeof raw === 'string' ? raw : raw?.path;
    if (!folderPath) continue;
    const scanned = await scanArchiveFolderForCleanup(folderPath, {
      id: typeof raw === 'object' ? raw.id : '',
      name: typeof raw === 'object' ? raw.name : '',
      autoExtensions,
      hasPinnedLast: typeof raw === 'object' ? Boolean(raw.hasPinnedLast) : false,
      keepAllVersions: typeof raw === 'object' ? Boolean(raw.keepAllVersions) : false,
    });
    entries.push(scanned);
  }

  return buildCleanupPlan(entries, { keepVersions: clampKeepVersions(keepVersions) });
}

export async function moveFileSafe(srcPath, destPath) {
  try {
    await fs.promises.rename(srcPath, destPath);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fs.promises.copyFile(srcPath, destPath);
      await fs.promises.unlink(srcPath);
    } else {
      throw err;
    }
  }
}

export function resolveUniqueArchiveDest(archiveDir, fileName) {
  const direct = path.join(archiveDir, fileName);
  if (!fs.existsSync(direct)) return direct;

  const parsed = path.parse(fileName);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  let candidate = path.join(archiveDir, `${parsed.name}_${stamp}${parsed.ext}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(archiveDir, `${parsed.name}_${stamp}_${counter++}${parsed.ext}`);
  }
  return candidate;
}

export async function executeArchiveSubdirMove(plan, { isPathAllowed = () => true, signal = null } = {}) {
  let processedFiles = 0;
  let freedBytes = 0;
  const errors = [];
  const touchedFolders = new Set();

  for (const candidate of plan?.candidates || []) {
    if (signal?.aborted) break;

    // Doppelte Sicherheitsprüfung direkt vor Schreiboperationen
    if (fs.existsSync(path.join(candidate.path, '_last')) || readLiveKeepAllVersions(candidate.path, false)) {
      continue;
    }

    const archiveDir = path.join(candidate.path, ARCHIVE_SUBDIR_NAME);
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    for (const file of candidate.filesToRemove || []) {
      if (signal?.aborted) break;

      const resolvedFile = path.resolve(file.filePath);
      if (!isPathAllowed(resolvedFile) || path.dirname(resolvedFile) !== path.resolve(candidate.path)) {
        errors.push(`${file.name}: Ungültiger Dateipfad.`);
        continue;
      }
      if (!fs.existsSync(resolvedFile)) continue;

      try {
        const destPath = resolveUniqueArchiveDest(archiveDir, file.name);
        await moveFileSafe(resolvedFile, destPath);
        processedFiles++;
        freedBytes += Number(file.size) || 0;
        touchedFolders.add(candidate.path);
      } catch (err) {
        errors.push(`${candidate.name} (${file.name}): ${err.message}`);
      }
    }
  }

  return {
    processedFiles,
    freedBytes,
    touchedFolders: [...touchedFolders],
    errors,
  };
}
