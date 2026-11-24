import { detectAdwareSignals, normalizeInstallMode, sanitizeSilentArgs } from './installer-logic.js';
import { scoreCatalogItem } from './search.js';
import { canDownloadOnline, getBaseName, getPackageStatus, isPackageVisible } from './unified-packages.js';
import { compareVersions, extractVersion } from './version.js';

export const BUNDLE_SOURCES = Object.freeze(['archive', 'winget']);
export const DEFAULT_BUNDLE_ICON = '📦';
export const BUNDLE_ICON_PRESETS = Object.freeze(['📦', '💻', '🛠️', '🎮', '🎬', '🚀', '🏢', '🧰', '🎨', '🔒']);

export function getBundleItemKey(item) {
  if (!item) return '';
  const source = item.source === 'winget' ? 'winget' : 'archive';
  const refId = String(item.refId || '').trim();
  const packageId = String(item.packageId || '').trim();

  if (source === 'archive' && refId) {
    return `archive:${refId}`;
  }
  if (source === 'winget' && packageId) {
    return `winget:${packageId.toLowerCase()}`;
  }
  const fallback = String(refId || packageId || item.name || '')
    .trim()
    .toLowerCase();
  return fallback ? `${source}:${fallback}` : '';
}

export function matchesSelectedItemId(item, selectedIds) {
  if (!item || !selectedIds) return false;
  const rawSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (rawSet.size === 0) return false;

  const lowerSet = new Set(
    [...rawSet]
      .map((v) =>
        String(v || '')
          .trim()
          .toLowerCase()
      )
      .filter(Boolean)
  );
  const key = getBundleItemKey(item);
  if (key && (rawSet.has(key) || lowerSet.has(key.toLowerCase()))) return true;

  const refId = String(item.refId || '').trim();
  if (refId && (rawSet.has(refId) || lowerSet.has(refId.toLowerCase()))) return true;

  const pkgId = String(item.packageId || '').trim();
  if (pkgId && (rawSet.has(pkgId) || lowerSet.has(pkgId.toLowerCase()))) return true;

  return false;
}

export function normalizeBundleItem(raw, fallbackOrder = 1) {
  if (!raw || typeof raw !== 'object') return null;

  const rawSource = String(raw.source || '')
    .trim()
    .toLowerCase();
  const refId = String(raw.refId || '').trim();
  const packageId = String(raw.packageId || '').trim();

  let source;
  if (rawSource === 'archive' || rawSource === 'winget') {
    source = rawSource;
  } else if (refId) {
    source = 'archive';
  } else if (packageId) {
    source = 'winget';
  } else {
    return null;
  }

  if (source === 'archive' && !refId) return null;
  if (source === 'winget' && !packageId) return null;

  const parsedOrder = Number(raw.order);
  const order = Number.isFinite(parsedOrder) && parsedOrder > 0 ? Math.round(parsedOrder) : fallbackOrder;
  const name = String(raw.name || packageId || refId).trim();

  return {
    order,
    source,
    refId: source === 'archive' ? refId : '',
    packageId,
    name,
    optional: Boolean(raw.optional),
  };
}

export function sortBundleItems(items = []) {
  if (!Array.isArray(items)) return [];

  const decorated = [];
  for (let idx = 0; idx < items.length; idx++) {
    const raw = items[idx];
    const parsedOrder = raw && typeof raw === 'object' ? Number(raw.order) : Number.NaN;
    const hasFiniteOrder = Number.isFinite(parsedOrder) && parsedOrder > 0;
    const normalized = normalizeBundleItem(raw, idx + 1);
    if (!normalized) continue;
    decorated.push({
      item: normalized,
      hasFiniteOrder,
      sortOrder: hasFiniteOrder ? parsedOrder : Number.POSITIVE_INFINITY,
      idx,
    });
  }

  decorated.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return a.idx - b.idx;
  });

  const seenKeys = new Set();
  const result = [];
  for (const entry of decorated) {
    const key = getBundleItemKey(entry.item);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    result.push({
      ...entry.item,
      order: result.length + 1,
    });
  }

  return result;
}

export function moveBundleItem(items = [], fromIndex, toIndex) {
  const list = sortBundleItems(items);
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= list.length ||
    toIndex >= list.length ||
    fromIndex === toIndex
  ) {
    return list;
  }

  const next = [...list];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);

  return next.map((item, idx) => ({
    ...item,
    order: idx + 1,
  }));
}

