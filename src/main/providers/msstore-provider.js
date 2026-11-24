import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import {
  mergeWingetShowResults,
  parseWingetExportJson,
  parseWingetSearchOutput,
  parseWingetShowOutput,
  parseWingetUpgradeOutput,
} from '../../shared/winget-parser.js';
import { createJob } from '../jobs.js';
import { runCli } from './cli-runner.js';
import { getWingetCache, wingetProvider } from './winget-provider.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

function runWingetMsStore(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return runCli('winget', args, { signal, timeoutMs, windowsHide: true });
}

async function fetchMsStoreShowFresh(packageId, { preferGerman = true, signal = null } = {}) {
  const cleanId = String(packageId || '').trim();
  if (!cleanId) {
    throw new Error('Keine MS-Store-Paket-ID angegeben.');
  }

  const baseArgs = ['show', '--id', cleanId, '--exact', '--source', 'msstore', '--accept-source-agreements'];
  let deParsed = null;

  if (preferGerman) {
    const deRes = await runWingetMsStore([...baseArgs, '--locale', 'de-DE'], { signal });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (deRes.code === 0 && deRes.stdout) {
      deParsed = parseWingetShowOutput(deRes.stdout, cleanId, { packageManager: 'msstore' });
      if (deParsed.version && deParsed.description) {
        return { ...deParsed, locale: 'de-DE' };
      }
    }
  }

  const fallbackRes = await runWingetMsStore(baseArgs, { signal });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  let defaultParsed = null;
  if (fallbackRes.code === 0 && fallbackRes.stdout) {
    defaultParsed = parseWingetShowOutput(fallbackRes.stdout, cleanId, { packageManager: 'msstore' });
  }

  const combined = deParsed
    ? mergeWingetShowResults(deParsed, defaultParsed, { packageManager: 'msstore' })
    : defaultParsed;
  if (!combined?.name && !combined?.version) {
    const errDetail = fallbackRes.stderr || `MS-Store-Paket "${cleanId}" konnte nicht abgerufen werden.`;
    throw new Error(errDetail.trim());
  }

  return {
    ...combined,
    packageManager: 'msstore',
    locale: deParsed?.version ? 'de-DE' : 'default',
  };
}

