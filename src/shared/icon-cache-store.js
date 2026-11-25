import fs from 'node:fs';
import path from 'node:path';
import { isGenericIconSource } from './icon-logic.js';

const ICON_CACHE_INDEX_FILENAME = 'icon-index.json';
export const ICON_CACHE_POSITIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const ICON_CACHE_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;

const ICON_FILE_EXTS = new Set(['.png', '.ico', '.svg', '.webp', '.jpg', '.jpeg']);
const SHARED_REPO_HOSTS = new Set([
  'github.com',
  'www.github.com',
  'gitlab.com',
  'www.gitlab.com',
  'bitbucket.org',
  'sourceforge.net',
  'www.sourceforge.net',
  'learn.microsoft.com',
  'microsoft.com',
  'www.microsoft.com',
]);

const IGNORED_URL_HOSTS = new Set([
  'aka.ms',
  'go.microsoft.com',
  'bit.ly',
  'tinyurl.com',
  't.co',
  'localhost',
  '127.0.0.1',
]);

function normalizeUrlOriginKey(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase();
    if (!host || IGNORED_URL_HOSTS.has(host) || isGenericIconSource(value)) return '';
    if (SHARED_REPO_HOSTS.has(host)) {
      const segs = parsed.pathname.split('/').filter(Boolean);
      if (segs.length >= 2) {
        return `url:${parsed.origin.toLowerCase()}/${segs[0].toLowerCase()}/${segs[1].toLowerCase()}`;
      }
      if (segs.length === 1) {
        return `url:${parsed.origin.toLowerCase()}/${segs[0].toLowerCase()}`;
      }
      return '';
    }
    return `url:${parsed.origin.toLowerCase()}`;
  } catch {
    return '';
  }
}

/**
 * Erzeugt eindeutige, priorisierte Schluessel fuer den persistenten Icon-Index.
 * @param {{
 *   id?: string,
 *   packageManager?: string,
 *   packageId?: string,
 *   homepage?: string,
 *   repositoryUrl?: string,
 *   publisherUrl?: string,
 *   webVersionUrl?: string,
 *   links?: Array<string | { url?: string }>,
 * }} [params]
 * @returns {string[]}
 */
export function buildPersistentIconIndexKeys({
  id = '',
  packageManager = '',
  packageId = '',
  homepage = '',
  repositoryUrl = '',
  publisherUrl = '',
  webVersionUrl = '',
  links = [],
} = {}) {
  const keys = [];
  const seen = new Set();
  const pushKey = (key) => {
    const normalized = String(key || '').trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    keys.push(normalized);
  };

  const cleanPm = String(packageManager || '')
    .trim()
    .toLowerCase();
  const cleanPkgId = String(packageId || '').trim();
  const cleanId = String(id || '').trim();

  if (cleanPkgId) {
    const pmPrefix = cleanPm || 'winget';
    pushKey(`${pmPrefix}:${cleanPkgId}`);
    if (cleanPkgId !== cleanPkgId.toLowerCase()) {
      pushKey(`${pmPrefix}:${cleanPkgId.toLowerCase()}`);
    }
  }

  if (cleanId && !cleanId.toLowerCase().startsWith('provider:')) {
    pushKey(`archive:${cleanId}`);
  }

  const rawUrls = [homepage, publisherUrl, repositoryUrl, webVersionUrl];
  if (Array.isArray(links)) {
    for (const entry of links) {
      if (typeof entry === 'string') {
        rawUrls.push(entry);
      } else if (entry && typeof entry.url === 'string') {
        rawUrls.push(entry.url);
      }
    }
  }

  for (const rawUrl of rawUrls) {
    const urlKey = normalizeUrlOriginKey(rawUrl);
    if (urlKey) pushKey(urlKey);
  }

  return keys;
}

/**
 * Verwaltet den persistenten Disk-Index `icon-index.json` fuer heruntergeladene Online-/App-Icons.
 * @param {{
 *   cacheDir?: string,
 *   positiveTtlMs?: number,
 *   negativeTtlMs?: number,
 *   now?: () => number,
 *   isOnline?: () => boolean,
 * }} [options]
 */
