import path from 'node:path';
import {
  isValidNvmVersion,
  normalizeNodeVersion,
  parseNvmListAvailableOutput,
  parseNvmListOutput,
} from '../../shared/nvm-parser.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli, runElevatedPowerShell } from './cli-runner.js';
import { createCliAvailabilityChecker, createWingetBootstrapRunner } from './manager-bootstrap.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

function getNvmExtraPaths() {
  return [
    process.env.NVM_HOME ? path.join(process.env.NVM_HOME, 'nvm.exe') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'nvm', 'nvm.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'nvm', 'nvm.exe') : '',
    'C:\\ProgramData\\nvm\\nvm.exe',
  ].filter(Boolean);
}

function escapeSingleQuotedPs(value) {
  return String(value || '').replace(/'/g, "''");
}

async function resolveNvmExe(signal = null) {
  return (
    (await findBinaryPath('nvm.exe', {
      signal,
      timeoutMs: 5000,
      extraPaths: getNvmExtraPaths(),
    })) || 'nvm'
  );
}

async function runNvm(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const nvmExe = await resolveNvmExe(signal);
  return runCli(nvmExe, args, { signal, timeoutMs, windowsHide: true });
}

/**
 * Setzt eine installierte Node.js-Version über `nvm use <version>` aktiv.
 * Fällt automatisch auf UAC-Elevation zurück, falls das Symlink-Erstellen Adminrechte benötigt.
 * @param {string} version
 * @param {{ signal?: AbortSignal | null, useJob?: boolean }} [options]
 */
export async function useNvmVersion(version, { signal = null, useJob = true } = {}) {
  const cleanVer = normalizeNodeVersion(version);
  if (!isValidNvmVersion(cleanVer)) {
    return { success: false, error: 'Ungültige Node.js-Versionsnummer angegeben.' };
  }

  let job = null;
  if (useJob) {
    job = createJob({
      type: 'nvm-use',
      title: `Node.js-Version aktivieren: v${cleanVer}`,
      dedupeKey: 'nvm-use',
      cancelable: true,
    });
    if (!job) return { success: false, alreadyRunning: true, error: 'Es wird bereits eine Node-Version umgeschaltet.' };
    job.update(20, `Aktiviere Node.js v${cleanVer} über NVM...`);
  }

  const activeSignal = job ? job.signal : signal;
  const nvmExe = await resolveNvmExe(activeSignal);
  let res = await runCli(nvmExe, ['use', cleanVer], { signal: activeSignal, timeoutMs: 30000, windowsHide: true });

  if (activeSignal?.aborted || res.aborted) {
    job?.finish('canceled', 'Umschalten abgebrochen.', { autoRemoveMs: 3500 });
    return { success: false, canceled: true, exitCode: res.code };
  }

  if (res.notFound) {
    const msg = 'NVM for Windows ist auf diesem PC nicht verfügbar.';
    job?.finish('error', msg, { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: msg };
  }

  const combinedOut = `${res.stdout}\n${res.stderr}\n${res.error || ''}`;
  const needsElevation =
    res.code !== 0 ||
    /exit status 1|access is denied|zugriff verweigert|administrator|privilege|elevation|symlink|cannot create/i.test(
      combinedOut
    );

  if (needsElevation) {
    job?.update(50, 'Symlink erfordert Administrator-Bestätigung (UAC)...');
    const psScript = `& '${escapeSingleQuotedPs(nvmExe)}' 'use' '${escapeSingleQuotedPs(cleanVer)}'`;
    const uacRes = await runElevatedPowerShell(psScript, {
      signal: activeSignal,
      timeoutMs: 2 * 60 * 1000,
      onProgress: (pct, detail) => job?.update(pct, detail),
    });

    if (uacRes.canceled || uacRes.aborted) {
      job?.finish('canceled', 'Administrator-Bestätigung (UAC) abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: uacRes.code };
    }
    res = { ...res, code: uacRes.code, stdout: uacRes.stdout, stderr: uacRes.stderr, error: uacRes.error };
  }

  if (res.code === 0) {
    const verify = await runNvm(['list'], { signal: activeSignal, timeoutMs: 15000 });
    const parsed = parseNvmListOutput(verify.stdout);
    const activeEntry = parsed.find((p) => p.isActive);
    const activeConfirmed = activeEntry ? activeEntry.version === cleanVer : true;
    if (activeConfirmed) {
      job?.finish('done', `Node.js v${cleanVer} ist jetzt aktiv.`, { autoRemoveMs: 4000 });
      return { success: true, version: cleanVer, exitCode: 0 };
    }
  }

  const errMsg = (res.error || res.stderr || res.stdout || `nvm use fehlgeschlagen (Code ${res.code})`).trim();
  job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
  return { success: false, exitCode: res.code, error: errMsg };
}

export const nvmProvider = {
  id: 'nvm',
  name: 'NVM',
  category: 'runtime',
  description: 'Node.js-Versionsmanager für Windows (NVM for Windows)',
  requiresAdminForBootstrap: true,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning:
    'Achtung: Beim Deinstallieren von NVM for Windows können alle darüber verwalteten Node.js-Versionen entfernt werden.',
  capabilities: {
    search: true,
    listInstalled: true,
    listUpgrades: false,
    show: true,
    install: true,
    uninstall: true,
    supportsArchiveDownload: false,
  },

  checkAvailability: createCliAvailabilityChecker({
    binary: 'nvm',
    versionArgs: ['version'],
    extraPaths: getNvmExtraPaths,
    notFoundMessage: 'NVM for Windows ist auf diesem PC nicht installiert.',
  }),

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  installManager: createWingetBootstrapRunner({
    wingetId: 'CoreyButler.NVMforWindows',
    action: 'install',
    name: 'NVM for Windows',
  }),

  uninstallManager: createWingetBootstrapRunner({
    wingetId: 'CoreyButler.NVMforWindows',
    action: 'uninstall',
    name: 'NVM for Windows',
  }),

  useVersion: useNvmVersion,

  async search(query = '', { limit = 30, signal = null } = {}) {
    const res = await runNvm(['list', 'available'], { signal, timeoutMs: 45000 });
    if (res.aborted) return { success: false, results: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        results: [],
        error: res.error || res.stderr || 'NVM for Windows ist auf diesem PC nicht verfügbar.',
      };
    }

    const results = parseNvmListAvailableOutput(res.stdout, { query, limit });
    return {
      success: true,
      results,
      hint: results.length === 0 ? 'Keine passenden Node.js-Versionen gefunden.' : '',
    };
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runNvm(['list'], { signal, timeoutMs: 30000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        packages: [],
        error: res.error || res.stderr || 'nvm list fehlgeschlagen.',
      };
    }

    const packages = parseNvmListOutput(res.stdout);
    return { success: true, packages };
  },

  async show(packageId, { signal = null } = {}) {
    const cleanVer = normalizeNodeVersion(packageId);
    if (!isValidNvmVersion(cleanVer)) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: 'Ungültige Node.js-Version angegeben.',
      };
    }

    let isInstalled = false;
    let isActive = false;
    try {
      const listRes = await this.listInstalled({ signal });
      if (listRes.success) {
        const match = listRes.packages.find((p) => p.version === cleanVer);
        if (match) {
          isInstalled = true;
          isActive = Boolean(match.isActive);
        }
      }
    } catch {
      // Optionaler Status-Abgleich
    }

    const statusText = isActive
      ? 'Aktuell aktive Node.js-Version auf diesem PC.'
      : isInstalled
        ? 'Auf diesem PC über NVM for Windows installiert (derzeit inaktiv).'
        : 'Node.js-Runtime-Version zur Installation über NVM for Windows.';

    return {
      success: true,
      package: {
        name: `Node.js v${cleanVer}`,
        packageManager: 'nvm',
        packageId: cleanVer,
        version: cleanVer,
        isInstalled,
        isActive,
        publisher: 'OpenJS Foundation',
        author: 'Node.js Contributors',
        shortDescription: statusText,
        description: `${statusText}\nVerwaltet über NVM for Windows (nvm install / nvm use / nvm uninstall).`,
        homepage: 'https://nodejs.org/',
        repositoryUrl: 'https://github.com/nodejs/node',
        releaseNotesUrl: `https://github.com/nodejs/node/releases/tag/v${cleanVer}`,
        license: 'MIT',
        licenseUrl: 'https://github.com/nodejs/node/blob/main/LICENSE',
        tags: isActive ? ['nodejs', 'runtime', 'aktiv'] : ['nodejs', 'runtime'],
      },
      fromCache: false,
      isStale: false,
      updatedAt: Date.now(),
      error: null,
    };
  },

  async install(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanVer = normalizeNodeVersion(packageId);
    if (!isValidNvmVersion(cleanVer, { allowAliases: true })) {
      return { success: false, error: 'Ungültige Node.js-Version für NVM angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'nvm-install',
        title: `NVM-Installation: ${itemName || `Node.js v${cleanVer}`}`,
        dedupeKey: `nvm-install:${cleanVer.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'NVM-Installation läuft bereits.' };
      job.update(null, `Installiere Node.js ${cleanVer} via NVM...`);
    }

    const activeSignal = job ? job.signal : signal;
    const res = await runNvm(['install', cleanVer], { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', 'NVM-Installation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.notFound) {
      const msg = 'NVM for Windows ist auf diesem PC nicht verfügbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }
    if (res.code === 0) {
      job?.finish('done', `Node.js v${cleanVer} installiert.`, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `NVM-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanVer = normalizeNodeVersion(packageId);
    if (!isValidNvmVersion(cleanVer)) {
      return { success: false, error: 'Ungültige Node.js-Version für NVM angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'nvm-uninstall',
        title: `NVM-Deinstallation: ${itemName || `Node.js v${cleanVer}`}`,
        dedupeKey: `nvm-uninstall:${cleanVer.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'NVM-Deinstallation läuft bereits.' };
      job.update(null, `Entferne Node.js v${cleanVer} via NVM...`);
    }

    const res = await runNvm(['uninstall', cleanVer], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', 'NVM-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.code === 0) {
      job?.finish('done', `Node.js v${cleanVer} deinstalliert.`, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `NVM-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },
};
