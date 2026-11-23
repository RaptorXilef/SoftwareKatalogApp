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

function stripVersionSuffix(name) {
  return String(name || '')
    .replace(/\s+\(?(?:x64|x86|64-bit|32-bit|current user|user)\)?/gi, '')
    .replace(/\s+v?\d+(?:\.\d+)+.*$/i, '')
    .trim();
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

function findMatchingRegistryIndex(wingetItem, upgradeInfo, registryEntries, usedRegIndices) {
  const pkgId = wingetItem.packageId;
  const pkgIdLower = pkgId.toLowerCase();
  const idParts = pkgId
    .split('.')
    .map((p) => normalizeCompact(p))
    .filter((p) => p.length >= 2);
  const idTail = idParts[idParts.length - 1] || '';
  const idPublisher = idParts[0] || '';
  const upgradeNameNorm = upgradeInfo?.name ? normalizeText(stripVersionSuffix(upgradeInfo.name)) : '';
  const wingetVer = (wingetItem.version || upgradeInfo?.installedVersion || '').toLowerCase();

  let bestIdx = -1;
  let bestScore = 0;

  for (let i = 0; i < registryEntries.length; i++) {
    if (usedRegIndices.has(i)) continue;
    const reg = registryEntries[i];
    let score = 0;

    if (reg.registryKey && reg.registryKey.toLowerCase() === pkgIdLower) {
      score += 100;
    }

    const regNameFull = normalizeText(reg.displayName);
    const regNameBase = normalizeText(stripVersionSuffix(reg.displayName));
    const regCompact = normalizeCompact(stripVersionSuffix(reg.displayName));
    const regPubCompact = normalizeCompact(reg.publisher);

    if (upgradeNameNorm && (regNameFull === upgradeNameNorm || regNameBase === upgradeNameNorm)) {
      score += 80;
    } else if (upgradeNameNorm && (regNameFull.includes(upgradeNameNorm) || upgradeNameNorm.includes(regNameBase))) {
      score += 45;
    }

    if (idTail && regCompact === idTail) {
      score += 65;
    } else if (idTail && idTail.length >= 3 && regCompact.includes(idTail)) {
      score += 35;
    }

    if (idPublisher && regPubCompact && (regPubCompact.includes(idPublisher) || idPublisher.includes(regPubCompact))) {
      score += 20;
    }

    if (wingetVer && reg.displayVersion) {
      const regVer = reg.displayVersion.toLowerCase();
      if (regVer === wingetVer) score += 25;
      else if (regVer.startsWith(wingetVer) || wingetVer.startsWith(regVer)) score += 15;
    }

    if (score >= 50 && score > bestScore) {
      bestScore = score;
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
    const regIdx = findMatchingRegistryIndex(wg, up, cleanRegistry, usedRegIndices);
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
