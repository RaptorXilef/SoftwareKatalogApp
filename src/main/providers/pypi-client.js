import { normalizeSourceUrl } from '../../shared/provider-sources-parser.js';
import {
  isValidPythonPackageName,
  normalizePythonPackageName,
  parsePyPiPackageJson,
  parsePyPiSearchHtml,
  parsePyPiSimpleIndexHtml,
} from '../../shared/python-parser.js';
import { compareVersions, extractVersion } from '../../shared/version.js';
import { fetchRegistryJson } from './npm-registry-client.js';
import { getWingetCache } from './winget-provider.js';

const PYPI_BASE_URL = 'https://pypi.org';
const DEFAULT_TIMEOUT_MS = 12000;

function resolvePyPiUrls(indexUrl) {
  const clean = normalizeSourceUrl(indexUrl);
  if (!clean || clean === 'https://pypi.org/simple' || clean === 'https://pypi.org') {
    return {
      isCustom: false,
      apiBase: PYPI_BASE_URL,
      simpleBase: `${PYPI_BASE_URL}/simple`,
    };
  }
  if (clean.toLowerCase().endsWith('/simple')) {
    return {
      isCustom: true,
      apiBase: clean.slice(0, -7),
      simpleBase: clean,
    };
  }
  return {
    isCustom: true,
    apiBase: clean,
    simpleBase: `${clean}/simple`,
  };
}

async function fetchPyPiText(url, { signal = null, timeoutMs = 8000, accept = 'text/html,application/json' } = {}) {
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
        Accept: accept,
        'User-Agent': 'SoftwareKatalogApp (https://github.com/RaptorXilef/SoftwareKatalogApp)',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`PyPI HTTP-Fehler ${res.status}`);
    }
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Ruft aktuelle Paketmetadaten direkt ueber die PyPI JSON API (`https://pypi.org/pypi/<pkg>/json`) ab.
 * @param {string} packageId
 * @param {{ signal?: AbortSignal | null, packageManager?: string, indexUrl?: string }} [options]
 */
async function fetchPyPiPackageFresh(packageId, { signal = null, packageManager = 'pip', indexUrl = '' } = {}) {
  const cleanId = String(packageId || '').trim();
  if (!isValidPythonPackageName(cleanId)) {
    throw new Error(`Ungueltiger Python-Paketname: "${cleanId}".`);
  }

  const { isCustom, apiBase, simpleBase } = resolvePyPiUrls(indexUrl);
  const jsonUrl = `${apiBase}/pypi/${encodeURIComponent(cleanId)}/json`;
  try {
    const payload = await fetchRegistryJson(jsonUrl, { signal, timeoutMs: DEFAULT_TIMEOUT_MS });
    const parsed = parsePyPiPackageJson(payload, cleanId, { packageManager });
    if (parsed) return parsed;
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError' || !isCustom) {
      throw err;
    }
  }

  if (isCustom) {
    const norm = normalizePythonPackageName(cleanId);
    const simplePkgUrl = `${simpleBase}/${encodeURIComponent(norm)}/`;
    const simpleHtml = await fetchPyPiText(simplePkgUrl, {
      signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      accept: 'text/html',
    });
    const versions = [];
    const linkRe = /<a\b[^>]*>([^<]+)<\/a>/gi;
    let m = linkRe.exec(simpleHtml);
    while (m !== null) {
      const ver = extractVersion(m[1]);
      if (ver) versions.push(ver);
      m = linkRe.exec(simpleHtml);
    }
    versions.sort((a, b) => compareVersions(b, a, 4));
    return {
      name: cleanId,
      packageManager,
      packageId: cleanId,
      version: versions[0] || '',
      publisher: '',
      author: '',
      shortDescription: `Paket aus Custom-Index (${simpleBase})`,
      description: `Paket aus benutzerdefiniertem Python-Index: ${simplePkgUrl}`,
      homepage: simplePkgUrl,
      repositoryUrl: '',
      license: '',
      licenseUrl: '',
      tags: [],
      pypiUrl: simplePkgUrl,
    };
  }

  throw new Error(`PyPI-Paket "${cleanId}" konnte nicht geparst werden.`);
}

/**
 * Liefert PyPI-Paketdetails ueber den 7-Tage-Offline-Cache (`userData/provider-cache.json`).
 * @param {string} packageId
 * @param {{ packageManager?: string, forceRefresh?: boolean, signal?: AbortSignal | null, indexUrl?: string }} [options]
 */