export function normalizeBundle(raw, { now = Date.now(), fallbackId = '' } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = String(src.id || fallbackId || '').trim();
  const name = String(src.name || '').trim() || 'Unbenanntes Bündel';
  const description = String(src.description || '').trim();
  const icon = String(src.icon || '').trim() || DEFAULT_BUNDLE_ICON;

  const createdRaw = Number(src.createdAt);
  const updatedRaw = Number(src.updatedAt);
  const createdAt = Number.isFinite(createdRaw) && createdRaw > 0 ? createdRaw : now;
  const updatedAt = Number.isFinite(updatedRaw) && updatedRaw > 0 ? updatedRaw : createdAt;

  return {
    id,
    name,
    description,
    icon,
    createdAt,
    updatedAt,
    items: sortBundleItems(src.items || []),
  };
}

export function buildExportBundlePayload(bundle) {
  return {
    format: 'software-katalog-bundle',
    version: 1,
    exportedAt: new Date().toISOString(),
    bundle: normalizeBundle(bundle),
  };
}

/**
 * Erstellt das Export-JSON-Objekt für alle Bündel.
 */
export function buildExportAllBundlesPayload(bundles = []) {
  return {
    format: 'software-katalog-bundles',
    version: 1,
    exportedAt: new Date().toISOString(),
    bundles: (Array.isArray(bundles) ? bundles : []).map((b) => normalizeBundle(b)),
  };
}

export function validateImportBundlePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'Ungültiges JSON-Format: Bündel-Objekt erwartet.' };
  }

  if (raw.format !== undefined && raw.format !== 'software-katalog-bundle') {
    return { valid: false, error: 'Unbekanntes Bündel-Exportformat.' };
  }

  const candidate = raw.bundle && typeof raw.bundle === 'object' && !Array.isArray(raw.bundle) ? raw.bundle : raw;
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
  if (!name) {
    return { valid: false, error: 'Bündel-Name fehlt oder ist leer.' };
  }

  if (!Array.isArray(candidate.items)) {
    return { valid: false, error: 'Bündel enthält keine gültige Paketliste (items).' };
  }

  const normalizedItems = sortBundleItems(candidate.items);
  if (candidate.items.length > 0 && normalizedItems.length === 0) {
    return { valid: false, error: 'Keine gültigen Pakete im importierten Bündel gefunden.' };
  }

  return {
    valid: true,
    bundle: normalizeBundle({
      ...candidate,
      name,
      items: normalizedItems,
    }),
  };
}

/**
 * Validiert sowohl Einzel- als auch Mehrfach-Bündel-Exporte beim JSON-Import.
 */
export function validateImportBundlesPayload(raw) {
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return { valid: false, error: 'Die JSON-Datei enthält keine Bündel.' };
    }
    const bundles = [];
    for (let i = 0; i < raw.length; i++) {
      const check = validateImportBundlePayload(raw[i]);
      if (!check.valid) {
        return { valid: false, error: `Bündel #${i + 1}: ${check.error}` };
      }
      bundles.push(check.bundle);
    }
    return { valid: true, bundles };
  }

  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Ungültiges JSON-Format: Bündel-Objekt erwartet.' };
  }

  if (
    raw.format !== undefined &&
    raw.format !== 'software-katalog-bundle' &&
    raw.format !== 'software-katalog-bundles'
  ) {
    return { valid: false, error: 'Unbekanntes Bündel-Exportformat.' };
  }

  if (raw.format === 'software-katalog-bundles' || Array.isArray(raw.bundles)) {
    if (!Array.isArray(raw.bundles) || raw.bundles.length === 0) {
      return { valid: false, error: 'Die JSON-Datei enthält keine gültige Bündel-Liste.' };
    }
    const bundles = [];
    for (let i = 0; i < raw.bundles.length; i++) {
      const check = validateImportBundlePayload(raw.bundles[i]);
      if (!check.valid) {
        return { valid: false, error: `Bündel #${i + 1}: ${check.error}` };
      }
      bundles.push(check.bundle);
    }
    return { valid: true, bundles };
  }

  const single = validateImportBundlePayload(raw);
  if (!single.valid) {
    return { valid: false, error: single.error };
  }
  return { valid: true, bundles: [single.bundle] };
}

/**
 * Vergibt beim Import eine kollisionsfreie Bündel-ID.
 */
