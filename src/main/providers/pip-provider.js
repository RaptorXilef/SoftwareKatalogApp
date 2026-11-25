import fs from 'node:fs';
import path from 'node:path';
import {
  isValidPythonPackageName,
  parsePipListJson,
  parsePipOutdatedJson,
  parsePipVersionOutput,
} from '../../shared/python-parser.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import {
  createConfigSourceManager,
  getAdditionalCustomRegistryUrls,
  getPrimaryCustomRegistryUrl,
} from './config-sources-helper.js';
import { createWingetBootstrapRunner } from './manager-bootstrap.js';
import { searchPyPiPackages, showPyPiPackage } from './pypi-client.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const pipSourceManager = createConfigSourceManager({
  providerId: 'pip',
  defaultSource: { name: 'pypi', url: 'https://pypi.org/simple' },
});

function getPythonExtraPaths() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    const pyRoot = path.join(process.env.LOCALAPPDATA, 'Programs', 'Python');
    try {
      if (fs.existsSync(pyRoot)) {
        const dirs = fs.readdirSync(pyRoot).sort().reverse();
        for (const dir of dirs) {
          candidates.push(path.join(pyRoot, dir, 'python.exe'));
        }
      }
    } catch {
      // Ignorieren
    }
  }
  return candidates;
}

function getPyLauncherExtraPaths() {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return [path.join(systemRoot, 'py.exe')];
}

function buildPythonEnv() {
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
}

async function resolvePipCommand(signal = null) {
  const pythonBin = await findBinaryPath('python.exe', {
    signal,
    timeoutMs: 5000,
    extraPaths: getPythonExtraPaths(),
  });
  const pyCheck = await runCli(pythonBin || 'python', ['-m', 'pip', '--version'], {
    signal,
    timeoutMs: 8000,
    env: buildPythonEnv(),
    windowsHide: true,
  });
  if (pyCheck.code === 0 && !pyCheck.notFound) {
    return {
      executable: pythonBin || 'python',
      checkRes: pyCheck,
    };
  }

  const pyLauncherBin = await findBinaryPath('py.exe', {
    signal,
    timeoutMs: 5000,
    extraPaths: getPyLauncherExtraPaths(),
  });
  const launcherCheck = await runCli(pyLauncherBin || 'py', ['-m', 'pip', '--version'], {
    signal,
    timeoutMs: 8000,
    env: buildPythonEnv(),
    windowsHide: true,
  });
  if (launcherCheck.code === 0 && !launcherCheck.notFound) {
    return {
      executable: pyLauncherBin || 'py',
      checkRes: launcherCheck,
    };
  }

  return {
    executable: pythonBin || pyLauncherBin || null,
    checkRes: pyCheck.notFound ? launcherCheck : pyCheck,
  };
}

async function runPip(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const resolved = await resolvePipCommand(signal);
  if (!resolved.executable || resolved.checkRes.notFound) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: Boolean(signal?.aborted),
      notFound: true,
      error: 'Python / pip ist auf diesem PC nicht verfuegbar.',
      errorCode: 'ENOENT',
    };
  }
  return runCli(resolved.executable, ['-m', 'pip', ...args], {
    signal,
    timeoutMs,
    env: buildPythonEnv(),
    windowsHide: true,
  });
}