export const msstoreProvider = {
  id: 'msstore',
  name: 'MS Store',
  category: 'system',
  description: 'Microsoft Store-Apps über die bestehende Winget-Quelle (msstore)',
  requiresAdminForBootstrap: false,
  canInstallManager: false,
  canUninstallManager: false,
  isSystemComponent: false,
  capabilities: {
    search: true,
    listInstalled: true,
    listUpgrades: true,
    show: true,
    install: true,
    uninstall: true,
    supportsArchiveDownload: false,
  },

  async checkAvailability({ signal = null } = {}) {
    return wingetProvider.checkAvailability({ signal });
  },

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  async installManager() {
    return {
      success: false,
      error: 'MS Store nutzt die bestehende Winget-Integration und benötigt keine separate Installation.',
    };
  },

  async uninstallManager() {
    return {
      success: false,
      error: 'MS Store nutzt die bestehende Winget-Integration und benötigt keine separate Deinstallation.',
    };
  },

  async search(query, { limit = 25, signal = null } = {}) {
    if (!query || query.trim().length < 2) {
      return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
    }

    const { code, stdout, stderr, aborted } = await runWingetMsStore(
      ['search', '--query', query.trim(), '--source', 'msstore', '--accept-source-agreements'],
      { signal }
    );

    if (aborted) return { success: false, results: [], canceled: true };
    if (code === -1) {
      return { success: false, results: [], error: stderr || 'Winget / MS Store ist auf diesem PC nicht verfügbar.' };
    }

    const results = parseWingetSearchOutput(stdout, limit, {
      packageManager: 'msstore',
      defaultSource: 'msstore',
      requireDotInId: false,
    });
    return {
      success: true,
      results,
      hint: results.length === 0 ? stderr || 'Keine MS-Store-Treffer gefunden.' : '',
    };
  },

  async listInstalled({ signal = null } = {}) {
    const tempFile = path.join(
      app.getPath('temp'),
      `sk_msstore_export_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
    );

    try {
      const { code, stderr } = await runWingetMsStore(
        ['export', '-o', tempFile, '--include-versions', '--accept-source-agreements'],
        { signal, timeoutMs: 60000 }
      );

      if (signal?.aborted) return { success: false, packages: [], canceled: true };
      if (!fs.existsSync(tempFile)) {
        return { success: false, packages: [], error: stderr || `winget export fehlgeschlagen (Code ${code}).` };
      }

      const raw = await fs.promises.readFile(tempFile, 'utf-8');
      const packages = parseWingetExportJson(raw)
        .filter((pkg) => String(pkg.source || '').toLowerCase() === 'msstore')
        .map((pkg) => ({
          ...pkg,
          packageManager: 'msstore',
          source: 'msstore',
        }));

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
    const { code, stdout, stderr } = await runWingetMsStore(
      ['upgrade', '--source', 'msstore', '--accept-source-agreements'],
      { signal, timeoutMs: 60000 }
    );

    if (signal?.aborted) return { success: false, upgrades: [], canceled: true };
    if (code === -1 && !stdout) {
      return { success: false, upgrades: [], error: stderr || 'Winget / MS Store ist auf diesem PC nicht verfügbar.' };
    }

    const upgrades = parseWingetUpgradeOutput(stdout, {
      packageManager: 'msstore',
      defaultSource: 'msstore',
    });
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
        error: 'Keine MS-Store-Paket-ID angegeben.',
      };
    }

    const cacheKey = `msstore:show:${cleanId.toLowerCase()}`;
    const cache = getWingetCache();
    const res = await cache.getOrFetch(cacheKey, () => fetchMsStoreShowFresh(cleanId, { preferGerman, signal }), {
      forceRefresh,
    });

    if (!res.data) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: res.error || `MS-Store-Paket "${cleanId}" nicht gefunden.`,
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
    if (!cleanId) return { success: false, error: 'Keine MS-Store-Paket-ID angegeben.' };

    const args = [
      'install',
      '--id',
      cleanId,
      '--exact',
      '--source',
      'msstore',
      '--accept-package-agreements',
      '--accept-source-agreements',
      silent === true ? '--silent' : '--interactive',
    ];
    if (version) args.push('--version', String(version).trim());
    if (scope === 'user' || scope === 'machine') args.push('--scope', scope);

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'msstore-install',
        title: `MS Store-Installation: ${itemName || cleanId}`,
        dedupeKey: `msstore-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Installation läuft bereits.' };
      job.update(null, silent ? 'Installiere still über MS Store...' : 'Starte MS-Store-Installation...');
    }

    const activeSignal = job ? job.signal : signal;
    const { code, stdout, stderr } = await runWingetMsStore(args, {
      signal: activeSignal,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });

    if (activeSignal?.aborted) {
      return { success: false, canceled: true, exitCode: code };
    }

    const alreadyUpToDate = code === -1978335189;
    if (code === 0 || code === 3010 || alreadyUpToDate) {
      const rebootRequired = code === 3010;
      const msg = alreadyUpToDate
        ? 'Bereits auf dem neuesten Stand.'
        : rebootRequired
          ? 'Installiert (Neustart empfohlen).'
          : 'Erfolgreich über MS Store installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: code, rebootRequired, alreadyUpToDate };
    }

    if (code === 1602 || code === 1223) {
      job?.finish('canceled', 'Installation wurde abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: code };
    }

    const errMsg = (stderr || stdout || `MS-Store-/Winget-Fehlercode ${code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, opts);
  },

  async uninstall(packageId, { silent = false, itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!cleanId) return { success: false, error: 'Keine MS-Store-Paket-ID angegeben.' };

    const args = [
      'uninstall',
      '--id',
      cleanId,
      '--exact',
      '--source',
      'msstore',
      '--accept-source-agreements',
      silent === true ? '--silent' : '--interactive',
    ];

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'msstore-uninstall',
        title: `MS Store-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `msstore-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Deinstallation läuft bereits.' };
      job.update(null, 'Deinstalliere MS Store-App...');
    }

    const { code, stdout, stderr } = await runWingetMsStore(args, { signal, timeoutMs: INSTALL_TIMEOUT_MS });

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

    const errMsg = (stderr || stdout || `MS-Store-/Winget-Fehlercode ${code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: code, error: errMsg };
  },
};