export function resolveImportedBundleId(importedId, existingIds, generateId) {
  const used = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  const cleanId = String(importedId || '').trim();
  if (cleanId && !used.has(cleanId)) {
    return cleanId;
  }

  let candidate = String(generateId() || '').trim();
  while (!candidate || used.has(candidate)) {
    candidate = String(generateId() || '').trim();
  }
  return candidate;
}

/**
 * Liefert alle sichtbaren Archiv-Programme für den Bündel-Editor (ohne 20er-Limit).
 */
export function getBundleEditorArchiveCandidates(catalog = [], { query = '', visibleHiddenCats = [] } = {}) {
  const q = String(query || '').trim();
  const scored = [];

  for (const item of catalog || []) {
    if (!item || !isPackageVisible(item, visibleHiddenCats)) continue;
    const res = scoreCatalogItem(item, q);
    if (res.matched) {
      scored.push({ score: res.score, item });
    }
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      String(a.item.name || '').localeCompare(String(b.item.name || ''), 'de', { sensitivity: 'base' })
  );

  return scored.map(({ item }) => {
    const linkedPkgId = String(item.packageId || item.wingetId || '').trim();
    const archiveVer = item.lastFiles?.[0] ? extractVersion(getBaseName(item.lastFiles[0])) : '';
    return {
      providerId: 'archive',
      packageId: item.id,
      linkedPackageId: linkedPkgId,
      name: item.name,
      version: archiveVer || item.webVersion || '',
      isInstalled: Boolean(item.isInstalled),
      inArchive: true,
      shortDescription: item.mainCategory || '',
      editorItem: {
        source: 'archive',
        refId: item.id,
        packageId: linkedPkgId,
        name: item.name,
        optional: false,
      },
    };
  });
}

/**
 * Liefert bekannte & installierte Pakete eines Paketmanagers (z. B. Winget) zur Sofortauswahl.
 */
export function getKnownProviderPackages(packages = [], { providerId = 'winget', query = '' } = {}) {
  const targetPm = String(providerId || 'winget')
    .trim()
    .toLowerCase();
  const byPkgId = new Map();

  for (const pkg of packages || []) {
    if (!pkg) continue;
    const pkgPm = String(pkg.packageManager || (pkg.wingetId ? 'winget' : ''))
      .trim()
      .toLowerCase();
    const pkgId = String(pkg.packageId || (targetPm === 'winget' ? pkg.wingetId : '') || '').trim();
    if (!pkgId || pkgPm !== targetPm) continue;

    const key = pkgId.toLowerCase();
    const existing = byPkgId.get(key);
    if (!existing) {
      byPkgId.set(key, {
        packageId: pkgId,
        name: String(pkg.name || pkgId).trim(),
        version: pkg.installedVersion || pkg.webVersion || '',
        isInstalled: Boolean(pkg.isInstalled),
        inArchive: Boolean(pkg.inArchive),
        publisher: String(pkg.publisher || '').trim(),
      });
    } else {
      const preferNew = Boolean(pkg.isInstalled) && !existing.isInstalled;
      byPkgId.set(key, {
        packageId: preferNew ? pkgId : existing.packageId,
        name: preferNew ? String(pkg.name || pkgId).trim() : existing.name,
        version: pkg.installedVersion || existing.version || pkg.webVersion || '',
        isInstalled: existing.isInstalled || Boolean(pkg.isInstalled),
        inArchive: existing.inArchive || Boolean(pkg.inArchive),
        publisher: existing.publisher || String(pkg.publisher || '').trim(),
      });
    }
  }

  const queryWords = String(query || '')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const filtered = [...byPkgId.values()].filter((entry) => {
    if (queryWords.length === 0) return true;
    const hay = `${entry.name} ${entry.packageId} ${entry.publisher}`.toLowerCase();
    return queryWords.every((w) => hay.includes(w));
  });

  filtered.sort((a, b) => {
    if (a.isInstalled !== b.isInstalled) return Number(b.isInstalled) - Number(a.isInstalled);
    return a.name.localeCompare(b.name, 'de', { sensitivity: 'base' });
  });

  return filtered.map((entry) => ({
    providerId: targetPm,
    packageId: entry.packageId,
    linkedPackageId: '',
    name: entry.name,
    version: entry.version,
    isInstalled: entry.isInstalled,
    inArchive: entry.inArchive,
    shortDescription: entry.publisher || (entry.isInstalled ? 'Auf diesem PC installiert' : 'Aus Archiv bekannt'),
    editorItem: {
      source: targetPm,
      refId: '',
      packageId: entry.packageId,
      name: entry.name,
      optional: false,
    },
  }));
}

