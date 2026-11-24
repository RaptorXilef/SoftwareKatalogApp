import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { createProviderCache } from '../../shared/provider-cache.js';
import {
  mergeWingetShowResults,
  parseWingetExportJson,
  parseWingetSearchOutput,
  parseWingetShowOutput,
  parseWingetUpgradeOutput,
} from '../../shared/winget-parser.js';
import { createJob } from '../jobs.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

let cacheInstance = null;

export function getWingetCache() {
  if (!cacheInstance) {
    cacheInstance = createProviderCache({
      filePath: path.join(app.getPath('userData'), 'provider-cache.json'),
    });
  }
  return cacheInstance;
}

function runWinget(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    /** @type {any} */
    const child = spawn('winget', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(payload);
    };

    const onAbort = () => {
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {
          // Ignorieren
        }
      }
      if (!child.killed) child.kill('SIGTERM');
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (!child.killed) child.kill('SIGTERM');
            finish({ code: -1, stdout, stderr: stderr || 'Zeitüberschreitung beim Winget-Aufruf.', timedOut: true });
          }, timeoutMs)
        : null;

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      finish({ code: -1, stdout: '', stderr: err.message, timedOut });
    });
    child.on('exit', (code) => {
      finish({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}

async function fetchShowFresh(packageId, { preferGerman = true, signal = null } = {}) {
  const cleanId = String(packageId || '').trim();
  if (!cleanId) {
    throw new Error('Keine Winget-Paket-ID angegeben.');
  }

  const baseArgs = ['show', '--id', cleanId, '--exact', '--source', 'winget', '--accept-source-agreements'];
  let deParsed = null;

  if (preferGerman) {
    const deRes = await runWinget([...baseArgs, '--locale', 'de-DE'], { signal });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (deRes.code === 0 && deRes.stdout) {
      deParsed = parseWingetShowOutput(deRes.stdout, cleanId);
      if (deParsed.version && deParsed.downloadUrl && deParsed.installerType) {
        return { ...deParsed, locale: 'de-DE' };
      }
    }
  }

  const fallbackRes = await runWinget(baseArgs, { signal });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  let defaultParsed = null;
  if (fallbackRes.code === 0 && fallbackRes.stdout) {
    defaultParsed = parseWingetShowOutput(fallbackRes.stdout, cleanId);
  }

  const combined = deParsed ? mergeWingetShowResults(deParsed, defaultParsed) : defaultParsed;
  if (!combined?.version) {
    const errDetail = fallbackRes.stderr || `Winget-Paket "${cleanId}" konnte nicht abgerufen werden.`;
    throw new Error(errDetail.trim());
  }

  return {
    ...combined,
    locale: deParsed?.version ? 'de-DE' : 'default',
  };
}

export const wingetProvider = {
  id: 'winget',
  name: 'Winget',
  description: 'Windows Package Manager (winget)',
  capabilities: {
    search: true,
    listInstalled: true,
    listUpgrades: true,
    show: true,
    install: true,
    uninstall: true,
    supportsArchiveDownload: true,
  },

  async isAvailable() {
    const res = await runWinget(['--version'], { timeoutMs: 8000 });
    if (res.code !== 0) {
      return { available: false, version: null, error: res.stderr || 'Winget nicht verfügbar.' };
    }
    return { available: true, version: res.stdout.trim() || null };
  },

  async search(query, { limit = 25, signal = null } = {}) {
    if (!query || query.trim().length < 2) {
      return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
    }

    const { code, stdout, stderr } = await runWinget(
      ['search', '--query', query.trim(), '--source', 'winget', '--accept-source-agreements'],
      { signal }
    );

    if (code === -1) {
      return { success: false, results: [], error: stderr || 'Winget ist auf diesem PC nicht verfügbar.' };
    }

    const results = parseWingetSearchOutput(stdout, limit);
    return {
      success: true,
      results,
      hint: results.length === 0 ? stderr || 'Keine Winget-Treffer gefunden.' : '',
    };
  },

  async listInstalled({ signal = null } = {}) {
    const tempFile = path.join(
      app.getPath('temp'),
      `sk_winget_export_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
    );

    try {
      const { code, stderr } = await runWinget(
        ['export', '-o', tempFile, '--include-versions', '--accept-source-agreements'],
        { signal, timeoutMs: 60000 }
      );

      if (signal?.aborted) return { success: false, packages: [], canceled: true };
      if (!fs.existsSync(tempFile)) {
        return { success: false, packages: [], error: stderr || `winget export fehlgeschlagen (Code ${code}).` };
      }

      const raw = await fs.promises.readFile(tempFile, 'utf-8');
      const packages = parseWingetExportJson(raw);
      return { success: true, packages };
    } catch (e) {
      return { success: false, packages: [], error: e.message };
    } finally {
      try {
        if (fs.existsSync(tempFile)) await fs.promises.unlink(tempFile);
      } catch {
        // Temp-Datei konnte nicht sofort gelöscht werden
      }
    }
  },

  async listUpgrades({ signal = null } = {}) {
    const { code, stdout, stderr } = await runWinget(['upgrade', '--accept-source-agreements'], {
      signal,
      timeoutMs: 60000,
    });

    if (signal?.aborted) return { success: false, upgrades: [], canceled: true };
    if (code === -1 && !stdout) {
      return { success: false, upgrades: [], error: stderr || 'Winget ist auf diesem PC nicht verfügbar.' };
    }

    const upgrades = parseWingetUpgradeOutput(stdout);
    return { success: true, upgrades };
  },

  async show(packageId, { preferGerman = true, forceRefresh = false, signal = null } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!cleanId) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: 'Keine Paket-ID angegeben.',
      };
    }

    const cacheKey = `winget:show:${cleanId.toLowerCase()}`;
    const cache = getWingetCache();
    const res = await cache.getOrFetch(cacheKey, () => fetchShowFresh(cleanId, { preferGerman, signal }), {
      forceRefresh,
    });

    if (!res.data) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: res.error || `Winget-Paket "${cleanId}" nicht gefunden.`,
      };
    }

    return {
      success: true,
      package: res.data,
      fromCache: res.fromCache,
      isStale: res.isStale,
      updatedAt: res.updatedAt,
      error: res.error,
    };
  },

  async install(
    packageId,
    { silent = false, version = '', scope = '', itemName = '', signal = null, useJob = true } = {}
  ) {
    const cleanId = String(packageId || '').trim();
    if (!cleanId) return { success: false, error: 'Keine Winget-Paket-ID angegeben.' };

    const args = [
      'install',
      '--id',
      cleanId,
      '--exact',
      '--source',
      'winget',
      '--accept-package-agreements',
      '--accept-source-agreements',
      // Silent-Install ist IMMER opt-in (Standard bleibt interaktiv)
      silent === true ? '--silent' : '--interactive',
    ];
    if (version) args.push('--version', String(version).trim());
    if (scope === 'user' || scope === 'machine') args.push('--scope', scope);

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'winget-install',
        title: `Winget-Installation: ${itemName || cleanId}`,
        dedupeKey: `winget-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Installation läuft bereits.' };
      job.update(null, silent ? 'Installiere still via Winget...' : 'Starte interaktiven Winget-Installer...');
    }

    const activeSignal = job ? job.signal : signal;
    const { code, stdout, stderr } = await runWinget(args, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted) {
      return { success: false, canceled: true, exitCode: code };
    }

    // -1978335189 (0x8A15002B) = bereits installiert / kein neueres Update
    const alreadyUpToDate = code === -1978335189;
    if (code === 0 || code === 3010 || alreadyUpToDate) {
      const rebootRequired = code === 3010;
      const msg = alreadyUpToDate
        ? 'Bereits auf dem neuesten Stand.'
        : rebootRequired
          ? 'Installiert (Neustart empfohlen).'
          : 'Erfolgreich über Winget installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: code, rebootRequired, alreadyUpToDate };
    }

    if (code === 1602 || code === 1223) {
      job?.finish('canceled', 'Installation wurde abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: code };
    }

    const errMsg = (stderr || stdout || `Winget-Fehlercode ${code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: code, error: errMsg };
  },

  async uninstall(packageId, { silent = false, itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!cleanId) return { success: false, error: 'Keine Winget-Paket-ID angegeben.' };

    const args = [
      'uninstall',
      '--id',
      cleanId,
      '--exact',
      '--accept-source-agreements',
      // Silent ist opt-in, Standard bleibt interaktiv
      silent === true ? '--silent' : '--interactive',
    ];

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'winget-uninstall',
        title: `Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `winget-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Deinstallation läuft bereits.' };
      job.update(null, 'Deinstalliere über Winget...');
    }

    const { code, stdout, stderr } = await runWinget(args, { signal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (code === 0 || code === 3010) {
      const rebootRequired = code === 3010;
      job?.finish('done', rebootRequired ? 'Deinstalliert (Neustart empfohlen).' : 'Erfolgreich deinstalliert.', {
        autoRemoveMs: 4000,
      });
      return { success: true, exitCode: code, rebootRequired };
    }

    if (code === 1602 || code === 1223) {
      job?.finish('canceled', 'Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: code };
    }

    const errMsg = (stderr || stdout || `Winget-Fehlercode ${code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: code, error: errMsg };
  },
};
