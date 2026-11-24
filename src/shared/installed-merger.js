import { parseDisplayIcon } from './icon-logic.js';
import { extractMsiProductCodeFromEntry } from './msi-parser.js';

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
      windowsInstaller: Number(raw?.windowsInstaller ?? raw?.WindowsInstaller ?? 0),
    };

    const dedupeKey = `${normalizeText(displayName)}|${entry.displayVersion.toLowerCase()}`;
    const existing = deduped.get(dedupeKey);
    if (!existing || registryRichnessScore(entry) > registryRichnessScore(existing)) {
      deduped.set(dedupeKey, entry);
    }
  }

  return [...deduped.values()];
}

const REGISTRY_MATCHABLE_PMS = new Set(['winget', 'msstore', 'scoop', 'chocolatey']);

const CRYPTIC_STORE_ID_RE = /^(?:9[A-Z0-9]{11}|XP[A-Z0-9]{10,})$/i;
const RAW_GUID_RE = /^\{?[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}\}?$/i;
const UNKNOWN_VERSION_RE = /^(?:-|unknown|unbekannt)$/i;
const TRIVIAL_APPX_VERSIONS = new Set(['0.0.0.0', '1.0.0.0', '0.0.0', '1.0.0']);

/**
 * Erkennt kryptische MS-Store-Produkt-IDs (z. B. `9N9PHDT62W94`, `XP...`) oder rohe GUIDs.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isCrypticStoreId(value) {
  const clean = String(value || '').trim();
  if (!clean) return false;
  return CRYPTIC_STORE_ID_RE.test(clean) || RAW_GUID_RE.test(clean);
}

/**
 * Prueft, ob ein Anzeigename leer, kryptisch oder nur eine technische Paket-ID ist.
 * @param {unknown} name
 * @param {unknown} [packageId]
 * @returns {boolean}
 */