/**
 * Kombiniert Remote-Suchergebnisse mit bekannten lokalen Provider-Paketen ohne Duplikate.
 */
export function mergeProviderEditorResults({ knownPackages = [], remoteResults = [], providerId = 'winget' } = {}) {
  const targetPm = String(providerId || 'winget')
    .trim()
    .toLowerCase();
  const knownByKey = new Map();
  for (const kp of knownPackages || []) {
    const key = String(kp?.packageId || '')
      .trim()
      .toLowerCase();
    if (key) knownByKey.set(key, kp);
  }

  const merged = [];
  const seenKeys = new Set();

  for (const pkg of remoteResults || []) {
    const pkgId = String(pkg?.packageId || pkg?.id || '').trim();
    if (!pkgId) continue;
    const key = pkgId.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    const known = knownByKey.get(key);
    const name = String(pkg?.name || known?.name || pkgId).trim();
    merged.push({
      providerId: targetPm,
      packageId: pkgId,
      linkedPackageId: '',
      name,
      version: pkg?.version || known?.version || '',
      isInstalled: Boolean(known?.isInstalled),
      inArchive: Boolean(known?.inArchive),
      shortDescription: pkg?.shortDescription || known?.shortDescription || '',
      editorItem: {
        source: targetPm,
        refId: '',
        packageId: pkgId,
        name,
        optional: false,
      },
    });
  }

  for (const kp of knownPackages || []) {
    const key = String(kp?.packageId || '')
      .trim()
      .toLowerCase();
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    merged.push(kp);
  }

  return merged;
}

export function findMatchingPackageForBundleItem(item, packages = []) {
  if (!item || !Array.isArray(packages) || packages.length === 0) return null;

  const refId = String(item.refId || '').trim();
  const pkgIdLower = String(item.packageId || '')
    .trim()
    .toLowerCase();

  if (item.source === 'archive') {
    if (refId) {
      const direct = packages.find((p) => p.inArchive && (p.id === refId || p.archiveItemId === refId));
      if (direct) return direct;
    }
    if (pkgIdLower) {
      const archiveFallback = packages.find((p) => {
        if (!p.inArchive) return false;
        const pId = String(p.packageId || p.wingetId || '')
          .trim()
          .toLowerCase();
        return pId && pId === pkgIdLower;
      });
      if (archiveFallback) return archiveFallback;
    }
    return null;
  }

  if (!pkgIdLower) return null;

  const matches = packages.filter((p) => {
    const pId = String(p.packageId || p.wingetId || '')
      .trim()
      .toLowerCase();
    if (!pId || pId !== pkgIdLower) return false;
    const pPm = String(p.packageManager || (p.wingetId ? 'winget' : ''))
      .trim()
      .toLowerCase();
    return !pPm || pPm === 'winget';
  });

  if (matches.length === 0) return null;
  return matches.find((p) => p.inArchive && p.isInstalled) || matches.find((p) => p.isInstalled) || matches[0];
}

