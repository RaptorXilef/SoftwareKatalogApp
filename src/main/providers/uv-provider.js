import os from 'node:os';
import path from 'node:path';
import { isValidPythonPackageName, parseUvToolListOutput, parseUvVersionOutput } from '../../shared/python-parser.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import {
  createConfigSourceManager,
  getAdditionalCustomRegistryUrls,
  getPrimaryCustomRegistryUrl,
} from './config-sources-helper.js';
import { createCliAvailabilityChecker, createWingetBootstrapRunner } from './manager-bootstrap.js';
import { checkPyPiUpdates, searchPyPiPackages, showPyPiPackage } from './pypi-client.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const uvSourceManager = createConfigSourceManager({
  providerId: 'uv',
  defaultSource: { name: 'pypi', url: 'https://pypi.org/simple' },
});

function getUvExtraPaths() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'uv.exe'),
    path.join(os.homedir(), '.cargo', 'bin', 'uv.exe'),
  ];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'uv', 'uv.exe'));
  }
  return candidates;
}

async function runUv(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const uvExe = await findBinaryPath('uv.exe', {
    signal,
    timeoutMs: 5000,
    extraPaths: getUvExtraPaths(),
  });
  return runCli(uvExe || 'uv', args, { signal, timeoutMs, windowsHide: true });
}

export const uvProvider = {
  id: 'uv',
  name: 'uv tool',
  category: 'developer',
  description: 'Moderner, isolierter Python-CLI-Manager von Astral (uv tool)',
  requiresAdminForBootstrap: false,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning:
    'uv wird ueber Winget deinstalliert. Isolierte Python-Tools bleiben ggf. im Benutzerprofil erhalten.',
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
    binary: 'uv.exe',
    versionArgs: ['--version'],
    extraPaths: getUvExtraPaths,
    parseVersion: parseUvVersionOutput,
    notFoundMessage: 'uv ist auf diesem PC nicht installiert.',
  }),

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  installManager: createWingetBootstrapRunner({
    wingetId: 'astral-sh.uv',
    action: 'install',
    name: 'uv',
  }),

  uninstallManager: createWingetBootstrapRunner({
    wingetId: 'astral-sh.uv',
    action: 'uninstall',
    name: 'uv',
  }),

  async search(query, { limit = 25, signal = null } = {}) {
    return searchPyPiPackages(query, {
      limit,
      signal,
      packageManager: 'uv',
      indexUrl: getPrimaryCustomRegistryUrl('uv'),
    });
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runUv(['tool', 'list'], { signal, timeoutMs: 45000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        packages: [],
        error: res.error || res.stderr || 'uv tool list fehlgeschlagen.',
      };
    }

    const packages = parseUvToolListOutput(res.stdout);
    return { success: true, packages };
  },

  async listUpgrades({ signal = null } = {}) {
    const installed = await this.listInstalled({ signal });
    if (installed.canceled) return { success: false, upgrades: [], canceled: true };
    if (!installed.success) return { success: false, upgrades: [], error: installed.error };

    const upgrades = await checkPyPiUpdates(installed.packages, {
      packageManager: 'uv',
      signal,
      indexUrl: getPrimaryCustomRegistryUrl('uv'),
    });
    if (signal?.aborted) return { success: false, upgrades: [], canceled: true };
    return { success: true, upgrades };
  },

  async show(packageId, { forceRefresh = false, signal = null } = {}) {
    return showPyPiPackage(packageId, {
      packageManager: 'uv',
      forceRefresh,
      signal,
      indexUrl: getPrimaryCustomRegistryUrl('uv'),
    });
  },

  async listVersions(packageId, { forceRefresh = false, signal = null } = {}) {
    const { listPyPiPackageVersions } = await import('./pypi-client.js');
    return listPyPiPackageVersions(packageId, {
      indexUrl: getPrimaryCustomRegistryUrl('uv'),
      forceRefresh,
      signal,
    });
  },

  async install(packageId, { upgrade = false, version = '', itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidPythonPackageName(cleanId)) {
      return { success: false, error: 'Ungueltiger Python-Paketname angegeben.' };
    }

    const cleanVer = String(version || '').trim();
    if (cleanVer && !/^[A-Za-z0-9._+-]+$/.test(cleanVer)) {
      return { success: false, error: 'Ungueltige Versionsangabe.' };
    }

    const baseArgs =
      upgrade && !cleanVer
        ? ['tool', 'upgrade', cleanId]
        : ['tool', 'install', cleanVer ? `${cleanId}==${cleanVer}` : cleanId];
    const primaryIndex = getPrimaryCustomRegistryUrl('uv');
    const extraIndices = getAdditionalCustomRegistryUrls('uv');
    const args = [...baseArgs];
    if (primaryIndex) args.push('--index-url', primaryIndex);
    for (const extra of extraIndices) args.push('--extra-index-url', extra);

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'uv-upgrade' : 'uv-install',
        title: `uv-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: `uv-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'uv-Aktion laeuft bereits.' };
      job.update(
        null,
        upgrade
          ? `Aktualisiere ${itemName || cleanId} via uv tool...`
          : `Installiere ${itemName || cleanId} via uv tool...`
      );
    }

    const activeSignal = job ? job.signal : signal;
    const res = await runUv(args, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', 'uv-Aktion abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.notFound) {
      const msg = 'uv ist auf diesem PC nicht verfuegbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }
    if (res.code === 0) {
      const msg = upgrade ? 'Erfolgreich ueber uv tool aktualisiert.' : 'Erfolgreich ueber uv tool installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `uv-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, { ...opts, upgrade: true });
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidPythonPackageName(cleanId)) {
      return { success: false, error: 'Ungueltiger Python-Paketname angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'uv-uninstall',
        title: `uv-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `uv-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'uv-Deinstallation laeuft bereits.' };
      job.update(null, `Deinstalliere ${itemName || cleanId} via uv tool...`);
    }

    const res = await runUv(['tool', 'uninstall', cleanId], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', 'uv-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.code === 0) {
      job?.finish('done', 'Erfolgreich ueber uv tool deinstalliert.', { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `uv-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  ...uvSourceManager,
};
