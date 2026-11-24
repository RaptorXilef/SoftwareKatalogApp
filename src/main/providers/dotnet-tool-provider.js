import path from 'node:path';
import {
  isValidDotnetToolId,
  parseDotnetToolListOutput,
  parseDotnetVersionOutput,
  parseNugetSearchJson,
  parseNugetShowJson,
} from '../../shared/dotnet-parser.js';
import { compareVersions } from '../../shared/version.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import { createCliAvailabilityChecker, createWingetBootstrapRunner } from './manager-bootstrap.js';
import { fetchRegistryJson } from './npm-registry-client.js';
import { getWingetCache } from './winget-provider.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const NUGET_SEARCH_URL = 'https://azuresearch-usnc.nuget.org/query';

function getDotnetExtraPaths() {
  const candidates = [];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'dotnet', 'dotnet.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'dotnet', 'dotnet.exe'));
  }
  return candidates;
}

async function runDotnet(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const dotnetExe = await findBinaryPath('dotnet.exe', {
    signal,
    timeoutMs: 5000,
    extraPaths: getDotnetExtraPaths(),
  });
  return runCli(dotnetExe || 'dotnet', args, { signal, timeoutMs, windowsHide: true });
}

async function fetchNugetShowFresh(packageId, { signal = null } = {}) {
  const cleanId = String(packageId || '').trim();
  if (!isValidDotnetToolId(cleanId)) {
    throw new Error(`Ungueltige .NET Tool-ID: "${cleanId}".`);
  }

  const url = `${NUGET_SEARCH_URL}?q=packageid:${encodeURIComponent(cleanId)}&packageType=DotnetTool&take=5`;
  const data = await fetchRegistryJson(url, { signal });
  let parsed = parseNugetShowJson(data, cleanId);

  if (!parsed) {
    const fallbackUrl = `${NUGET_SEARCH_URL}?q=${encodeURIComponent(cleanId)}&packageType=DotnetTool&take=10`;
    const fallbackData = await fetchRegistryJson(fallbackUrl, { signal });
    parsed = parseNugetShowJson(fallbackData, cleanId);
  }

  if (!parsed) {
    throw new Error(`.NET Tool "${cleanId}" wurde auf NuGet nicht gefunden.`);
  }
  return parsed;
}

const installSdk10 = createWingetBootstrapRunner({
  wingetId: 'Microsoft.DotNet.SDK.10',
  action: 'install',
  name: '.NET SDK 10',
});
const installSdk9 = createWingetBootstrapRunner({
  wingetId: 'Microsoft.DotNet.SDK.9',
  action: 'install',
  name: '.NET SDK 9',
});

const uninstallSdk10 = createWingetBootstrapRunner({
  wingetId: 'Microsoft.DotNet.SDK.10',
  action: 'uninstall',
  name: '.NET SDK 10',
});
const uninstallSdk9 = createWingetBootstrapRunner({
  wingetId: 'Microsoft.DotNet.SDK.9',
  action: 'uninstall',
  name: '.NET SDK 9',
});

