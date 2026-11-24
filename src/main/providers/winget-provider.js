import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { createProviderCache } from '../../shared/provider-cache.js';
import { normalizeProviderVersion } from '../../shared/provider-lifecycle-logic.js';
import {
  isValidSourceName,
  isValidSourceUrl,
  isValidWingetSourceType,
  PROVIDER_SOURCE_TEMPLATES,
  parseWingetSourceListOutput,
} from '../../shared/provider-sources-parser.js';
import {
  mergeWingetExportWithList,
  mergeWingetShowResults,
  parseWingetExportJson,
  parseWingetListOutput,
  parseWingetSearchOutput,
  parseWingetShowOutput,
  parseWingetUpgradeOutput,
} from '../../shared/winget-parser.js';
import { isAdminSessionActive } from '../elevated-helper.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli, runElevatedPowerShell } from './cli-runner.js';

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

function escapeSingleQuotedPs(value) {
  return String(value || '').replace(/'/g, "''");
}

function runWinget(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS, preferElevated = false } = {}) {
  return runCli('winget', args, { signal, timeoutMs, windowsHide: true, preferElevated });
}

async function runWingetWithUacFallback(args, { signal = null } = {}) {
  if (isAdminSessionActive()) {
    const elevRes = await runWinget(args, { signal, timeoutMs: 2 * 60 * 1000, preferElevated: true });
    if (signal?.aborted || elevRes.aborted) {
      return { success: false, canceled: true };
    }
    if (elevRes.notFound) {
      return { success: false, error: elevRes.stderr || 'Winget ist auf diesem PC nicht verfuegbar.' };
    }
    if (elevRes.code === 0) {
      return { success: true };
    }
    const elevErr = (elevRes.stderr || elevRes.stdout || elevRes.error || `Winget-Fehlercode ${elevRes.code}`).trim();
    return { success: false, error: elevErr };
  }

  const res = await runWinget(args, { signal, timeoutMs: 60000 });
  if (signal?.aborted || res.aborted) {
    return { success: false, canceled: true };
  }
  if (res.notFound) {
    return { success: false, error: res.stderr || 'Winget ist auf diesem PC nicht verfuegbar.' };
  }
  if (res.code === 0) {
    return { success: true };
  }

  const psArgs = args.map((arg) => `'${escapeSingleQuotedPs(arg)}'`).join(' ');
  const uacRes = await runElevatedPowerShell(`& 'winget' ${psArgs}`, {
    signal,
    timeoutMs: 2 * 60 * 1000,
  });
  if (uacRes.canceled || uacRes.aborted) {
    return { success: false, canceled: true };
  }
  if (uacRes.code === 0) {
    return { success: true };
  }
  const errMsg = (
    uacRes.error ||
    uacRes.stderr ||
    uacRes.stdout ||
    res.stderr ||
    res.stdout ||
    `Winget-Fehlercode ${uacRes.code}`
  ).trim();
  return { success: false, error: errMsg };
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
  category: 'system',
  description: 'Offizieller Windows-Paketmanager (Microsoft App-Installer)',
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
    supportsArchiveDownload: true,
    manageSources: true,
  },

  async checkAvailability({ signal = null } = {}) {
    const binaryPath = await findBinaryPath('winget', { signal, timeoutMs: 5000 });
    const res = await runWinget(['--version'], { signal, timeoutMs: 8000 });
    if (res.notFound || res.code !== 0) {
      return {
        available: false,
        version: null,
        binaryPath: binaryPath || null,
        error: res.error || res.stderr || 'Winget ist auf diesem PC nicht verfügbar.',
      };
    }
    return {
      available: true,
      version: normalizeProviderVersion(res.stdout),
      binaryPath: binaryPath || 'winget',
      error: null,
    };
  },

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  async installManager() {
    return { success: false, error: 'Winget wird über den Microsoft Store (App-Installer) verwaltet.' };
  },

  async uninstallManager() {
    return { success: false, error: 'Winget wird über den Microsoft Store (App-Installer) verwaltet.' };
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
      const [exportRes, listRes] = await Promise.all([
        runWinget(['export', '-o', tempFile, '--include-versions', '--accept-source-agreements'], {
          signal,
          timeoutMs: 60000,
        }),
        runWinget(['list', '--source', 'winget', '--accept-source-agreements'], {
          signal,
          timeoutMs: 60000,
        }),
      ]);

      if (signal?.aborted || exportRes.aborted || listRes.aborted) {
        return { success: false, packages: [], canceled: true };
      }

      const listed = listRes.stdout
        ? parseWingetListOutput(listRes.stdout, {
            packageManager: 'winget',
            defaultSource: 'winget',
            requireDotInId: false,
          })
        : [];

      if (!fs.existsSync(tempFile)) {
        if (listed.length > 0) {
          return { success: true, packages: listed };
        }
        return {
          success: false,
          packages: [],
          error: exportRes.stderr || listRes.stderr || `winget export fehlgeschlagen (Code ${exportRes.code}).`,
        };
      }

      const raw = await fs.promises.readFile(tempFile, 'utf-8');
      const exported = parseWingetExportJson(raw);
      const packages = mergeWingetExportWithList(exported, listed, {
        packageManager: 'winget',
        defaultSource: 'winget',
      });
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
    const { code, stdout, stderr } = await runWinget(args, {
      signal: activeSignal,
      timeoutMs: INSTALL_TIMEOUT_MS,
      preferElevated: true,
    });

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

    const { code, stdout, stderr } = await runWinget(args, {
      signal,
      timeoutMs: INSTALL_TIMEOUT_MS,
      preferElevated: true,
    });

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

  async listSources({ signal = null } = {}) {
    const res = await runWinget(['source', 'list'], { signal, timeoutMs: 30000 });
    if (res.aborted) return { success: false, canceled: true, sources: [] };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        sources: [],
        templates: PROVIDER_SOURCE_TEMPLATES.winget,
        requiresAdmin: true,
        mode: 'cli',
        error: res.error || res.stderr || 'Winget-Quellen konnten nicht abgerufen werden.',
      };
    }

    const sources = parseWingetSourceListOutput(res.stdout).map((src) => ({
      ...src,
      builtIn: false,
    }));
    return {
      success: true,
      mode: 'cli',
      requiresAdmin: true,
      sources,
      templates: PROVIDER_SOURCE_TEMPLATES.winget,
      hint: 'Das Hinzufuegen oder Entfernen von Winget-Quellen erfordert unter Windows ggf. Administratorrechte (UAC).',
    };
  },

  async addSource({ name = '', url = '', type = '' } = {}, { signal = null } = {}) {
    const cleanName = String(name || '').trim();
    const cleanUrl = String(url || '').trim();
    const cleanType = String(type || '').trim();

    if (!isValidSourceName(cleanName)) {
      return { success: false, error: 'Ungueltiger Quellenname (erlaubt: Buchstaben, Ziffern, . _ -).' };
    }
    if (!isValidSourceUrl(cleanUrl)) {
      return { success: false, error: 'Bitte eine gueltige HTTP/HTTPS-URL angeben.' };
    }
    if (!isValidWingetSourceType(cleanType)) {
      return { success: false, error: 'Ungueltiger Winget-Quelltyp.' };
    }

    const args = ['source', 'add', '--name', cleanName, '--arg', cleanUrl, '--accept-source-agreements'];
    if (cleanType) {
      args.push('--type', cleanType);
    }
    return runWingetWithUacFallback(args, { signal });
  },

  async removeSource(name, { signal = null } = {}) {
    const cleanName = String(name || '').trim();
    if (!isValidSourceName(cleanName)) {
      return { success: false, error: 'Ungueltiger Quellenname.' };
    }
    return runWingetWithUacFallback(['source', 'remove', '--name', cleanName], { signal });
  },
};