export function evaluateBundleItemStatus(item, packages = [], { versionCompareDepth = 3 } = {}) {
  const normalizedItem = normalizeBundleItem(item) || {
    order: Number(item?.order) || 1,
    source: item?.source === 'winget' ? 'winget' : 'archive',
    refId: String(item?.refId || '').trim(),
    packageId: String(item?.packageId || '').trim(),
    name: String(item?.name || '').trim(),
    optional: Boolean(item?.optional),
  };

  const key = getBundleItemKey(normalizedItem);
  const matchedPackage = findMatchingPackageForBundleItem(normalizedItem, packages);
  const pkgStatus = matchedPackage ? getPackageStatus(matchedPackage, { versionCompareDepth }) : null;

  const isInstalled = Boolean(matchedPackage?.isInstalled);
  const inArchive = Boolean(matchedPackage?.inArchive);
  const archiveMissing = normalizedItem.source === 'archive' && !inArchive;

  let isOutdated = false;
  if (isInstalled && pkgStatus) {
    if (normalizedItem.source === 'archive') {
      const webNewerThanPc = Boolean(
        pkgStatus.hasWebUpdate &&
          canDownloadOnline(matchedPackage) &&
          pkgStatus.localVersion &&
          pkgStatus.webVersion &&
          compareVersions(pkgStatus.webVersion, pkgStatus.localVersion, versionCompareDepth) > 0
      );
      isOutdated = Boolean(pkgStatus.hasArchiveUpdate || matchedPackage.hasWingetUpgrade || webNewerThanPc);
    } else {
      const webNewerThanPc = Boolean(
        pkgStatus.webVersion &&
          pkgStatus.localVersion &&
          compareVersions(pkgStatus.webVersion, pkgStatus.localVersion, versionCompareDepth) > 0
      );
      isOutdated = Boolean(pkgStatus.hasWebUpdate || matchedPackage.hasWingetUpgrade || webNewerThanPc);
    }
  }

  let status = 'missing';
  let action = 'install';
  let statusLabel = '⬇️ Fehlt - installieren';
  if (isInstalled && isOutdated) {
    status = 'outdated';
    action = 'update';
    statusLabel = '⬆️ Veraltet - aktualisieren';
  } else if (isInstalled) {
    status = 'up-to-date';
    action = 'skip';
    statusLabel = '✅ Bereits aktuell - überspringen';
  }

  const installMode = normalizeInstallMode(matchedPackage?.installMode);
  const silentArgs = sanitizeSilentArgs(matchedPackage?.silentArgs || '');
  const primaryFileName = matchedPackage?.lastFiles?.[0] ? getBaseName(matchedPackage.lastFiles[0]) : '';
  const adwareSignal = detectAdwareSignals({
    name: normalizedItem.name || matchedPackage?.name || '',
    fileName: primaryFileName,
    packageId: normalizedItem.packageId || matchedPackage?.packageId || matchedPackage?.wingetId || '',
    publisher: matchedPackage?.publisher || '',
  });

  const adwareProtected = installMode === 'interactive-required' || adwareSignal.flagged;
  const adwareReason =
    adwareSignal.reason ||
    (installMode === 'interactive-required' ? 'Als Immer Interaktiv (Adware-Schutz) markiert.' : '');

  const canRunArchiveSilent =
    normalizedItem.source === 'archive' && !adwareProtected && installMode === 'silent' && silentArgs.length > 0;
  const canRunWingetSilent =
    normalizedItem.source === 'winget' && !adwareProtected && installMode !== 'interactive-required';

  const installedVersion = pkgStatus?.localVersion || matchedPackage?.installedVersion || null;
  const archiveVersion = pkgStatus?.archiveVersion || null;
  const webVersion = pkgStatus?.webVersion || matchedPackage?.webVersion || null;
  const availableVersion =
    normalizedItem.source === 'archive' ? archiveVersion || webVersion || null : webVersion || archiveVersion || null;

  const defaultSelected = !archiveMissing && (status === 'missing' || status === 'outdated');

  return {
    ...normalizedItem,
    key,
    name: normalizedItem.name || matchedPackage?.name || normalizedItem.packageId || normalizedItem.refId,
    status,
    action,
    statusLabel,
    installedVersion,
    availableVersion,
    archiveVersion,
    webVersion,
    hasWebUpdate: Boolean(pkgStatus?.hasWebUpdate),
    hasArchiveUpdate: Boolean(pkgStatus?.hasArchiveUpdate),
    isInstalled,
    inArchive,
    archiveMissing,
    installMode,
    silentArgs,
    adwareProtected,
    adwareReason,
    canRunArchiveSilent,
    canRunWingetSilent,
    defaultSelected,
    matchedPackage: matchedPackage || null,
  };
}

export function evaluateBundleStatus(bundle, { packages = [], versionCompareDepth = 3 } = {}) {
  const items = sortBundleItems(bundle?.items || []).map((item) =>
    evaluateBundleItemStatus(item, packages, { versionCompareDepth })
  );

  let installedCount = 0;
  let upToDateCount = 0;
  let outdatedCount = 0;
  let missingCount = 0;
  let adwareProtectedCount = 0;
  let silentReadyCount = 0;

  for (const entry of items) {
    if (entry.isInstalled) installedCount++;
    if (entry.status === 'up-to-date') upToDateCount++;
    else if (entry.status === 'outdated') outdatedCount++;
    else missingCount++;

    if (entry.adwareProtected) adwareProtectedCount++;
    if (entry.canRunArchiveSilent) silentReadyCount++;
  }

  const total = items.length;
  const statusText = total === 0 ? 'Noch keine Pakete' : `${installedCount} von ${total} bereits installiert`;

  return {
    items,
    summary: {
      total,
      installedCount,
      upToDateCount,
      outdatedCount,
      missingCount,
      adwareProtectedCount,
      silentReadyCount,
      statusText,
    },
  };
}

