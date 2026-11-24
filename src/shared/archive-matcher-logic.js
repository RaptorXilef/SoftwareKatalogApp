import { getBaseName } from './unified-packages.js';

const GENERIC_DIRS = new Set([
  'c:',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\program files\\common files',
  'c:\\program files (x86)\\common files',
  'c:\\windows',
  'c:\\windows\\system32',
  'c:\\windows\\syswow64',
  'c:\\programdata',
]);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim();
}

function normalizeCompact(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]/g, '');
}

function stripVersionAndNoise(name) {
  return String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\((?:x64|x86|64-bit|32-bit|win64|win32|arm64|current user|user|portable)\)/gi, ' ')
    .replace(/\b(?:x64|x86|64\s*bit|32\s*bit|win64|win32|arm64|portable|setup|installer)\b/gi, ' ')
    .replace(/(?:^|\s)v?\d+(?:\.\d+)+.*$/i, ' ')
    .replace(/\s+\b(?:20\d{2}|19\d{2})\b\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeWinPath(rawPath) {
  if (!rawPath) return '';
  return String(rawPath)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/,-?\d+$/, '')
    .trim()
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

function extractInstallDir(rawPath) {
  const norm = normalizeWinPath(rawPath);
  if (!norm) return '';
  if (/\.(exe|ico|dll|bat|cmd|lnk|ps1|msi)$/i.test(norm)) {
    const idx = norm.lastIndexOf('\\');
    return idx > 0 ? norm.slice(0, idx) : '';
  }
  return norm;
}

function isGenericSystemDir(dir) {
  if (!dir) return true;
  if (GENERIC_DIRS.has(dir)) return true;
  if (/^[a-z]:$/.test(dir)) return true;
  if (/\\appdata\\(local|roaming|local\\programs)$/.test(dir)) return true;
  return false;
}

function extractExeFromCommand(cmd) {
  const raw = String(cmd || '').trim();
  if (!raw) return '';
  const quotedMatch = raw.match(/^"([^"]+\.exe)"/i);
  if (quotedMatch) return quotedMatch[1];
  const exeMatch = raw.match(/^([a-z]:\\[^"]*?\.exe)\b/i);
  return exeMatch ? exeMatch[1] : '';
}

function collectPaths(rawEntries) {
  const files = new Set();
  const dirs = new Set();

  for (const raw of rawEntries) {
    const norm = normalizeWinPath(raw);
    if (!norm) continue;
    if (/\.(exe|bat|cmd|ps1)$/i.test(norm)) {
      files.add(norm);
    }
    const dir = extractInstallDir(norm);
    if (dir && !isGenericSystemDir(dir)) {
      dirs.add(dir);
    }
  }

  return { files, dirs };
}

function pathsMatch(archivePaths, pcPaths) {
  for (const file of archivePaths.files) {
    if (pcPaths.files.has(file)) return true;
  }
  for (const dirA of archivePaths.dirs) {
    for (const dirB of pcPaths.dirs) {
      if (dirA === dirB || dirA.startsWith(`${dirB}\\`) || dirB.startsWith(`${dirA}\\`)) {
        return true;
      }
    }
  }
  return false;
}

function getItemNameVariants(item) {
  const folderName = getBaseName(item?.path || '');
  const rawList = [item?.name, folderName, ...(Array.isArray(item?.searchNames) ? item.searchNames : [])].filter(
    Boolean
  );
  const normalized = new Set();
  const compact = new Set();

  for (const raw of rawList) {
    const full = normalizeText(raw);
    const stripped = normalizeText(stripVersionAndNoise(raw));
    if (full) {
      normalized.add(full);
      compact.add(normalizeCompact(full));
    }
    if (stripped) {
      normalized.add(stripped);
      compact.add(normalizeCompact(stripped));
    }
  }

  return { normalized, compact, folderName };
}

function toCandidate(app, source) {
  return {
    packageManager: 'winget',
    packageId: String(app.packageId || app.id || '').trim(),
    name: String(app.name || app.packageId || '').trim(),
    version: String(app.installedVersion || app.version || '').trim(),
    source,
  };
}

/**
 * Prüft, ob ein Katalog-Eintrag bereits eine Paket-ID (packageId oder wingetId) besitzt.
 */
function hasAssignedPackageId(item) {
  return Boolean(String(item?.packageId || item?.wingetId || '').trim());
}

/**
 * Liefert alle Archiv-Ordner ohne hinterlegte Paket-ID.
 */
export function getUnmatchedArchiveItems(catalogItems = []) {
  return (catalogItems || []).filter((item) => item && !hasAssignedPackageId(item));
}

/**
 * Erzeugt eine bereinigte Suchanfrage für `winget search` aus Name bzw. Ordnername.
 */
export function buildWingetSearchQuery(item) {
  const folderName = getBaseName(item?.path || '');
  const rawName = String(item?.name || '').trim();

  const cleanedName = stripVersionAndNoise(rawName);
  if (cleanedName.length >= 2) return cleanedName;

  const cleanedFolder = stripVersionAndNoise(folderName);
  if (cleanedFolder.length >= 2) return cleanedFolder;

  return rawName || folderName || '';
}

function findInstalledWingetMatch(item, installedApps, usedPackageIds) {
  const itemPaths = collectPaths([item.validInstallPath, ...(item.autoPaths || []), ...(item.installPaths || [])]);
  const { normalized: itemNames, compact: itemCompacts } = getItemNameVariants(item);

  // 1. Direkte Verknüpfung über archiveItemId
  for (const app of installedApps) {
    const pid = String(app.packageId || '').trim();
    if (!pid || usedPackageIds.has(pid.toLowerCase())) continue;
    if (app.archiveItemId && app.archiveItemId === item.id) {
      return {
        app,
        reason: 'Installiertes PC-Programm (Katalog-Verknüpfung)',
        reasonKey: 'archiveMatcher.reasonCatalogLink',
        reasonParams: {},
      };
    }
  }

  // 2. Installationspfad-Abgleich (ohne generische Systemordner)
  if (itemPaths.files.size > 0 || itemPaths.dirs.size > 0) {
    for (const app of installedApps) {
      const pid = String(app.packageId || '').trim();
      if (!pid || usedPackageIds.has(pid.toLowerCase())) continue;
      const pcPaths = collectPaths([app.displayIcon, app.installLocation, extractExeFromCommand(app.uninstallString)]);
      if (pathsMatch(itemPaths, pcPaths)) {
        return {
          app,
          reason: 'Installiertes PC-Programm (Pfad)',
          reasonKey: 'archiveMatcher.reasonPath',
          reasonParams: {},
        };
      }
    }
  }

  // 3. Exakter Name gegen PC-App-Name oder eindeutigen ID-Endteil
  if (itemNames.size > 0) {
    for (const app of installedApps) {
      const pid = String(app.packageId || '').trim();
      if (!pid || usedPackageIds.has(pid.toLowerCase())) continue;

      const pcFull = normalizeText(app.name);
      const pcStripped = normalizeText(stripVersionAndNoise(app.name));
      if ((pcFull && itemNames.has(pcFull)) || (pcStripped && itemNames.has(pcStripped))) {
        return {
          app,
          reason: 'Installiertes PC-Programm (Name)',
          reasonKey: 'archiveMatcher.reasonName',
          reasonParams: {},
        };
      }

      const idParts = pid
        .split('.')
        .map((p) => normalizeCompact(p))
        .filter(Boolean);
      const idTail = idParts[idParts.length - 1] || '';
      const idPub = idParts[0] || '';
      const combinedId = normalizeText(pid.replace(/\./g, ' '));

      if (idTail.length >= 3 && itemCompacts.has(idTail)) {
        return {
          app,
          reason: 'Winget-Export ID',
          reasonKey: 'archiveMatcher.reasonWingetExport',
          reasonParams: {},
        };
      }
      if (idPub && idTail && combinedId && itemNames.has(combinedId)) {
        return {
          app,
          reason: 'Winget-Export ID',
          reasonKey: 'archiveMatcher.reasonWingetExport',
          reasonParams: {},
        };
      }
    }
  }

  return null;
}

/**
 * Stufe 1 (sicher & automatisch): Gleicht Archiv-Ordner ohne `packageId`
 * mit den per `winget export` erkannten installierten PC-Programmen ab.
 */
export function matchArchiveWithInstalledWinget(unmatchedItems = [], installedWingetApps = []) {
  const validInstalled = (installedWingetApps || []).filter((app) => {
    const pid = String(app?.packageId || '').trim();
    return Boolean(pid);
  });

  const usedPackageIds = new Set();
  const matched = [];
  const remaining = [];

  for (const item of unmatchedItems || []) {
    const hit = findInstalledWingetMatch(item, validInstalled, usedPackageIds);
    if (hit) {
      const candidate = toCandidate(hit.app, 'winget-export');
      usedPackageIds.add(candidate.packageId.toLowerCase());
      matched.push({
        itemId: item.id,
        itemName: item.name || getBaseName(item.path),
        itemPath: item.path,
        folderName: getBaseName(item.path),
        stage: 'installed',
        confidence: 'high',
        preselected: true,
        matchReason: hit.reason,
        matchReasonKey: hit.reasonKey,
        matchReasonParams: hit.reasonParams || {},
        selectedPackageId: candidate.packageId,
        candidates: [candidate],
      });
    } else {
      remaining.push(item);
    }
  }

  return { matched, remaining };
}

/**
 * Bewertet und dedupliziert `winget search`-Kandidaten für einen Archiv-Ordner.
 * @param {Record<string, any>} item
 * @param {Array<Record<string, any>>} [searchResults]
 * @param {{ limit?: number, locale?: string }} [options]
 */
export function rankSearchCandidates(item, searchResults = [], { limit = 8, locale = 'de' } = {}) {
  const { normalized: itemNames, compact: itemCompacts } = getItemNameVariants(item);
  const itemTokens = new Set();
  for (const name of itemNames) {
    for (const token of name.split(/\s+/)) {
      if (token.length >= 2) itemTokens.add(token);
    }
  }

  const deduped = new Map();

  for (const raw of searchResults || []) {
    const pkgId = String(raw?.packageId || raw?.id || '').trim();
    if (!pkgId) continue;
    const key = pkgId.toLowerCase();
    if (deduped.has(key)) continue;

    const candName = String(raw?.name || pkgId).trim();
    const candNorm = normalizeText(candName);
    const candStripped = normalizeText(stripVersionAndNoise(candName));
    const candCompact = normalizeCompact(candStripped || candName);

    const idParts = pkgId
      .split('.')
      .map((p) => normalizeCompact(p))
      .filter(Boolean);
    const idTail = idParts[idParts.length - 1] || '';

    let score = 0;
    for (const targetNorm of itemNames) {
      if (!targetNorm) continue;
      if (candNorm === targetNorm || candStripped === targetNorm) {
        score = Math.max(score, 100);
      } else if (candNorm.startsWith(targetNorm) || targetNorm.startsWith(candStripped || candNorm)) {
        score = Math.max(score, 65);
      } else if (candNorm.includes(targetNorm) || targetNorm.includes(candStripped || candNorm)) {
        score = Math.max(score, 50);
      }
    }

    for (const targetCompact of itemCompacts) {
      if (!targetCompact) continue;
      if (idTail && idTail === targetCompact) {
        score = Math.max(score, 85);
      } else if (idTail && idTail.length >= 3 && (idTail.includes(targetCompact) || targetCompact.includes(idTail))) {
        score = Math.max(score, 45);
      }
      if (candCompact && candCompact === targetCompact) {
        score = Math.max(score, 95);
      }
    }

    const candTokens = new Set(`${candNorm} ${normalizeText(pkgId.replace(/\./g, ' '))}`.split(/\s+/).filter(Boolean));
    let tokenHits = 0;
    for (const tok of itemTokens) {
      if (candTokens.has(tok)) tokenHits++;
    }
    score += tokenHits * 15;

    deduped.set(key, {
      packageManager: 'winget',
      packageId: pkgId,
      name: candName,
      version: String(raw?.version || '').trim(),
      source: 'winget-search',
      score,
    });
  }

  const effectiveLocale = locale || 'de';
  return [...deduped.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, effectiveLocale, { sensitivity: 'base' }))
    .slice(0, limit);
}

/**
 * Erzeugt einen Stufe-2-Checklisten-Eintrag (niemals ungefragt vorab angehakt).
 * @param {Record<string, any>} item
 * @param {Array<Record<string, any>>} [searchResults]
 * @param {{ query?: string, locale?: string }} [options]
 */
export function buildStage2Entry(item, searchResults = [], { query = '', locale = 'de' } = {}) {
  const candidates = rankSearchCandidates(item, searchResults, { locale });
  const topScore = candidates[0]?.score || 0;
  const matchReasonKey =
    candidates.length > 0
      ? query
        ? 'archiveMatcher.reasonSearchQuery'
        : 'archiveMatcher.reasonSearch'
      : query
        ? 'archiveMatcher.reasonNoHitQuery'
        : 'archiveMatcher.reasonNoHit';

  return {
    itemId: item.id,
    itemName: item.name || getBaseName(item.path),
    itemPath: item.path,
    folderName: getBaseName(item.path),
    stage: candidates.length > 0 ? 'search' : 'none',
    confidence: candidates.length === 0 ? 'none' : topScore >= 90 ? 'medium' : 'low',
    preselected: false,
    matchReason:
      candidates.length > 0
        ? `Winget-Suche${query ? ` ("${query}")` : ''}`
        : `Kein Winget-Treffer${query ? ` für "${query}"` : ''}`,
    matchReasonKey,
    matchReasonParams: query ? { query } : {},
    selectedPackageId: candidates[0]?.packageId || '',
    candidates,
  };
}
