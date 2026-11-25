/**
 * Reine Hilfsfunktionen für das Multi-Root-Archiv-System
 * (ohne Node/Electron-Abhängigkeiten, für Main, Scanner, Renderer & Tests nutzbar).
 */

import { compareVersions, extractVersion } from './version.js';

/**
 * Normalisiert einen Pfad für Vergleiche (Separatoren, Trim, Windows-Case).
 * @param {string} rawPath
 * @param {{ platform?: string }} [opts]
 * @returns {string}
 */
export function normalizePathKey(
  rawPath,
  { platform = typeof process !== 'undefined' ? process.platform : 'win32' } = {}
) {
  let cleaned = String(rawPath || '').trim();
  if (!cleaned) return '';

  const isWin = platform === 'win32';
  const hasUncPrefix = isWin && cleaned.startsWith('\\\\');

  if (isWin) {
    cleaned = cleaned.replace(/\/+/g, '\\');
    cleaned = hasUncPrefix ? `\\\\${cleaned.slice(2).replace(/\\+/g, '\\')}` : cleaned.replace(/\\+/g, '\\');
    // Trailing Backslash entfernen, außer bei "C:\"
    if (cleaned.length > 3 || (cleaned.length > 1 && cleaned[1] !== ':')) {
      cleaned = cleaned.replace(/\\+$/, '');
    }
    return cleaned.toLowerCase();
  }

  cleaned = cleaned.replace(/\/+/g, '/');
  if (cleaned.length > 1) {
    cleaned = cleaned.replace(/\/+$/, '');
  }
  return cleaned;
}

/**
 * Migriert und normalisiert `archivePaths` aus beliebigen Config-Objekten.
 * Behält Prioritätsreihenfolge bei, entfernt Leer- und Duplikat-Einträge.
 * Abwärtskompatibilität: `{ targetPath: '...' }` -> `['...']`.
 * @param {{ archivePaths?: unknown, targetPath?: unknown } | null | undefined} rawConfig
 * @param {{ platform?: string }} [opts]
 * @returns {string[]}
 */
export function normalizeArchivePaths(rawConfig, opts = {}) {
  const candidates = [];

  if (Array.isArray(rawConfig?.archivePaths) && rawConfig.archivePaths.length > 0) {
    for (const entry of rawConfig.archivePaths) {
      if (typeof entry === 'string' && entry.trim()) {
        candidates.push(entry.trim());
      }
    }
  }

  if (candidates.length === 0 && typeof rawConfig?.targetPath === 'string' && rawConfig.targetPath.trim()) {
    candidates.push(rawConfig.targetPath.trim());
  }

  if (candidates.length === 0) {
    return ['../software'];
  }

  const seen = new Set();
  const result = [];
  for (const p of candidates) {
    const key = normalizePathKey(p, opts);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(p);
  }

  return result.length > 0 ? result : ['../software'];
}

/**
 * Erzeugt ein kompaktes, sprechendes Label für einen Archiv-Wurzelpfad.
 * @param {string} rootPath
 * @param {number} [index]
 * @returns {string}
 */