export function isIdLikeDisplayName(name, packageId = '') {
  const cleanName = String(name || '').trim();
  if (!cleanName) return true;
  if (isCrypticStoreId(cleanName)) return true;

  const cleanPkgId = String(packageId || '').trim();
  if (cleanPkgId && cleanName.toLowerCase() === cleanPkgId.toLowerCase()) {
    if (
      isCrypticStoreId(cleanPkgId) ||
      cleanPkgId.includes('.') ||
      cleanPkgId.includes('/') ||
      cleanPkgId.includes(':')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Prueft, ob eine Versionsangabe fehlt oder "Unknown"/"Unbekannt"/"-" lautet.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUnknownVersionString(value) {
  const clean = String(value || '').trim();
  return !clean || UNKNOWN_VERSION_RE.test(clean);
}

/**
 * Waehlt aus einer priorisierten Kandidatenliste den besten menschenlesbaren Anzeigenamen
 * und vermeidet kryptische Store-IDs oder abgeschnittene Namen.
 * @param {{ candidates?: Array<unknown>, packageId?: string, packageManager?: string }} [options]
 * @returns {string}
 */
export function pickBestDisplayName({ candidates = [], packageId = '' } = {}) {
  const cleanList = [];
  for (const raw of candidates || []) {
    const s = String(raw || '').trim();
    if (s) cleanList.push(s);
  }
  const cleanPkgId = String(packageId || '').trim();

  // Pass 1: Echter, nicht abgeschnittener Name, der weder kryptisch noch reine ID ist
  for (const cand of cleanList) {
    if (/(?:…|\.\.\.)$/.test(cand)) continue;
    if (!isIdLikeDisplayName(cand, cleanPkgId)) return cand;
  }

  // Pass 2: Nicht-kryptischer Kandidat (z. B. falls Paket-ID selbst der einzige Name ist)
  for (const cand of cleanList) {
    if (!isCrypticStoreId(cand)) return cand;
  }

  return cleanList[0] || cleanPkgId;
}

function getAppxPkgNameWithoutPublisher(packageName) {
  const raw = String(packageName || '').trim();
  if (!raw) return '';
  // Bei AppX-Namen wie "AD2F1837.HPPrinterControl" den sprechenden Teil nach dem Punkt beruecksichtigen
  const dotIdx = raw.indexOf('.');
  return dotIdx !== -1 && dotIdx < raw.length - 1 ? raw.slice(dotIdx + 1) : raw;
}

/**
 * Ordnet einem MS-Store-/Provider-Paket das am besten passende lokale AppX-Manifest/StartApps-Objekt zu.
 * @param {Record<string, any> | null | undefined} pkg
 * @param {Array<Record<string, any>>} [appxEntries]
 * @returns {Record<string, any> | null}
 */
export function matchAppxEntryForPackage(pkg, appxEntries = []) {
  if (!pkg || !Array.isArray(appxEntries) || appxEntries.length === 0) return null;

  const pkgId = String(pkg.packageId || '').trim();
  const pkgIdLower = pkgId.toLowerCase();
  const familyHint = String(pkg.appxPackageFamilyName || '')
    .trim()
    .toLowerCase();
  const pkgVer = String(pkg.version || pkg.installedVersion || '')
    .trim()
    .toLowerCase();
  const pkgPubCompact = normalizeCompact(pkg.publisher || '');

  const rawName = String(pkg.name || '').trim();
  const hasReadableName = Boolean(rawName && !isCrypticStoreId(rawName) && !/(?:…|\.\.\.)$/.test(rawName));
  const pkgNameNorm = hasReadableName ? normalizeText(stripVersionSuffix(rawName)) : '';
  const pkgNameCompact = hasReadableName ? normalizeCompact(stripVersionSuffix(rawName)) : '';

  // Eindeutigkeit einer Versionsnummer vorab bestimmen (nur bei 3+ Teilen ohne triviale 1.0.0.0)
  const versionCounts = new Map();
  for (const entry of appxEntries) {
    const v = String(entry?.version || '')
      .trim()
      .toLowerCase();
    if (v) versionCounts.set(v, (versionCounts.get(v) || 0) + 1);
  }

  let bestEntry = null;
  let bestScore = 0;

  for (const appx of appxEntries) {
    if (!appx || typeof appx !== 'object') continue;
    let score = 0;

    const appxFamily = String(appx.packageFamilyName || '')
      .trim()
      .toLowerCase();
    const appxName = String(appx.name || '')
      .trim()
      .toLowerCase();
    const appxDisp = String(appx.displayName || '').trim();
    const appxDispNorm = normalizeText(stripVersionSuffix(appxDisp));
    const appxDispCompact = normalizeCompact(stripVersionSuffix(appxDisp));
    const appxTailCompact = normalizeCompact(getAppxPkgNameWithoutPublisher(appx.name));
    const appxFullCompact = normalizeCompact(appx.name);
    const appxPubCompact = normalizeCompact(appx.publisherDisplayName || '');
    const appxVer = String(appx.version || '')
      .trim()
      .toLowerCase();

    if (familyHint && appxFamily && familyHint === appxFamily) {
      score = Math.max(score, 1100);
    }

    if (pkgIdLower && ((appxFamily && appxFamily === pkgIdLower) || (appxName && appxName === pkgIdLower))) {
      score = Math.max(score, 1000);
    }

    if (pkgNameNorm && appxDispNorm) {
      if (pkgNameNorm === appxDispNorm || (pkgNameCompact && pkgNameCompact === appxDispCompact)) {
        score = Math.max(score, 900);
      } else if (pkgNameCompact.length >= 3 && appxDispCompact.length >= 3) {
        if (appxDispCompact.startsWith(pkgNameCompact) || pkgNameCompact.startsWith(appxDispCompact)) {
          score = Math.max(score, 820);
        } else if (
          (pkgNameCompact.length >= 5 && appxDispCompact.includes(pkgNameCompact)) ||
          (appxDispCompact.length >= 5 && pkgNameCompact.includes(appxDispCompact))
        ) {
          score = Math.max(score, 720);
        }
      }
    }

    if (pkgNameCompact.length >= 3 && (appxTailCompact || appxFullCompact)) {
      if (pkgNameCompact === appxTailCompact || pkgNameCompact === appxFullCompact) {
        score = Math.max(score, 850);
      } else if (
        (appxTailCompact.length >= 4 &&
          (appxTailCompact.includes(pkgNameCompact) || pkgNameCompact.includes(appxTailCompact))) ||
        (appxFullCompact.length >= 5 && pkgNameCompact.includes(appxFullCompact))
      ) {
        score = Math.max(score, 680);
      }
    }

    // Eindeutige nicht-triviale Version (z. B. 159.1.1160.0) als Fallback fuer kryptische Store-IDs ohne lesbaren Namen
    if (
      score === 0 &&
      !hasReadableName &&
      pkgVer &&
      !isUnknownVersionString(pkgVer) &&
      !TRIVIAL_APPX_VERSIONS.has(pkgVer) &&
      pkgVer.split('.').length >= 3 &&
      appxVer === pkgVer &&
      versionCounts.get(pkgVer) === 1
    ) {
      score = 600;
    }

    if (score === 0) continue;

    if (pkgVer && appxVer && !isUnknownVersionString(pkgVer)) {
      if (appxVer === pkgVer) score += 120;
      else if (appxVer.startsWith(pkgVer) || pkgVer.startsWith(appxVer)) score += 60;
    }

    if (
      pkgPubCompact &&
      appxPubCompact &&
      (pkgPubCompact === appxPubCompact ||
        appxPubCompact.includes(pkgPubCompact) ||
        pkgPubCompact.includes(appxPubCompact))
    ) {
      score += 80;
    }

    if (score > bestScore) {
      bestScore = score;
      bestEntry = appx;
    }
  }

  return bestEntry;
}

function findMatchingRegistryIndex(
  pkgItem,
  upgradeInfo,
  registryEntries,
  usedRegIndices,
  archiveLookup = null,
  cachedMeta = null
) {
  const pkgPm = String(pkgItem.packageManager || 'winget')
    .trim()
    .toLowerCase();
  if (!REGISTRY_MATCHABLE_PMS.has(pkgPm)) {
    return -1;
  }
  const pkgId = String(pkgItem.packageId || '').trim();
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

  const pkgVer = (pkgItem.version || upgradeInfo?.installedVersion || '').toLowerCase();
  const archiveItem = archiveLookup?.byPackageKey?.get(`${pkgPm}:${pkgIdLower}`) || null;
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
  if (pkgItem?.name && !isIdLikeDisplayName(pkgItem.name, pkgId)) {
    addNameCandidate(pkgItem.name);
  }
  if (cachedMeta?.name && !isIdLikeDisplayName(cachedMeta.name, pkgId)) {
    addNameCandidate(cachedMeta.name);
  }
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
    if (pkgVer && reg.displayVersion) {
      const regVer = reg.displayVersion.toLowerCase();
      if (regVer === pkgVer) tieScore += 20;
      else if (regVer.startsWith(pkgVer) || pkgVer.startsWith(regVer)) tieScore += 10;
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

function lookupCachedMeta(cachedMetadata, pm, pkgId) {
  if (!cachedMetadata || !pm || !pkgId) return null;
  const key = `${pm}:${pkgId.toLowerCase()}`;
  if (typeof cachedMetadata === 'function') {
    return cachedMetadata(pm, pkgId, key) || null;
  }
  if (cachedMetadata instanceof Map) {
    return cachedMetadata.get(key) || cachedMetadata.get(pkgId.toLowerCase()) || null;
  }
  if (typeof cachedMetadata === 'object') {
    return cachedMetadata[key] || cachedMetadata[pkgId.toLowerCase()] || null;
  }
  return null;
}

function resolveTruncatedGenericId(truncatedId, candidateIds) {
  if (!truncatedId) return '';
  if (!truncatedId.endsWith('…') && !truncatedId.endsWith('...')) return truncatedId;
  const prefix = truncatedId.replace(/(?:…|\.\.\.)$/, '').toLowerCase();
  if (!prefix) return truncatedId;
  const match = candidateIds.find((id) => id.toLowerCase().startsWith(prefix));
  return match || truncatedId;
}

/**
 * Fuehrt `winget export`, `winget upgrade`, zusaetzliche System-Provider (`scoop`, `chocolatey`, `msstore`, `msi`),
 * Windows-Registry-Uninstall-Daten, AppX-Inventar, gecachte `show()`-Metadaten und den Archiv-Katalog zusammen.
 */
export function mergeInstalledSoftware({
  wingetExports = [],
  wingetUpgrades = [],
  providerInstalled = [],
  providerUpgrades = [],
  registryEntries = [],
  appxEntries = [],
  cachedMetadata = null,
  catalogItems = [],
  includeSystemComponents = false,
  msiEnabled = false,
}) {
  const cleanRegistry = cleanRegistryEntries(registryEntries, includeSystemComponents);
  const archiveLookup = buildArchiveLookup(catalogItems);

  const hasSeparateMsStore =
    (providerInstalled || []).some((p) => String(p?.packageManager || '').toLowerCase() === 'msstore') ||
    (providerUpgrades || []).some((u) => String(u?.packageManager || '').toLowerCase() === 'msstore');

  const filteredWingetExports = hasSeparateMsStore
    ? (wingetExports || []).filter((e) => String(e?.source || '').toLowerCase() !== 'msstore')
    : wingetExports || [];
  const filteredWingetUpgrades = hasSeparateMsStore
    ? (wingetUpgrades || []).filter((u) => String(u?.source || '').toLowerCase() !== 'msstore')
    : wingetUpgrades || [];

  const upgradeById = new Map();
  for (const up of filteredWingetUpgrades) {
    const resolvedId = resolveTruncatedWingetId(up.packageId, filteredWingetExports);
    if (resolvedId) {
      upgradeById.set(resolvedId.toLowerCase(), { ...up, packageId: resolvedId });
    }
  }

  const wingetMap = new Map();
  for (const exp of filteredWingetExports) {
    if (!exp.packageId) continue;
    const key = exp.packageId.toLowerCase();
    wingetMap.set(key, {
      packageManager: 'winget',
      packageId: exp.packageId,
      name: String(exp.name || '').trim(),
      version: exp.version || '',
      availableVersion: String(exp.availableVersion || '').trim(),
      installedVersionIsLowerBound: Boolean(exp.installedVersionIsLowerBound),
      source: exp.source || 'winget',
    });
    if (exp.availableVersion && !upgradeById.has(key)) {
      upgradeById.set(key, {
        packageManager: 'winget',
        packageId: exp.packageId,
        name: String(exp.name || '').trim(),
        installedVersion: exp.version || '',
        availableVersion: String(exp.availableVersion).trim(),
        installedVersionIsLowerBound: Boolean(exp.installedVersionIsLowerBound),
        source: exp.source || 'winget',
      });
    }
  }
  for (const [key, up] of upgradeById.entries()) {
    if (!wingetMap.has(key)) {
      wingetMap.set(key, {
        packageManager: 'winget',
        packageId: up.packageId,
        name: String(up.name || '').trim(),
        version: up.installedVersion || '',
        availableVersion: up.availableVersion || '',
        installedVersionIsLowerBound: Boolean(up.installedVersionIsLowerBound),
        source: up.source || 'winget',
      });
    } else if (up.name && !wingetMap.get(key).name) {
      wingetMap.get(key).name = String(up.name).trim();
    }
  }

  const knownMsStoreIds = [];
  for (const exp of wingetExports || []) {
    if (String(exp?.source || '').toLowerCase() === 'msstore' && exp?.packageId) {
      knownMsStoreIds.push(String(exp.packageId).trim());
    }
  }
  for (const pkg of providerInstalled || []) {
    if (String(pkg?.packageManager || '').toLowerCase() === 'msstore' && (pkg?.packageId || pkg?.id)) {
      const pid = String(pkg.packageId || pkg.id).trim();
      if (!pid.endsWith('…') && !pid.endsWith('...')) {
        knownMsStoreIds.push(pid);
      }
    }
  }

  const genericUpgradeByKey = new Map();
  const upsertGenericUpgrade = (up, forcedPm = '') => {
    const pm =
      forcedPm ||
      String(up?.packageManager || '')
        .trim()
        .toLowerCase();
    let pkgId = String(up?.packageId || up?.id || '').trim();
    if (!pm || !pkgId || pm === 'winget' || pm === 'archive') return;
    if (pm === 'msstore') {
      pkgId = resolveTruncatedGenericId(pkgId, knownMsStoreIds);
    }
    const key = `${pm}:${pkgId.toLowerCase()}`;
    const existing = genericUpgradeByKey.get(key);
    if (!existing) {
      genericUpgradeByKey.set(key, { ...up, packageManager: pm, packageId: pkgId });
      return;
    }
    genericUpgradeByKey.set(key, {
      ...existing,
      ...up,
      packageManager: pm,
      packageId: pkgId,
      name: pickBestDisplayName({ candidates: [existing.name, up.name], packageId: pkgId, packageManager: pm }),
      availableVersion: existing.availableVersion || up.availableVersion || '',
      installedVersion: !isUnknownVersionString(existing.installedVersion)
        ? existing.installedVersion
        : up.installedVersion || existing.installedVersion || '',
      installedVersionIsLowerBound: Boolean(existing.installedVersionIsLowerBound || up.installedVersionIsLowerBound),
    });
  };

  for (const up of providerUpgrades || []) {
    upsertGenericUpgrade(up);
  }

  // Fallback: Falls `winget upgrade` (allgemein) MS-Store-Upgrades enthaelt, fuer `msstore` retten
  if (hasSeparateMsStore) {
    for (const up of wingetUpgrades || []) {
      if (String(up?.source || '').toLowerCase() === 'msstore') {
        upsertGenericUpgrade({ ...up, source: 'msstore' }, 'msstore');
      }
    }
  }

  const genericPkgMap = new Map();
  for (const pkg of providerInstalled || []) {
    const pm = String(pkg?.packageManager || '')
      .trim()
      .toLowerCase();
    const pkgId = String(pkg?.packageId || pkg?.id || '').trim();
    if (!pm || !pkgId || pm === 'winget' || pm === 'archive' || pm === 'msi') continue;

    if (pkg.availableVersion) {
      upsertGenericUpgrade(
        {
          packageManager: pm,
          packageId: pkgId,
          name: pkg.name || '',
          installedVersion: pkg.version || pkg.installedVersion || '',
          availableVersion: pkg.availableVersion,
          installedVersionIsLowerBound: Boolean(pkg.installedVersionIsLowerBound),
          source: pkg.source || pm,
        },
        pm
      );
    }

    const key = `${pm}:${pkgId.toLowerCase()}`;
    const existing = genericPkgMap.get(key);
    if (!existing) {
      genericPkgMap.set(key, {
        packageManager: pm,
        packageId: pkgId,
        name: String(pkg?.name || '').trim(),
        version: String(pkg?.version || pkg?.installedVersion || '').trim(),
        installedVersionIsLowerBound: Boolean(pkg?.installedVersionIsLowerBound),
        bucket: String(pkg?.bucket || '').trim(),
        isActive: Boolean(pkg?.isActive),
        arch: String(pkg?.arch || '').trim(),
        source: String(pkg?.source || pm).trim(),
      });
    } else {
      existing.name = pickBestDisplayName({
        candidates: [existing.name, pkg?.name],
        packageId: pkgId,
        packageManager: pm,
      });
      if (isUnknownVersionString(existing.version) && !isUnknownVersionString(pkg?.version || pkg?.installedVersion)) {
        existing.version = String(pkg?.version || pkg?.installedVersion || '').trim();
      }
    }
  }
  for (const [key, up] of genericUpgradeByKey.entries()) {
    if (!genericPkgMap.has(key)) {
      const pm = String(up.packageManager).trim().toLowerCase();
      const pkgId = String(up.packageId || up.id).trim();
      genericPkgMap.set(key, {
        packageManager: pm,
        packageId: pkgId,
        name: String(up.name || '').trim(),
        version: String(up.installedVersion || '').trim(),
        installedVersionIsLowerBound: Boolean(up.installedVersionIsLowerBound),
        bucket: String(up.bucket || '').trim(),
        isActive: Boolean(up.isActive),
        arch: String(up.arch || '').trim(),
        source: String(up.source || pm).trim(),
      });
    }
  }

  const usedRegIndices = new Set();
  const programs = [];

  for (const wg of wingetMap.values()) {
    const up = upgradeById.get(wg.packageId.toLowerCase()) || null;
    const cachedMeta = lookupCachedMeta(cachedMetadata, 'winget', wg.packageId);
    const regIdx = findMatchingRegistryIndex(wg, up, cleanRegistry, usedRegIndices, archiveLookup, cachedMeta);
    const reg = regIdx !== -1 ? cleanRegistry[regIdx] : null;
    if (regIdx !== -1) usedRegIndices.add(regIdx);

    const archiveMatch = findArchiveMatch(archiveLookup, {
      packageManager: 'winget',
      packageId: wg.packageId,
      name: reg?.displayName || wg.name || up?.name || cachedMeta?.name || wg.packageId,
    });
    const displayName = pickBestDisplayName({
      candidates: [reg?.displayName, wg.name, up?.name, cachedMeta?.name, archiveMatch?.name],
      packageId: wg.packageId,
      packageManager: 'winget',
    });
    const installedVersion = reg?.displayVersion || wg.version || up?.installedVersion || '';
    const availableVersion = up?.availableVersion || wg.availableVersion || '';

    programs.push({
      id: `winget:${wg.packageId.toLowerCase()}`,
      name: displayName,
      publisher: reg?.publisher || cachedMeta?.publisher || cachedMeta?.author || '',
      installedVersion,
      installedVersionIsLowerBound: Boolean(up?.installedVersionIsLowerBound || wg.installedVersionIsLowerBound),
      availableVersion,
      hasUpdate: Boolean(availableVersion),
      packageManager: 'winget',
      packageId: wg.packageId,
      homepage: cachedMeta?.homepage || cachedMeta?.repositoryUrl || '',
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

  for (const [key, provPkg] of genericPkgMap.entries()) {
    const up = genericUpgradeByKey.get(key) || null;
    const cachedMeta = lookupCachedMeta(cachedMetadata, provPkg.packageManager, provPkg.packageId);
    const regIdx = findMatchingRegistryIndex(provPkg, up, cleanRegistry, usedRegIndices, archiveLookup, cachedMeta);
    const reg = regIdx !== -1 ? cleanRegistry[regIdx] : null;
    if (regIdx !== -1) usedRegIndices.add(regIdx);

    const appx =
      provPkg.packageManager === 'msstore'
        ? matchAppxEntryForPackage(
            {
              ...provPkg,
              name: pickBestDisplayName({
                candidates: [provPkg.name, up?.name, cachedMeta?.name, reg?.displayName],
                packageId: provPkg.packageId,
                packageManager: 'msstore',
              }),
              publisher: reg?.publisher || cachedMeta?.publisher || '',
            },
            appxEntries
          )
        : null;

    const candidateNames =
      provPkg.packageManager === 'msstore'
        ? [appx?.displayName, cachedMeta?.name, provPkg.name, up?.name, reg?.displayName]
        : [reg?.displayName, cachedMeta?.name, up?.name, provPkg.name];

    const prelimName = pickBestDisplayName({
      candidates: candidateNames,
      packageId: provPkg.packageId,
      packageManager: provPkg.packageManager,
    });
    const archiveMatch = findArchiveMatch(archiveLookup, {
      packageManager: provPkg.packageManager,
      packageId: provPkg.packageId,
      name: prelimName,
    });
    const displayName = pickBestDisplayName({
      candidates: [...candidateNames, archiveMatch?.name],
      packageId: provPkg.packageId,
      packageManager: provPkg.packageManager,
    });

    let installedVersion = provPkg.version || reg?.displayVersion || up?.installedVersion || '';
    if (isUnknownVersionString(installedVersion) && appx?.version) {
      installedVersion = appx.version;
    }
    const availableVersion = up?.availableVersion || '';

    programs.push({
      id: `${provPkg.packageManager}:${provPkg.packageId.toLowerCase()}`,
      name: displayName,
      publisher: reg?.publisher || appx?.publisherDisplayName || cachedMeta?.publisher || cachedMeta?.author || '',
      installedVersion,
      installedVersionIsLowerBound: Boolean(up?.installedVersionIsLowerBound || provPkg.installedVersionIsLowerBound),
      availableVersion,
      hasUpdate: Boolean(availableVersion),
      packageManager: provPkg.packageManager,
      packageId: provPkg.packageId,
      bucket: provPkg.bucket || '',
      isActive: Boolean(provPkg.isActive),
      arch: provPkg.arch || '',
      homepage: cachedMeta?.homepage || cachedMeta?.repositoryUrl || '',
      appxPackageFamilyName: appx?.packageFamilyName || '',
      source: provPkg.source || up?.source || provPkg.packageManager,
      uninstallString: reg?.uninstallString || '',
      quietUninstallString: reg?.quietUninstallString || '',
      displayIcon: reg?.displayIcon || '',
      installLocation: reg?.installLocation || appx?.installLocation || '',
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
    const msiCode = msiEnabled && reg.windowsInstaller === 1 ? extractMsiProductCodeFromEntry(reg) : '';

    if (msiCode) {
      const archiveMatch = findArchiveMatch(archiveLookup, {
        packageManager: 'msi',
        packageId: msiCode,
        name: reg.displayName,
      });

      programs.push({
        id: `msi:${msiCode.toLowerCase()}`,
        name: reg.displayName,
        publisher: reg.publisher || '',
        installedVersion: reg.displayVersion || '',
        availableVersion: '',
        hasUpdate: false,
        packageManager: 'msi',
        packageId: msiCode,
        source: 'msi',
        uninstallString: reg.uninstallString || `msiexec.exe /X${msiCode}`,
        quietUninstallString: reg.quietUninstallString || `msiexec.exe /X${msiCode} /qn /norestart`,
        displayIcon: reg.displayIcon || '',
        installLocation: reg.installLocation || '',
        registryKey: reg.registryKey || msiCode,
        windowsInstaller: 1,
        canUninstall: true,
        inArchive: Boolean(archiveMatch),
        archiveItemId: archiveMatch?.id || null,
        archivePath: archiveMatch?.path || null,
        archiveIcon: archiveMatch?.icon || null,
      });
      continue;
    }

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
