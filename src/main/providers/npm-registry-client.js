import { isValidNpmPackageName, parseNpmSearchJson, parseNpmShowJson } from '../../shared/npm-parser.js';
import { compareVersions } from '../../shared/version.js';
import { getWingetCache } from './winget-provider.js';

const REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const DEFAULT_FETCH_TIMEOUT_MS = 15000;

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
 * @param {{ limit?: number, signal?: AbortSignal | null, packageManager?: string }} [options]
 */
export async function searchNpmRegistry(query, { limit = 25, signal = null, packageManager = 'npm' } = {}) {
  const cleanQuery = String(query || '').trim();
  if (cleanQuery.length < 2) {
    return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
  }

  const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.max(Math.round(limit), 1), 50) : 25;
  const url = `${REGISTRY_BASE_URL}/-/v1/search?text=${encodeURIComponent(cleanQuery)}&size=${size}`;

  const data = await fetchRegistryJson(url, { signal });
  const results = parseNpmSearchJson(data, limit, { packageManager });
  return {
    success: true,
    results,
    hint: results.length === 0 ? `Keine ${packageManager}-Treffer in der Registry gefunden.` : '',
  };
}

/**
 * Ruft aktuelle Paketmetadaten direkt von `registry.npmjs.org` ab.
 * Für Scoped-Pakete (`@scope/pkg`) wird das volle Packument geladen, da `/latest` dort oft HTTP 405 liefert.
 * @param {string} packageId
 * @param {{ signal?: AbortSignal | null, packageManager?: string }} [options]
 */
export async function fetchNpmPackageLatest(packageId, { signal = null, packageManager = 'npm' } = {}) {
  const cleanId = String(packageId || '').trim();
  if (!isValidNpmPackageName(cleanId)) {
    throw new Error(`Ungültiger Paketname: "${cleanId}".`);
  }

  const encoded = encodeURIComponent(cleanId);
  const url = cleanId.startsWith('@') ? `${REGISTRY_BASE_URL}/${encoded}` : `${REGISTRY_BASE_URL}/${encoded}/latest`;

  const payload = await fetchRegistryJson(url, { signal });
  const parsed = parseNpmShowJson(payload, cleanId, { packageManager });
  if (!parsed) {
    throw new Error(`Paket "${cleanId}" konnte nicht geparst werden.`);
  }
  return parsed;
}

/**
 * Liefert Paketdetails über den 7-Tage-Offline-Cache (`userData/provider-cache.json`).
 * @param {string} packageId
 * @param {{ packageManager?: string, forceRefresh?: boolean, signal?: AbortSignal | null }} [options]
 */
export async function showNpmRegistryPackage(
  packageId,
  { packageManager = 'npm', forceRefresh = false, signal = null } = {}
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

  const cacheKey = `npm-registry:show:${cleanId.toLowerCase()}`;
  const cache = getWingetCache();
  const res = await cache.getOrFetch(
    cacheKey,
    () => fetchNpmPackageLatest(cleanId, { signal, packageManager: 'npm' }),
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
 * Prüft installierte globale Pakete parallel (mit begrenzter Nebenläufigkeit) gegen `registry.npmjs.org`.
 * @param {Array<{ packageId?: string, id?: string, name?: string, version?: string }>} installedPackages
 * @param {{ packageManager?: string, signal?: AbortSignal | null, concurrency?: number }} [options]
 */
export async function checkNpmRegistryUpdates(
  installedPackages = [],
  { packageManager = 'bun', signal = null, concurrency = 6 } = {}
) {
  const list = Array.isArray(installedPackages) ? installedPackages.filter((p) => p?.packageId || p?.name) : [];
  if (list.length === 0) return [];

  const upgrades = [];
  const executing = new Set();

  for (const pkg of list) {
    if (signal?.aborted) break;
    const pkgId = String(pkg.packageId || pkg.name || '').trim();
    const installedVer = String(pkg.version || '').trim();
    if (!pkgId || !isValidNpmPackageName(pkgId)) continue;

    const task = (async () => {
      try {
        const latest = await fetchNpmPackageLatest(pkgId, { signal, packageManager });
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
