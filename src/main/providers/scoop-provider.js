import os from 'node:os';
import path from 'node:path';
import { normalizeProviderVersion } from '../../shared/provider-lifecycle-logic.js';
import {
  isValidSourceName,
  isValidSourceUrl,
  PROVIDER_SOURCE_TEMPLATES,
  parseScoopBucketListOutput,
} from '../../shared/provider-sources-parser.js';
import {
  parseScoopExportJson,
  parseScoopInfoOutput,
  parseScoopSearchOutput,
  parseScoopStatusOutput,
} from '../../shared/scoop-parser.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import { createCliAvailabilityChecker, createPowerShellBootstrapRunner } from './manager-bootstrap.js';
import { getWingetCache } from './winget-provider.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const VALID_SCOOP_ID_RE = /^[A-Za-z0-9._+/-]+$/;

function getScoopExtraPaths() {
  const candidates = [];
  if (process.env.SCOOP) {
    candidates.push(path.join(process.env.SCOOP, 'shims', 'scoop.cmd'));
  }
  candidates.push(path.join(os.homedir(), 'scoop', 'shims', 'scoop.cmd'));
  return candidates;
}

function parseScoopVersionOutput(stdout) {
  const clean = String(stdout || '').trim();
  if (!clean) return null;
  for (const line of clean.split(/\r?\n/)) {
    const match = line.trim().match(/v?(\d+\.\d+(?:\.\d+)*)/i);
    if (match) {
      return normalizeProviderVersion(match[1]);
    }
  }
  return null;
}

async function runScoop(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const scoopCmd = await findBinaryPath('scoop.cmd', {
    signal,
    timeoutMs: 5000,
    extraPaths: getScoopExtraPaths(),
  });
  if (process.platform === 'win32' && !scoopCmd) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: Boolean(signal?.aborted),
      notFound: true,
      error: 'Scoop ist auf diesem PC nicht verfügbar.',
      errorCode: 'ENOENT',
    };
  }
  return runCli(scoopCmd || 'scoop', args, {
    signal,
    timeoutMs,
    windowsHide: true,
  });
}

function normalizeScoopPackageRef(packageId, bucket = '') {
  const cleanId = String(packageId || '').trim();
  if (!cleanId || !VALID_SCOOP_ID_RE.test(cleanId)) return '';
  const cleanBucket = String(bucket || '').trim();
  if (cleanBucket && VALID_SCOOP_ID_RE.test(cleanBucket) && !cleanId.includes('/')) {
    return `${cleanBucket}/${cleanId}`;
  }
  return cleanId;
}

async function fetchScoopShowFresh(packageId, { signal = null } = {}) {
  const cleanId = String(packageId || '').trim();
  if (!cleanId || !VALID_SCOOP_ID_RE.test(cleanId)) {
    throw new Error('Ungültige Scoop-Paket-ID angegeben.');
  }

  const res = await runScoop(['info', cleanId], { signal });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (res.notFound) {
    throw new Error('Scoop ist auf diesem PC nicht verfügbar.');
  }

  const parsed = parseScoopInfoOutput(res.stdout, cleanId);
  if (res.code !== 0 || (!parsed.version && !parsed.description && !parsed.homepage)) {
    const errMsg = res.stderr || res.stdout || `Scoop-Paket "${cleanId}" konnte nicht abgerufen werden.`;
    throw new Error(errMsg.trim());
  }

  return parsed;
}