export function createIconCacheIndex({
  cacheDir,
  positiveTtlMs = ICON_CACHE_POSITIVE_TTL_MS,
  negativeTtlMs = ICON_CACHE_NEGATIVE_TTL_MS,
  now = () => Date.now(),
  isOnline = () => true,
} = {}) {
  const resolvedCacheDir = cacheDir ? path.resolve(cacheDir) : '';
  const indexPath = resolvedCacheDir ? path.join(resolvedCacheDir, ICON_CACHE_INDEX_FILENAME) : '';
  let loaded = false;
  /** @type {{ version: number, entries: Record<string, { status: 'hit' | 'miss', fileName?: string, sourceType?: string, updatedAt: number }> }} */
  let store = { version: 1, entries: {} };

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    if (!indexPath) return;
    try {
      if (!fs.existsSync(indexPath)) return;
      const raw = fs.readFileSync(indexPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        store = {
          version: Number(parsed.version) || 1,
          entries: { ...parsed.entries },
        };
      }
    } catch {
      store = { version: 1, entries: {} };
    }
  }

  function persist() {
    if (!indexPath) return;
    try {
      fs.mkdirSync(resolvedCacheDir, { recursive: true });
      const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
      fs.renameSync(tmpPath, indexPath);
    } catch {
      // Cache-Schreibfehler niemals fatal machen
    }
  }

  function resolveCachedFile(fileName) {
    const safeName = path.basename(String(fileName || '').trim());
    if (!safeName || !resolvedCacheDir) return '';
    const fullPath = path.join(resolvedCacheDir, safeName);
    try {
      if (!fs.existsSync(fullPath)) return '';
      const stat = fs.statSync(fullPath);
      if (!stat.isFile() || stat.size <= 0) return '';
      return fullPath;
    } catch {
      return '';
    }
  }

  /**
   * Prueft die uebergebenen Keys gegen den persistenten Index + Dateiexistenz auf der Platte.
   * @param {string[]} keys
   * @param {{ online?: boolean }} [opts]
   */
  function lookup(keys = [], opts = {}) {
    ensureLoaded();
    const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
    const currentNow = now();
    const online = opts.online !== undefined ? Boolean(opts.online) : Boolean(isOnline());
    let dirty = false;
    let negativeHit = null;
    let staleHit = null;

    for (const key of list) {
      const entry = store.entries[key];
      if (!entry || typeof entry !== 'object') continue;
      const age = Math.max(0, currentNow - Number(entry.updatedAt || 0));

      if (entry.status === 'hit' && entry.fileName) {
        const resolvedFile = resolveCachedFile(entry.fileName);
        if (!resolvedFile) {
          delete store.entries[key];
          dirty = true;
          continue;
        }
        if (age <= positiveTtlMs || !online) {
          if (dirty) persist();
          return {
            status: 'hit',
            key,
            filePath: resolvedFile,
            sourceType: entry.sourceType || 'persistent-cache',
            updatedAt: entry.updatedAt,
            offlineRetained: age > positiveTtlMs && !online,
          };
        }
        if (!staleHit) {
          staleHit = {
            status: 'stale',
            key,
            filePath: resolvedFile,
            sourceType: entry.sourceType || 'persistent-cache',
            updatedAt: entry.updatedAt,
          };
        }
        continue;
      }

      if (entry.status === 'miss') {
        if (age <= negativeTtlMs) {
          if (!negativeHit) {
            negativeHit = {
              status: 'miss',
              key,
              updatedAt: entry.updatedAt,
            };
          }
        } else {
          delete store.entries[key];
          dirty = true;
        }
      }
    }

    if (dirty) persist();
    if (staleHit) return staleHit;
    if (negativeHit) return negativeHit;
    return { status: 'none' };
  }

  /**
   * Speichert einen positiven Treffer fuer alle Schluessel auf eine lokale Cache-Datei.
   * @param {string[]} keys
   * @param {string} filePath
   * @param {string} [sourceType]
   */
  function recordHit(keys = [], filePath = '', sourceType = '') {
    ensureLoaded();
    const fileName = path.basename(String(filePath || '').trim());
    if (!fileName) return;
    const resolved = resolveCachedFile(fileName);
    if (!resolved) return;

    const timestamp = now();
    const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
    for (const key of list) {
      store.entries[key] = {
        status: 'hit',
        fileName,
        sourceType: String(sourceType || ''),
        updatedAt: timestamp,
      };
    }
    if (list.length > 0) persist();
  }

  /**
   * Speichert einen negativen Online-Treffer mit kurzer TTL (Standard 24h).
   * @param {string[]} keys
   */
  function recordMiss(keys = []) {
    ensureLoaded();
    const timestamp = now();
    const list = Array.isArray(keys) ? keys.filter(Boolean) : [];
    for (const key of list) {
      store.entries[key] = {
        status: 'miss',
        updatedAt: timestamp,
      };
    }
    if (list.length > 0) persist();
  }

  function getStats() {
    ensureLoaded();
    let hitCount = 0;
    let missCount = 0;
    for (const entry of Object.values(store.entries)) {
      if (entry?.status === 'hit') hitCount += 1;
      else if (entry?.status === 'miss') missCount += 1;
    }

    let fileCount = 0;
    let totalBytes = 0;
    if (resolvedCacheDir && fs.existsSync(resolvedCacheDir)) {
      try {
        for (const item of fs.readdirSync(resolvedCacheDir, { withFileTypes: true })) {
          if (!item.isFile()) continue;
          const ext = path.extname(item.name).toLowerCase();
          if (!ICON_FILE_EXTS.has(ext) && item.name !== ICON_CACHE_INDEX_FILENAME) continue;
          const st = fs.statSync(path.join(resolvedCacheDir, item.name));
          totalBytes += st.size;
          if (ICON_FILE_EXTS.has(ext)) fileCount += 1;
        }
      } catch {
        // Ignorieren
      }
    }

    return {
      cacheDir: resolvedCacheDir,
      indexPath,
      entryCount: Object.keys(store.entries).length,
      hitCount,
      missCount,
      fileCount,
      totalBytes,
    };
  }

  function clear() {
    ensureLoaded();
    store = { version: 1, entries: {} };
    let removedFiles = 0;
    if (resolvedCacheDir && fs.existsSync(resolvedCacheDir)) {
      try {
        for (const item of fs.readdirSync(resolvedCacheDir, { withFileTypes: true })) {
          if (!item.isFile()) continue;
          const ext = path.extname(item.name).toLowerCase();
          if (item.name === ICON_CACHE_INDEX_FILENAME || ICON_FILE_EXTS.has(ext) || ext === '.tmp') {
            try {
              fs.unlinkSync(path.join(resolvedCacheDir, item.name));
              if (ICON_FILE_EXTS.has(ext)) removedFiles += 1;
            } catch {
              // Ignorieren
            }
          }
        }
      } catch {
        // Ignorieren
      }
    }
    persist();
    return { success: true, removedFiles };
  }

  return {
    lookup,
    recordHit,
    recordMiss,
    getStats,
    clear,
  };
}
