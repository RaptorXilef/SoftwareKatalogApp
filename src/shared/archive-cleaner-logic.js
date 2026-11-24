import { compareVersions, extractVersion } from './version.js';

export const DEFAULT_KEEP_VERSIONS = 2;
export const ARCHIVE_SUBDIR_NAME = '_archive';

/**
 * Begrenzt die Anzahl zu behaltender Versionen auf mindestens 1 (maximal 50).
 */
export function clampKeepVersions(value) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num) || num < 1) return Number.isNaN(num) ? DEFAULT_KEEP_VERSIONS : 1;
  return Math.min(50, num);
}

/**
 * Prüft, ob eine Datei im Software-Ordner als Setup-/Archiv-Datei für das Aufräumen zählt.
 */
export function isCleanupCandidateFile(filename, autoExtensions = ['.exe', '.msi', '.zip']) {
  const name = String(filename || '').trim();
  if (!name) return false;
  const lower = name.toLowerCase();
  if (lower.endsWith('.part')) return false;

  const normalizedExts = (Array.isArray(autoExtensions) ? autoExtensions : [])
    .map((ext) =>
      String(ext || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean)
    .map((ext) => (ext.startsWith('.') ? ext : `.${ext}`));

  return normalizedExts.some((ext) => lower.endsWith(ext));
}

/**
 * Formatiert eine Byte-Größe menschenlesbar (B, KB, MB, GB).
 */
export function formatBytes(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num <= 0) return '0 B';
  if (num < 1024) return `${Math.round(num)} B`;
  const kb = num / 1024;
  if (kb < 1024) return `${kb.toFixed(1).replace('.', ',')} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace('.', ',')} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2).replace('.', ',')} GB`;
}

/**
 * Sortiert Dateien absteigend von der neuesten zur ältesten Version.
 */
function sortVersionedFilesDescending(files = []) {
  return [...(files || [])]
    .map((file) => ({
      ...file,
      name: String(file.name || ''),
      size: Math.max(0, Number(file.size) || 0),
      mtimeMs: Number(file.mtimeMs) || 0,
      version: file.version ?? extractVersion(String(file.name || '')),
    }))
    .sort((a, b) => {
      if (a.version && b.version) {
        const cmp = compareVersions(b.version, a.version, 0);
        if (cmp !== 0) return cmp;
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        return b.name.localeCompare(a.name, 'de', { numeric: true, sensitivity: 'base' });
      }
      if (a.version !== b.version) {
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        return a.version ? -1 : 1;
      }
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return b.name.localeCompare(a.name, 'de', { numeric: true, sensitivity: 'base' });
    });
}

/**
 * Wählt anhand der `keepVersions` neuesten Versions-Slots die zu behaltenden und zu entfernenden Dateien.
 * Dateien mit gleicher erkannter Versionsnummer (z. B. x64 + x86) teilen sich einen Versions-Slot.
 */
export function selectFilesForCleanup(files = [], { keepVersions = DEFAULT_KEEP_VERSIONS } = {}) {
  const keepLimit = clampKeepVersions(keepVersions);
  const sorted = sortVersionedFilesDescending(files);

  const keptFiles = [];
  const filesToRemove = [];
  const keptSlots = new Set();

  for (const file of sorted) {
    const slotKey = file.version ? `v:${file.version}` : `__unversioned:${file.name.toLowerCase()}`;
    if (keptSlots.has(slotKey) || keptSlots.size < keepLimit) {
      keptSlots.add(slotKey);
      keptFiles.push(file);
    } else {
      filesToRemove.push(file);
    }
  }

  const reclaimBytes = filesToRemove.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  const totalBytes = sorted.reduce((sum, f) => sum + (Number(f.size) || 0), 0);

  return {
    keepVersions: keepLimit,
    keptFiles,
    filesToRemove,
    reclaimBytes,
    totalBytes,
  };
}

/**
 * Erstellt den vollständigen Aufräum-Plan.
 * Zwingender Schutz: Programme mit `hasLastDir: true` (`_last`) oder `keepAllVersions: true`
 * werden NIEMALS in `candidates` aufgenommen, sondern unter `protectedItems` geführt.
 */
export function buildCleanupPlan(programEntries = [], { keepVersions = DEFAULT_KEEP_VERSIONS } = {}) {
  const clampedKeep = clampKeepVersions(keepVersions);
  const candidates = [];
  const protectedItems = [];
  let unaffectedCount = 0;
  let totalFilesToRemove = 0;
  let totalReclaimBytes = 0;

  for (const entry of programEntries || []) {
    if (!entry) continue;
    const files = Array.isArray(entry.files) ? entry.files : [];
    const totalBytes = files.reduce((sum, f) => sum + Math.max(0, Number(f.size) || 0), 0);
    const hasLastDir = Boolean(entry.hasLastDir);
    const keepAllVersions = Boolean(entry.keepAllVersions);

    if (hasLastDir || keepAllVersions) {
      const reasons = [];
      if (hasLastDir) reasons.push('pinnedLast');
      if (keepAllVersions) reasons.push('keepAllVersions');
      protectedItems.push({
        id: entry.id,
        name: entry.name,
        path: entry.path,
        hasLastDir,
        keepAllVersions,
        reasons,
        totalFiles: files.length,
        totalBytes,
      });
      continue;
    }

    const selection = selectFilesForCleanup(files, { keepVersions: clampedKeep });
    if (selection.filesToRemove.length > 0) {
      candidates.push({
        id: entry.id,
        name: entry.name,
        path: entry.path,
        totalFiles: files.length,
        keptFiles: selection.keptFiles,
        filesToRemove: selection.filesToRemove,
        reclaimBytes: selection.reclaimBytes,
        totalBytes: selection.totalBytes,
      });
      totalFilesToRemove += selection.filesToRemove.length;
      totalReclaimBytes += selection.reclaimBytes;
    } else {
      unaffectedCount++;
    }
  }

  candidates.sort(
    (a, b) => b.reclaimBytes - a.reclaimBytes || a.name.localeCompare(b.name, 'de', { sensitivity: 'base' })
  );
  protectedItems.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));

  return {
    keepVersions: clampedKeep,
    candidates,
    protectedItems,
    unaffectedCount,
    totalFilesToRemove,
    totalReclaimBytes,
  };
}