export async function showPyPiPackage(
  packageId,
  { packageManager = 'pip', forceRefresh = false, signal = null, indexUrl = '' } = {}
) {
  const cleanId = String(packageId || '').trim();
  if (!cleanId) {
    return {
      success: false,
      package: null,
      fromCache: false,
      isStale: false,
      updatedAt: null,
      error: 'Keine Python-Paket-ID angegeben.',
    };
  }

  const { isCustom, simpleBase } = resolvePyPiUrls(indexUrl);
  const normId = normalizePythonPackageName(cleanId);
  const cacheKey = isCustom ? `pypi:show:${simpleBase.toLowerCase()}:${normId}` : `pypi:show:${normId}`;
  const cache = getWingetCache();
  const res = await cache.getOrFetch(
    cacheKey,
    () => fetchPyPiPackageFresh(cleanId, { signal, packageManager: 'pip', indexUrl }),
    { forceRefresh }
  );

  if (!res.data) {
    return {
      success: false,
      package: null,
      fromCache: false,
      isStale: false,
      updatedAt: null,
      error: res.error || `PyPI-Paket "${cleanId}" nicht gefunden.`,
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
 * Laedt verfuegbare Versionen eines Python-Pakets von PyPI (absteigend sortiert).
 * @param {string} packageId
 * @param {{ indexUrl?: string, forceRefresh?: boolean, signal?: AbortSignal | null }} [options]
 */
export async function listPyPiPackageVersions(packageId, { indexUrl = '', forceRefresh = false, signal = null } = {}) {
  const cleanId = String(packageId || '').trim();
  if (!isValidPythonPackageName(cleanId)) {
    return { success: false, versions: [], error: `Ungueltiger Python-Paketname: "${cleanId}".` };
  }

  const { apiBase } = resolvePyPiUrls(indexUrl);
  const cacheKey = `pypi:versions:${apiBase.toLowerCase()}:${cleanId.toLowerCase()}`;
  const cache = getWingetCache();
  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached?.data && Array.isArray(cached.data) && Date.now() - Number(cached.updatedAt || 0) < 15 * 60 * 1000) {
      return { success: true, versions: cached.data, fromCache: true };
    }
  }

  try {
    const payload = await fetchRegistryJson(`${apiBase}/pypi/${encodeURIComponent(cleanId)}/json`, {
      signal,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    const releases = payload?.releases && typeof payload.releases === 'object' ? payload.releases : {};
    const versions = Object.entries(releases)
      .filter(([, files]) => !Array.isArray(files) || files.length === 0 || files.some((f) => !f?.yanked))
      .map(([ver]) => String(ver).trim())
      .filter(Boolean)
      .sort((a, b) => compareVersions(b, a, 0) || b.localeCompare(a, 'en', { numeric: true }));
    if (versions.length > 0) cache.set(cacheKey, versions);
    return { success: true, versions, fromCache: false };
  } catch (err) {
    return { success: false, versions: [], error: err?.message || 'PyPI-Versionen konnten nicht geladen werden.' };
  }
}

/**
 * Durchsucht PyPI ueber direkte Paketpruefung + PyPI-Suche mit PEP-503-Simple-Fallback.
 * @param {string} query
 * @param {{ limit?: number, signal?: AbortSignal | null, packageManager?: string, indexUrl?: string }} [options]
 */
export async function searchPyPiPackages(
  query,
  { limit = 25, signal = null, packageManager = 'pip', indexUrl = '' } = {}
) {
  const cleanQuery = String(query || '').trim();
  if (cleanQuery.length < 2) {
    return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
  }

  const { isCustom, simpleBase } = resolvePyPiUrls(indexUrl);
  const maxResults = Number.isFinite(limit) && limit > 0 ? Math.min(Math.max(Math.round(limit), 1), 50) : 25;
  /** @type {Array<Record<string, any>>} */
  const combined = [];
  const seen = new Set();

  const pushUnique = (entry) => {
    if (!entry?.packageId) return;
    const key = normalizePythonPackageName(entry.packageId);
    if (!key || seen.has(key)) return;
    seen.add(key);
    combined.push({ ...entry, packageManager, source: packageManager });
  };

  // 1. Direkte Exakt-Pruefung ueber die schnelle PyPI JSON API (bzw. Custom Simple-Index)
  const directCandidates = [];
  if (isValidPythonPackageName(cleanQuery)) {
    directCandidates.push(cleanQuery);
    const normQuery = normalizePythonPackageName(cleanQuery);
    if (normQuery && normQuery !== cleanQuery.toLowerCase()) {
      directCandidates.push(normQuery);
    }
  }

  const searchPromise = isCustom
    ? Promise.resolve([])
    : (async () => {
        try {
          const searchHtml = await fetchPyPiText(`${PYPI_BASE_URL}/search/?q=${encodeURIComponent(cleanQuery)}`, {
            signal,
            timeoutMs: 8000,
            accept: 'text/html',
          });
          return parsePyPiSearchHtml(searchHtml, maxResults, { packageManager });
        } catch (err) {
          if (signal?.aborted || err?.name === 'AbortError') throw err;
          return [];
        }
      })();

  const directResults = await Promise.allSettled(
    directCandidates.map((cand) => fetchPyPiPackageFresh(cand, { signal, packageManager, indexUrl }))
  );

  for (const outcome of directResults) {
    if (outcome.status === 'fulfilled' && outcome.value) {
      pushUnique({
        packageManager,
        packageId: outcome.value.packageId,
        id: outcome.value.packageId,
        name: outcome.value.name,
        version: outcome.value.version,
        shortDescription: outcome.value.shortDescription,
        description: outcome.value.description,
        homepage: outcome.value.homepage,
        source: packageManager,
      });
    }
  }

  let htmlResults = [];
  try {
    htmlResults = await searchPromise;
  } catch (err) {
    if (signal?.aborted || err?.name === 'AbortError') {
      return { success: false, results: [], canceled: true };
    }
  }

  for (const item of htmlResults) {
    if (combined.length >= maxResults) break;
    pushUnique(item);
  }

  // 2. Simple-Fallback (PEP 503), falls /search/ (oder Custom-Index) keine Treffer liefert
  if (combined.length === 0 && isValidPythonPackageName(cleanQuery)) {
    const norm = normalizePythonPackageName(cleanQuery);
    try {
      const simpleHtml = await fetchPyPiText(`${simpleBase}/${encodeURIComponent(norm)}/`, {
        signal,
        timeoutMs: 6000,
        accept: 'text/html',
      });
      if (simpleHtml) {
        const simpleMatches = parsePyPiSimpleIndexHtml(`<a href="#">${cleanQuery}</a>`, cleanQuery, maxResults, {
          packageManager,
        });
        for (const item of simpleMatches) {
          pushUnique(item);
        }
      }
    } catch {
      // Fallback-Fehler ignorieren
    }
  }

  const finalResults = combined.slice(0, maxResults);
  return {
    success: true,
    results: finalResults,
    hint:
      finalResults.length === 0
        ? 'Keine PyPI-Treffer gefunden (Tipp: genauen Paketnamen eingeben, z. B. "ruff" oder "black").'
        : '',
  };
}

/**
 * Prueft installierte Python-Pakete mit begrenzter Nebenlaeufigkeit gegen PyPI.
 * @param {Array<{ packageId?: string, id?: string, name?: string, version?: string }>} installedPackages
 * @param {{ packageManager?: string, signal?: AbortSignal | null, concurrency?: number, indexUrl?: string }} [options]
 */
export async function checkPyPiUpdates(
  installedPackages = [],
  { packageManager = 'uv', signal = null, concurrency = 6, indexUrl = '' } = {}
) {
  const list = Array.isArray(installedPackages) ? installedPackages.filter((p) => p?.packageId || p?.name) : [];
  if (list.length === 0) return [];

  const upgrades = [];
  const executing = new Set();

  for (const pkg of list) {
    if (signal?.aborted) break;
    const pkgId = String(pkg.packageId || pkg.name || '').trim();
    const installedVer = String(pkg.version || '').trim();
    if (!pkgId || !isValidPythonPackageName(pkgId)) continue;

    const task = (async () => {
      try {
        const latest = await fetchPyPiPackageFresh(pkgId, { signal, packageManager, indexUrl });
        if (!latest?.version) return;
        const isOutdated = installedVer ? compareVersions(latest.version, installedVer, 4) > 0 : false;
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
        // Einzelne PyPI-Fehler blockieren keine weiteren Paket-Checks
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
