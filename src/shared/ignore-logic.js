import { compareVersions } from './version.js';

export const IGNORE_EXPORT_FORMAT = 'software-katalog-ignored-updates';
const IGNORE_EXPORT_VERSION = 1;

/**
 * Normalisiert den Geltungsbereich eines Ignorier-Eintrags auf 'user' oder 'admin'.
 * @param {unknown} scope
 * @returns {'user' | 'admin'}
 */
export function normalizeIgnoreScope(scope) {
  return String(scope || '')
    .trim()
    .toLowerCase() === 'admin'
    ? 'admin'
    : 'user';
}

/**
 * Normalisiert den Ignorier-Modus auf 'version' oder 'all'.
 * @param {unknown} mode
 * @returns {'version' | 'all'}
 */
function normalizeIgnoreMode(mode) {
  return String(mode || '')
    .trim()
    .toLowerCase() === 'all'
    ? 'all'
    : 'version';
}

/**
 * Normalisiert eine Versionsnummer fuer Vergleiche (entfernt fuehrendes 'v' vor Ziffern).
 * @param {unknown} version
 * @returns {string}
 */
function normalizeIgnoreVersion(version) {
  return String(version || '')
    .trim()
    .replace(/^v(?=\d)/i, '');
}

/**
 * Ermittelt den eindeutigen Paket-Schluessel eines Katalog- oder PC-Pakets.
 * @param {Record<string, any> | null | undefined} item
 * @returns {string}
 */
export function getIgnorePackageKey(item) {
  if (!item || typeof item !== 'object') return '';
  const pm = String(item.packageManager || (item.wingetId ? 'winget' : ''))
    .trim()
    .toLowerCase();
  const pid = String(item.packageId || item.wingetId || '')
    .trim()
    .toLowerCase();
  if (pm && pid) return `${pm}:${pid}`;

  const archiveRef = String(item.archiveItemId || (item.inArchive && item.id ? item.id : ''))
    .trim()
    .toLowerCase();
  if (archiveRef) return `archive:${archiveRef}`;

  const directId = String(item.id || '')
    .trim()
    .toLowerCase();
  return directId || '';
}

/**
 * Liefert alle fuer ein Paket zutreffenden Schluessel fuer den Abgleich mit Ignorier-Regeln.
 * @param {Record<string, any> | null | undefined} item
 * @returns {Set<string>}
 */
function getIgnoreMatchKeys(item) {
  const keys = new Set();
  if (!item || typeof item !== 'object') return keys;

  const pm = String(item.packageManager || (item.wingetId ? 'winget' : ''))
    .trim()
    .toLowerCase();
  const pid = String(item.packageId || item.wingetId || '')
    .trim()
    .toLowerCase();
  if (pm && pid) keys.add(`${pm}:${pid}`);

  const archiveRef = String(item.archiveItemId || (item.inArchive && item.id ? item.id : ''))
    .trim()
    .toLowerCase();
  if (archiveRef) keys.add(`archive:${archiveRef}`);

  const directId = String(item.id || '')
    .trim()
    .toLowerCase();
  if (directId) keys.add(directId);

  const pkgKey = String(item.packageKey || '')
    .trim()
    .toLowerCase();
  if (pkgKey) keys.add(pkgKey);

  return keys;
}

/**
 * Normalisiert einen einzelnen Ignorier-Eintrag gemaess Schema.
 * @param {unknown} raw
 * @param {{ now?: number, fallbackId?: string, defaultScope?: 'user' | 'admin' }} [options]
 * @returns {{ id: string, packageKey: string, name: string, packageManager: string, packageId: string, mode: 'version' | 'all', ignoredVersion: string, createdAt: number, scope: 'user' | 'admin' } | null}
 */
