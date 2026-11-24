import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isValidNpmPackageName,
  mergeBunGlobalPackages,
  parseBunGlobalPackageJson,
  parseBunPmLsOutput,
} from '../../shared/npm-parser.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import { createConfigSourceManager, getPrimaryCustomRegistryUrl } from './config-sources-helper.js';
import {
  createCliAvailabilityChecker,
  createPowerShellBootstrapRunner,
  createWingetBootstrapRunner,
} from './manager-bootstrap.js';
import { checkNpmRegistryUpdates, searchNpmRegistry, showNpmRegistryPackage } from './npm-registry-client.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const bunSourceManager = createConfigSourceManager({
  providerId: 'bun',
  defaultSource: { name: 'npmjs', url: 'https://registry.npmjs.org' },
});

function getBunInstallRoot() {
  return process.env.BUN_INSTALL ? path.resolve(process.env.BUN_INSTALL) : path.join(os.homedir(), '.bun');
}

function getBunExtraPaths() {
  return [path.join(getBunInstallRoot(), 'bin', 'bun.exe')];
}

function getBunGlobalPackageJsonPath() {
  return path.join(getBunInstallRoot(), 'install', 'global', 'package.json');
}

async function runBun(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const bunExe = await findBinaryPath('bun.exe', {
    signal,
    timeoutMs: 5000,
    extraPaths: getBunExtraPaths(),
  });
  return runCli(bunExe || 'bun', args, { signal, timeoutMs, windowsHide: true });
}

const installBunViaWinget = createWingetBootstrapRunner({
  wingetId: 'Oven-sh.Bun',
  action: 'install',
  name: 'Bun',
});

const installBunViaPowerShell = createPowerShellBootstrapRunner({
  script: 'irm bun.sh/install.ps1 | iex',
  requiresAdmin: false,
  label: 'Installiere Bun via PowerShell-Skript (bun.sh/install.ps1)...',
});

export const bunProvider = {
  id: 'bun',
  name: 'Bun',
  category: 'runtime',
  description: 'Schnelle JavaScript-Runtime & globaler Paketmanager (bun add -g)',
  requiresAdminForBootstrap: false,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning: 'Bun wird über Winget deinstalliert. Globale Pakete unter ~/.bun bleiben ggf. erhalten.',
  capabilities: {
    search: true,
    listInstalled: true,
    listUpgrades: true,
    show: true,
    install: true,
    uninstall: true,
    supportsArchiveDownload: false,
    manageSources: true,
  },

  checkAvailability: createCliAvailabilityChecker({
    binary: 'bun',
    versionArgs: ['--version'],
    extraPaths: getBunExtraPaths,
    notFoundMessage: 'Bun ist auf diesem PC nicht installiert.',
  }),

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  async installManager(opts = {}) {
    const wingetRes = await installBunViaWinget(opts);
    if (wingetRes?.success || wingetRes?.canceled) {
      return wingetRes;
    }
    opts.onProgress?.(null, 'Winget fehlgeschlagen - versuche offizielles Bun-Installationsskript...');
    return installBunViaPowerShell(opts);
  },

  uninstallManager: createWingetBootstrapRunner({
    wingetId: 'Oven-sh.Bun',
    action: 'uninstall',
    name: 'Bun',
  }),

  async search(query, { limit = 25, signal = null } = {}) {
    try {
      return await searchNpmRegistry(query, {
        limit,
        signal,
        packageManager: 'bun',
        registryUrl: getPrimaryCustomRegistryUrl('bun'),
      });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        return { success: false, results: [], canceled: true };
      }
      return { success: false, results: [], error: err?.message || 'Bun-Suche fehlgeschlagen.' };
    }
  },

  async listInstalled({ signal = null } = {}) {
    let pkgJsonEntries = [];
    const pkgJsonPath = getBunGlobalPackageJsonPath();
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const raw = await fs.promises.readFile(pkgJsonPath, 'utf-8');
        pkgJsonEntries = parseBunGlobalPackageJson(raw);
      } catch {
        pkgJsonEntries = [];
      }
    }

    const res = await runBun(['pm', 'ls', '-g'], { signal, timeoutMs: 30000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };

    if (res.notFound && pkgJsonEntries.length === 0) {
      return { success: false, packages: [], error: res.error || 'Bun ist auf diesem PC nicht verfügbar.' };
    }

    const pmLsEntries = res.stdout ? parseBunPmLsOutput(res.stdout) : [];
    const packages = mergeBunGlobalPackages(pkgJsonEntries, pmLsEntries);
    return { success: true, packages };
  },

  async listUpgrades({ signal = null } = {}) {
    const installed = await this.listInstalled({ signal });
    if (installed.canceled) return { success: false, upgrades: [], canceled: true };
    if (!installed.success) return { success: false, upgrades: [], error: installed.error };

    const upgrades = await checkNpmRegistryUpdates(installed.packages, {
      packageManager: 'bun',
      signal,
      registryUrl: getPrimaryCustomRegistryUrl('bun'),
    });
    if (signal?.aborted) return { success: false, upgrades: [], canceled: true };
    return { success: true, upgrades };
  },

  async show(packageId, { forceRefresh = false, signal = null } = {}) {
    return showNpmRegistryPackage(packageId, {
      packageManager: 'bun',
      forceRefresh,
      signal,
      registryUrl: getPrimaryCustomRegistryUrl('bun'),
    });
  },

  async install(packageId, { upgrade = false, version = '', itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidNpmPackageName(cleanId)) {
      return { success: false, error: 'Ungültiger Bun-Paketname angegeben.' };
    }

    const cleanVer = String(version || '').trim();
    if (cleanVer && !/^[A-Za-z0-9._+-]+$/.test(cleanVer)) {
      return { success: false, error: 'Ungültige Versionsangabe.' };
    }
    const spec = cleanVer ? `${cleanId}@${cleanVer}` : `${cleanId}@latest`;

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'bun-upgrade' : 'bun-install',
        title: `Bun-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: `bun-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Bun-Aktion läuft bereits.' };
      job.update(
        null,
        upgrade ? `Aktualisiere ${itemName || cleanId} via Bun...` : `Installiere ${itemName || cleanId} via Bun...`
      );
    }

    const activeSignal = job ? job.signal : signal;
    const customRegistry = getPrimaryCustomRegistryUrl('bun');
    const installArgs = customRegistry ? ['add', '-g', '--registry', customRegistry, spec] : ['add', '-g', spec];
    const res = await runBun(installArgs, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', 'Bun-Aktion abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.notFound) {
      const msg = 'Bun ist auf diesem PC nicht verfügbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }
    if (res.code === 0) {
      const msg = upgrade ? 'Erfolgreich über Bun aktualisiert.' : 'Erfolgreich über Bun installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `Bun-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, { ...opts, upgrade: true });
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidNpmPackageName(cleanId)) {
      return { success: false, error: 'Ungültiger Bun-Paketname angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'bun-uninstall',
        title: `Bun-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `bun-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Bun-Deinstallation läuft bereits.' };
      job.update(null, `Deinstalliere ${itemName || cleanId} via Bun...`);
    }

    const res = await runBun(['remove', '-g', cleanId], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', 'Bun-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.code === 0) {
      job?.finish('done', 'Erfolgreich über Bun deinstalliert.', { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `Bun-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  ...bunSourceManager,
};
