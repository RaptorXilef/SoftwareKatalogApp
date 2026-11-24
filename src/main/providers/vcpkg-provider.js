import fs from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';
import {
  extractVcpkgBasePort,
  isSafeVcpkgUninstallDir,
  isValidVcpkgPortName,
  parseVcpkgListOutput,
  parseVcpkgManifestJson,
  parseVcpkgSearchOutput,
  parseVcpkgUpgradeOutput,
  parseVcpkgVersionOutput,
} from '../../shared/vcpkg-parser.js';
import { getConfig, saveConfig } from '../config.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import { getWingetCache } from './winget-provider.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const VCPKG_REPO_URL = 'https://github.com/microsoft/vcpkg.git';

async function resolveVcpkgLocation(signal = null) {
  const cfgRoot = String(getConfig().providerSettings?.vcpkgRoot || '').trim();
  const envRoot = String(process.env.VCPKG_ROOT || '').trim();

  for (const candidateRoot of [cfgRoot, envRoot]) {
    if (!candidateRoot) continue;
    const normalizedRoot = path.resolve(candidateRoot);
    const exePath = path.join(normalizedRoot, 'vcpkg.exe');
    try {
      if (fs.existsSync(exePath) && fs.statSync(exePath).isFile()) {
        return { binaryPath: exePath, rootDir: normalizedRoot };
      }
    } catch {
      // Weiter pruefen
    }
  }

  const fromPath = await findBinaryPath('vcpkg.exe', { signal, timeoutMs: 5000 });
  if (fromPath) {
    return { binaryPath: fromPath, rootDir: path.dirname(fromPath) };
  }

  const fallbackRoot = cfgRoot ? path.resolve(cfgRoot) : envRoot ? path.resolve(envRoot) : '';
  return { binaryPath: null, rootDir: fallbackRoot };
}

async function runVcpkg(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { binaryPath, rootDir } = await resolveVcpkgLocation(signal);
  if (!binaryPath) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: Boolean(signal?.aborted),
      notFound: true,
      error: 'vcpkg ist auf diesem PC nicht verfuegbar (VCPKG_ROOT oder PATH pruefen).',
      errorCode: 'ENOENT',
    };
  }

  const env = rootDir ? { ...process.env, VCPKG_ROOT: rootDir } : process.env;
  return runCli(binaryPath, args, { signal, timeoutMs, env, windowsHide: true });
}

async function fetchVcpkgShowFresh(packageId, { signal = null } = {}) {
  const basePort = extractVcpkgBasePort(packageId);
  if (!basePort || !isValidVcpkgPortName(basePort)) {
    throw new Error(`Ungueltiger vcpkg-Port-Name: "${packageId}".`);
  }

  const { rootDir } = await resolveVcpkgLocation(signal);
  if (rootDir) {
    const manifestPath = path.join(rootDir, 'ports', basePort, 'vcpkg.json');
    if (fs.existsSync(manifestPath)) {
      const raw = await fs.promises.readFile(manifestPath, 'utf-8');
      const parsed = parseVcpkgManifestJson(raw, packageId);
      if (parsed) return parsed;
    }
  }

  const res = await runVcpkg(['search', basePort], { signal, timeoutMs: 30000 });
  if (res.notFound) {
    throw new Error('vcpkg ist auf diesem PC nicht verfuegbar.');
  }
  const matches = parseVcpkgSearchOutput(res.stdout, 20);
  const exact = matches.find((m) => m.packageId.toLowerCase() === basePort.toLowerCase()) || matches[0];
  if (!exact) {
    throw new Error(`vcpkg-Port "${basePort}" nicht gefunden.`);
  }

  return {
    name: exact.name,
    packageManager: 'vcpkg',
    packageId: packageId || exact.packageId,
    version: exact.version,
    publisher: 'Microsoft vcpkg',
    author: '',
    shortDescription: exact.shortDescription,
    description: exact.description,
    homepage: exact.homepage,
    repositoryUrl: 'https://github.com/microsoft/vcpkg',
    license: '',
    licenseUrl: '',
    tags: [],
  };
}

