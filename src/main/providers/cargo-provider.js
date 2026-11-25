import os from 'node:os';
import path from 'node:path';
import {
  isValidCargoCrateName,
  parseCargoInstallListOutput,
  parseCargoVersionOutput,
  parseCratesIoSearchJson,
  parseCratesIoShowJson,
} from '../../shared/cargo-parser.js';
import { compareVersions } from '../../shared/version.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import { createCliAvailabilityChecker, createWingetBootstrapRunner } from './manager-bootstrap.js';
import { getWingetCache } from './winget-provider.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const CRATES_API_BASE = 'https://crates.io/api/v1';
const CRATES_USER_AGENT = 'SoftwareKatalogApp (https://github.com/RaptorXilef/SoftwareKatalogApp)';

function getCargoExtraPaths() {
  const candidates = [];
  if (process.env.CARGO_HOME) {
    candidates.push(path.join(process.env.CARGO_HOME, 'bin', 'cargo.exe'));
  }
  candidates.push(path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe'));
  return candidates;
}

async function runCargo(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cargoExe = await findBinaryPath('cargo.exe', {
    signal,
    timeoutMs: 5000,
    extraPaths: getCargoExtraPaths(),
  });
  return runCli(cargoExe || 'cargo', args, { signal, timeoutMs, windowsHide: true });
}

async function fetchCratesIoJson(url, { signal = null, timeoutMs = 15000 } = {}) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const onExternalAbort = () => controller.abort();
  if (signal) {
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': CRATES_USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`crates.io HTTP-Fehler ${res.status}`);
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

async function fetchCratesIoShowFresh(crateName, { signal = null } = {}) {
  const cleanName = String(crateName || '').trim();
  if (!isValidCargoCrateName(cleanName)) {
    throw new Error(`Ungueltiger Cargo-Crate-Name: "${cleanName}".`);
  }

  const url = `${CRATES_API_BASE}/crates/${encodeURIComponent(cleanName)}`;
  const data = await fetchCratesIoJson(url, { signal });
  const parsed = parseCratesIoShowJson(data, cleanName);
  if (!parsed) {
    throw new Error(`Crate "${cleanName}" konnte nicht geparst werden.`);
  }
  return parsed;
}

export const cargoProvider = {
  id: 'cargo',
  name: 'Cargo',
  category: 'developer',
  description: 'Rust-Paketmanager fuer installierte CLI-Crates (crates.io)',
  requiresAdminForBootstrap: false,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning: 'Achtung: Rustup (inkl. Cargo und Rust-Toolchains) wird ueber Winget vom System entfernt.',
  capabilities: {
    search: true,
    listInstalled: true,
    listUpgrades: true,
    listVersions: true,
    show: true,
    install: true,
    uninstall: true,
    supportsArchiveDownload: false,
  },

  checkAvailability: createCliAvailabilityChecker({
    binary: 'cargo.exe',
    versionArgs: ['--version'],
    extraPaths: getCargoExtraPaths,
    parseVersion: parseCargoVersionOutput,
    notFoundMessage: 'Rust Cargo ist auf diesem PC nicht installiert.',
  }),

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  installManager: createWingetBootstrapRunner({
    wingetId: 'Rustlang.Rustup',
    action: 'install',
    name: 'Rustup (Cargo)',
  }),

  uninstallManager: createWingetBootstrapRunner({
    wingetId: 'Rustlang.Rustup',
    action: 'uninstall',
    name: 'Rustup (Cargo)',
  }),

  async search(query, { limit = 20, signal = null } = {}) {
    const cleanQuery = String(query || '').trim();
    if (cleanQuery.length < 2) {
      return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
    }

    const perPage = Number.isFinite(limit) && limit > 0 ? Math.min(Math.max(Math.round(limit), 1), 50) : 20;
    const url = `${CRATES_API_BASE}/crates?q=${encodeURIComponent(cleanQuery)}&per_page=${perPage}`;

    try {
      const data = await fetchCratesIoJson(url, { signal });
      const results = parseCratesIoSearchJson(data, perPage);
      return {
        success: true,
        results,
        hint: results.length === 0 ? 'Keine crates.io-Treffer gefunden.' : '',
      };
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        return { success: false, results: [], canceled: true };
      }
      return { success: false, results: [], error: err?.message || 'crates.io-Suche fehlgeschlagen.' };
    }
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runCargo(['install', '--list'], { signal, timeoutMs: 45000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        packages: [],
        error: res.error || res.stderr || 'cargo install --list fehlgeschlagen.',
      };
    }

    const packages = parseCargoInstallListOutput(res.stdout);
    return { success: true, packages };
  },

  async listUpgrades({ signal = null } = {}) {
    const installed = await this.listInstalled({ signal });
    if (installed.canceled) return { success: false, upgrades: [], canceled: true };
    if (!installed.success) return { success: false, upgrades: [], error: installed.error };

    const list = installed.packages.filter((p) => isValidCargoCrateName(p.packageId));
    if (list.length === 0) return { success: true, upgrades: [] };

    const upgrades = [];
    const executing = new Set();
    const concurrency = 2; // Konservativ gemaess crates.io API-Richtlinie

    for (const pkg of list) {
      if (signal?.aborted) break;
      const task = (async () => {
        try {
          const latest = await fetchCratesIoShowFresh(pkg.packageId, { signal });
          if (!latest?.version) return;
          const isOutdated = pkg.version ? compareVersions(latest.version, pkg.version, 4) > 0 : false;
          if (isOutdated) {
            upgrades.push({
              packageManager: 'cargo',
              packageId: pkg.packageId,
              id: pkg.packageId,
              name: pkg.name || pkg.packageId,
              installedVersion: pkg.version,
              availableVersion: latest.version,
              source: 'cargo',
            });
          }
        } catch {
          // Einzelne API-Fehler blockieren keine weiteren Checks
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
        error: 'Keine Cargo-Crate-ID angegeben.',
      };
    }

    const cacheKey = `cargo:show:${cleanId.toLowerCase()}`;
    const cache = getWingetCache();
    const res = await cache.getOrFetch(cacheKey, () => fetchCratesIoShowFresh(cleanId, { signal }), { forceRefresh });

    if (!res.data) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: res.error || `Crate "${cleanId}" nicht gefunden.`,
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

  async listVersions(packageId, { forceRefresh = false, signal = null } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidCargoCrateName(cleanId)) {
      return { success: false, versions: [], error: 'Ungueltiger Cargo-Crate-Name angegeben.' };
    }
    const cacheKey = `cargo:versions:${cleanId.toLowerCase()}`;
    const cache = getWingetCache();
    if (!forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached?.data && Array.isArray(cached.data) && Date.now() - Number(cached.updatedAt || 0) < 15 * 60 * 1000) {
        return { success: true, versions: cached.data, fromCache: true };
      }
    }
    try {
      const data = await fetchCratesIoJson(`${CRATES_API_BASE}/crates/${encodeURIComponent(cleanId)}`, { signal });
      const versions = Array.isArray(data?.versions)
        ? data.versions
            .filter((v) => !v?.yanked)
            .map((v) => String(v?.num || '').trim())
            .filter(Boolean)
            .sort((a, b) => compareVersions(b, a, 0) || b.localeCompare(a, 'en', { numeric: true }))
        : [];
      if (versions.length > 0) cache.set(cacheKey, versions);
      return { success: true, versions, fromCache: false };
    } catch (err) {
      return { success: false, versions: [], error: err?.message || 'Crate-Versionen konnten nicht geladen werden.' };
    }
  },

  async install(packageId, { upgrade = false, version = '', itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidCargoCrateName(cleanId)) {
      return { success: false, error: 'Ungueltiger Cargo-Crate-Name angegeben.' };
    }

    const cleanVer = String(version || '').trim();
    if (cleanVer && !/^[A-Za-z0-9._+-]+$/.test(cleanVer)) {
      return { success: false, error: 'Ungueltige Versionsangabe.' };
    }

    const args = ['install', cleanId];
    if (cleanVer) {
      args.push('--version', cleanVer);
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'cargo-upgrade' : 'cargo-install',
        title: `Cargo-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: `cargo-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Cargo-Aktion laeuft bereits.' };
      job.update(
        null,
        upgrade
          ? `Kompiliere & aktualisiere ${itemName || cleanId} via Cargo...`
          : `Kompiliere & installiere ${itemName || cleanId} via Cargo...`
      );
    }

    const activeSignal = job ? job.signal : signal;
    const res = await runCargo(args, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', 'Cargo-Aktion abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.notFound) {
      const msg = 'Rust Cargo ist auf diesem PC nicht verfuegbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }
    if (res.code === 0) {
      const msg = upgrade ? 'Erfolgreich ueber Cargo aktualisiert.' : 'Erfolgreich ueber Cargo installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `Cargo-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, { ...opts, upgrade: true });
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidCargoCrateName(cleanId)) {
      return { success: false, error: 'Ungueltiger Cargo-Crate-Name angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'cargo-uninstall',
        title: `Cargo-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `cargo-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Cargo-Deinstallation laeuft bereits.' };
      job.update(null, `Deinstalliere ${itemName || cleanId} via Cargo...`);
    }

    const res = await runCargo(['uninstall', cleanId], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', 'Cargo-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }
    if (res.code === 0) {
      job?.finish('done', 'Erfolgreich ueber Cargo deinstalliert.', { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `Cargo-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },
};
