import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { createJob } from './jobs.js';

const lastCounts = { smart: 0, update: 0, full: 0 };

function cleanupScanLock(dataDir) {
  const lockFile = path.join(dataDir, 'scan.lock');
  try {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (e) {
    console.warn('Konnte scan.lock nach Abbruch nicht bereinigen:', e);
  }
}

/**
 * Startet einen Archiv-Scan als abbrechbaren Job.
 * mode: 'smart' (Standard: neue Ordner + geänderte Setup-Dateien), 'update', 'full'
 */
export async function runArchiveScan(mode = 'smart') {
  const { absScriptPath, appFolder, dataDir } = getConfig();
  const titles = {
    smart: 'Archiv prüfen',
    update: 'Metadaten aktualisieren',
    full: 'Vollständiger Archiv-Rescan',
  };

  let child = null;
  const job = createJob({
    type: 'archive-scan',
    title: titles[mode] || 'Archiv prüfen',
    dedupeKey: 'archive-scan',
    cancelable: true,
    onCancel: () => {
      if (child && !child.killed) {
        child.kill('SIGTERM');
      }
      cleanupScanLock(dataDir);
    },
  });

  if (!job) {
    return { success: false, alreadyRunning: true, error: 'Ein Archiv-Scan läuft bereits.' };
  }

  return new Promise((resolve) => {
    const args = [absScriptPath];
    if (mode === 'full') args.push('--full');
    if (mode === 'update') args.push('--update');

    child = spawn(process.execPath, args, {
      cwd: appFolder,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        SK_APP_DIR: appFolder,
        SK_DATA_DIR: dataDir,
      },
    });

    let fullError = '';
    let buffer = '';
    let dirCount = 0;
    /** @type {Array<{ index: number, path: string, label: string }>} */
    const offlineRoots = [];
    const expected = lastCounts[mode] || 0;

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.startsWith('SCAN_START:')) {
          job.update(2, `Durchsuche ${line.replace('SCAN_START:', '').trim()}...`);
        } else if (line.startsWith('SCAN_ROOT:')) {
          job.update(null, `Scanne Archiv: ${line.replace('SCAN_ROOT:', '').trim()}...`);
        } else if (line.startsWith('SCAN_OFFLINE:')) {
          try {
            const info = JSON.parse(line.replace('SCAN_OFFLINE:', '').trim());
            offlineRoots.push(info);
            job.update(null, `Quelle offline (übersprungen): ${info.label || info.path}`);
          } catch {
            // Ignorieren
          }
        } else if (line.startsWith('SCAN_DIR:')) {
          dirCount++;
          const currentDir = line.replace('SCAN_DIR:', '').trim();
          const pct = expected > 0 ? Math.min(98, (dirCount / expected) * 100) : null;
          job.update(pct, currentDir);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      fullError += chunk.toString();
    });

    child.on('error', (err) => {
      job.finish('error', `Startfehler: ${err.message}`, { autoRemoveMs: 5000 });
      resolve({ success: false, error: err.message });
    });

    child.on('exit', (code) => {
      if (job.signal.aborted) {
        cleanupScanLock(dataDir);
        resolve({ success: false, canceled: true });
        return;
      }

      if (code === 0) {
        if (dirCount > 0) lastCounts[mode] = dirCount;
        const offlineNote =
          offlineRoots.length > 0
            ? ` · ${offlineRoots.length} offline (${offlineRoots.map((r) => r.label || r.path).join(', ')})`
            : '';
        job.finish('done', `Archiv aktualisiert (${dirCount} Ordner geprüft${offlineNote})`);
        resolve({ success: true, offlineRoots });
      } else if (fullError.includes('LOCKED')) {
        job.finish('error', 'Archiv wird gerade von einem anderen PC gescannt.', { autoRemoveMs: 5000 });
        resolve({ success: false, error: 'LOCKED' });
      } else {
        job.finish('error', `Scanner-Fehler (Code ${code})`, { autoRemoveMs: 6000 });
        resolve({ success: false, error: fullError || `Code ${code}` });
      }
    });
  });
}

/**
 * Aktualisiert blitzschnell genau einen Software-Ordner im Katalog (ohne Vollscan).
 */
export async function scanSingleFolder(absSoftwarePath) {
  const { absScriptPath, appFolder, dataDir } = getConfig();

  return new Promise((resolve) => {
    /** @type {any} */
    const child = spawn(process.execPath, [absScriptPath, '--single', absSoftwarePath], {
      cwd: appFolder,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        SK_APP_DIR: appFolder,
        SK_DATA_DIR: dataDir,
      },
    });

    let errOut = '';
    child.stderr.on('data', (d) => {
      errOut += d.toString();
    });
    child.on('error', (err) => resolve({ success: false, error: err.message }));
    child.on('exit', (code) => {
      if (code === 0) resolve({ success: true });
      else resolve({ success: false, error: errOut || `Exit ${code}` });
    });
  });
}