export function getArchiveRootLabel(rootPath, index = 0) {
  const raw = String(rootPath || '').trim();
  if (!raw) return `Archiv ${index + 1}`;

  // UNC-Pfad: \\Server\Freigabe\...
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    const parts = raw
      .replace(/^[\\/]+/, '')
      .split(/[\\/]+/)
      .filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`.slice(0, 28);
    }
    if (parts.length === 1) return parts[0].slice(0, 28);
  }

  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return `Archiv ${index + 1}`;

  // Laufwerkspfad unter Windows (z. B. D:\SoftwareArchiv -> D:\SoftwareArchiv)
  if (/^[a-z]:$/i.test(parts[0])) {
    if (parts.length === 1) return parts[0].toUpperCase();
    return `${parts[0].toUpperCase()}\\${parts[parts.length - 1]}`.slice(0, 28);
  }

  return parts[parts.length - 1].slice(0, 28);
}

/**
 * Pure Pfad-Containment-Prüfung (erwartet idealerweise bereits aufgelöste Pfade).
 * @param {string} targetPath
 * @param {string} baseDir
 * @param {{ platform?: string }} [opts]
 * @returns {boolean}
 */
export function isNormalizedPathInsideDir(targetPath, baseDir, opts = {}) {
  const normTarget = normalizePathKey(targetPath, opts);
  const normBase = normalizePathKey(baseDir, opts);
  if (!normTarget || !normBase) return false;

  const isWin = (opts.platform || (typeof process !== 'undefined' ? process.platform : 'win32')) === 'win32';
  const sep = isWin ? '\\' : '/';
  const targetWithSep = normTarget.endsWith(sep) ? normTarget : `${normTarget}${sep}`;
  const baseWithSep = normBase.endsWith(sep) ? normBase : `${normBase}${sep}`;
  return targetWithSep.startsWith(baseWithSep);
}

/**
 * Normalisiert einen Softwarenamen für robusten Duplikat-Abgleich über mehrere Archiv-Wurzeln.
 * @param {string} name
 * @returns {string}
 */
function normalizeSoftwareNameKey(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Liefert eindeutige Schlüssel für das Matching derselben Software über Archiv-Orte hinweg.
 * @param {{ packageId?: string, wingetId?: string, name?: string } | null | undefined} entry
 * @returns {{ packageKey: string, nameKey: string }}
 */
export function buildSoftwareMergeKeys(entry) {
  const rawPid = String(entry?.packageId || entry?.wingetId || '')
    .trim()
    .toLowerCase();
  const normName = normalizeSoftwareNameKey(entry?.name || '');
  return {
    packageKey: rawPid ? `pid:${rawPid}` : '',
    nameKey: normName ? `name:${normName}` : '',
  };
}

function mergeUniqueStrings(baseArr, extraArr, normalizeFn = (x) => String(x || '')) {
  const result = [];
  const seen = new Set();
  for (const list of [baseArr, extraArr]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item !== 'string' || !item.trim()) continue;
      const key = normalizeFn(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function mergeUniqueLinks(baseLinks, extraLinks) {
  const result = [];
  const seen = new Set();
  for (const list of [baseLinks, extraLinks]) {
    if (!Array.isArray(list)) continue;
    for (const link of list) {
      if (!link || typeof link !== 'object') continue;
      const url = String(link.url || '').trim();
      if (!url) continue;
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ label: String(link.label || url), url });
    }
  }
  return result;
}

function extractCachedSlicesFromExisting(existingEntries, offlineSet, roots) {
  /** @type {Map<number, any[]>} */
  const offlineSlices = new Map();
  if (!Array.isArray(existingEntries) || offlineSet.size === 0) return offlineSlices;

  const pushSlice = (rootIdx, slice) => {
    if (!offlineSlices.has(rootIdx)) offlineSlices.set(rootIdx, []);
    offlineSlices.get(rootIdx).push(slice);
  };

  for (const entry of existingEntries) {
    if (!entry || typeof entry !== 'object') continue;
    const sourcesMap = entry.lastFileSources && typeof entry.lastFileSources === 'object' ? entry.lastFileSources : {};

    const entryPrimaryRoot = Number.isInteger(entry.archiveRootIndex) ? entry.archiveRootIndex : 0;
    if (offlineSet.has(entryPrimaryRoot)) {
      const rootMeta = roots[entryPrimaryRoot];
      const primaryPath = entry.primaryPath || entry.path || '';
      const hasExplicitSources = Object.keys(sourcesMap).length > 0;
      const primaryFiles = (entry.lastFiles || []).filter((f) => {
        if (!hasExplicitSources) return true;
        const meta = sourcesMap[f];
        return !meta || meta.rootIndex === entryPrimaryRoot;
      });
      const primaryFileSources = {};
      for (const f of primaryFiles) {
        const src = sourcesMap[f];
        primaryFileSources[f] = {
          rootIndex: entryPrimaryRoot,
          rootLabel:
            src?.rootLabel ||
            entry.archiveRootLabel ||
            rootMeta?.label ||
            getArchiveRootLabel(rootMeta?.rawPath || '', entryPrimaryRoot),
          rootPath: src?.rootPath || entry.archiveRootPath || rootMeta?.rawPath || '',
          offline: true,
        };
      }

      pushSlice(entryPrimaryRoot, {
        ...entry,
        path: primaryPath,
        primaryPath,
        archiveRootIndex: entryPrimaryRoot,
        archiveRootLabel:
          entry.archiveRootLabel || rootMeta?.label || getArchiveRootLabel(rootMeta?.rawPath || '', entryPrimaryRoot),
        archiveRootPath: entry.archiveRootPath || rootMeta?.rawPath || '',
        archiveRootAbsPath: entry.archiveRootAbsPath || rootMeta?.absPath || '',
        lastFiles: primaryFiles,
        lastFileSources: primaryFileSources,
        alternatePaths: [],
        archiveOffline: true,
      });
    }

    // Auch sekundäre Archiv-Orte bewahren, die in einem Offline-Root liegen
    if (Array.isArray(entry.alternatePaths)) {
      for (const alt of entry.alternatePaths) {
        if (!alt || !offlineSet.has(alt.rootIndex)) continue;
        const rootMeta = roots[alt.rootIndex];
        const altFiles = (entry.lastFiles || []).filter((f) => sourcesMap[f]?.rootIndex === alt.rootIndex);
        const altFileSources = {};
        for (const f of altFiles) {
          const src = sourcesMap[f];
          altFileSources[f] = {
            rootIndex: alt.rootIndex,
            rootLabel:
              src?.rootLabel ||
              alt.rootLabel ||
              rootMeta?.label ||
              getArchiveRootLabel(alt.rootPath || '', alt.rootIndex),
            rootPath: src?.rootPath || alt.rootPath || rootMeta?.rawPath || '',
            offline: true,
          };
        }

        pushSlice(alt.rootIndex, {
          id: entry.id,
          name: entry.name,
          path: alt.path,
          primaryPath: alt.path,
          archiveRootIndex: alt.rootIndex,
          archiveRootLabel: alt.rootLabel || rootMeta?.label || getArchiveRootLabel(alt.rootPath || '', alt.rootIndex),
          archiveRootPath: alt.rootPath || rootMeta?.rawPath || '',
          archiveRootAbsPath: alt.rootAbsPath || rootMeta?.absPath || '',
          description: '',
          icon: null,
          screenshots: [],
          os: entry.os || [],
          mainCategory: entry.mainCategory || '',
          subCategories: entry.subCategories || [],
          lastFiles: altFiles,
          lastFileSources: altFileSources,
          hasPinnedLast: Boolean(alt.hasPinnedLast),
          searchNames: entry.searchNames || [],
          installPaths: entry.installPaths || [],
          autoPaths: entry.autoPaths || [],
          softwareType: entry.softwareType || 'default',
          installMode: entry.installMode || 'interactive',
          silentArgs: entry.silentArgs || '',
          innoInfFile: entry.innoInfFile || '',
          innoInfExists: Boolean(entry.innoInfExists),
          webSourceType: entry.webSourceType || 'none',
          packageManager: entry.packageManager || '',
          packageId: entry.packageId || '',
          wingetId: entry.wingetId || '',
          keepAllVersions: Boolean(entry.keepAllVersions),
          links: [],
          formats: entry.formats || [],
          hiddenCategory: entry.hiddenCategory || '',
          addedAt: entry.addedAt || 0,
          updatedAt: entry.updatedAt || 0,
          scanMtime: 0,
          archiveOffline: true,
        });
      }
    }
  }

  return offlineSlices;
}

const STRING_FALLBACK_FIELDS = [
  'description',
  'icon',
  'packageManager',
  'packageId',
  'wingetId',
  'mainCategory',
  'hiddenCategory',
  'silentArgs',
  'innoInfFile',
  'githubAssetPattern',
  'webVersionUrl',
  'webVersionPrefix',
  'webVersionSuffix',
  'downloadUrl',
  'dlPrefix',
  'dlSuffix',
  'webVersion',
];

const ARRAY_MERGE_FIELDS = ['subCategories', 'formats', 'os', 'searchNames', 'installPaths', 'autoPaths'];

/**
 * Führt gescannte Software-Einträge aus mehreren Archiv-Wurzeln in Prioritätsreihenfolge zusammen.
 * @param {Map<number, any[]> | Record<number, any[]> | any[][]} scannedByRoot
 * @param {{ existingEntries?: any[], offlineRootIndices?: number[], roots?: Array<{ index: number, rawPath: string, absPath?: string, label?: string }> }} [options]
 * @returns {any[]}
 */
export function mergeMultiRootCatalogEntries(
  scannedByRoot,
  { existingEntries = [], offlineRootIndices = [], roots = [] } = {}
) {
  const offlineSet = new Set(Array.isArray(offlineRootIndices) ? offlineRootIndices : []);
  const offlineSlices = extractCachedSlicesFromExisting(existingEntries, offlineSet, roots);

  const getRootEntries = (idx) => {
    if (offlineSet.has(idx)) return offlineSlices.get(idx) || [];
    if (scannedByRoot instanceof Map) return scannedByRoot.get(idx) || [];
    if (Array.isArray(scannedByRoot)) return scannedByRoot[idx] || [];
    if (scannedByRoot && typeof scannedByRoot === 'object') return scannedByRoot[idx] || [];
    return [];
  };

  let maxRootIndex = roots.length - 1;
  if (scannedByRoot instanceof Map) {
    for (const k of scannedByRoot.keys()) maxRootIndex = Math.max(maxRootIndex, Number(k));
  } else if (Array.isArray(scannedByRoot)) {
    maxRootIndex = Math.max(maxRootIndex, scannedByRoot.length - 1);
  } else if (scannedByRoot && typeof scannedByRoot === 'object') {
    for (const k of Object.keys(scannedByRoot)) maxRootIndex = Math.max(maxRootIndex, Number(k));
  }
  for (const idx of offlineSet) {
    maxRootIndex = Math.max(maxRootIndex, Number(idx));
  }

  /** @type {Array<{ primary: any, sources: Array<{ rootIndex: number, rootLabel: string, rootPath: string, rootAbsPath: string, path: string, offline: boolean, hasPinnedLast: boolean }> }>} */
  const groups = [];
  /** @type {Map<string, number>} */
  const byPackageKey = new Map();
  /** @type {Map<string, number>} */
  const byNameKey = new Map();

  for (let rootIdx = 0; rootIdx <= maxRootIndex; rootIdx++) {
    const entries = getRootEntries(rootIdx);
    const rootMeta = roots[rootIdx] || { index: rootIdx, rawPath: '', absPath: '', label: `Archiv ${rootIdx + 1}` };
    const isRootOffline = offlineSet.has(rootIdx);

    for (const rawEntry of entries) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;

      const rootLabel =
        rawEntry.archiveRootLabel || rootMeta.label || getArchiveRootLabel(rootMeta.rawPath || '', rootIdx);
      const rootPath = rawEntry.archiveRootPath || rootMeta.rawPath || '';
      const rootAbsPath = rawEntry.archiveRootAbsPath || rootMeta.absPath || '';
      const entryOffline = Boolean(isRootOffline || rawEntry.archiveOffline);

      const { packageKey, nameKey } = buildSoftwareMergeKeys(rawEntry);
      let groupIdx = -1;
      if (packageKey && byPackageKey.has(packageKey)) {
        groupIdx = /** @type {number} */ (byPackageKey.get(packageKey));
      } else if (nameKey && byNameKey.has(nameKey)) {
        groupIdx = /** @type {number} */ (byNameKey.get(nameKey));
      }

      const sourceInfo = {
        rootIndex: rootIdx,
        rootLabel,
        rootPath,
        rootAbsPath,
        path: rawEntry.primaryPath || rawEntry.path || '',
        offline: entryOffline,
        hasPinnedLast: Boolean(rawEntry.hasPinnedLast),
      };

      const rawFiles = Array.isArray(rawEntry.lastFiles) ? rawEntry.lastFiles : [];
      const rawFileSources =
        rawEntry.lastFileSources && typeof rawEntry.lastFileSources === 'object' ? rawEntry.lastFileSources : {};

      if (groupIdx === -1) {
        const cloned = {
          ...rawEntry,
          primaryPath: rawEntry.primaryPath || rawEntry.path || '',
          archiveRootIndex: rootIdx,
          archiveRootLabel: rootLabel,
          archiveRootPath: rootPath,
          archiveRootAbsPath: rootAbsPath,
          archiveOffline: entryOffline,
          lastFiles: [...rawFiles],
          lastFileSources: {},
          screenshots: [...(rawEntry.screenshots || [])],
          links: mergeUniqueLinks(rawEntry.links || [], []),
          alternatePaths: [],
        };

        for (const f of cloned.lastFiles) {
          const existingSrc = rawFileSources[f];
          cloned.lastFileSources[f] = {
            rootIndex: existingSrc?.rootIndex ?? rootIdx,
            rootLabel: existingSrc?.rootLabel || rootLabel,
            rootPath: existingSrc?.rootPath || rootPath,
            offline: Boolean(entryOffline || existingSrc?.offline),
          };
        }

        const newIdx = groups.length;
        groups.push({ primary: cloned, sources: [sourceInfo] });
        if (packageKey && !byPackageKey.has(packageKey)) byPackageKey.set(packageKey, newIdx);
        if (nameKey && !byNameKey.has(nameKey)) byNameKey.set(nameKey, newIdx);
      } else {
        const group = groups[groupIdx];
        const primary = group.primary;

        // Duplikate im selben Root nicht als alternatePath doppeln, sondern nur zusammenführen
        const alreadyHasSource = group.sources.some(
          (s) => s.rootIndex === rootIdx && normalizePathKey(s.path) === normalizePathKey(sourceInfo.path)
        );
        if (!alreadyHasSource) {
          group.sources.push(sourceInfo);
          primary.alternatePaths.push(sourceInfo);
        }

        // Dateien zusammenführen mit Herkunfts-Kennzeichnung
        const seenFileKeys = new Set(primary.lastFiles.map((f) => normalizePathKey(f)));
        for (const f of rawFiles) {
          const fKey = normalizePathKey(f);
          if (!fKey) continue;
          const existingSrc = rawFileSources[f];
          if (!seenFileKeys.has(fKey)) {
            seenFileKeys.add(fKey);
            primary.lastFiles.push(f);
          }
          if (!primary.lastFileSources[f]) {
            primary.lastFileSources[f] = {
              rootIndex: existingSrc?.rootIndex ?? rootIdx,
              rootLabel: existingSrc?.rootLabel || rootLabel,
              rootPath: existingSrc?.rootPath || rootPath,
              offline: Boolean(entryOffline || existingSrc?.offline),
            };
          }
        }

        // Screenshots, Links & fehlende Metadaten aus nachrangigem Archiv-Ort ergänzen
        primary.screenshots = mergeUniqueStrings(primary.screenshots, rawEntry.screenshots, (p) => normalizePathKey(p));
        primary.links = mergeUniqueLinks(primary.links, rawEntry.links);
        primary.hasPinnedLast = Boolean(primary.hasPinnedLast || rawEntry.hasPinnedLast);
        primary.keepAllVersions = Boolean(primary.keepAllVersions || rawEntry.keepAllVersions);
        primary.innoInfExists = Boolean(primary.innoInfExists || rawEntry.innoInfExists);
        if ((!primary.webSourceType || primary.webSourceType === 'none') && rawEntry.webSourceType) {
          primary.webSourceType = rawEntry.webSourceType;
        }

        for (const field of STRING_FALLBACK_FIELDS) {
          if (!primary[field] && rawEntry[field]) {
            primary[field] = rawEntry[field];
          }
        }
        for (const field of ARRAY_MERGE_FIELDS) {
          primary[field] = mergeUniqueStrings(primary[field], rawEntry[field], (v) => v.trim().toLowerCase());
        }

        if (!primary.addedAt || (rawEntry.addedAt && rawEntry.addedAt < primary.addedAt)) {
          primary.addedAt = rawEntry.addedAt || primary.addedAt;
        }
        if (rawEntry.updatedAt && rawEntry.updatedAt > (primary.updatedAt || 0)) {
          primary.updatedAt = rawEntry.updatedAt;
        }

        const mergedKeys = buildSoftwareMergeKeys(primary);
        if (mergedKeys.packageKey && !byPackageKey.has(mergedKeys.packageKey)) {
          byPackageKey.set(mergedKeys.packageKey, groupIdx);
        }
        if (mergedKeys.nameKey && !byNameKey.has(mergedKeys.nameKey)) {
          byNameKey.set(mergedKeys.nameKey, groupIdx);
        }
      }
    }
  }

  return groups.map(({ primary, sources }) => {
    const anyOnline = sources.some((s) => !s.offline);
    primary.archiveOffline = !anyOnline;

    const rootIndicesInFiles = new Set(
      Object.values(primary.lastFileSources || {}).map((s) => Number(s?.rootIndex ?? 0))
    );
    primary.hasMultipleArchiveRoots = sources.length > 1 || rootIndicesInFiles.size > 1;

    // Hoechste Versionsnummer absteigend sortieren (bei Multi-Archiv erreichbare Dateien vor Offline)
    if (primary.lastFiles.length > 1) {
      primary.lastFiles = sortArchiveSetupFiles(primary.lastFiles, primary.lastFileSources);
    }

    return primary;
  });
}

/**
 * Sortiert Setup-Dateien absteigend nach hoechster erkannter Versionsnummer
 * (und bevorzugt erreichbare Multi-Archiv-Dateien gegenueber Offline-Quellen).
 * @param {string[]} files
 * @param {Record<string, { offline?: boolean }>} [fileSources]
 * @returns {string[]}
 */
export function sortArchiveSetupFiles(files = [], fileSources = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length <= 1) return [...list];

  const getBaseName = (p) =>
    String(p || '')
      .split(/[\\/]/)
      .pop() || '';
  const hasAnyOnline =
    fileSources && Object.keys(fileSources).length > 0 ? list.some((f) => !fileSources[f]?.offline) : true;

  return [...list].sort((a, b) => {
    if (hasAnyOnline && fileSources && Object.keys(fileSources).length > 0) {
      const aOffline = Boolean(fileSources[a]?.offline);
      const bOffline = Boolean(fileSources[b]?.offline);
      if (aOffline !== bOffline) return aOffline ? 1 : -1;
    }

    const baseA = getBaseName(a);
    const baseB = getBaseName(b);
    const verA = extractVersion(baseA);
    const verB = extractVersion(baseB);

    if (verA && verB) {
      const cmp = compareVersions(verB, verA, 0);
      if (cmp !== 0) return cmp;
    } else if (verA && !verB) {
      return -1;
    } else if (!verA && verB) {
      return 1;
    }

    return baseB.localeCompare(baseA, 'en', { numeric: true, sensitivity: 'base' });
  });
}

/**
 * Ermittelt für bestehende Software den höchstpriorisierten erreichbaren Archiv-Ordner
 * (z. B. für Downloads/Updates). Gibt `null` zurück, wenn alle Quellen offline sind.
 * @param {any} item
 * @param {{ archiveRoots?: string[], pathExists?: (p: string) => boolean }} [options]
 * @returns {string | null}
 */
export function resolveBestArchivePath(item, { archiveRoots = [], pathExists = () => false } = {}) {
  const candidates = [];

  if (item?.primaryPath || item?.path) {
    candidates.push({
      path: item.primaryPath || item.path,
      rootIndex: Number.isInteger(item.archiveRootIndex) ? item.archiveRootIndex : 0,
      rootAbsPath: item.archiveRootAbsPath || archiveRoots[item.archiveRootIndex ?? 0] || '',
      offline: Boolean(item.archiveOffline),
    });
  }

  if (Array.isArray(item?.alternatePaths)) {
    for (const alt of item.alternatePaths) {
      if (!alt?.path) continue;
      candidates.push({
        path: alt.path,
        rootIndex: Number.isInteger(alt.rootIndex) ? alt.rootIndex : 999,
        rootAbsPath: alt.rootAbsPath || archiveRoots[alt.rootIndex] || '',
        offline: Boolean(alt.offline),
      });
    }
  }

  candidates.sort((a, b) => a.rootIndex - b.rootIndex);

  for (const cand of candidates) {
    if (cand.path && pathExists(cand.path)) {
      return cand.path;
    }
    const matchingRoot = cand.rootAbsPath || archiveRoots.find((r) => isNormalizedPathInsideDir(cand.path, r));
    if (matchingRoot && pathExists(matchingRoot)) {
      return cand.path;
    }
  }

  return null;
}

/**
 * Gibt den höchstpriorisierten erreichbaren Archiv-Stammordner zurück.
 * @param {string[]} archiveRoots
 * @param {(p: string) => boolean} pathExists
 * @returns {string | null}
 */
export function resolvePrimaryReachableRoot(archiveRoots, pathExists) {
  if (!Array.isArray(archiveRoots) || archiveRoots.length === 0) return null;
  for (const root of archiveRoots) {
    if (root && pathExists(root)) return root;
  }
  return archiveRoots[0] || null;
}

/**
 * Formatiert den Dateinamen im Detail-Modal inkl. Herkunftskennzeichnung bei Multi-Root-Einträgen.
 * @param {string} filePath
 * @param {Record<string, { rootIndex?: number, rootLabel?: string, offline?: boolean }> | null | undefined} lastFileSources
 * @param {boolean} [showRootPrefix]
 * @returns {string}
 */
export function formatMultiRootFileLabel(filePath, lastFileSources, showRootPrefix = false) {
  const filename = String(filePath || '')
    .split(/[/\\]/)
    .pop();
  if (!showRootPrefix || !lastFileSources || typeof lastFileSources !== 'object') {
    return filename || '';
  }
  const src = lastFileSources[filePath];
  if (!src) return filename || '';
  const idx = Number.isInteger(src.rootIndex) ? src.rootIndex + 1 : 1;
  const label = src.rootLabel || `Archiv ${idx}`;
  const offlineSuffix = src.offline ? ' (offline)' : '';
  return `[#${idx} ${label}${offlineSuffix}] ${filename}`;
}
