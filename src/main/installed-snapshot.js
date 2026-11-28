import fs from 'node:fs';
import path from 'node:path';
import { buildPersistentIconIndexKeys, createIconCacheIndex } from '../shared/icon-cache-store.js';
import { getIconCacheDir, getUserDataFolder } from './config.js';

const INSTALLED_SNAPSHOT_FILENAME = 'installed-snapshot.json';
let snapshotWriteSeq = 0;

function getInstalledSnapshotPath() {
  return path.join(getUserDataFolder(), INSTALLED_SNAPSHOT_FILENAME);
}

/**
 * Speichert die auf diesem PC erkannten Programme & Updates atomar im nutzerspezifischen
 * AppData-Ordner (`%APPDATA%\SoftwareKatalog\installed-snapshot.json`).
 * @param {Array<Record<string, any>>} programs
 * @param {number} [scannedAt]
 */
export function saveInstalledSnapshot(programs, scannedAt = Date.now()) {
  try {
    const filePath = getInstalledSnapshotPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload = JSON.stringify(
      {
        version: 1,
        scannedAt: Number.isFinite(Number(scannedAt)) ? Number(scannedAt) : Date.now(),
        programs: Array.isArray(programs) ? programs : [],
      },
      null,
      2
    );

    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${++snapshotWriteSeq}.tmp`;
    try {
      fs.writeFileSync(tmpPath, payload, 'utf-8');
      try {
        fs.renameSync(tmpPath, filePath);
      } catch {
        fs.writeFileSync(filePath, payload, 'utf-8');
      }
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Temp-Datei ignorieren
      }
    }
    return { success: true };
  } catch (err) {
    console.warn('Konnte installed-snapshot.json nicht speichern:', err?.message || err);
    return { success: false, error: err?.message || 'Snapshot konnte nicht gespeichert werden.' };
  }
}

/**
 * Lädt den zuletzt auf diesem PC gespeicherten Scan-Stand für die Tabs "Installiert" & "Updates"
 * und verknüpft vorhandene lokale Icon-Cache-Dateien direkt ohne Netzwerk-/NAS-Zugriff.
 */
export function loadInstalledSnapshot() {
  try {
    const filePath = getInstalledSnapshotPath();
    if (!fs.existsSync(filePath)) {
      return { success: true, hasSnapshot: false, programs: [], scannedAt: null };
    }

    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const rawPrograms = Array.isArray(parsed?.programs) ? parsed.programs : Array.isArray(parsed) ? parsed : [];
    const iconIndex = createIconCacheIndex({ cacheDir: getIconCacheDir() });

    const programs = rawPrograms
      .filter((p) => p && typeof p === 'object' && p.id)
      .map((prog) => {
        let cachedIconPath =
          typeof prog.cachedIconPath === 'string' && prog.cachedIconPath && fs.existsSync(prog.cachedIconPath)
            ? prog.cachedIconPath
            : null;
        if (!cachedIconPath) {
          const keys = buildPersistentIconIndexKeys({
            id: prog.id || '',
            packageManager: prog.packageManager || '',
            packageId: prog.packageId || '',
            homepage: prog.homepage || '',
          });
          const primaryKeys = keys.filter((k) => !k.startsWith('url:'));
          const cachedHit = iconIndex.lookup(primaryKeys.length > 0 ? primaryKeys : keys);
          if ((cachedHit.status === 'hit' || cachedHit.status === 'stale') && cachedHit.filePath) {
            cachedIconPath = cachedHit.filePath;
          }
        }
        return { ...prog, cachedIconPath };
      });

    const scannedAt = Number.isFinite(Number(parsed?.scannedAt)) ? Number(parsed.scannedAt) : null;
    return {
      success: true,
      hasSnapshot: programs.length > 0 || scannedAt !== null,
      programs,
      scannedAt,
    };
  } catch (err) {
    console.warn('Konnte installed-snapshot.json nicht lesen:', err?.message || err);
    return {
      success: false,
      hasSnapshot: false,
      programs: [],
      scannedAt: null,
      error: err?.message || 'Snapshot konnte nicht gelesen werden.',
    };
  }
}