export const vcpkgProvider = {
  id: 'vcpkg',
  name: 'vcpkg',
  category: 'developer',
  description: 'C/C++-Paketmanager von Microsoft (VCPKG_ROOT oder PATH)',
  requiresAdminForBootstrap: false,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning: '',
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
    try {
      const { binaryPath, rootDir } = await resolveVcpkgLocation(signal);
      if (!binaryPath) {
        return {
          available: false,
          version: null,
          binaryPath: null,
          error: 'vcpkg wurde weder unter VCPKG_ROOT noch im PATH gefunden.',
        };
      }
      const env = rootDir ? { ...process.env, VCPKG_ROOT: rootDir } : process.env;
      const res = await runCli(binaryPath, ['--version'], { signal, timeoutMs: 10000, env, windowsHide: true });
      if (res.notFound || res.code !== 0) {
        return {
          available: false,
          version: null,
          binaryPath: null,
          error: res.error || res.stderr || 'vcpkg konnte nicht ausgefuehrt werden.',
        };
      }
      return {
        available: true,
        version: parseVcpkgVersionOutput(res.stdout),
        binaryPath,
        error: null,
      };
    } catch (err) {
      return {
        available: false,
        version: null,
        binaryPath: null,
        error: err?.message || 'Fehler beim Pruefen von vcpkg.',
      };
    }
  },

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  async installManager({ signal = null, onProgress = null } = {}) {
    onProgress?.(5, 'Pruefe Git-Verfuegbarkeit...');
    const gitBin = await findBinaryPath('git.exe', { signal, timeoutMs: 5000 });
    const gitCheck = await runCli(gitBin || 'git', ['--version'], { signal, timeoutMs: 8000, windowsHide: true });
    if (gitCheck.aborted) return { success: false, canceled: true };
    if (gitCheck.notFound || gitCheck.code !== 0) {
      return {
        success: false,
        error:
          'Git ist auf diesem PC nicht installiert. Bitte installiere zuerst Git (z. B. ueber Winget: Git.Git), um vcpkg zu klonen.',
      };
    }

    const configuredRoot = String(getConfig().providerSettings?.vcpkgRoot || '').trim();
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Zielordner fuer vcpkg-Installation auswaehlen',
      defaultPath: configuredRoot || undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths?.length) {
      return { success: false, canceled: true };
    }

    const chosenDir = path.resolve(filePaths[0]);
    let targetDir = chosenDir;
    try {
      const entries = await fs.promises.readdir(chosenDir);
      const hasBootstrap = entries.some((name) => name.toLowerCase() === 'bootstrap-vcpkg.bat');
      if (entries.length > 0 && !hasBootstrap) {
        targetDir = path.join(chosenDir, 'vcpkg');
      }
    } catch {
      targetDir = path.join(chosenDir, 'vcpkg');
    }

    const bootstrapBat = path.join(targetDir, 'bootstrap-vcpkg.bat');
    if (!fs.existsSync(bootstrapBat)) {
      onProgress?.(20, `Klone vcpkg nach ${targetDir}...`);
      const cloneRes = await runCli(gitBin || 'git', ['clone', VCPKG_REPO_URL, targetDir], {
        signal,
        timeoutMs: 15 * 60 * 1000,
        windowsHide: true,
      });
      if (cloneRes.aborted) return { success: false, canceled: true };
      if (cloneRes.code !== 0) {
        return {
          success: false,
          error: (cloneRes.stderr || cloneRes.stdout || cloneRes.error || 'git clone vcpkg fehlgeschlagen.').trim(),
        };
      }
    }

    if (!fs.existsSync(bootstrapBat)) {
      return { success: false, error: `bootstrap-vcpkg.bat wurde in "${targetDir}" nicht gefunden.` };
    }

    onProgress?.(60, 'Fuehre bootstrap-vcpkg.bat aus...');
    const bootRes = await runCli(bootstrapBat, ['-disableMetrics'], {
      cwd: targetDir,
      signal,
      timeoutMs: 15 * 60 * 1000,
      windowsHide: true,
    });
    if (bootRes.aborted) return { success: false, canceled: true };
    if (bootRes.code !== 0) {
      return {
        success: false,
        error: (
          bootRes.stderr ||
          bootRes.stdout ||
          bootRes.error ||
          `bootstrap-vcpkg.bat fehlgeschlagen (Code ${bootRes.code}).`
        ).trim(),
      };
    }

    saveConfig({ providerSettings: { vcpkgRoot: targetDir } });
    return { success: true, vcpkgRoot: targetDir };
  },

  async uninstallManager({ signal = null, onProgress = null } = {}) {
    const { binaryPath, rootDir } = await resolveVcpkgLocation(signal);
    const targetDir = rootDir || (binaryPath ? path.dirname(binaryPath) : '');
    if (!targetDir || !fs.existsSync(targetDir)) {
      return { success: false, error: 'Kein vcpkg-Installationsordner zum Entfernen gefunden.' };
    }
    if (!isSafeVcpkgUninstallDir(targetDir)) {
      return {
        success: false,
        error: `Sicherheitsabbruch: Ordner "${targetDir}" darf nicht automatisch geloescht werden.`,
      };
    }

    const hasMarker = ['vcpkg.exe', 'bootstrap-vcpkg.bat', '.vcpkg-root'].some((marker) =>
      fs.existsSync(path.join(targetDir, marker))
    );
    if (!hasMarker) {
      return {
        success: false,
        error: `Ordner "${targetDir}" enthaelt keine gueltige vcpkg-Installation.`,
      };
    }

    onProgress?.(40, `Entferne vcpkg-Ordner ${targetDir}...`);
    await fs.promises.rm(targetDir, { recursive: true, force: true });

    const cfgRoot = String(getConfig().providerSettings?.vcpkgRoot || '').trim();
    if (cfgRoot && path.resolve(cfgRoot).toLowerCase() === path.resolve(targetDir).toLowerCase()) {
      saveConfig({ providerSettings: { vcpkgRoot: '' } });
    }
    return { success: true };
  },

  async search(query, { limit = 25, signal = null } = {}) {
    const cleanQuery = String(query || '').trim();
    if (cleanQuery.length < 2) {
      return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
    }
    if (/[\r\n]/.test(cleanQuery)) {
      return { success: false, results: [], error: 'Ungueltiger Suchbegriff.' };
    }

    const res = await runVcpkg(['search', cleanQuery], { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, results: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        results: [],
        error: res.error || res.stderr || 'vcpkg search fehlgeschlagen.',
      };
    }

    const results = parseVcpkgSearchOutput(res.stdout, limit);
    return {
      success: true,
      results,
      hint: results.length === 0 ? 'Keine vcpkg-Ports gefunden.' : '',
    };
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runVcpkg(['list'], { signal, timeoutMs: 45000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        packages: [],
        error: res.error || res.stderr || 'vcpkg list fehlgeschlagen.',
      };
    }

    const packages = parseVcpkgListOutput(res.stdout);
    return { success: true, packages };
  },

  async listUpgrades({ signal = null } = {}) {
    const res = await runVcpkg(['upgrade'], { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, upgrades: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        upgrades: [],
        error: res.error || res.stderr || 'vcpkg upgrade-Pruefung fehlgeschlagen.',
      };
    }

    const upgrades = parseVcpkgUpgradeOutput(res.stdout);
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
        error: 'Kein vcpkg-Port angegeben.',
      };
    }

    const basePort = extractVcpkgBasePort(cleanId) || cleanId;
    const cacheKey = `vcpkg:show:${basePort.toLowerCase()}`;
    const cache = getWingetCache();
    const res = await cache.getOrFetch(cacheKey, () => fetchVcpkgShowFresh(cleanId, { signal }), { forceRefresh });

    if (!res.data) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: res.error || `vcpkg-Port "${cleanId}" nicht gefunden.`,
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

  async install(packageId, { upgrade = false, itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!upgrade && !isValidVcpkgPortName(cleanId)) {
      return { success: false, error: 'Ungueltiger vcpkg-Port-Name angegeben.' };
    }

    const args = upgrade ? ['upgrade', '--no-dry-run'] : ['install', cleanId];

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'vcpkg-upgrade' : 'vcpkg-install',
        title: `vcpkg-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: upgrade ? 'vcpkg-upgrade' : `vcpkg-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'vcpkg-Aktion laeuft bereits.' };
      job.update(
        null,
        upgrade ? 'Aktualisiere vcpkg-Pakete (--no-dry-run)...' : `Installiere ${itemName || cleanId} via vcpkg...`
      );
    }

    const activeSignal = job ? job.signal : signal;
    const res = await runVcpkg(args, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', 'vcpkg-Aktion abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.notFound) {
      const msg = 'vcpkg ist auf diesem PC nicht verfuegbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }
    if (res.code === 0) {
      const msg = upgrade ? 'Erfolgreich ueber vcpkg aktualisiert.' : 'Erfolgreich ueber vcpkg installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `vcpkg-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, { ...opts, upgrade: true });
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidVcpkgPortName(cleanId)) {
      return { success: false, error: 'Ungueltiger vcpkg-Port-Name angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'vcpkg-uninstall',
        title: `vcpkg-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `vcpkg-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'vcpkg-Deinstallation laeuft bereits.' };
      job.update(null, `Entferne ${itemName || cleanId} via vcpkg...`);
    }

    const res = await runVcpkg(['remove', cleanId], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', 'vcpkg-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.code === 0) {
      job?.finish('done', 'Erfolgreich ueber vcpkg entfernt.', { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `vcpkg-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },
};
