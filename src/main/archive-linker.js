import fs from 'node:fs';
import path from 'node:path';
import { loadCatalogWithLiveStatus } from './catalog-service.js';
import { getConfig, isInsideTargetDir } from './config.js';
import { getProvider } from './providers/registry.js';
import { scanSingleFolder } from './scanner-bridge.js';
import { downloadWebUpdate } from './web-updater.js';

/**
 * Erzeugt aus einer Paket-ID (z. B. "VideoLAN.VLC") einen sicheren Ordnernamen für Modus `auto-id`.
 */
export function buildAutoIdFolderName(packageId) {
  const cleaned = String(packageId || '')
    .trim()
    .replace(/\.\.+/g, '.')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return cleaned || 'Package';
}

function readExistingMetaSummary(metaFilePath) {
  if (!fs.existsSync(metaFilePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
    return {
      name: raw.name || '',
      packageManager: raw.packageManager || (raw.wingetId ? 'winget' : ''),
      packageId: raw.packageId || raw.wingetId || '',
      wingetId: raw.wingetId || '',
      keepAllVersions: Boolean(raw.keepAllVersions),
      raw,
    };
  } catch {
    return null;
  }
}

/**
 * Prüft vor dem Schreiben, ob der Zielordner im Archiv liegt und ob bereits `_metadata/` existiert.
 */
export function checkArchiveTargetCollision(targetDir) {
  if (!targetDir) {
    return { valid: false, error: 'Kein Zielordner angegeben.' };
  }

  const resolvedDir = path.resolve(targetDir);
  if (!isInsideTargetDir(resolvedDir)) {
    return {
      valid: false,
      error: 'Sicherheitsverletzung: Zielordner liegt außerhalb des konfigurierten Archiv-Verzeichnisses.',
    };
  }

  const { absTargetPath } = getConfig();
  const resolvedRoot = path.resolve(absTargetPath);
  const isSameAsRoot =
    process.platform === 'win32'
      ? resolvedDir.toLowerCase() === resolvedRoot.toLowerCase()
      : resolvedDir === resolvedRoot;
  if (isSameAsRoot) {
    return {
      valid: false,
      error: 'Bitte einen Unterordner innerhalb des Archivs wählen (nicht das Archiv-Stammverzeichnis selbst).',
    };
  }

  const dirExists = fs.existsSync(resolvedDir);
  const metaDir = path.join(resolvedDir, '_metadata');
  const metaFile = path.join(metaDir, 'meta.json');
  const metaDirExists = fs.existsSync(metaDir);
  const metaFileExists = fs.existsSync(metaFile);
  const existing = readExistingMetaSummary(metaFile);

  return {
    valid: true,
    targetDir: resolvedDir,
    dirExists,
    hasMetadata: metaDirExists || metaFileExists,
    existingMeta: existing
      ? {
          name: existing.name,
          packageManager: existing.packageManager,
          packageId: existing.packageId,
          wingetId: existing.wingetId,
          keepAllVersions: existing.keepAllVersions,
        }
      : null,
  };
}

/**
 * Sucht im geladenen Archiv-Katalog nach einem bereits verknüpften Eintrag für `packageManager` + `packageId`.
 */
export function findExistingArchiveLink(packageManager, packageId) {
  const cleanPm = String(packageManager || '')
    .trim()
    .toLowerCase();
  const cleanId = String(packageId || '')
    .trim()
    .toLowerCase();
  if (!cleanId) return null;

  const items = loadCatalogWithLiveStatus();
  return (
    items.find((item) => {
      const itemPm = (item.packageManager || (item.wingetId ? 'winget' : '')).toLowerCase();
      const itemPid = (item.packageId || item.wingetId || '').toLowerCase();
      if (!itemPid) return false;
      if (cleanPm) return itemPm === cleanPm && itemPid === cleanId;
      return itemPid === cleanId;
    }) || null
  );
}

function buildLinksObject(pkgMeta) {
  if (pkgMeta?.links && !Array.isArray(pkgMeta.links) && typeof pkgMeta.links === 'object') {
    return { ...pkgMeta.links };
  }
  const links = {};
  if (pkgMeta?.homepage) links.Homepage = pkgMeta.homepage;
  if (pkgMeta?.releaseNotesUrl) links.Changelog = pkgMeta.releaseNotesUrl;
  return links;
}

/**
 * Nimmt ein Paket im Archiv auf oder verknüpft es mit einem bestehenden Archiv-Ordner.
 * Unterstützt `auto-id` (`<Archiv>/<packageId>` mit echtem Softwarenamen in meta.json) sowie
 * Kollisionsauflösung (`create`, `link`, `overwrite`) und optionalen Direkt-Download.
 */
export async function linkPackageToArchive({
  packageManager = '',
  packageId = '',
  softwareName = '',
  targetDir = '',
  saveMode = null,
  collisionMode = 'create',
  metadata = null,
  downloadSetup = false,
  saveIntoLastFolder = false,
  keepAllVersions = false,
  downloadUseJob = true,
  signal = null,
}) {
  const cleanPid = String(packageId || '').trim();
  const cleanPm = cleanPid
    ? String(packageManager || 'winget')
        .trim()
        .toLowerCase()
    : '';
  const effectiveDownloadSetup = Boolean(downloadSetup && cleanPid);

  if (!cleanPid && !targetDir) {
    return {
      success: false,
      needsTargetDir: true,
      error: 'Bitte einen Zielordner im Archiv auswählen.',
    };
  }

  const cfg = getConfig();
  const effectiveSaveMode = saveMode || cfg.archiveSaveMode || 'ask';

  if (effectiveSaveMode === 'none' && !targetDir) {
    return {
      success: false,
      skipped: true,
      error: 'Archiv-Speicherung ist in den Einstellungen deaktiviert (Modus: none).',
    };
  }

  let resolvedTargetDir = '';
  if (targetDir) {
    resolvedTargetDir = path.resolve(targetDir);
  } else if (effectiveSaveMode === 'auto-id') {
    resolvedTargetDir = path.join(cfg.absTargetPath, buildAutoIdFolderName(cleanPid));
  } else {
    return {
      success: false,
      needsTargetDir: true,
      error: 'Bitte einen Zielordner im Archiv auswählen.',
    };
  }

  const collision = checkArchiveTargetCollision(resolvedTargetDir);
  if (!collision.valid) {
    return { success: false, error: collision.error };
  }

  const normalizedMode = ['create', 'link', 'overwrite'].includes(collisionMode) ? collisionMode : 'create';
  if (collision.hasMetadata && normalizedMode === 'create') {
    return {
      success: false,
      collision: true,
      targetDir: resolvedTargetDir,
      existingMeta: collision.existingMeta,
    };
  }

  let fetchedPkg = metadata || null;
  if (cleanPid && cleanPm) {
    if ((!fetchedPkg || !softwareName) && normalizedMode !== 'link') {
      const provider = getProvider(cleanPm);
      if (provider?.capabilities.show) {
        const showRes = await provider.show(cleanPid, { preferGerman: true });
        if (showRes?.success && showRes.package) {
          fetchedPkg = { ...showRes.package, ...(fetchedPkg || {}) };
        }
      }
    } else if (!fetchedPkg && normalizedMode === 'link') {
      const provider = getProvider(cleanPm);
      if (provider?.capabilities.show) {
        const showRes = await provider.show(cleanPid, { preferGerman: true });
        if (showRes?.success && showRes.package) {
          fetchedPkg = showRes.package;
        }
      }
    }
  }

  // Anzeigename != Ordnername: In meta.json steht zwingend der echte Softwarename
  const realDisplayName = String(
    softwareName || fetchedPkg?.name || collision.existingMeta?.name || cleanPid || path.basename(resolvedTargetDir)
  ).trim();

  const metaDir = path.join(resolvedTargetDir, '_metadata');
  const metaFile = path.join(metaDir, 'meta.json');
  if (!fs.existsSync(metaDir)) {
    fs.mkdirSync(metaDir, { recursive: true });
  }

  const existingSummary = readExistingMetaSummary(metaFile);
  let nextMeta;

  if (normalizedMode === 'link' && existingSummary?.raw) {
    nextMeta = {
      ...existingSummary.raw,
      name: existingSummary.raw.name || realDisplayName,
    };
    if (cleanPm && cleanPid) {
      nextMeta.packageManager = cleanPm;
      nextMeta.packageId = cleanPid;
    }
    if (cleanPm === 'winget' && cleanPid) {
      nextMeta.wingetId = cleanPid;
      if (!nextMeta.webSourceType || nextMeta.webSourceType === 'none') {
        nextMeta.webSourceType = 'winget';
      }
    }
    if (fetchedPkg?.version && !nextMeta.webVersion) {
      nextMeta.webVersion = fetchedPkg.version;
    }
    if (nextMeta.keepAllVersions === undefined) {
      nextMeta.keepAllVersions = Boolean(keepAllVersions);
    }
  } else {
    nextMeta = {
      name: realDisplayName,
      softwareType: 'default',
      category: '',
      hiddenCategory: '',
      tags: Array.isArray(fetchedPkg?.tags) ? fetchedPkg.tags.slice(0, 12) : [],
      formats: [],
      os: ['Windows 10', 'Windows 11'],
      description: fetchedPkg?.description || fetchedPkg?.shortDescription || '',
      searchNames: Array.isArray(metadata?.searchNames) ? metadata.searchNames : [],
      installPaths: Array.isArray(metadata?.installPaths) ? metadata.installPaths : [],
      autoPaths: [],
      packageManager: cleanPm,
      packageId: cleanPid,
      wingetId: cleanPm === 'winget' ? cleanPid : '',
      keepAllVersions: Boolean(keepAllVersions),
      webSourceType: cleanPm === 'winget' && cleanPid ? 'winget' : 'none',
      webVersion: fetchedPkg?.version || '',
      links: buildLinksObject(fetchedPkg),
    };
  }

  fs.writeFileSync(metaFile, JSON.stringify(nextMeta, null, 2), 'utf-8');

  const scanRes = await scanSingleFolder(resolvedTargetDir);
  if (!scanRes.success) {
    return { success: false, error: scanRes.error || 'Einzelordner-Rescan fehlgeschlagen.' };
  }

  const catalogItems = loadCatalogWithLiveStatus();
  let linkedItem = catalogItems.find((i) => path.resolve(i.path) === resolvedTargetDir) || null;
  let downloadResult = null;

  if (effectiveDownloadSetup && linkedItem) {
    downloadResult = await downloadWebUpdate(linkedItem, {
      saveIntoLastFolder,
      useJob: downloadUseJob,
      signal,
    });
    const refreshedItems = loadCatalogWithLiveStatus();
    linkedItem = refreshedItems.find((i) => path.resolve(i.path) === resolvedTargetDir) || linkedItem;
  }

  return {
    success: true,
    mode: normalizedMode,
    targetDir: resolvedTargetDir,
    item: linkedItem,
    downloadResult,
  };
}
