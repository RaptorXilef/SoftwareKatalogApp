import path from 'node:path';
import { isValidNpmPackageName, parsePnpmListJson } from '../../shared/npm-parser.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import { createConfigSourceManager, getPrimaryCustomRegistryUrl } from './config-sources-helper.js';
import { createCliAvailabilityChecker, createWingetBootstrapRunner } from './manager-bootstrap.js';
import { checkNpmRegistryUpdates, searchNpmRegistry, showNpmRegistryPackage } from './npm-registry-client.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const pnpmSourceManager = createConfigSourceManager({
  providerId: 'pnpm',
  defaultSource: { name: 'npmjs', url: 'https://registry.npmjs.org' },
});

function getPnpmExtraPaths() {
  const candidates = [];
  if (process.env.PNPM_HOME) {
    candidates.push(path.join(process.env.PNPM_HOME, 'pnpm.exe'));
    candidates.push(path.join(process.env.PNPM_HOME, 'pnpm.cmd'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'pnpm', 'pnpm.exe'));
  }
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'pnpm.cmd'));
  }
  return candidates;
}

async function runPnpm(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const pnpmBin = await findBinaryPath('pnpm', {
    signal,
    timeoutMs: 5000,
    extraPaths: getPnpmExtraPaths(),
  });
  return runCli(pnpmBin || 'pnpm', args, {
    signal,
    timeoutMs,
    windowsHide: true,
  });
}

export const pnpmProvider = {
  id: 'pnpm',
  name: 'pnpm',
  category: 'runtime',
  description: 'Speichereffizienter JavaScript-Paketmanager für globale Pakete (pnpm add -g)',
  requiresAdminForBootstrap: false,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning: 'pnpm wird über Winget deinstalliert. Globale Stores bleiben ggf. bestehen.',
  capabilities: {
    search: true,
    listInstalled: true,
    listUpgrades: true,
    listVersions: true,
    show: true,
    install: true,
    uninstall: true,
    supportsArchiveDownload: false,
    manageSources: true,
  },

  checkAvailability: createCliAvailabilityChecker({
    binary: 'pnpm',
    versionArgs: ['--version'],
    extraPaths: getPnpmExtraPaths,
    notFoundMessage: 'pnpm ist auf diesem PC nicht installiert.',
  }),

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  installManager: createWingetBootstrapRunner({
    wingetId: 'pnpm.pnpm',
    action: 'install',
    name: 'pnpm',
  }),

  uninstallManager: createWingetBootstrapRunner({
    wingetId: 'pnpm.pnpm',
    action: 'uninstall',
    name: 'pnpm',
  }),

  async search(query, { limit = 25, signal = null } = {}) {
    try {
      return await searchNpmRegistry(query, {
        limit,
        signal,
        packageManager: 'pnpm',
        registryUrl: getPrimaryCustomRegistryUrl('pnpm'),
      });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        return { success: false, results: [], canceled: true };
      }
      return { success: false, results: [], error: err?.message || 'pnpm-Suche fehlgeschlagen.' };
    }
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runPnpm(['list', '-g', '--depth=0', '--json'], { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound) {
      return { success: false, packages: [], error: res.error || 'pnpm ist auf diesem PC nicht verfügbar.' };
    }

    const packages = parsePnpmListJson(res.stdout);
    if (res.code !== 0 && packages.length === 0 && !res.stdout.trim()) {
      return {
        success: false,
        packages: [],
        error: res.error || res.stderr || `pnpm list fehlgeschlagen (Code ${res.code}).`,
      };
    }
    return { success: true, packages };
  },

  async listUpgrades({ signal = null } = {}) {
    const installed = await this.listInstalled({ signal });
    if (installed.canceled) return { success: false, upgrades: [], canceled: true };
    if (!installed.success) return { success: false, upgrades: [], error: installed.error };

    const upgrades = await checkNpmRegistryUpdates(installed.packages, {
      packageManager: 'pnpm',
      signal,
      registryUrl: getPrimaryCustomRegistryUrl('pnpm'),
    });
    if (signal?.aborted) return { success: false, upgrades: [], canceled: true };
    return { success: true, upgrades };
  },

  async show(packageId, { forceRefresh = false, signal = null } = {}) {
    return showNpmRegistryPackage(packageId, {
      packageManager: 'pnpm',
      forceRefresh,
      signal,
      registryUrl: getPrimaryCustomRegistryUrl('pnpm'),
    });
  },

  async listVersions(packageId, { forceRefresh = false, signal = null } = {}) {
    const { listNpmRegistryVersions } = await import('./npm-registry-client.js');
    return listNpmRegistryVersions(packageId, {
      registryUrl: getPrimaryCustomRegistryUrl('pnpm'),
      forceRefresh,
      signal,
    });
  },

  async install(packageId, { upgrade = false, version = '', itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidNpmPackageName(cleanId)) {
      return { success: false, error: 'Ungültiger pnpm-Paketname angegeben.' };
    }

    const cleanVer = String(version || '').trim();
    if (cleanVer && !/^[A-Za-z0-9._+-]+$/.test(cleanVer)) {
      return { success: false, error: 'Ungültige Versionsangabe.' };
    }
    const spec = cleanVer ? `${cleanId}@${cleanVer}` : `${cleanId}@latest`;

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'pnpm-upgrade' : 'pnpm-install',
        title: `pnpm-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: `pnpm-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'pnpm-Aktion läuft bereits.' };
      job.update(
        null,
        upgrade ? `Aktualisiere ${itemName || cleanId} via pnpm...` : `Installiere ${itemName || cleanId} via pnpm...`
      );
    }

    const activeSignal = job ? job.signal : signal;
    const customRegistry = getPrimaryCustomRegistryUrl('pnpm');
    const installArgs = customRegistry ? ['add', '-g', '--registry', customRegistry, spec] : ['add', '-g', spec];
    const res = await runPnpm(installArgs, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', 'pnpm-Aktion abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.notFound) {
      const msg = 'pnpm ist auf diesem PC nicht verfügbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }
    if (res.code === 0) {
      const msg = upgrade ? 'Erfolgreich über pnpm aktualisiert.' : 'Erfolgreich über pnpm installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `pnpm-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, { ...opts, upgrade: true });
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidNpmPackageName(cleanId)) {
      return { success: false, error: 'Ungültiger pnpm-Paketname angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'pnpm-uninstall',
        title: `pnpm-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `pnpm-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'pnpm-Deinstallation läuft bereits.' };
      job.update(null, `Deinstalliere ${itemName || cleanId} via pnpm...`);
    }

    const res = await runPnpm(['remove', '-g', cleanId], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', 'pnpm-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.code === 0) {
      job?.finish('done', 'Erfolgreich über pnpm deinstalliert.', { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `pnpm-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  ...pnpmSourceManager,
};