export function normalizeIgnoreEntry(raw, { now = Date.now(), fallbackId = '', defaultScope = 'user' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = /** @type {Record<string, any>} */ (raw);

  const packageManager = String(src.packageManager || '')
    .trim()
    .toLowerCase();
  const packageId = String(src.packageId || '').trim();
  const rawKey = String(src.packageKey || '')
    .trim()
    .toLowerCase();
  const packageKey = rawKey || (packageManager && packageId ? `${packageManager}:${packageId.toLowerCase()}` : '');
  if (!packageKey) return null;

  const mode = src.mode === 'all' ? 'all' : 'version';
  const ignoredVersion = normalizeIgnoreVersion(src.ignoredVersion || '');
  if (mode === 'version' && !ignoredVersion) return null;

  const id = String(src.id || fallbackId || packageKey).trim();
  const name = String(src.name || packageId || packageKey).trim();
  const createdRaw = Number(src.createdAt);
  const createdAt = Number.isFinite(createdRaw) && createdRaw > 0 ? createdRaw : now;
  const scope = normalizeIgnoreScope(src.scope !== undefined ? src.scope : defaultScope);

  return {
    id,
    packageKey,
    name,
    packageManager,
    packageId,
    mode,
    ignoredVersion,
    createdAt,
    scope,
  };
}

/**
 * Erstellt einen Ignorier-Eintrag aus einem Paket-Objekt.
 * @param {Record<string, any> | null | undefined} item
 * @param {{ mode?: 'version' | 'all', ignoredVersion?: string, now?: number, scope?: 'user' | 'admin' }} [options]
 */
export function buildIgnoreEntryFromPackage(
  item,
  { mode = 'version', ignoredVersion = '', now = Date.now(), scope = 'user' } = {}
) {
  const packageManager = String(item?.packageManager || (item?.wingetId ? 'winget' : item?.inArchive ? 'archive' : ''))
    .trim()
    .toLowerCase();
  const packageId = String(
    item?.packageId || item?.wingetId || (item?.inArchive ? item?.archiveItemId || item?.id : '') || ''
  ).trim();
  const packageKey = getIgnorePackageKey(item);
  const resolvedMode = normalizeIgnoreMode(mode);

  return {
    packageKey,
    name: String(item?.name || packageId || packageKey).trim(),
    packageManager,
    packageId,
    mode: resolvedMode,
    ignoredVersion: normalizeIgnoreVersion(ignoredVersion),
    createdAt: now,
    scope: normalizeIgnoreScope(scope),
  };
}

/**
 * Fuehrt globale Admin-Regeln (`data/ignored-updates.json`) und nutzerspezifische Regeln
 * (`%APPDATA%\SoftwareKatalog\ignored-updates.json`) zusammen. Admin-Regeln stehen zuerst
 * und haben Vorrang bei identischem Paket.
 * @param {Array<Record<string, any>>} [adminEntries]
 * @param {Array<Record<string, any>>} [userEntries]
 */
export function mergeScopedIgnoredUpdates(adminEntries = [], userEntries = []) {
  const normalizedAdmin = (Array.isArray(adminEntries) ? adminEntries : [])
    .map((e) => normalizeIgnoreEntry({ ...e, scope: 'admin' }, { defaultScope: 'admin' }))
    .filter(Boolean);
  const normalizedUser = (Array.isArray(userEntries) ? userEntries : [])
    .map((e) => normalizeIgnoreEntry({ ...e, scope: 'user' }, { defaultScope: 'user' }))
    .filter(Boolean);

  return [...normalizedAdmin, ...normalizedUser];
}

/**
 * Prueft, ob zwei Versionen exakt gleichwertig sind.
 * Numerische Versionen werden ohne Stellenlimit verglichen (z. B. 2.0 == 2.0.0, aber 2.0.1 != 2.0.0).
 * @param {unknown} targetVersion
 * @param {unknown} ignoredVersion
 * @returns {boolean}
 */
export function versionsMatchExact(targetVersion, ignoredVersion) {
  const t = normalizeIgnoreVersion(targetVersion);
  const ig = normalizeIgnoreVersion(ignoredVersion);
  if (!t || !ig) return false;
  if (t.toLowerCase() === ig.toLowerCase()) return true;

  if (/^\d+(?:\.\d+)*$/.test(t) && /^\d+(?:\.\d+)*$/.test(ig)) {
    return compareVersions(t, ig, 0) === 0;
  }

  return false;
}

/**
 * Findet eine passende Ignorier-Regel fuer das Paket und die angebotene Zielversion.
 * @param {Record<string, any> | null | undefined} item
 * @param {unknown} targetVersion
 * @param {Array<Record<string, any>>} [ignoreList]
 */
export function findMatchingIgnoreRule(item, targetVersion, ignoreList = []) {
  if (!item || !Array.isArray(ignoreList) || ignoreList.length === 0) return null;
  const itemKeys = getIgnoreMatchKeys(item);
  if (itemKeys.size === 0) return null;

  for (const rule of ignoreList) {
    if (!rule || typeof rule !== 'object') continue;
    const ruleKeys = [];
    const rk = String(rule.packageKey || '')
      .trim()
      .toLowerCase();
    if (rk) ruleKeys.push(rk);

    const rpm = String(rule.packageManager || '')
      .trim()
      .toLowerCase();
    const rpid = String(rule.packageId || '')
      .trim()
      .toLowerCase();
    if (rpm && rpid) ruleKeys.push(`${rpm}:${rpid}`);

    if (!ruleKeys.some((k) => itemKeys.has(k))) continue;

    if (rule.mode === 'all') return rule;
    if (rule.mode === 'version' && versionsMatchExact(targetVersion, rule.ignoredVersion)) {
      return rule;
    }
  }

  return null;
}

/**
 * Gibt true zurueck, wenn das Update durch eine Regel in der Ignorierliste unterdrueckt wird.
 * @param {Record<string, any> | null | undefined} item
 * @param {unknown} targetVersion
 * @param {Array<Record<string, any>>} [ignoreList]
 * @returns {boolean}
 */
export function isUpdateIgnored(item, targetVersion, ignoreList = []) {
  return Boolean(findMatchingIgnoreRule(item, targetVersion, ignoreList));
}

function defaultGenerateId() {
  return String(globalThis.crypto.randomUUID());
}

/**
 * Fuegt einen Ignorier-Eintrag hinzu oder aktualisiert eine bestehende Regel fuer dasselbe packageKey.
 * @param {Array<Record<string, any>>} entries
 * @param {unknown} entryInput
 * @param {{ now?: number, generateId?: () => string, defaultScope?: 'user' | 'admin' }} [options]
 */
export function upsertIgnoredUpdate(
  entries = [],
  entryInput,
  { now = Date.now(), generateId = defaultGenerateId, defaultScope = 'user' } = {}
) {
  const list = Array.isArray(entries)
    ? entries.map((e) => normalizeIgnoreEntry(e, { now, defaultScope })).filter(Boolean)
    : [];
  const normalized = normalizeIgnoreEntry(entryInput, { now, fallbackId: generateId(), defaultScope });
  if (!normalized) {
    return { success: false, error: 'Ungueltiger Ignorier-Eintrag.', entries: list };
  }

  const existingIdx = list.findIndex((e) => e.packageKey === normalized.packageKey);
  if (existingIdx !== -1) {
    const existing = list[existingIdx];
    const updated = {
      ...normalized,
      id: existing.id,
      createdAt: now,
    };
    const nextList = [...list];
    nextList[existingIdx] = updated;
    return { success: true, entry: updated, entries: nextList };
  }

  return { success: true, entry: normalized, entries: [...list, normalized] };
}

/**
 * Entfernt einen Eintrag anhand seiner id oder packageKey.
 * @param {Array<Record<string, any>>} entries
 * @param {unknown} idOrKey
 */
export function removeIgnoredUpdateEntry(entries = [], idOrKey) {
  const list = Array.isArray(entries) ? entries : [];
  const clean = String(idOrKey || '').trim();
  if (!clean) {
    return { removed: false, entries: [...list] };
  }
  const cleanLower = clean.toLowerCase();
  const next = list.filter((e) => {
    const eid = String(e?.id || '').trim();
    const ekey = String(e?.packageKey || '')
      .trim()
      .toLowerCase();
    return eid !== clean && ekey !== cleanLower;
  });

  return { removed: next.length !== list.length, entries: next };
}

/**
 * Filtert Ignorier-Eintraege anhand eines Suchbegriffs.
 * @param {Array<Record<string, any>>} entries
 * @param {unknown} query
 */
export function filterIgnoredEntries(entries = [], query = '') {
  const list = Array.isArray(entries) ? entries : [];
  const words = String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return list;

  return list.filter((entry) => {
    if (!entry) return false;
    const ruleLabel = entry.mode === 'all' ? 'alle updates' : `nur version v${entry.ignoredVersion || ''}`;
    const scopeLabel = entry.scope === 'admin' ? 'admin global alle nutzer' : 'user persoenlich personal';
    const hay = [
      entry.name,
      entry.packageId,
      entry.packageManager,
      entry.packageKey,
      entry.ignoredVersion,
      ruleLabel,
      scopeLabel,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/**
 * Erstellt das Export-JSON-Objekt fuer die Ignorierliste.
 * @param {Array<Record<string, any>>} entries
 */
export function buildExportIgnoredUpdatesPayload(entries = []) {
  const normalized = (Array.isArray(entries) ? entries : []).map((e) => normalizeIgnoreEntry(e)).filter(Boolean);

  return {
    format: IGNORE_EXPORT_FORMAT,
    version: IGNORE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    entries: normalized,
  };
}

/**
 * Validiert ein importiertes JSON-Dokument (Export-Objekt oder direktes Array).
 * @param {unknown} raw
 * @returns {{ valid: boolean, entries?: Array<NonNullable<ReturnType<typeof normalizeIgnoreEntry>>>, error?: string }}
 */
export function validateImportIgnoredUpdatesPayload(raw) {
  let rawEntries;

  if (Array.isArray(raw)) {
    rawEntries = raw;
  } else if (raw && typeof raw === 'object') {
    const obj = /** @type {Record<string, any>} */ (raw);
    if (obj.format !== undefined && obj.format !== IGNORE_EXPORT_FORMAT) {
      return { valid: false, error: 'Unbekanntes Exportformat fuer ignorierte Updates.' };
    }
    if (!Array.isArray(obj.entries)) {
      return { valid: false, error: 'Die JSON-Datei enthaelt keine gueltige Eintragsliste (entries).' };
    }
    rawEntries = obj.entries;
  } else {
    return { valid: false, error: 'Ungueltiges JSON-Format: Objekt oder Array erwartet.' };
  }

  if (rawEntries.length === 0) {
    return { valid: false, error: 'Die JSON-Datei enthaelt keine Ignorier-Eintraege.' };
  }

  const validated = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const item = rawEntries[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { valid: false, error: `Eintrag #${i + 1}: Ungueltiges Eintragsformat.` };
    }
    if (item.mode !== 'version' && item.mode !== 'all') {
      return { valid: false, error: `Eintrag #${i + 1}: Ungueltiger Modus (erwartet "version" oder "all").` };
    }
    const normalized = normalizeIgnoreEntry(item);
    if (!normalized) {
      return {
        valid: false,
        error: `Eintrag #${i + 1}: Pflichtfelder fehlen (packageKey/packageId oder ignoredVersion bei mode "version").`,
      };
    }
    validated.push(normalized);
  }

  return { valid: true, entries: validated };
}

/**
 * Fuehrt bestehende und importierte Ignorier-Eintraege zusammen oder ersetzt die bestehende Liste.
 * @param {Array<Record<string, any>>} existingEntries
 * @param {Array<Record<string, any>>} importedEntries
 * @param {{ mode?: 'merge' | 'replace', now?: number, generateId?: () => string, defaultScope?: 'user' | 'admin' }} [options]
 */
export function mergeIgnoredUpdates(
  existingEntries = [],
  importedEntries = [],
  { mode = 'merge', now = Date.now(), generateId = defaultGenerateId, defaultScope = 'user' } = {}
) {
  const cleanExisting = (Array.isArray(existingEntries) ? existingEntries : [])
    .map((e) => normalizeIgnoreEntry({ ...e, scope: defaultScope }, { now, defaultScope }))
    .filter(Boolean);

  // Import-Eintraege nach packageKey deduplizieren (letzter gewinnt)
  const dedupedImportMap = new Map();
  for (const raw of Array.isArray(importedEntries) ? importedEntries : []) {
    const norm = normalizeIgnoreEntry({ ...raw, scope: defaultScope }, { now, defaultScope });
    if (norm) {
      dedupedImportMap.set(norm.packageKey, norm);
    }
  }
  const cleanImported = [...dedupedImportMap.values()];

  if (mode === 'replace') {
    const usedIds = new Set();
    const replaced = cleanImported.map((item) => {
      let id = item.id;
      while (!id || usedIds.has(id)) {
        id = String(generateId() || '').trim();
      }
      usedIds.add(id);
      return { ...item, id };
    });
    return {
      entries: replaced,
      added: replaced.length,
      updated: 0,
      skipped: 0,
      total: replaced.length,
    };
  }

  const result = cleanExisting.map((e) => ({ ...e }));
  const byKey = new Map();
  const usedIds = new Set();
  for (let i = 0; i < result.length; i++) {
    byKey.set(result[i].packageKey, i);
    usedIds.add(result[i].id);
  }

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const imp of cleanImported) {
    const existingIdx = byKey.get(imp.packageKey);
    if (existingIdx !== undefined) {
      const cur = result[existingIdx];
      const unchanged =
        cur.mode === imp.mode &&
        cur.ignoredVersion === imp.ignoredVersion &&
        cur.name === imp.name &&
        cur.packageManager === imp.packageManager &&
        cur.packageId === imp.packageId;
      if (unchanged) {
        skipped++;
        continue;
      }
      result[existingIdx] = {
        ...imp,
        id: cur.id,
      };
      updated++;
    } else {
      let id = imp.id;
      while (!id || usedIds.has(id)) {
        id = String(generateId() || '').trim();
      }
      usedIds.add(id);
      byKey.set(imp.packageKey, result.length);
      result.push({ ...imp, id });
      added++;
    }
  }

  return {
    entries: result,
    added,
    updated,
    skipped,
    total: result.length,
  };
}
