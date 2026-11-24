import fs from 'node:fs';
import path from 'node:path';
import {
  buildLinkedMetaObject,
  inspectArchiveTargetCollision,
  readExistingMetaSummary,
  resolveAutoIdTargetDir,
} from './archive-linker-core.js';
import { loadCatalogWithLiveStatus } from './catalog-service.js';
import { getConfig } from './config.js';
import { getProvider } from './providers/registry.js';
import { scanSingleFolder } from './scanner-bridge.js';
import { downloadWebUpdate } from './web-updater.js';
import { extractCachedAppIcon } from './windows-tools.js';

const ICON_EXTS = new Set(['.png', '.ico', '.svg', '.webp', '.jpg', '.jpeg', '.gif', '.avif']);

async function ensureArchiveIcon({ resolvedTargetDir, metaDir, nextMeta, fetchedPkg, metadata, cleanPm, cleanPid }) {
  try {
    const existingFiles = await fs.promises.readdir(metaDir);
    if (existingFiles.some((f) => f.toLowerCase().startsWith('icon.'))) {
      return;
    }

    const directIcon = typeof metadata?.icon === 'string' ? metadata.icon.trim() : '';
    if (directIcon && fs.existsSync(directIcon)) {
      const ext = path.extname(directIcon).toLowerCase();
      if (ICON_EXTS.has(ext)) {
        await fs.promises.copyFile(directIcon, path.join(metaDir, `icon${ext}`));
        return;
      }
    }

    const metaLinks =
      nextMeta.links && typeof nextMeta.links === 'object' && !Array.isArray(nextMeta.links)
        ? Object.entries(nextMeta.links).map(([label, url]) => ({ label, url }))
        : [];

    const iconRes = await extractCachedAppIcon({
      id: metadata?.id || `${cleanPm || 'archive'}:${cleanPid || path.basename(resolvedTargetDir)}`,
      name: nextMeta.name || '',
      displayIcon: metadata?.displayIcon || '',
      installLocation: metadata?.installLocation || '',
      executablePath: metadata?.validInstallPath || metadata?.executablePath || metadata?.installPaths?.[0] || '',
      uninstallString: metadata?.uninstallString || '',
      packageManager: cleanPm,
      packageId: cleanPid,
      appxPackageFamilyName: metadata?.appxPackageFamilyName || '',
      homepage: fetchedPkg?.homepage || metadata?.homepage || '',
      webVersionUrl: nextMeta.webVersionUrl || '',
      links: metaLinks,
      allowOnlineFallback: true,
    });

    if (iconRes?.success && iconRes.iconPath && fs.existsSync(iconRes.iconPath)) {
      const ext = path.extname(iconRes.iconPath).toLowerCase() || '.png';
      if (ICON_EXTS.has(ext)) {
        await fs.promises.copyFile(iconRes.iconPath, path.join(metaDir, `icon${ext}`));
      }
    }
  } catch {
    // Fehlgeschlagenes Icon darf die Archiv-Aufnahme nicht abbrechen
  }
}

/**
 * Prüft vor dem Schreiben, ob der Zielordner in einem konfigurierten Archiv liegt und ob bereits `_metadata/` existiert.
 */
export function checkArchiveTargetCollision(targetDir) {
  const { absArchivePaths } = getConfig();
  return inspectArchiveTargetCollision(targetDir, absArchivePaths);
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
    resolvedTargetDir = resolveAutoIdTargetDir(cfg.absTargetPath, cleanPid);
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

  const metaDir = path.join(resolvedTargetDir, '_metadata');
  const metaFile = path.join(metaDir, 'meta.json');
  if (!fs.existsSync(metaDir)) {
    fs.mkdirSync(metaDir, { recursive: true });
  }

  const existingSummary = readExistingMetaSummary(metaFile);
  const nextMeta = buildLinkedMetaObject({
    collisionMode: normalizedMode,
    existingSummary,
    packageManager: cleanPm,
    packageId: cleanPid,
    softwareName,
    fetchedPkg,
    metadata,
    keepAllVersions,
    resolvedTargetDir,
  });

  fs.writeFileSync(metaFile, JSON.stringify(nextMeta, null, 2), 'utf-8');

  await ensureArchiveIcon({
    resolvedTargetDir,
    metaDir,
    nextMeta,
    fetchedPkg,
    metadata,
    cleanPm,
    cleanPid,
  });

  const scanRes = await scanSingleFolder(resolvedTargetDir);
  if (!scanRes.success) {
    return { success: false, error: scanRes.error || 'Einzelordner-Rescan fehlgeschlagen.' };
  }

  const catalogItems = loadCatalogWithLiveStatus();
  let linkedItem = catalogItems.find((i) => path.resolve(i.path) === resolvedTargetDir) || null;
  let downloadResult = null;

  const provider = cleanPm ? getProvider(cleanPm) : null;
  const supportsArchiveDownload = Boolean(provider?.capabilities?.supportsArchiveDownload);
  if (effectiveDownloadSetup && supportsArchiveDownload && linkedItem) {
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
