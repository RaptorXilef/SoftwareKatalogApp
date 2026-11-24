import { parseDisplayIcon } from './icon-logic.js';

const GENERIC_ID_TAILS = new Set([
  'app',
  'cli',
  'desktop',
  'client',
  'studio',
  'pro',
  'viewer',
  'player',
  'editor',
  'tool',
  'tools',
  'manager',
  'launcher',
  'installer',
  'setup',
  'updater',
  'runtime',
  'sdk',
  'core',
  'windows',
  'win',
  'x64',
  'x86',
  'stable',
  'beta',
  'nightly',
  'canary',
  'dev',
  'insiders',
  'community',
  'enterprise',
  'free',
  'lite',
  'plus',
  'home',
  'standard',
]);

const GENERIC_INSTALL_DIRS = new Set([
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

function splitCamelCaseWords(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
}

function stripVersionSuffix(name) {
  return String(name || '')
    .replace(/\s+\(?(?:x64|x86|64-bit|32-bit|current user|user)\)?/gi, '')
    .replace(/\s+v?\d+(?:\.\d+)+.*$/i, '')
    .trim();
}

function normalizeWinPath(rawPath) {
  if (!rawPath) return '';
  return String(rawPath)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

function isGenericInstallDir(dir) {
  if (!dir) return true;
  if (GENERIC_INSTALL_DIRS.has(dir)) return true;
  if (/^[a-z]:$/.test(dir)) return true;
  if (/\\appdata\\(local|roaming|local\\programs)$/.test(dir)) return true;
  return false;
}

function extractDirFromExePath(normPath) {
  if (!normPath || !/\.(exe|ico|dll|bat|cmd|ps1|msi)$/i.test(normPath)) return normPath;
  const idx = normPath.lastIndexOf('\\');
  return idx > 0 ? normPath.slice(0, idx) : '';
}

function extractExeFromUninstall(cmd) {
  const raw = String(cmd || '').trim();
  if (!raw) return '';
  const quotedMatch = raw.match(/^"([^"]+\.exe)"/i);
  if (quotedMatch) return quotedMatch[1];
  const exeMatch = raw.match(/^([a-z]:\\[^"]*?\.exe)\b/i);
  return exeMatch ? exeMatch[1] : '';
}

function collectStrictPaths(rawEntries) {
  const files = new Set();
  const dirs = new Set();
  for (const raw of rawEntries) {
    const norm = normalizeWinPath(raw);
    if (!norm) continue;
    if (/\.(exe|bat|cmd|ps1)$/i.test(norm)) {
      files.add(norm);
    }
    const dir = extractDirFromExePath(norm);
    if (dir && !isGenericInstallDir(dir)) {
      dirs.add(dir);
    }
  }
  return { files, dirs };
}

function hasExactPathMatch(archivePaths, reg) {
  if (!archivePaths || (archivePaths.files.size === 0 && archivePaths.dirs.size === 0)) return false;
  const parsedIcon = parseDisplayIcon(reg.displayIcon);
  const regPaths = collectStrictPaths([
    parsedIcon.path,
    reg.installLocation,
    extractExeFromUninstall(reg.uninstallString),
  ]);

  for (const file of archivePaths.files) {
    if (regPaths.files.has(file)) return true;
  }
  for (const dir of archivePaths.dirs) {
    if (regPaths.dirs.has(dir)) return true;
  }
  return false;
}

function resolveTruncatedWingetId(truncatedId, exportsList) {
  if (!truncatedId) return '';
  if (!truncatedId.endsWith('…') && !truncatedId.endsWith('...')) return truncatedId;

  const prefix = truncatedId.replace(/(?:…|\.\.\.)$/, '').toLowerCase();
  if (!prefix) return truncatedId;

  const match = exportsList.find((e) => e.packageId.toLowerCase().startsWith(prefix));
  return match ? match.packageId : truncatedId;
}

function registryRichnessScore(entry) {
  let score = 0;
  if (entry.quietUninstallString) score += 4;
  if (entry.uninstallString) score += 3;
  if (entry.displayIcon) score += 2;
  if (entry.installLocation) score += 2;
  if (entry.publisher) score += 1;
  return score;
}

function cleanRegistryEntries(entries, includeSystemComponents) {
  const deduped = new Map();

  for (const raw of entries || []) {
    const displayName = String(raw?.displayName || raw?.DisplayName || '').trim();
    if (!displayName) continue;

    const systemComponent = Number(raw?.systemComponent ?? raw?.SystemComponent ?? 0);
    const parentKeyName = String(raw?.parentKeyName || raw?.ParentKeyName || '').trim();
    if (!includeSystemComponents && (systemComponent === 1 || parentKeyName)) {
      continue;
    }

    const entry = {
      displayName,
      displayVersion: String(raw?.displayVersion || raw?.DisplayVersion || '').trim(),
      publisher: String(raw?.publisher || raw?.Publisher || '').trim(),
      uninstallString: String(raw?.uninstallString || raw?.UninstallString || '').trim(),
      quietUninstallString: String(raw?.quietUninstallString || raw?.QuietUninstallString || '').trim(),
      displayIcon: String(raw?.displayIcon || raw?.DisplayIcon || '').trim(),
      installLocation: String(raw?.installLocation || raw?.InstallLocation || '').trim(),
      registryKey: String(raw?.registryKey || raw?.PSChildName || '').trim(),
    };

    const dedupeKey = `${normalizeText(displayName)}|${entry.displayVersion.toLowerCase()}`;
    const existing = deduped.get(dedupeKey);
    if (!existing || registryRichnessScore(entry) > registryRichnessScore(existing)) {
      deduped.set(dedupeKey, entry);
    }
  }

  return [...deduped.values()];
}

function findMatchingRegistryIndex(wingetItem, upgradeInfo, registryEntries, usedRegIndices, archiveLookup = null) {
  const pkgId = wingetItem.packageId;
  const pkgIdLower = pkgId.toLowerCase();
  const idSegments = pkgId
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  const idPartsCompact = idSegments.map((p) => normalizeCompact(p)).filter((p) => p.length >= 2);
  const rawTail = idSegments[idSegments.length - 1] || '';
  const idTailCompact = normalizeCompact(rawTail);
  const idTailSpaced = normalizeText(splitCamelCaseWords(rawTail));
  const idPublisherCompact = idPartsCompact[0] || '';
  const idFullCompact = normalizeCompact(idSegments.join(''));

  const wingetVer = (wingetItem.version || upgradeInfo?.installedVersion || '').toLowerCase();
  const archiveItem = archiveLookup?.byPackageKey?.get(`winget:${pkgIdLower}`) || null;
  const archivePaths = archiveItem
    ? collectStrictPaths([
        archiveItem.validInstallPath,
        ...(archiveItem.autoPaths || []),
        ...(archiveItem.installPaths || []),
      ])
    : null;

  const exactNameCandidates = new Set();
  const addNameCandidate = (raw) => {
    if (!raw) return;
    const full = normalizeText(raw);
    const base = normalizeText(stripVersionSuffix(raw));
    if (full) exactNameCandidates.add(full);
    if (base) exactNameCandidates.add(base);
  };
  addNameCandidate(upgradeInfo?.name);
  if (archiveItem) {
    addNameCandidate(archiveItem.name);
    for (const s of archiveItem.searchNames || []) addNameCandidate(s);
  }

  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < registryEntries.length; i++) {
    if (usedRegIndices.has(i)) continue;
    const reg = registryEntries[i];
    let tierScore = 0;

    // Tier 1: Exakter Registry-Schlüssel == Winget-Paket-ID
    if (reg.registryKey && reg.registryKey.toLowerCase() === pkgIdLower) {
      tierScore = Math.max(tierScore, 1000);
    }

    // Tier 2: Exakter Installations-/Executable-Pfad eines mit dieser Winget-ID verknüpften Archiv-Eintrags
    if (archivePaths && hasExactPathMatch(archivePaths, reg)) {
      tierScore = Math.max(tierScore, 900);
    }

    const regNameFull = normalizeText(reg.displayName);
    const regNameBase = normalizeText(stripVersionSuffix(reg.displayName));
    const regCompact = normalizeCompact(stripVersionSuffix(reg.displayName));
    const regPubCompact = normalizeCompact(reg.publisher);

    // Tier 3: Exakter normalisierter Name (aus Winget-Upgrade-Liste oder verknüpftem Archiv-Eintrag)
    if (
      (regNameFull && exactNameCandidates.has(regNameFull)) ||
      (regNameBase && exactNameCandidates.has(regNameBase))
    ) {
      tierScore = Math.max(tierScore, 800);
    }

    // Tier 4: Exakter kompakter Match auf Publisher+Name oder eindeutigen Paket-ID-Tail (ohne Substring-Raten!)
    if (idFullCompact && regCompact === idFullCompact) {
      tierScore = Math.max(tierScore, 750);
    } else if (
      idTailCompact &&
      idTailCompact.length >= 2 &&
      !GENERIC_ID_TAILS.has(idTailCompact) &&
      (regCompact === idTailCompact || (idTailSpaced && regNameBase === idTailSpaced))
    ) {
      tierScore = Math.max(tierScore, 700);
    }

    // Kein strikter Treffer -> niemals per Substring zuordnen!
    if (tierScore === 0) continue;

    let tieScore = tierScore + registryRichnessScore(reg);
    if (idPublisherCompact && regPubCompact && regPubCompact === idPublisherCompact) {
      tieScore += 15;
    }
    if (wingetVer && reg.displayVersion) {
      const regVer = reg.displayVersion.toLowerCase();
      if (regVer === wingetVer) tieScore += 20;
      else if (regVer.startsWith(wingetVer) || wingetVer.startsWith(regVer)) tieScore += 10;
    }

    if (tieScore > bestScore) {
      bestScore = tieScore;
      bestIdx = i;
    }
  }

  return bestIdx;
}

function buildArchiveLookup(catalogItems) {
  const byPackageKey = new Map();
  const byName = new Map();

  for (const item of catalogItems || []) {
    const pm = (item.packageManager || (item.wingetId ? 'winget' : '')).toLowerCase();
    const pid = (item.packageId || item.wingetId || '').toLowerCase();
    if (pm && pid) {
      byPackageKey.set(`${pm}:${pid}`, item);
    }
    const candidates = [item.name, ...(item.searchNames || [])].filter(Boolean);
    for (const c of candidates) {
      const norm = normalizeText(c);
      if (norm && !byName.has(norm)) {
        byName.set(norm, item);
      }
    }
  }

  return { byPackageKey, byName };
}

function findArchiveMatch(lookup, { packageManager, packageId, name }) {
  if (packageManager && packageId) {
    const direct = lookup.byPackageKey.get(`${packageManager.toLowerCase()}:${packageId.toLowerCase()}`);
    if (direct) return direct;
  }
  const baseName = normalizeText(stripVersionSuffix(name));
  if (baseName && lookup.byName.has(baseName)) {
    return lookup.byName.get(baseName);
  }
  const fullName = normalizeText(name);
  if (fullName && lookup.byName.has(fullName)) {
    return lookup.byName.get(fullName);
  }
  return null;
}

/**
 * Führt `winget export`, `winget upgrade`, Windows-Registry-Uninstall-Daten
 * und den Archiv-Katalog zu einer einheitlichen Programmliste zusammen.
 */
export function mergeInstalledSoftware({
  wingetExports = [],
  wingetUpgrades = [],
  registryEntries = [],
  catalogItems = [],
  includeSystemComponents = false,
}) {
  const cleanRegistry = cleanRegistryEntries(registryEntries, includeSystemComponents);
  const archiveLookup = buildArchiveLookup(catalogItems);

  const upgradeById = new Map();
  for (const up of wingetUpgrades || []) {
    const resolvedId = resolveTruncatedWingetId(up.packageId, wingetExports);
    if (resolvedId) {
      upgradeById.set(resolvedId.toLowerCase(), { ...up, packageId: resolvedId });
    }
  }

  const wingetMap = new Map();
  for (const exp of wingetExports || []) {
    if (!exp.packageId) continue;
    wingetMap.set(exp.packageId.toLowerCase(), {
      packageManager: 'winget',
      packageId: exp.packageId,
      version: exp.version || '',
      source: exp.source || 'winget',
    });
  }
  for (const [key, up] of upgradeById.entries()) {
    if (!wingetMap.has(key)) {
      wingetMap.set(key, {
        packageManager: 'winget',
        packageId: up.packageId,
        version: up.installedVersion || '',
        source: up.source || 'winget',
      });
    }
  }

  const usedRegIndices = new Set();
  const programs = [];

  for (const wg of wingetMap.values()) {
    const up = upgradeById.get(wg.packageId.toLowerCase()) || null;
    const regIdx = findMatchingRegistryIndex(wg, up, cleanRegistry, usedRegIndices, archiveLookup);
    const reg = regIdx !== -1 ? cleanRegistry[regIdx] : null;
    if (regIdx !== -1) usedRegIndices.add(regIdx);

    const displayName = reg?.displayName || up?.name || wg.packageId;
    const installedVersion = reg?.displayVersion || wg.version || up?.installedVersion || '';
    const availableVersion = up?.availableVersion || '';
    const archiveMatch = findArchiveMatch(archiveLookup, {
      packageManager: 'winget',
      packageId: wg.packageId,
      name: displayName,
    });

    programs.push({
      id: `winget:${wg.packageId.toLowerCase()}`,
      name: displayName,
      publisher: reg?.publisher || '',
      installedVersion,
      availableVersion,
      hasUpdate: Boolean(availableVersion),
      packageManager: 'winget',
      packageId: wg.packageId,
      source: wg.source || up?.source || 'winget',
      uninstallString: reg?.uninstallString || '',
      quietUninstallString: reg?.quietUninstallString || '',
      displayIcon: reg?.displayIcon || '',
      installLocation: reg?.installLocation || '',
      registryKey: reg?.registryKey || '',
      canUninstall: true,
      inArchive: Boolean(archiveMatch),
      archiveItemId: archiveMatch?.id || null,
      archivePath: archiveMatch?.path || null,
      archiveIcon: archiveMatch?.icon || null,
    });
  }

  for (let i = 0; i < cleanRegistry.length; i++) {
    if (usedRegIndices.has(i)) continue;
    const reg = cleanRegistry[i];
    const archiveMatch = findArchiveMatch(archiveLookup, {
      packageManager: '',
      packageId: '',
      name: reg.displayName,
    });

    const regSlug = reg.registryKey || `${normalizeCompact(reg.displayName)}:${reg.displayVersion}`;
    programs.push({
      id: `registry:${regSlug.toLowerCase()}`,
      name: reg.displayName,
      publisher: reg.publisher || '',
      installedVersion: reg.displayVersion || '',
      availableVersion: '',
      hasUpdate: false,
      packageManager: null,
      packageId: null,
      source: 'registry',
      uninstallString: reg.uninstallString || '',
      quietUninstallString: reg.quietUninstallString || '',
      displayIcon: reg.displayIcon || '',
      installLocation: reg.installLocation || '',
      registryKey: reg.registryKey || '',
      canUninstall: Boolean(reg.uninstallString || reg.quietUninstallString),
      inArchive: Boolean(archiveMatch),
      archiveItemId: archiveMatch?.id || null,
      archivePath: archiveMatch?.path || null,
      archiveIcon: archiveMatch?.icon || null,
    });
  }

  programs.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  return programs;
}