export const dotnetToolProvider = {
  id: 'dotnet',
  name: '.NET Tools',
  category: 'developer',
  description: 'Globale .NET CLI-Tools (dotnet tool install -g / NuGet)',
  requiresAdminForBootstrap: true,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning: 'Achtung: Das .NET SDK wird ueber Winget vom System entfernt.',
  capabilities: {
    search: true,
    listInstalled: true,
    listUpgrades: true,
    show: true,
    install: true,
    uninstall: true,
    supportsArchiveDownload: false,
  },

  checkAvailability: createCliAvailabilityChecker({
    binary: 'dotnet.exe',
    versionArgs: ['--version'],
    extraPaths: getDotnetExtraPaths,
    parseVersion: parseDotnetVersionOutput,
    notFoundMessage: '.NET SDK ist auf diesem PC nicht installiert.',
  }),

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  async installManager(opts = {}) {
    const res10 = await installSdk10(opts);
    if (res10?.success || res10?.canceled) return res10;
    opts.onProgress?.(null, 'Microsoft.DotNet.SDK.10 nicht verfuegbar - versuche Fallback .NET SDK 9...');
    return installSdk9(opts);
  },

  async uninstallManager(opts = {}) {
    const res10 = await uninstallSdk10(opts);
    if (res10?.success || res10?.canceled) return res10;
    opts.onProgress?.(null, 'Versuche Deinstallation von .NET SDK 9...');
    return uninstallSdk9(opts);
  },

  async search(query, { limit = 25, signal = null } = {}) {
    const cleanQuery = String(query || '').trim();
    if (cleanQuery.length < 2) {
      return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
    }

    const take = Number.isFinite(limit) && limit > 0 ? Math.min(Math.max(Math.round(limit), 1), 50) : 25;
    const url = `${NUGET_SEARCH_URL}?q=${encodeURIComponent(cleanQuery)}&packageType=DotnetTool&take=${take}`;

    try {
      const data = await fetchRegistryJson(url, { signal });
      const results = parseNugetSearchJson(data, take);
      return {
        success: true,
        results,
        hint: results.length === 0 ? 'Keine .NET Global Tools auf NuGet gefunden.' : '',
      };
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        return { success: false, results: [], canceled: true };
      }
      return { success: false, results: [], error: err?.message || 'NuGet-Suche fehlgeschlagen.' };
    }
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runDotnet(['tool', 'list', '-g'], { signal, timeoutMs: 45000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        packages: [],
        error: res.error || res.stderr || 'dotnet tool list -g fehlgeschlagen.',
      };
    }

    const packages = parseDotnetToolListOutput(res.stdout);
    return { success: true, packages };
  },

  async listUpgrades({ signal = null } = {}) {
    const installed = await this.listInstalled({ signal });
    if (installed.canceled) return { success: false, upgrades: [], canceled: true };
    if (!installed.success) return { success: false, upgrades: [], error: installed.error };

    const list = installed.packages.filter((p) => isValidDotnetToolId(p.packageId));
    if (list.length === 0) return { success: true, upgrades: [] };

    const upgrades = [];
    const executing = new Set();
    const concurrency = 6;

    for (const pkg of list) {
      if (signal?.aborted) break;
      const task = (async () => {
        try {
          const latest = await fetchNugetShowFresh(pkg.packageId, { signal });
          if (!latest?.version) return;
          const isOutdated = pkg.version ? compareVersions(latest.version, pkg.version, 4) > 0 : false;
          if (isOutdated) {
            upgrades.push({
              packageManager: 'dotnet',
              packageId: pkg.packageId,
              id: pkg.packageId,
              name: pkg.name || pkg.packageId,
              installedVersion: pkg.version,
              availableVersion: latest.version,
              source: 'dotnet',
            });
          }
        } catch {
          // Einzelne NuGet-Fehler blockieren keine weiteren Checks
        }
      })();

      executing.add(task);
      task.finally(() => executing.delete(task));
      if (executing.size >= concurrency) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);
    if (signal?.aborted) return { success: false, upgrades: [], canceled: true };
    return { success: true, upgrades };
  },

  async show(packageId, { forceRefresh = false, signal = null } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!cleanId) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: 'Keine .NET Tool-ID angegeben.',
      };
    }

    const cacheKey = `dotnet:show:${cleanId.toLowerCase()}`;
    const cache = getWingetCache();
    const res = await cache.getOrFetch(cacheKey, () => fetchNugetShowFresh(cleanId, { signal }), { forceRefresh });

    if (!res.data) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: res.error || `.NET Tool "${cleanId}" nicht gefunden.`,
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

  async install(packageId, { upgrade = false, version = '', itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidDotnetToolId(cleanId)) {
      return { success: false, error: 'Ungueltige .NET Tool-ID angegeben.' };
    }

    const cleanVer = String(version || '').trim();
    if (cleanVer && !/^[A-Za-z0-9._+-]+$/.test(cleanVer)) {
      return { success: false, error: 'Ungueltige Versionsangabe.' };
    }

    const args = ['tool', upgrade ? 'update' : 'install', '-g', cleanId];
    if (cleanVer) {
      args.push('--version', cleanVer);
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'dotnet-upgrade' : 'dotnet-install',
        title: `.NET Tool-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: `dotnet-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: '.NET Tool-Aktion laeuft bereits.' };
      job.update(
        null,
        upgrade
          ? `Aktualisiere ${itemName || cleanId} via dotnet tool...`
          : `Installiere ${itemName || cleanId} via dotnet tool...`
      );
    }

    const activeSignal = job ? job.signal : signal;
    const res = await runDotnet(args, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', '.NET Tool-Aktion abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.notFound) {
      const msg = '.NET SDK ist auf diesem PC nicht verfuegbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }
    if (res.code === 0) {
      const msg = upgrade ? 'Erfolgreich ueber .NET Tools aktualisiert.' : 'Erfolgreich ueber .NET Tools installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `dotnet-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, { ...opts, upgrade: true });
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidDotnetToolId(cleanId)) {
      return { success: false, error: 'Ungueltige .NET Tool-ID angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'dotnet-uninstall',
        title: `.NET Tool-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `dotnet-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: '.NET Tool-Deinstallation laeuft bereits.' };
      job.update(null, `Deinstalliere ${itemName || cleanId} via dotnet tool...`);
    }

    const res = await runDotnet(['tool', 'uninstall', '-g', cleanId], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', '.NET Tool-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.code === 0) {
      job?.finish('done', 'Erfolgreich ueber .NET Tools deinstalliert.', { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `dotnet-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },
};
