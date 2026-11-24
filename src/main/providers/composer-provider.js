import path from 'node:path';
import {
  isValidComposerPackageName,
  parseComposerOutdatedJson,
  parseComposerShowJson,
  parsePackagistSearchJson,
  parsePackagistShowJson,
} from '../../shared/composer-parser.js';
import { normalizeProviderVersion } from '../../shared/provider-lifecycle-logic.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import { createCliAvailabilityChecker, createWingetBootstrapRunner } from './manager-bootstrap.js';
import { fetchRegistryJson } from './npm-registry-client.js';
import { getWingetCache } from './winget-provider.js';

const DEFAULT_TIMEOUT_MS = 60000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const PACKAGIST_BASE_URL = 'https://packagist.org';

function getComposerExtraPaths() {
  const candidates = ['C:\\ProgramData\\ComposerSetup\\bin\\composer.bat'];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Composer', 'vendor', 'bin', 'composer.bat'));
  }
  return candidates;
}

function parseComposerVersionOutput(stdout) {
  const clean = String(stdout || '').trim();
  if (!clean) return null;
  const match = clean.match(/Composer(?:\s+version)?\s+v?(\d+\.\d+\.\d+(?:[-+._a-z0-9]*)?)/i);
  if (match) return normalizeProviderVersion(match[1]);
  const semver = clean.match(/v?(\d+\.\d+\.\d+)/);
  return semver ? normalizeProviderVersion(semver[1]) : null;
}

async function runComposer(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const composerBin = await findBinaryPath(process.platform === 'win32' ? 'composer.bat' : 'composer', {
    signal,
    timeoutMs: 5000,
    extraPaths: getComposerExtraPaths(),
  });
  if (process.platform === 'win32' && !composerBin) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: Boolean(signal?.aborted),
      notFound: true,
      error: 'Composer ist auf diesem PC nicht verfügbar.',
      errorCode: 'ENOENT',
    };
  }
  return runCli(composerBin || 'composer', args, {
    signal,
    timeoutMs,
    windowsHide: true,
  });
}

async function fetchPackagistShowFresh(packageId, { signal = null } = {}) {
  const cleanId = String(packageId || '')
    .trim()
    .toLowerCase();
  if (!isValidComposerPackageName(cleanId)) {
    throw new Error(`Ungültiger Composer-Paketname: "${packageId}".`);
  }

  const [vendor, pkg] = cleanId.split('/');
  const url = `${PACKAGIST_BASE_URL}/packages/${encodeURIComponent(vendor)}/${encodeURIComponent(pkg)}.json`;
  const data = await fetchRegistryJson(url, { signal });
  const parsed = parsePackagistShowJson(data, cleanId);
  if (!parsed) {
    throw new Error(`Packagist-Paket "${cleanId}" konnte nicht geparst werden.`);
  }
  return parsed;
}

export const composerProvider = {
  id: 'composer',
  name: 'Composer',
  category: 'developer',
  description: 'PHP-Paketmanager für globale CLI-Tools (Packagist)',
  requiresAdminForBootstrap: true,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning:
    'Composer wird über Winget vom System entfernt. PHP und globale vendor-Ordner bleiben ggf. erhalten.',
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
    binary: process.platform === 'win32' ? 'composer.bat' : 'composer',
    versionArgs: ['--version'],
    extraPaths: getComposerExtraPaths,
    parseVersion: parseComposerVersionOutput,
    notFoundMessage: 'Composer ist auf diesem PC nicht installiert.',
  }),

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  installManager: createWingetBootstrapRunner({
    wingetId: 'Composer.Composer',
    action: 'install',
    name: 'Composer',
  }),

  uninstallManager: createWingetBootstrapRunner({
    wingetId: 'Composer.Composer',
    action: 'uninstall',
    name: 'Composer',
  }),

  async search(query, { limit = 25, signal = null } = {}) {
    const cleanQuery = String(query || '').trim();
    if (cleanQuery.length < 2) {
      return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
    }

    const perPage = Number.isFinite(limit) && limit > 0 ? Math.min(Math.max(Math.round(limit), 1), 50) : 25;
    const url = `${PACKAGIST_BASE_URL}/search.json?q=${encodeURIComponent(cleanQuery)}&per_page=${perPage}`;
    try {
      const data = await fetchRegistryJson(url, { signal });
      const results = parsePackagistSearchJson(data, limit);
      return {
        success: true,
        results,
        hint: results.length === 0 ? 'Keine Packagist-Treffer gefunden.' : '',
      };
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        return { success: false, results: [], canceled: true };
      }
      return { success: false, results: [], error: err?.message || 'Packagist-Suche fehlgeschlagen.' };
    }
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runComposer(['global', 'show', '--format=json'], { signal });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        packages: [],
        error: res.error || res.stderr || 'composer global show fehlgeschlagen.',
      };
    }

    const packages = parseComposerShowJson(res.stdout);
    return { success: true, packages };
  },

  async listUpgrades({ signal = null } = {}) {
    const res = await runComposer(['global', 'outdated', '--format=json'], { signal });
    if (res.aborted) return { success: false, upgrades: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        upgrades: [],
        error: res.error || res.stderr || 'composer global outdated fehlgeschlagen.',
      };
    }

    const upgrades = parseComposerOutdatedJson(res.stdout);
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
        error: 'Keine Composer-Paket-ID angegeben.',
      };
    }

    const cacheKey = `composer:show:${cleanId.toLowerCase()}`;
    const cache = getWingetCache();
    const res = await cache.getOrFetch(cacheKey, () => fetchPackagistShowFresh(cleanId, { signal }), { forceRefresh });

    if (!res.data) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: res.error || `Composer-Paket "${cleanId}" nicht gefunden.`,
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
    if (!isValidComposerPackageName(cleanId)) {
      return { success: false, error: 'Ungültiger Composer-Paketname angegeben (erwartet: vendor/package).' };
    }

    const cleanVer = String(version || '').trim();
    if (cleanVer && !/^[A-Za-z0-9._+-]+$/.test(cleanVer)) {
      return { success: false, error: 'Ungültige Versionsangabe.' };
    }

    const args =
      upgrade && !cleanVer
        ? ['global', 'update', cleanId, '--with-all-dependencies']
        : ['global', 'require', cleanVer ? `${cleanId}:${cleanVer}` : cleanId];

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'composer-upgrade' : 'composer-install',
        title: `Composer-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: `composer-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Composer-Aktion läuft bereits.' };
      job.update(
        null,
        upgrade
          ? `Aktualisiere ${itemName || cleanId} via Composer...`
          : `Installiere ${itemName || cleanId} via Composer...`
      );
    }

    const activeSignal = job ? job.signal : signal;
    const res = await runComposer(args, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', 'Composer-Aktion abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.notFound) {
      const msg = 'Composer ist auf diesem PC nicht verfügbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }
    if (res.code === 0) {
      const msg = upgrade ? 'Erfolgreich über Composer aktualisiert.' : 'Erfolgreich über Composer installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `Composer-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, { ...opts, upgrade: true });
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidComposerPackageName(cleanId)) {
      return { success: false, error: 'Ungültiger Composer-Paketname angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'composer-uninstall',
        title: `Composer-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `composer-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Composer-Deinstallation läuft bereits.' };
      job.update(null, `Deinstalliere ${itemName || cleanId} via Composer...`);
    }

    const res = await runComposer(['global', 'remove', cleanId], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', 'Composer-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.code === 0) {
      job?.finish('done', 'Erfolgreich über Composer deinstalliert.', { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `Composer-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },
};
