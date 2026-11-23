import { compareVersions, extractVersion } from './version.js';

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

export function getBaseName(filePath) {
  if (!filePath) return '';
  return String(filePath).split('\\').pop().split('/').pop();
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim();
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

function collectArchivePaths(item) {
  return collectPaths([item.validInstallPath, ...(item.autoPaths || []), ...(item.installPaths || [])]);
}

function collectPcAppPaths(pcApp) {
  return collectPaths([pcApp.displayIcon, pcApp.installLocation, extractExeFromCommand(pcApp.uninstallString)]);
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

function getArchivePackageKey(item) {
  const pm = String(item.packageManager || (item.wingetId ? 'winget' : ''))
    .trim()
    .toLowerCase();
  const pid = String(item.packageId || item.wingetId || '')
    .trim()
    .toLowerCase();
  return pm && pid ? `${pm}:${pid}` : '';
}

function getPcPackageKey(pcApp) {
  const pm = String(pcApp.packageManager || '')
    .trim()
    .toLowerCase();
  const pid = String(pcApp.packageId || '')
    .trim()
    .toLowerCase();
  return pm && pid ? `${pm}:${pid}` : '';
}

function getArchiveNameSet(item) {
  const names = new Set();
  for (const candidate of [item.name, ...(item.searchNames || [])]) {
    const full = normalizeText(candidate);
    const base = normalizeText(stripVersionSuffix(candidate));
    if (full) names.add(full);
    if (base) names.add(base);
  }
  return names;
}

function pickHigherWebVersion(archiveWebVer, pcAvailableVer) {
  const aVer = archiveWebVer ? String(archiveWebVer).trim() : '';
  const pVer = pcAvailableVer ? extractVersion(String(pcAvailableVer)) || String(pcAvailableVer).trim() : '';
  if (aVer && !pVer) return aVer;
  if (!aVer && pVer) return pVer;
  if (!aVer && !pVer) return null;

  const cmp = compareVersions(pVer, aVer, 0);
  return cmp > 0 ? pVer : aVer;
}

function findMatchingPcApp(item, itemPaths, installedApps, usedIndices, pcByKey) {
  // 1. Explizite archiveItemId
  for (let i = 0; i < installedApps.length; i++) {
    if (usedIndices.has(i)) continue;
    if (installedApps[i].archiveItemId === item.id) return i;
  }

  // 2. packageId / wingetId
  const itemKey = getArchivePackageKey(item);
  if (itemKey && pcByKey.has(itemKey)) {
    const idx = pcByKey.get(itemKey);
    if (!usedIndices.has(idx)) return idx;
  }

  // 3. Installationspfad
  if (itemPaths.files.size > 0 || itemPaths.dirs.size > 0) {
    for (let i = 0; i < installedApps.length; i++) {
      if (usedIndices.has(i)) continue;
      const pcPaths = collectPcAppPaths(installedApps[i]);
      if (pathsMatch(itemPaths, pcPaths)) return i;
    }
  }

  // 4. Normalisierter Name / searchNames
  const archiveNames = getArchiveNameSet(item);
  if (archiveNames.size > 0) {
    for (let i = 0; i < installedApps.length; i++) {
      if (usedIndices.has(i)) continue;
      const pcApp = installedApps[i];
      const pcBase = normalizeText(stripVersionSuffix(pcApp.name));
      const pcFull = normalizeText(pcApp.name);
      if ((pcBase && archiveNames.has(pcBase)) || (pcFull && archiveNames.has(pcFull))) {
        return i;
      }
    }
  }

  return -1;
}

function resolvePcIcon(pcApp, pcIconCache) {
  if (pcIconCache instanceof Map && pcIconCache.has(pcApp.id)) {
    return pcIconCache.get(pcApp.id) || null;
  }
  if (pcIconCache && typeof pcIconCache === 'object' && !(pcIconCache instanceof Map)) {
    if (pcIconCache[pcApp.id]) return pcIconCache[pcApp.id];
  }
  return pcApp.cachedIconPath || null;
}

/**
 * Führt Archiv-Einträge (`catalogItems`) und erkannte PC-Programme (`installedApps`)
 * zu einer einheitlichen Paketliste mit `origin` ('both' | 'archive' | 'pc') zusammen.
 */
export function buildUnifiedPackages({ catalogItems = [], installedApps = [], pcIconCache = null } = {}) {
  const usedPcIndices = new Set();
  const pcByKey = new Map();

  for (let i = 0; i < installedApps.length; i++) {
    const key = getPcPackageKey(installedApps[i]);
    if (key && !pcByKey.has(key)) {
      pcByKey.set(key, i);
    }
  }

  const unified = [];

  for (const item of catalogItems || []) {
    const itemPaths = collectArchivePaths(item);
    const matchIdx = findMatchingPcApp(item, itemPaths, installedApps, usedPcIndices, pcByKey);
    const matchedPc = matchIdx !== -1 ? installedApps[matchIdx] : null;
    if (matchIdx !== -1) usedPcIndices.add(matchIdx);

    const isInstalled = Boolean(matchedPc || item.isInstalled);
    const origin = isInstalled ? 'both' : 'archive';

    const pcVer = matchedPc?.installedVersion
      ? extractVersion(matchedPc.installedVersion) || matchedPc.installedVersion
      : null;
    const installedVersion = pcVer || item.installedVersion || null;
    const webVersion = pickHigherWebVersion(item.webVersion, matchedPc?.availableVersion);

    const packageManager = item.packageManager || matchedPc?.packageManager || (item.wingetId ? 'winget' : null);
    const packageId = item.packageId || item.wingetId || matchedPc?.packageId || null;
    const wingetId = item.wingetId || (packageManager === 'winget' ? packageId : '') || '';

    unified.push({
      ...item,
      origin,
      inArchive: true,
      archiveItemId: item.id,
      isInstalled,
      installedVersion,
      webVersion,
      packageManager,
      packageId,
      wingetId,
      publisher: matchedPc?.publisher || '',
      pcApp: matchedPc || null,
      canUninstall: Boolean(matchedPc?.canUninstall),
      uninstallString: matchedPc?.uninstallString || '',
      quietUninstallString: matchedPc?.quietUninstallString || '',
      installLocation: matchedPc?.installLocation || '',
      displayIcon: matchedPc?.displayIcon || '',
      pcSource: matchedPc?.source || null,
      hasWingetUpgrade: Boolean(matchedPc?.hasUpdate),
    });
  }

  for (let i = 0; i < installedApps.length; i++) {
    if (usedPcIndices.has(i)) continue;
    const pcApp = installedApps[i];
    const pkgManager = pcApp.packageManager || null;
    const pkgId = pcApp.packageId || null;
    const installedVersion = pcApp.installedVersion
      ? extractVersion(pcApp.installedVersion) || pcApp.installedVersion
      : null;
    const webVersion = pcApp.availableVersion ? extractVersion(pcApp.availableVersion) || pcApp.availableVersion : null;

    unified.push({
      id: pcApp.id,
      name: pcApp.name,
      publisher: pcApp.publisher || '',
      origin: 'pc',
      inArchive: false,
      archiveItemId: null,
      isInstalled: true,
      installedVersion,
      webVersion,
      packageManager: pkgManager,
      packageId: pkgId,
      wingetId: pkgManager === 'winget' ? pkgId || '' : '',
      webSourceType: pkgManager === 'winget' ? 'winget' : 'none',
      tags: pcApp.publisher ? [pcApp.publisher] : [],
      mainCategory: '',
      subCategories: [],
      hiddenCategory: '',
      formats: [],
      os: [],
      description: '',
      searchNames: [],
      links: [],
      lastFiles: [],
      screenshots: [],
      autoPaths: [],
      installPaths: [],
      validInstallPath: null,
      icon: resolvePcIcon(pcApp, pcIconCache),
      pcApp,
      canUninstall: Boolean(pcApp.canUninstall),
      uninstallString: pcApp.uninstallString || '',
      quietUninstallString: pcApp.quietUninstallString || '',
      installLocation: pcApp.installLocation || '',
      displayIcon: pcApp.displayIcon || '',
      registryKey: pcApp.registryKey || '',
      pcSource: pcApp.source || 'registry',
      hasWingetUpgrade: Boolean(pcApp.hasUpdate),
    });
  }

  return unified;
}

/**
 * Erstellt ein vereinheitlichtes Paket-Objekt für Remote-Suchergebnisse (`origin: 'remote'`),
 * verknüpft es optional mit bereits vorhandenen Archiv- oder PC-Einträgen.
 */
export function buildRemotePackageItem({
  providerId = 'winget',
  packageId = '',
  summary = {},
  providerName = '',
  existingPackages = [],
} = {}) {
  const cleanProviderId = String(providerId || 'winget')
    .trim()
    .toLowerCase();
  const cleanPkgId = String(packageId || summary.packageId || summary.id || '').trim();
  const cleanPidLower = cleanPkgId.toLowerCase();

  let matchedArchiveItem = null;
  let matchedPcItem = null;

  if (cleanPidLower && Array.isArray(existingPackages)) {
    for (const entry of existingPackages) {
      const entryPid = String(entry.packageId || entry.wingetId || '')
        .trim()
        .toLowerCase();
      const entryPm = String(entry.packageManager || (entry.wingetId ? 'winget' : ''))
        .trim()
        .toLowerCase();

      if (!entryPid || entryPid !== cleanPidLower) continue;
      if (entryPm && entryPm !== cleanProviderId) continue;

      if (entry.inArchive && !matchedArchiveItem) {
        matchedArchiveItem = entry;
      }
      if (entry.isInstalled && !matchedPcItem) {
        matchedPcItem = entry;
      }
    }
  }

  const pcOrArchiveInstalled = Boolean(
    matchedPcItem?.isInstalled || matchedArchiveItem?.isInstalled || summary.isInstalled
  );
  const installedVersion =
    matchedPcItem?.installedVersion || matchedArchiveItem?.installedVersion || summary.installedVersion || null;
  const rawWebVersion = summary.version || matchedPcItem?.webVersion || matchedArchiveItem?.webVersion || null;
  const webVersion = rawWebVersion ? extractVersion(String(rawWebVersion)) || String(rawWebVersion).trim() : null;

  return {
    id: `remote:${cleanProviderId}:${cleanPkgId}`,
    name: summary.name || matchedArchiveItem?.name || matchedPcItem?.name || cleanPkgId,
    origin: 'remote',
    inArchive: false,
    archiveItemId: matchedArchiveItem?.id || null,
    matchedArchiveItem: matchedArchiveItem || null,
    isInstalled: pcOrArchiveInstalled,
    installedVersion,
    webVersion,
    packageManager: cleanProviderId,
    packageId: cleanPkgId,
    wingetId: cleanProviderId === 'winget' ? cleanPkgId : '',
    webSourceType: cleanProviderId === 'winget' ? 'winget' : 'none',
    providerName: providerName || (cleanProviderId === 'winget' ? 'Winget' : cleanProviderId),
    publisher: summary.publisher || matchedPcItem?.publisher || '',
    shortDescription: summary.shortDescription || '',
    description: summary.description || '',
    tags: Array.isArray(summary.tags) ? summary.tags : [],
    mainCategory: '',
    subCategories: [],
    hiddenCategory: '',
    formats: [],
    os: [],
    searchNames: [],
    links: [],
    lastFiles: matchedArchiveItem?.lastFiles || [],
    screenshots: [],
    autoPaths: [],
    installPaths: [],
    validInstallPath: matchedPcItem?.validInstallPath || matchedArchiveItem?.validInstallPath || null,
    icon: matchedArchiveItem?.icon || matchedPcItem?.icon || null,
    canUninstall: Boolean(matchedPcItem?.canUninstall || matchedArchiveItem?.canUninstall),
    uninstallString: matchedPcItem?.uninstallString || matchedArchiveItem?.uninstallString || '',
    quietUninstallString: matchedPcItem?.quietUninstallString || matchedArchiveItem?.quietUninstallString || '',
    installLocation: matchedPcItem?.installLocation || matchedArchiveItem?.installLocation || '',
    displayIcon: matchedPcItem?.displayIcon || matchedArchiveItem?.displayIcon || '',
    registryKey: matchedPcItem?.registryKey || '',
    pcSource: matchedPcItem?.pcSource || null,
    hasWingetUpgrade: Boolean(matchedPcItem?.hasWingetUpgrade),
  };
}

/**
 * Ermittelt Status & Versionen für Karte und Detailansicht.
 * Priorität für Kartenfarbe: webupdate (Lila) > update (Orange) > newer (Blau) > installed (Grün) > none
 */
export function getPackageStatus(item, { versionCompareDepth = 3 } = {}) {
  const archiveVersion = item.lastFiles?.length > 0 ? extractVersion(getBaseName(item.lastFiles[0])) : null;
  const localVersion = item.installedVersion || null;
  const webVersion = item.webVersion || null;
  const depth = versionCompareDepth;

  const hasArchiveUpdate = Boolean(
    item.isInstalled && archiveVersion && localVersion && compareVersions(archiveVersion, localVersion, depth) > 0
  );
  const isPcNewer = Boolean(
    item.isInstalled && archiveVersion && localVersion && compareVersions(archiveVersion, localVersion, depth) < 0
  );

  let hasWebUpdate = false;
  if (item.origin === 'remote') {
    hasWebUpdate = Boolean(
      item.isInstalled && webVersion && localVersion && compareVersions(webVersion, localVersion, depth) > 0
    );
  } else if (item.origin === 'pc') {
    hasWebUpdate = Boolean(
      webVersion &&
        ((localVersion && compareVersions(webVersion, localVersion, depth) > 0) ||
          (item.hasWingetUpgrade && webVersion !== localVersion))
    );
  } else {
    hasWebUpdate = Boolean(webVersion && (!archiveVersion || compareVersions(webVersion, archiveVersion, depth) > 0));
  }

  let status = 'none';
  if (hasWebUpdate) {
    status = 'webupdate';
  } else if (hasArchiveUpdate) {
    status = 'update';
  } else if (isPcNewer) {
    status = 'newer';
  } else if (item.isInstalled) {
    status = 'installed';
  }

  return {
    status,
    archiveVersion,
    nasVersion: archiveVersion,
    localVersion,
    webVersion,
    hasWebUpdate,
    hasArchiveUpdate,
    hasNasUpdate: hasArchiveUpdate,
    hasAnyUpdate: hasWebUpdate || hasArchiveUpdate,
    isPcNewer,
  };
}

export function isPackageVisible(item, visibleHiddenCats = []) {
  const isHidden = Boolean(item.hiddenCategory?.trim());
  if (!isHidden) return true;
  return visibleHiddenCats.includes(item.hiddenCategory);
}

/**
 * Prüft, ob für ein Paket eine direkt auflösbare Online-Downloadquelle konfiguriert ist.
 */
export function canDownloadOnline(item) {
  if (!item) return false;
  const pm = String(item.packageManager || (item.wingetId ? 'winget' : ''))
    .trim()
    .toLowerCase();
  const pid = String(item.packageId || item.wingetId || '').trim();

  if ((item.webSourceType === 'winget' || (item.inArchive && pm === 'winget')) && pid) {
    return true;
  }
  if (item.webSourceType === 'github' && item.webVersionUrl) {
    return true;
  }
  return Boolean(item.downloadUrl);
}

export function computeTabCounts(packages, { visibleHiddenCats = [], versionCompareDepth = 3, bundlesCount = 0 } = {}) {
  let updates = 0;
  let installed = 0;
  let archive = 0;

  for (const item of packages || []) {
    if (!isPackageVisible(item, visibleHiddenCats)) continue;

    const st = getPackageStatus(item, { versionCompareDepth });
    if (st.hasWebUpdate || st.hasArchiveUpdate) updates++;
    if (item.isInstalled) installed++;
    if (item.inArchive) archive++;
  }

  return {
    updates,
    installed,
    archive,
    bundles: bundlesCount,
  };
}