export const scoopProvider = {
  id: 'scoop',
  name: 'Scoop',
  category: 'system',
  description: 'Kommandozeilen-Installer für portable Windows-Tools (ohne Adminrechte)',
  requiresAdminForBootstrap: false,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning:
    'Achtung: Beim Deinstallieren von Scoop werden auch alle über Scoop installierten Programme und Buckets vollständig entfernt!',
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
    binary: 'scoop.cmd',
    versionArgs: ['--version'],
    extraPaths: getScoopExtraPaths,
    parseVersion: parseScoopVersionOutput,
    notFoundMessage: 'Scoop ist auf diesem PC nicht installiert.',
  }),

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  installManager: createPowerShellBootstrapRunner({
    script:
      'Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser -Force; Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression',
    requiresAdmin: false,
    label: 'Installiere Scoop (ohne Adminrechte)...',
  }),

  uninstallManager: createPowerShellBootstrapRunner({
    script: 'scoop uninstall scoop',
    requiresAdmin: false,
    label: 'Deinstalliere Scoop inkl. Scoop-Apps...',
  }),

  async search(query, { limit = 25, signal = null } = {}) {
    const cleanQuery = String(query || '').trim();
    if (cleanQuery.length < 2) {
      return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
    }

    const res = await runScoop(['search', cleanQuery], { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, results: [], canceled: true };
    if (res.notFound || (res.code === -1 && !res.stdout)) {
      return {
        success: false,
        results: [],
        error: res.error || res.stderr || 'Scoop ist auf diesem PC nicht verfügbar.',
      };
    }

    const results = parseScoopSearchOutput(res.stdout, limit);
    return {
      success: true,
      results,
      hint: results.length === 0 ? res.stderr || 'Keine Scoop-Treffer gefunden.' : '',
    };
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runScoop(['export'], { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return { success: false, packages: [], error: res.error || res.stderr || 'scoop export fehlgeschlagen.' };
    }

    const packages = parseScoopExportJson(res.stdout);
    return { success: true, packages };
  },

  async listUpgrades({ signal = null, refreshBuckets = false } = {}) {
    if (refreshBuckets) {
      const upd = await runScoop(['update'], { signal, timeoutMs: 120000 });
      if (upd.aborted) return { success: false, upgrades: [], canceled: true };
    }

    const res = await runScoop(['status'], { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, upgrades: [], canceled: true };
    if (res.notFound || (res.code === -1 && !res.stdout)) {
      return {
        success: false,
        upgrades: [],
        error: res.error || res.stderr || 'Scoop ist auf diesem PC nicht verfügbar.',
      };
    }

    const upgrades = parseScoopStatusOutput(res.stdout);
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
        error: 'Keine Scoop-Paket-ID angegeben.',
      };
    }

    const cacheKey = `scoop:show:${cleanId.toLowerCase()}`;
    const cache = getWingetCache();
    const res = await cache.getOrFetch(cacheKey, () => fetchScoopShowFresh(cleanId, { signal }), {
      forceRefresh,
    });

    if (!res.data) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: res.error || `Scoop-Paket "${cleanId}" nicht gefunden.`,
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

  async install(packageId, { upgrade = false, bucket = '', itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    const targetRef = normalizeScoopPackageRef(cleanId, bucket);
    if (!targetRef) {
      return { success: false, error: 'Ungültige Scoop-Paket-ID angegeben.' };
    }

    const args = upgrade ? ['update', cleanId.split('/').pop() || cleanId] : ['install', targetRef];

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'scoop-upgrade' : 'scoop-install',
        title: `Scoop-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: `scoop-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Scoop-Aktion läuft bereits.' };
      job.update(
        null,
        upgrade ? `Aktualisiere ${itemName || cleanId} via Scoop...` : `Installiere ${itemName || cleanId} via Scoop...`
      );
    }

    const activeSignal = job ? job.signal : signal;
    const res = await runScoop(args, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

    if (activeSignal?.aborted || res.aborted) {
      job?.finish('canceled', 'Scoop-Aktion abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }

    if (res.notFound) {
      const msg = 'Scoop ist auf diesem PC nicht verfügbar.';
      job?.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: msg };
    }

    if (res.code === 0) {
      const msg = upgrade ? 'Erfolgreich über Scoop aktualisiert.' : 'Erfolgreich über Scoop installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `Scoop-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, { ...opts, upgrade: true });
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!cleanId || !VALID_SCOOP_ID_RE.test(cleanId)) {
      return { success: false, error: 'Ungültige Scoop-Paket-ID angegeben.' };
    }
    const pkgName = cleanId.split('/').pop() || cleanId;

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'scoop-uninstall',
        title: `Scoop-Deinstallation: ${itemName || pkgName}`,
        dedupeKey: `scoop-uninstall:${pkgName.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Scoop-Deinstallation läuft bereits.' };
      job.update(null, `Deinstalliere ${itemName || pkgName} via Scoop...`);
    }

    const res = await runScoop(['uninstall', pkgName], { signal, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.aborted) {
      job?.finish('canceled', 'Scoop-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }

    if (res.code === 0) {
      job?.finish('done', 'Erfolgreich über Scoop deinstalliert.', { autoRemoveMs: 4000 });
      return { success: true, exitCode: 0 };
    }

    const errMsg = (res.stderr || res.stdout || res.error || `Scoop-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async listSources({ signal = null } = {}) {
    const res = await runScoop(['bucket', 'list'], { signal, timeoutMs: 30000 });
    if (res.aborted) return { success: false, canceled: true, sources: [] };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        sources: [],
        templates: PROVIDER_SOURCE_TEMPLATES.scoop,
        requiresAdmin: false,
        mode: 'cli',
        error: res.error || res.stderr || 'Scoop-Buckets konnten nicht abgerufen werden.',
      };
    }

    const sources = parseScoopBucketListOutput(res.stdout).map((bucket) => ({
      ...bucket,
      builtIn: false,
    }));
    return {
      success: true,
      mode: 'cli',
      requiresAdmin: false,
      sources,
      templates: PROVIDER_SOURCE_TEMPLATES.scoop,
      hint: 'Bekannte Scoop-Buckets wie "extras" oder "versions" koennen ohne URL per Klick hinzugefuegt werden.',
    };
  },

  async addSource({ name = '', url = '' } = {}, { signal = null } = {}) {
    const cleanName = String(name || '').trim();
    const cleanUrl = String(url || '').trim();
    if (!isValidSourceName(cleanName)) {
      return { success: false, error: 'Ungueltiger Bucket-Name (erlaubt: Buchstaben, Ziffern, . _ -).' };
    }
    if (cleanUrl && !isValidSourceUrl(cleanUrl)) {
      return {
        success: false,
        error: 'Bitte eine gueltige HTTP/HTTPS-Repository-URL angeben (oder leer fuer bekannte Buckets).',
      };
    }

    const args = cleanUrl ? ['bucket', 'add', cleanName, cleanUrl] : ['bucket', 'add', cleanName];
    const res = await runScoop(args, { signal, timeoutMs: 120000 });
    if (res.aborted) return { success: false, canceled: true };
    if (res.code === 0) return { success: true };
    return {
      success: false,
      error: (
        res.stderr ||
        res.stdout ||
        res.error ||
        `Scoop-Bucket "${cleanName}" konnte nicht hinzugefuegt werden.`
      ).trim(),
    };
  },

  async removeSource(name, { signal = null } = {}) {
    const cleanName = String(name || '').trim();
    if (!isValidSourceName(cleanName)) {
      return { success: false, error: 'Ungueltiger Bucket-Name.' };
    }

    const res = await runScoop(['bucket', 'rm', cleanName], { signal, timeoutMs: 45000 });
    if (res.aborted) return { success: false, canceled: true };
    if (res.code === 0) return { success: true };
    return {
      success: false,
      error: (
        res.stderr ||
        res.stdout ||
        res.error ||
        `Scoop-Bucket "${cleanName}" konnte nicht entfernt werden.`
      ).trim(),
    };
  },
};
