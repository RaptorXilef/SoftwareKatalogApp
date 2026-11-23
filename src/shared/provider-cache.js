import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage

/**
 * Erstellt einen persistenten Offline-first-JSON-Cache.
 * Läuft ein Eintrag ab (> ttlMs) und schlägt der Online-Abruf fehl, bleibt der bestehende
 * Cache dauerhaft gültig und wird mit `isStale: true` sowie seinem Zeitstempel ausgeliefert.
 */
export function createProviderCache({ filePath, ttlMs = DEFAULT_CACHE_TTL_MS, now = () => Date.now() }) {
  let loaded = false;
  let store = { version: 1, entries: {} };

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    if (!filePath || !fs.existsSync(filePath)) return;

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        store = { version: 1, entries: parsed.entries };
      }
    } catch {
      store = { version: 1, entries: {} };
    }
  }

  function persist() {
    if (!filePath) return;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpFile = `${filePath}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmpFile, filePath);
  }

  function get(cacheKey) {
    ensureLoaded();
    const entry = store.entries[cacheKey];
    if (!entry || entry.data === undefined) return null;
    const updatedAt = Number(entry.updatedAt) || 0;
    const ageMs = Math.max(0, now() - updatedAt);
    return {
      data: entry.data,
      updatedAt,
      ageMs,
      isExpired: ageMs > ttlMs,
    };
  }

  function set(cacheKey, data, meta = {}) {
    ensureLoaded();
    const updatedAt = now();
    store.entries[cacheKey] = {
      ...meta,
      data,
      updatedAt,
    };
    persist();
    return updatedAt;
  }

  function del(cacheKey) {
    ensureLoaded();
    if (Object.hasOwn(store.entries, cacheKey)) {
      delete store.entries[cacheKey];
      persist();
      return true;
    }
    return false;
  }

  function clear() {
    loaded = true;
    store = { version: 1, entries: {} };
    persist();
  }

  function getStats() {
    ensureLoaded();
    const keys = Object.keys(store.entries);
    let expiredCount = 0;
    const current = now();
    for (const k of keys) {
      const ts = Number(store.entries[k]?.updatedAt) || 0;
      if (current - ts > ttlMs) expiredCount++;
    }
    return {
      totalEntries: keys.length,
      expiredEntries: expiredCount,
      filePath,
      ttlMs,
    };
  }

  async function getOrFetch(cacheKey, fetcher, { forceRefresh = false } = {}) {
    const cached = get(cacheKey);
    if (cached && !forceRefresh && !cached.isExpired) {
      return {
        data: cached.data,
        fromCache: true,
        isStale: false,
        updatedAt: cached.updatedAt,
        error: null,
      };
    }

    try {
      const fresh = await fetcher();
      if (fresh === null || fresh === undefined) {
        throw new Error('Abruf lieferte kein Ergebnis.');
      }
      const updatedAt = set(cacheKey, fresh);
      return {
        data: fresh,
        fromCache: false,
        isStale: false,
        updatedAt,
        error: null,
      };
    } catch (err) {
      const errorMsg = err?.message || String(err);
      if (cached) {
        return {
          data: cached.data,
          fromCache: true,
          isStale: true,
          updatedAt: cached.updatedAt,
          error: errorMsg,
        };
      }
      return {
        data: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: errorMsg,
      };
    }
  }

  return {
    get,
    set,
    delete: del,
    clear,
    getStats,
    getOrFetch,
  };
}