export function planBundleExecution(evaluatedItems = [], { allowSilent = true, silentWinget = false } = {}) {
  const ordered = [...(evaluatedItems || [])].sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0));

  const silentItems = [];
  const interactiveItems = [];
  let adwareProtectedCount = 0;

  for (const item of ordered) {
    if (!item) continue;
    const isProtected = Boolean(item.adwareProtected || item.installMode === 'interactive-required');
    if (isProtected) adwareProtectedCount++;

    let willRunSilent = false;
    if (!isProtected) {
      if (item.source === 'archive') {
        willRunSilent = Boolean(allowSilent && item.canRunArchiveSilent);
      } else if (item.source === 'winget') {
        willRunSilent = Boolean(silentWinget && item.canRunWingetSilent);
      }
    }

    if (willRunSilent) {
      silentItems.push({ ...item, willRunSilent: true, executionPhase: 'silent' });
    } else {
      interactiveItems.push({ ...item, willRunSilent: false, executionPhase: 'interactive' });
    }
  }

  const orderedQueue = [...silentItems, ...interactiveItems];
  const interactiveCount = interactiveItems.length;
  const silentCount = silentItems.length;

  let interactiveNotice = '';
  if (interactiveCount > 0) {
    const protectedSuffix =
      adwareProtectedCount > 0
        ? ` (davon ${adwareProtectedCount} mit 🛡️ Adware-Schutz - Silent-Parameter werden ignoriert)`
        : '';
    interactiveNotice =
      silentCount > 0
        ? `Nach ${silentCount} stillen Paket(en) folgen am Ende ${interactiveCount} interaktive Setup(s)${protectedSuffix}.`
        : `${interactiveCount} Paket(e) werden interaktiv installiert${protectedSuffix}.`;
  }

  return {
    silentItems,
    interactiveItems,
    orderedQueue,
    stats: {
      total: orderedQueue.length,
      silentCount,
      interactiveCount,
      adwareProtectedCount,
    },
    interactiveNotice,
  };
}

export function buildBundleDraftFromInstalled(packages = [], { name = '', description = '', icon = '💻' } = {}) {
  const seenKeys = new Set();
  const seenWingetIds = new Set();
  const rawItems = [];
  let archiveCount = 0;
  let wingetCount = 0;
  let excludedCount = 0;

  const installedPackages = (packages || []).filter((p) => p?.isInstalled);
  // Archiv-Einträge zuerst verarbeiten, damit sie Vorrang vor reinen Winget-Duplikaten haben
  installedPackages.sort((a, b) => Number(Boolean(b.inArchive)) - Number(Boolean(a.inArchive)));

  for (const pkg of installedPackages) {
    const pkgId = String(pkg.packageId || pkg.wingetId || '').trim();
    const pkgIdLower = pkgId.toLowerCase();

    if (pkg.inArchive) {
      const refId = String(pkg.archiveItemId || pkg.id || '').trim();
      if (!refId) {
        excludedCount++;
        continue;
      }
      const key = `archive:${refId}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      if (pkgIdLower) seenWingetIds.add(pkgIdLower);
      archiveCount++;
      rawItems.push({
        source: 'archive',
        refId,
        packageId: pkgId,
        name: pkg.name || refId,
        optional: false,
      });
      continue;
    }

    if (pkg.packageManager === 'winget' && pkgId) {
      if (seenWingetIds.has(pkgIdLower)) continue;
      const key = `winget:${pkgIdLower}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      seenWingetIds.add(pkgIdLower);
      wingetCount++;
      rawItems.push({
        source: 'winget',
        refId: '',
        packageId: pkgId,
        name: pkg.name || pkgId,
        optional: false,
      });
      continue;
    }

    excludedCount++;
  }

  rawItems.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  const items = rawItems.map((item, idx) => ({ ...item, order: idx + 1 }));

  const dateStr = new Date().toLocaleDateString('de-DE');
  const resolvedName = String(name || '').trim() || `PC-Snapshot (${dateStr})`;
  const resolvedDesc =
    String(description || '').trim() ||
    'Automatischer Snapshot der installierten Programme dieses PCs (Archiv & Winget).';

  return {
    draft: {
      id: '',
      name: resolvedName,
      description: resolvedDesc,
      icon: String(icon || '').trim() || '💻',
      items,
    },
    includedCount: items.length,
    archiveCount,
    wingetCount,
    excludedCount,
  };
}
