import { isValidNpmPackageName, parseNpmSearchJson, parseNpmShowJson } from '../../shared/npm-parser.js';
import { normalizeSourceUrl } from '../../shared/provider-sources-parser.js';
import { compareVersions } from '../../shared/version.js';
import { getWingetCache } from './winget-provider.js';

const REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const DEFAULT_FETCH_TIMEOUT_MS = 15000;

function resolveRegistryBaseUrl(registryUrl) {
  const clean = normalizeSourceUrl(registryUrl);
  return clean || REGISTRY_BASE_URL;
}

/**
 * Lädt JSON mit AbortSignal-Unterstützung und festem Timeout.
 * @param {string} url
 * @param {{ signal?: AbortSignal | null, timeoutMs?: number }} [options]
 */
export async function fetchRegistryJson(url, { signal = null, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
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
        'User-Agent': 'SoftwareKatalogApp',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Registry-HTTP-Fehler ${res.status} (${url})`);
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Durchsucht die npm-Registry (`/-/v1/search`).
 * @param {string} query
 * @param {{ limit?: number, signal?: AbortSignal | null, packageManager?: string, registryUrl?: string }} [options]
 */
export async function searchNpmRegistry(
  query,
  { limit = 25, signal = null, packageManager = 'npm', registryUrl = '' } = {}
) {
  const cleanQuery = String(query || '').trim();
  if (cleanQuery.length < 2) {
    return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
  }

  const base = resolveRegistryBaseUrl(registryUrl);
  const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.max(Math.round(limit), 1), 50) : 25;
  const url = `${base}/-/v1/search?text=${encodeURIComponent(cleanQuery)}&size=${size}`;

  const data = await fetchRegistryJson(url, { signal });
  const results = parseNpmSearchJson(data, limit, { packageManager });
  return {
    success: true,
    results,
    hint: results.length === 0 ? `Keine ${packageManager}-Treffer in der Registry gefunden.` : '',
  };
}

/**
 * Ruft aktuelle Paketmetadaten direkt von `registry.npmjs.org` (oder Custom-Registry) ab.
 * Für Scoped-Pakete (`@scope/pkg`) wird das volle Packument geladen, da `/latest` dort oft HTTP 405 liefert.
 * @param {string} packageId
 * @param {{ signal?: AbortSignal | null, packageManager?: string, registryUrl?: string }} [options]
 */
async function fetchNpmPackageLatest(packageId, { signal = null, packageManager = 'npm', registryUrl = '' } = {}) {
  const cleanId = String(packageId || '').trim();
  if (!isValidNpmPackageName(cleanId)) {
    throw new Error(`Ungültiger Paketname: "${cleanId}".`);
  }

  const base = resolveRegistryBaseUrl(registryUrl);
  const encoded = encodeURIComponent(cleanId);
  const url = cleanId.startsWith('@') ? `${base}/${encoded}` : `${base}/${encoded}/latest`;

  const payload = await fetchRegistryJson(url, { signal });
  const parsed = parseNpmShowJson(payload, cleanId, { packageManager });
  if (!parsed) {
    throw new Error(`Paket "${cleanId}" konnte nicht geparst werden.`);
  }
  return parsed;
}

/**
 * Laedt verfuegbare Versionen eines Pakets aus der npm-Registry (absteigend sortiert).
 * @param {string} packageId
 * @param {{ registryUrl?: string, forceRefresh?: boolean, signal?: AbortSignal | null }} [options]
 */
export async function listNpmRegistryVersions(
  packageId,
  { registryUrl = '', forceRefresh = false, signal = null } = {}
) {
  const cleanId = String(packageId || '').trim();
  if (!isValidNpmPackageName(cleanId)) {
    return { success: false, versions: [], error: `Ungültiger Paketname: "${cleanId}".` };
  }

  const base = resolveRegistryBaseUrl(registryUrl);
  const cacheKey = `npm-registry:versions:${base.toLowerCase()}:${cleanId.toLowerCase()}`;
  const cache = getWingetCache();
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached?.data && Array.isArray(cached.data) && Date.now() - Number(cached.updatedAt || 0) < 15 * 60 * 1000) {
      return { success: true, versions: cached.data, fromCache: true };
    }
  }

  try {
    const encoded = encodeURIComponent(cleanId);
    const payload = await fetchRegistryJson(`${base}/${encoded}`, { signal });
    const rawVersions = payload?.versions && typeof payload.versions === 'object' ? Object.keys(payload.versions) : [];
    const stable = [];
    const pre = [];
    for (const v of rawVersions) {
      if (v.includes('-')) pre.push(v);
      else stable.push(v);
    }
    stable.sort((a, b) => compareVersions(b, a, 0) || b.localeCompare(a, 'en', { numeric: true }));
    pre.sort((a, b) => compareVersions(b, a, 0) || b.localeCompare(a, 'en', { numeric: true }));
    const versions = [...stable, ...pre];
    if (versions.length > 0) cache.set(cacheKey, versions);
    return { success: true, versions, fromCache: false };
  } catch (err) {
    return { success: false, versions: [], error: err?.message || 'Versionen konnten nicht abgerufen werden.' };
  }
}

/**
 * Liefert Paketdetails über den 7-Tage-Offline-Cache (`userData/provider-cache.json`).
 * @param {string} packageId
 * @param {{ packageManager?: string, forceRefresh?: boolean, signal?: AbortSignal | null, registryUrl?: string }} [options]
 */
export async function showNpmRegistryPackage(
  packageId,
  { packageManager = 'npm', forceRefresh = false, signal = null, registryUrl = '' } = {}
) {
  const cleanId = String(packageId || '').trim();
  if (!cleanId) {
    return {
      success: false,
      package: null,
      fromCache: false,
      isStale: false,
      updatedAt: null,
      error: 'Keine Paket-ID angegeben.',
    };
  }

  const base = resolveRegistryBaseUrl(registryUrl);
  const cacheKey =
    base === REGISTRY_BASE_URL
      ? `npm-registry:show:${cleanId.toLowerCase()}`
      : `npm-registry:show:${base.toLowerCase()}:${cleanId.toLowerCase()}`;
  const cache = getWingetCache();
  const res = await cache.getOrFetch(
    cacheKey,
    () => fetchNpmPackageLatest(cleanId, { signal, packageManager: 'npm', registryUrl: base }),
    { forceRefresh }
  );

  if (!res.data) {
    return {
      success: false,
      package: null,
      fromCache: false,
      isStale: false,
      updatedAt: null,
      error: res.error || `Paket "${cleanId}" nicht gefunden.`,
    };
  }

  return {
    success: true,
    package: { ...res.data, packageManager },
    fromCache: res.fromCache,
    isStale: res.isStale,
    updatedAt: res.updatedAt,
    error: res.error,
  };
}

/**
 * Prüft installierte globale Pakete parallel (mit begrenzter Nebenläufigkeit) gegen die npm-Registry.
 * @param {Array<{ packageId?: string, id?: string, name?: string, version?: string }>} installedPackages
 * @param {{ packageManager?: string, signal?: AbortSignal | null, concurrency?: number, registryUrl?: string }} [options]
 */
export async function checkNpmRegistryUpdates(
  installedPackages = [],
  { packageManager = 'bun', signal = null, concurrency = 6, registryUrl = '' } = {}
) {
  const list = Array.isArray(installedPackages) ? installedPackages.filter((p) => p?.packageId || p?.name) : [];
  if (list.length === 0) return [];

  const base = resolveRegistryBaseUrl(registryUrl);
  const upgrades = [];
  const executing = new Set();

  for (const pkg of list) {
    if (signal?.aborted) break;
    const pkgId = String(pkg.packageId || pkg.name || '').trim();
    const installedVer = String(pkg.version || '').trim();
    if (!pkgId || !isValidNpmPackageName(pkgId)) continue;

    const task = (async () => {
      try {
        const latest = await fetchNpmPackageLatest(pkgId, { signal, packageManager, registryUrl: base });
        if (!latest?.version) return;
        const isOutdated = installedVer ? compareVersions(latest.version, installedVer, 3) > 0 : false;
        if (isOutdated) {
          upgrades.push({
            packageManager,
            packageId: pkgId,
            id: pkgId,
            name: pkg.name || pkgId,
            installedVersion: installedVer,
            availableVersion: latest.version,
            source: packageManager,
          });
        }
      } catch {
        // Einzelne Registry-Fehler blockieren keine weiteren Paket-Checks
      }
    })();

    executing.add(task);
    task.finally(() => executing.delete(task));
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return upgrades;
}