export const pipProvider = {
  id: 'pip',
  name: 'pip',
  category: 'developer',
  description: 'Python-Paketmanager fuer Pakete aus dem PyPI-Index (python -m pip)',
  requiresAdminForBootstrap: false,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning: 'Achtung: Python 3.13 (inkl. pip) wird ueber Winget vom System entfernt.',
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

  async checkAvailability({ signal = null } = {}) {
    try {
      const { executable, checkRes } = await resolvePipCommand(signal);
      if (!executable || checkRes.notFound || checkRes.code !== 0) {
        return {
          available: false,
          version: null,
          binaryPath: null,
          error: checkRes?.error || checkRes?.stderr || 'Python / pip ist auf diesem PC nicht installiert.',
        };
      }
      return {
        available: true,
        version: parsePipVersionOutput(checkRes.stdout),
        binaryPath: executable,
        error: null,
      };
    } catch (err) {
      return {
        available: false,
        version: null,
        binaryPath: null,
        error: err?.message || 'Fehler beim Pruefen von pip.',
      };
    }
  },

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  installManager: createWingetBootstrapRunner({
    wingetId: 'Python.Python.3.13',
    action: 'install',
    name: 'Python 3.13 (pip)',
  }),

  uninstallManager: createWingetBootstrapRunner({
    wingetId: 'Python.Python.3.13',
    action: 'uninstall',
    name: 'Python 3.13 (pip)',
  }),

  async search(query, { limit = 25, signal = null } = {}) {
    return searchPyPiPackages(query, {
      limit,
      signal,
      packageManager: 'pip',
      indexUrl: getPrimaryCustomRegistryUrl('pip'),
    });
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runPip(['list', '--format=json'], { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        packages: [],
        error: res.error || res.stderr || 'python -m pip list fehlgeschlagen.',
      };
    }

    const packages = parsePipListJson(res.stdout);
    return { success: true, packages };
  },

  async listUpgrades({ signal = null } = {}) {
    const primaryIndex = getPrimaryCustomRegistryUrl('pip');
    const extraIndices = getAdditionalCustomRegistryUrls('pip');
    const args = ['list', '--outdated', '--format=json'];
    if (primaryIndex) args.push('--index-url', primaryIndex);
    for (const extra of extraIndices) args.push('--extra-index-url', extra);

    const res = await runPip(args, { signal, timeoutMs: 90000 });
    if (res.aborted) return { success: false, upgrades: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        upgrades: [],
        error: res.error || res.stderr || 'python -m pip list --outdated fehlgeschlagen.',
      };
    }

    const upgrades = parsePipOutdatedJson(res.stdout);
    return { success: true, upgrades };
  },

  async show(packageId, { forceRefresh = false, signal = null } = {}) {
    return showPyPiPackage(packageId, {
      packageManager: 'pip',
      forceRefresh,
      signal,
      indexUrl: getPrimaryCustomRegistryUrl('pip'),
    });
  },

  async listVersions(packageId, { forceRefresh = false, signal = null } = {}) {
    const { listPyPiPackageVersions } = await import('./pypi-client.js');
    return listPyPiPackageVersions(packageId, {
      indexUrl: getPrimaryCustomRegistryUrl('pip'),
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

    const spec = cleanVer ? `${cleanId}==${cleanVer}` : cleanId;
    const args = ['install', '--upgrade'];
    const primaryIndex = getPrimaryCustomRegistryUrl('pip');
    const extraIndices = getAdditionalCustomRegistryUrls('pip');
    if (primaryIndex) args.push('--index-url', primaryIndex);
    for (const extra of extraIndices) args.push('--extra-index-url', extra);
    args.push(spec);

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'pip-upgrade' : 'pip-install',
        title: `pip-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: `pip-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'pip-Aktion laeuft bereits.' };
      job.update(
        null,
        upgrade ? `Aktualisiere ${itemName || cleanId} via pip...` : `Installiere ${itemName || cleanId} via pip...`
      );
    }

    const activeSignal = job ? job.signal : signal;
    const res = await runPip(args, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', 'pip-Aktion abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.notFound) {
      const msg = 'Python / pip ist auf diesem PC nicht verfuegbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }
    if (res.code === 0) {
      const msg = upgrade ? 'Erfolgreich ueber pip aktualisiert.' : 'Erfolgreich ueber pip installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `pip-Fehlercode ${res.code}`).trim();
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
        type: 'pip-uninstall',
        title: `pip-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `pip-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'pip-Deinstallation laeuft bereits.' };
      job.update(null, `Deinstalliere ${itemName || cleanId} via pip...`);
    }

    const res = await runPip(['uninstall', '-y', cleanId], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', 'pip-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.code === 0) {
      job?.finish('done', 'Erfolgreich ueber pip deinstalliert.', { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `pip-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  ...pipSourceManager,
};
