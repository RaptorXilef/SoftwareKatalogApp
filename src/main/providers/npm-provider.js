import path from 'node:path';
import {
  isValidNpmPackageName,
  parseNpmListJson,
  parseNpmOutdatedJson,
  parseNpmSearchJson,
} from '../../shared/npm-parser.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import { createConfigSourceManager, getPrimaryCustomRegistryUrl } from './config-sources-helper.js';
import { createCliAvailabilityChecker, createWingetBootstrapRunner } from './manager-bootstrap.js';
import { searchNpmRegistry, showNpmRegistryPackage } from './npm-registry-client.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const npmSourceManager = createConfigSourceManager({
  providerId: 'npm',
  defaultSource: { name: 'npmjs', url: 'https://registry.npmjs.org' },
});

function getNpmExtraPaths() {
  const candidates = [];
  if (process.env.NVM_SYMLINK) {
    candidates.push(path.join(process.env.NVM_SYMLINK, 'npm.cmd'));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'npm.cmd'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'npm.cmd'));
  }
  return candidates;
}

async function runNpm(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const npmCmd = await findBinaryPath('npm.cmd', {
    signal,
    timeoutMs: 5000,
    extraPaths: getNpmExtraPaths(),
  });
  if (process.platform === 'win32' && !npmCmd) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: Boolean(signal?.aborted),
      notFound: true,
      error: 'npm ist auf diesem PC nicht verfügbar.',
      errorCode: 'ENOENT',
    };
  }
  return runCli(npmCmd || 'npm', args, {
    signal,
    timeoutMs,
    windowsHide: true,
  });
}

export const npmProvider = {
  id: 'npm',
  name: 'npm',
  category: 'runtime',
  description: 'Globale Node.js-Pakete über npm (npm install -g)',
  requiresAdminForBootstrap: true,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning: 'Achtung: Beim Deinstallieren wird Node.js LTS (inkl. npm) über Winget vom System entfernt.',
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
    binary: 'npm.cmd',
    versionArgs: ['--version'],
    extraPaths: getNpmExtraPaths,
    notFoundMessage: 'npm ist auf diesem PC nicht installiert.',
  }),

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  installManager: createWingetBootstrapRunner({
    wingetId: 'OpenJS.NodeJS.LTS',
    action: 'install',
    name: 'Node.js LTS (npm)',
  }),

  uninstallManager: createWingetBootstrapRunner({
    wingetId: 'OpenJS.NodeJS.LTS',
    action: 'uninstall',
    name: 'Node.js LTS (npm)',
  }),

  async search(query, { limit = 25, signal = null } = {}) {
    const cleanQuery = String(query || '').trim();
    if (cleanQuery.length < 2) {
      return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
    }

    const customRegistry = getPrimaryCustomRegistryUrl('npm');
    try {
      return await searchNpmRegistry(cleanQuery, {
        limit,
        signal,
        packageManager: 'npm',
        registryUrl: customRegistry,
      });
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        return { success: false, results: [], canceled: true };
      }
      // Fallback über CLI (z. B. bei benutzerdefinierter Registry / Proxy in .npmrc)
      const searchArgs = customRegistry
        ? ['search', cleanQuery, '--json', '--registry', customRegistry]
        : ['search', cleanQuery, '--json'];
      const res = await runNpm(searchArgs, { signal, timeoutMs: 60000 });
      if (res.aborted) return { success: false, results: [], canceled: true };
      if (res.notFound || (res.code !== 0 && !res.stdout)) {
        return {
          success: false,
          results: [],
          error: err?.message || res.error || res.stderr || 'npm-Suche fehlgeschlagen.',
        };
      }
      const results = parseNpmSearchJson(res.stdout, limit, { packageManager: 'npm' });
      return {
        success: true,
        results,
        hint: results.length === 0 ? 'Keine npm-Treffer gefunden.' : '',
      };
    }
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runNpm(['list', '-g', '--depth=0', '--json'], { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound) {
      return { success: false, packages: [], error: res.error || 'npm ist auf diesem PC nicht verfügbar.' };
    }

    const packages = parseNpmListJson(res.stdout, { packageManager: 'npm' });
    if (res.code !== 0 && packages.length === 0 && !res.stdout.trim().startsWith('{')) {
      return {
        success: false,
        packages: [],
        error: res.error || res.stderr || `npm list fehlgeschlagen (Code ${res.code}).`,
      };
    }
    return { success: true, packages };
  },

  async listUpgrades({ signal = null } = {}) {
    const customRegistry = getPrimaryCustomRegistryUrl('npm');
    const args = customRegistry
      ? ['outdated', '-g', '--json', '--registry', customRegistry]
      : ['outdated', '-g', '--json'];
    const res = await runNpm(args, { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, upgrades: [], canceled: true };
    if (res.notFound) {
      return { success: false, upgrades: [], error: res.error || 'npm ist auf diesem PC nicht verfügbar.' };
    }

    // `npm outdated` gibt Exit-Code 1 zurück, sobald Updates existieren -> als Erfolg parsen!
    if (res.code !== 0 && res.code !== 1 && !res.stdout.trim().startsWith('{')) {
      return {
        success: false,
        upgrades: [],
        error: res.error || res.stderr || `npm outdated fehlgeschlagen (Code ${res.code}).`,
      };
    }

    const upgrades = parseNpmOutdatedJson(res.stdout, { packageManager: 'npm' });
    return { success: true, upgrades };
  },

  async show(packageId, { forceRefresh = false, signal = null } = {}) {
    return showNpmRegistryPackage(packageId, {
      packageManager: 'npm',
      forceRefresh,
      signal,
      registryUrl: getPrimaryCustomRegistryUrl('npm'),
    });
  },

  async install(packageId, { upgrade = false, version = '', itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidNpmPackageName(cleanId)) {
      return { success: false, error: 'Ungültiger npm-Paketname angegeben.' };
    }

    const cleanVer = String(version || '').trim();
    if (cleanVer && !/^[A-Za-z0-9._+-]+$/.test(cleanVer)) {
      return { success: false, error: 'Ungültige npm-Versionsangabe.' };
    }
    const spec = cleanVer ? `${cleanId}@${cleanVer}` : `${cleanId}@latest`;

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'npm-upgrade' : 'npm-install',
        title: `npm-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: `npm-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'npm-Aktion läuft bereits.' };
      job.update(
        null,
        upgrade ? `Aktualisiere ${itemName || cleanId} via npm...` : `Installiere ${itemName || cleanId} via npm...`
      );
    }

    const activeSignal = job ? job.signal : signal;
    const customRegistry = getPrimaryCustomRegistryUrl('npm');
    const installArgs = customRegistry
      ? ['install', '-g', '--registry', customRegistry, spec]
      : ['install', '-g', spec];
    const res = await runNpm(installArgs, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', 'npm-Aktion abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.notFound) {
      const msg = 'npm ist auf diesem PC nicht verfügbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }
    if (res.code === 0) {
      const msg = upgrade ? 'Erfolgreich über npm aktualisiert.' : 'Erfolgreich über npm installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `npm-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, { ...opts, upgrade: true });
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidNpmPackageName(cleanId)) {
      return { success: false, error: 'Ungültiger npm-Paketname angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'npm-uninstall',
        title: `npm-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `npm-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'npm-Deinstallation läuft bereits.' };
      job.update(null, `Deinstalliere ${itemName || cleanId} via npm...`);
    }

    const res = await runNpm(['uninstall', '-g', cleanId], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', 'npm-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.code === 0) {
      job?.finish('done', 'Erfolgreich über npm deinstalliert.', { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `npm-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  ...npmSourceManager,
};
