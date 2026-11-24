import { existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSoftwareMergeKeys,
  getArchiveRootLabel,
  isNormalizedPathInsideDir,
  mergeMultiRootCatalogEntries,
  normalizeArchivePaths,
  normalizePathKey,
} from '../shared/multi-archive-logic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.SK_APP_DIR ? path.resolve(process.env.SK_APP_DIR) : path.resolve(__dirname, '../..');
const DATA_DIR = process.env.SK_DATA_DIR ? path.resolve(process.env.SK_DATA_DIR) : path.join(APP_DIR, 'data');

const META_FOLDER_NAME = '_metadata';
const IS_FULL_RESCAN = process.argv.includes('--full');
const IS_UPDATE = process.argv.includes('--update');
const SINGLE_IDX = process.argv.indexOf('--single');
const SINGLE_TARGET = SINGLE_IDX !== -1 ? path.resolve(process.argv[SINGLE_IDX + 1] || '') : null;

async function asyncPool(limit, tasks) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    executing.add(p);
    p.then(() => executing.delete(p));
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

function isDirReachable(absPath) {
  if (!absPath) return false;
  try {
    return existsSync(absPath) && statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

async function loadConfig() {
  const configPath = path.join(DATA_DIR, 'config.json');
  const config = {
    archivePaths: ['../software'],
    targetPath: '../software',
    jsonPath: 'catalog.json',
    scanNested: false,
    nestedDepth: 1,
    autoExtensions: ['.exe', '.msi', '.zip'],
  };

  if (existsSync(configPath)) {
    try {
      Object.assign(config, JSON.parse(await fs.readFile(configPath, 'utf-8')));
    } catch (e) {
      console.error(`Fehler beim Lesen der config.json: ${e.message}`);
    }
  }

  const normalizedPaths = normalizeArchivePaths(config);
  const roots = normalizedPaths.map((rawPath, index) => ({
    index,
    rawPath,
    absPath: path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(APP_DIR, rawPath),
    label: getArchiveRootLabel(rawPath, index),
  }));

  const resolvedJson = path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(DATA_DIR, config.jsonPath);

  return {
    ...config,
    ROOTS: roots,
    ROOT_DIR: roots[0].absPath,
    OUTPUT_FILE: resolvedJson,
  };
}

/**
 * Berechnet den jüngsten Änderungszeitstempel eines Software-Ordners
 * (Ordner selbst, _last, _metadata, meta.json), um im Smart-Scan
 * neue Setup-Dateien oder geänderte Metadaten ohne Voll-Parse zu erkennen.
 */
async function getFolderSignature(softwareDir) {
  let maxMtime = 0;
  const probePaths = [
    softwareDir,
    path.join(softwareDir, '_last'),
    path.join(softwareDir, META_FOLDER_NAME),
    path.join(softwareDir, META_FOLDER_NAME, 'meta.json'),
  ];

  for (const p of probePaths) {
    try {
      const st = await fs.stat(p);
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    } catch {
      // Optionaler Unterordner existiert nicht
    }
  }
  return Math.floor(maxMtime);
}

async function parseSoftwareMetadata(softwareDir, metaDir, config, rootInfo) {
  let customName = '';
  let description = '';
  let iconPath = null;
  const screenshots = [];
  let os = [];
  let mainCategory = '';
  let subCategories = [];
  let links = [];
  let formats = [];
  let searchNames = [];
  let installPaths = [];
  let autoPaths = [];
  let softwareType = 'default';
  let installMode = 'interactive';
  let silentArgs = '';
  let innoInfFile = '';
  let innoInfExists = false;
  let webSourceType = '';
  let packageManager = '';
  let packageId = '';
  let wingetId = '';
  let keepAllVersions = false;
  let githubAssetPattern = '';
  let webVersionUrl = '';
  let webVersionPrefix = '';
  let webVersionSuffix = '';
  let downloadUrl = '';
  let dlPrefix = '';
  let dlSuffix = '';
  let webVersion = '';
  let hiddenCategory = '';

  let addedAt = 0;
  let updatedAt = 0;

  try {
    const swStat = await fs.stat(softwareDir);
    addedAt = swStat.birthtimeMs || swStat.mtimeMs;
    updatedAt = swStat.mtimeMs;

    const metaEntries = await fs.readdir(metaDir, { withFileTypes: true });

    for (const entry of metaEntries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(metaDir, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (lowerName.startsWith('icon.') && /\.(png|gif|jpg|jpeg|svg|webp|ico|avif)$/i.test(lowerName)) {
        iconPath = fullPath;
      } else if (/\.(png|gif|jpg|jpeg|svg|webp|ico|avif|mp4|webm|ogg|mov|avi)$/i.test(lowerName)) {
        screenshots.push(fullPath);
      }
    }

    screenshots.sort((a, b) => {
      const isVidA = /\.(mp4|webm|ogg|mov|avi)$/i.test(a);
      const isVidB = /\.(mp4|webm|ogg|mov|avi)$/i.test(b);
      if (isVidA !== isVidB) return isVidA ? 1 : -1;
      return a.localeCompare(b, 'de', { sensitivity: 'base' });
    });

    const jsonPath = path.join(metaDir, 'meta.json');
    if (existsSync(jsonPath)) {
      try {
        const metaStat = await fs.stat(jsonPath);
        if (metaStat.mtimeMs > updatedAt) updatedAt = metaStat.mtimeMs;

        const data = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));

        if (data.name) customName = data.name;
        if (data.description) {
          description = Array.isArray(data.description) ? data.description.join('<br>') : data.description;
        }
        if (data.hiddenCategory) hiddenCategory = data.hiddenCategory.trim();
        if (data.os) {
          os = Array.isArray(data.os)
            ? data.os
            : String(data.os)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }
        if (data.category) mainCategory = data.category;
        if (data.softwareType) softwareType = data.softwareType;
        if (data.tags) {
          subCategories = Array.isArray(data.tags)
            ? data.tags
            : String(data.tags)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }
        if (data.formats) {
          formats = Array.isArray(data.formats)
            ? data.formats
            : String(data.formats)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }
        if (data.searchNames) {
          searchNames = Array.isArray(data.searchNames)
            ? data.searchNames.filter(Boolean)
            : String(data.searchNames)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }
        if (data.installPaths) {
          installPaths = Array.isArray(data.installPaths)
            ? data.installPaths.filter(Boolean)
            : [data.installPaths].filter(Boolean);
        }
        if (data.autoPaths) {
          autoPaths = Array.isArray(data.autoPaths) ? data.autoPaths.filter(Boolean) : [data.autoPaths].filter(Boolean);
        }

        // Online-Update & Paketmanager-Felder (inkl. Abwärtskompatibilität auf wingetId)
        if (data.webSourceType) webSourceType = String(data.webSourceType).trim();
        if (data.packageManager) packageManager = String(data.packageManager).trim();
        if (data.packageId) packageId = String(data.packageId).trim();
        if (data.wingetId) wingetId = String(data.wingetId).trim();
        if (typeof data.keepAllVersions === 'boolean') keepAllVersions = data.keepAllVersions;
        if (data.installMode === 'silent' || data.installMode === 'interactive-required') {
          installMode = data.installMode;
        }
        if (typeof data.silentArgs === 'string') {
          silentArgs = data.silentArgs
            .replace(/[\r\n]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        }
        if (typeof data.innoInfFile === 'string') {
          const rawInf = data.innoInfFile.trim();
          const baseInf = rawInf.split('\\').pop().split('/').pop().trim();
          if (baseInf && !rawInf.includes('..') && /\.inf$/i.test(baseInf)) {
            innoInfFile = baseInf;
          }
        }

        if (!packageId && wingetId) {
          packageId = wingetId;
          if (!packageManager) packageManager = 'winget';
        } else if (packageManager === 'winget' && packageId && !wingetId) {
          wingetId = packageId;
        }

        if (data.githubAssetPattern) githubAssetPattern = data.githubAssetPattern.trim();
        if (data.webVersionUrl) webVersionUrl = data.webVersionUrl.trim();
        if (data.webVersionPrefix) webVersionPrefix = data.webVersionPrefix;
        if (data.webVersionSuffix) webVersionSuffix = data.webVersionSuffix;
        if (data.downloadUrl) downloadUrl = data.downloadUrl.trim();
        if (data.dlPrefix) dlPrefix = data.dlPrefix;
        if (data.dlSuffix) dlSuffix = data.dlSuffix;
        if (data.webVersion) webVersion = data.webVersion.trim();

        // Automatische Ableitung für bestehende Einträge ohne webSourceType
        if (!webSourceType) {
          if (wingetId || packageManager === 'winget') webSourceType = 'winget';
          else if (webVersionUrl.toLowerCase().includes('github.com')) webSourceType = 'github';
          else if (webVersionUrl) webSourceType = 'web';
          else webSourceType = 'none';
        }

        if (data.links && typeof data.links === 'object') {
          links = Array.isArray(data.links)
            ? data.links
            : Object.entries(data.links).map(([label, url]) => ({ label, url }));
        }
      } catch (e) {
        console.warn(`Fehler beim Parsen der meta.json in ${metaDir}: ${e.message}`);
      }
    }
  } catch (err) {
    console.error(`Fehler beim Lesen des _metadata Ordners ${metaDir}: ${err.message}`);
  }

  // _last Ordner (bewusstes Pinning für Sonderfälle)
  let lastFiles = [];
  let hasPinnedLast = false;
  const lastDir = path.join(softwareDir, '_last');
  if (existsSync(lastDir)) {
    try {
      const lEntries = await fs.readdir(lastDir, { withFileTypes: true });
      const names = lEntries.filter((e) => e.isFile() && !e.name.endsWith('.part')).map((e) => e.name);
      if (names.length > 0) {
        hasPinnedLast = true;
        names.sort((a, b) => b.localeCompare(a, 'de', { numeric: true, sensitivity: 'base' }));
        lastFiles = names.map((e) => path.join(lastDir, e));
      }
    } catch (e) {
      console.error(`Fehler beim Lesen des _last Ordners in ${softwareDir}: ${e.message}`);
    }
  }

  // Standardfall: Setup-Dateien direkt im Hauptordner der Software
  if (lastFiles.length === 0 && config.autoExtensions?.length > 0) {
    try {
      const rootEntries = await fs.readdir(softwareDir, { withFileTypes: true });
      const files = rootEntries.filter((e) => e.isFile() && !e.name.endsWith('.part')).map((e) => e.name);
      const foundFiles = [];

      for (const ext of config.autoExtensions) {
        let extLower = ext.toLowerCase().trim();
        if (extLower && !extLower.startsWith('.')) extLower = `.${extLower}`;
        const matchingFiles = files.filter((f) => f.toLowerCase().endsWith(extLower));
        if (matchingFiles.length > 0) {
          matchingFiles.sort((a, b) => b.localeCompare(a, 'de', { numeric: true, sensitivity: 'base' }));
          foundFiles.push(...matchingFiles);
        }
      }
      if (foundFiles.length > 0) {
        lastFiles.push(...foundFiles.map((f) => path.join(softwareDir, f)));
      }
    } catch (e) {
      console.error(`Fehler beim Suchen nach Setup-Dateien in ${softwareDir}: ${e.message}`);
    }
  }

  innoInfExists = Boolean(innoInfFile && existsSync(path.join(metaDir, innoInfFile)));
  const scanMtime = await getFolderSignature(softwareDir);
  const toRel = (p) => (p ? path.relative(APP_DIR, p) : null);

  const relSoftwarePath = toRel(softwareDir);
  const relLastFiles = lastFiles.map(toRel);
  const effectiveRoot = rootInfo || {
    index: 0,
    rawPath: config.targetPath || '../software',
    absPath: config.ROOT_DIR,
    label: getArchiveRootLabel(config.targetPath || '../software', 0),
  };
  const lastFileSources = {};
  for (const relF of relLastFiles) {
    lastFileSources[relF] = {
      rootIndex: effectiveRoot.index,
      rootLabel: effectiveRoot.label,
      rootPath: effectiveRoot.rawPath,
      offline: false,
    };
  }

  return {
    id: Buffer.from(relSoftwarePath).toString('base64url'),
    name: customName || path.basename(softwareDir),
    path: relSoftwarePath,
    primaryPath: relSoftwarePath,
    archiveRootIndex: effectiveRoot.index,
    archiveRootPath: effectiveRoot.rawPath,
    archiveRootAbsPath: effectiveRoot.absPath,
    archiveRootLabel: effectiveRoot.label,
    archiveOffline: false,
    description,
    icon: toRel(iconPath),
    screenshots: screenshots.map(toRel),
    os,
    mainCategory,
    subCategories,
    lastFiles: relLastFiles,
    lastFileSources,
    hasPinnedLast,
    searchNames,
    installPaths,
    autoPaths,
    softwareType,
    installMode,
    silentArgs,
    innoInfFile,
    innoInfExists,
    webSourceType: webSourceType || 'none',
    packageManager,
    packageId,
    wingetId,
    keepAllVersions,
    githubAssetPattern,
    webVersionUrl,
    webVersionPrefix,
    webVersionSuffix,
    downloadUrl,
    dlPrefix,
    dlSuffix,
    webVersion,
    links,
    formats,
    hiddenCategory,
    addedAt,
    updatedAt,
    scanMtime,
  };
}

async function scanDirectory(currentDir, cacheMap, config, rootInfo, currentDepth = 0, maxDepth = 6, nestedDepth = 0) {
  if (currentDepth > maxDepth) return [];

  process.stdout.write(`SCAN_DIR:${currentDir}\n`);

  try {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const subDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    const metaEntry = subDirs.find((d) => d.name.toLowerCase() === META_FOLDER_NAME);

    if (metaEntry) {
      let currentItem;
      const cacheKey = normalizePathKey(currentDir);
      const cached = cacheMap.get(cacheKey);

      if (!IS_FULL_RESCAN && cached) {
        // Smart-Check: Nur neu parsen, wenn sich Ordner, _last oder meta.json verändert haben
        const currentSig = await getFolderSignature(currentDir);
        currentItem =
          cached.scanMtime && cached.scanMtime === currentSig
            ? {
                ...cached,
                archiveRootIndex: rootInfo.index,
                archiveRootPath: rootInfo.rawPath,
                archiveRootAbsPath: rootInfo.absPath,
                archiveRootLabel: rootInfo.label,
                archiveOffline: false,
              }
            : await parseSoftwareMetadata(currentDir, path.join(currentDir, metaEntry.name), config, rootInfo);
      } else {
        currentItem = await parseSoftwareMetadata(currentDir, path.join(currentDir, metaEntry.name), config, rootInfo);
      }

      let results = [currentItem];

      if (config.scanNested && nestedDepth < config.nestedDepth) {
        const tasks = subDirs.map(
          (dir) => () =>
            scanDirectory(
              path.join(currentDir, dir.name),
              cacheMap,
              config,
              rootInfo,
              currentDepth + 1,
              maxDepth,
              nestedDepth + 1
            )
        );
        const nestedResults = await asyncPool(8, tasks);
        results = results.concat(nestedResults.flat());
      }
      return results;
    }

    const tasks = subDirs.map(
      (dir) => () =>
        scanDirectory(
          path.join(currentDir, dir.name),
          cacheMap,
          config,
          rootInfo,
          currentDepth + 1,
          maxDepth,
          nestedDepth
        )
    );
    const results = await asyncPool(8, tasks);
    return results.flat();
  } catch (err) {
    console.error(`Fehler beim Scannen von ${currentDir}: ${err.message}`);
    return [];
  }
}

async function writeCatalogAtomic(outputFile, list) {
  list.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
  const tmpFile = `${outputFile}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(list, null, 2), 'utf-8');
  await fs.rename(tmpFile, outputFile);
}

function resolveRootForDir(absDir, roots) {
  const matched = roots.find((r) => isNormalizedPathInsideDir(absDir, r.absPath));
  return matched || roots[0];
}

function buildCacheMapFromCatalog(oldData) {
  /** @type {Map<string, any>} */
  const cacheMap = new Map();
  for (const item of oldData) {
    if (!item?.path) continue;
    const primaryAbs = path.resolve(APP_DIR, item.primaryPath || item.path);
    if (!item.hasMultipleArchiveRoots && !item.archiveOffline) {
      cacheMap.set(normalizePathKey(primaryAbs), item);
    }
  }
  return cacheMap;
}

async function runSingleScan(config) {
  const metaDir = path.join(SINGLE_TARGET, META_FOLDER_NAME);
  let existingList = [];
  if (existsSync(config.OUTPUT_FILE)) {
    try {
      existingList = JSON.parse(await fs.readFile(config.OUTPUT_FILE, 'utf-8'));
    } catch {
      existingList = [];
    }
  }

  if (!existsSync(metaDir)) {
    return;
  }

  const targetRoot = resolveRootForDir(SINGLE_TARGET, config.ROOTS);
  const parsed = await parseSoftwareMetadata(SINGLE_TARGET, metaDir, config, targetRoot);
  const targetKey = normalizePathKey(SINGLE_TARGET);
  const parsedKeys = buildSoftwareMergeKeys(parsed);

  const unrelatedEntries = [];
  const relatedExisting = [];

  for (const item of existingList) {
    const itemPrimaryKey = normalizePathKey(path.resolve(APP_DIR, item.primaryPath || item.path || ''));
    const hasAltMatch = Array.isArray(item.alternatePaths)
      ? item.alternatePaths.some((a) => normalizePathKey(path.resolve(APP_DIR, a.path || '')) === targetKey)
      : false;
    const itemKeys = buildSoftwareMergeKeys(item);
    const pkgMatch = parsedKeys.packageKey && itemKeys.packageKey && parsedKeys.packageKey === itemKeys.packageKey;
    const nameMatch = parsedKeys.nameKey && itemKeys.nameKey && parsedKeys.nameKey === itemKeys.nameKey;

    if (itemPrimaryKey === targetKey || hasAltMatch || pkgMatch || nameMatch) {
      relatedExisting.push(item);
    } else {
      unrelatedEntries.push(item);
    }
  }

  // Bei Multi-Root-Kollisionen: andere erreichbare Wurzeln dieses Programms neu parsen, Offline-Wurzeln aus Cache bewahren
  /** @type {Map<number, any[]>} */
  const scannedByRoot = new Map([[targetRoot.index, [parsed]]]);
  const offlineIndices = new Set();

  for (const oldItem of relatedExisting) {
    const candidateSources = [
      { path: oldItem.primaryPath || oldItem.path, rootIndex: oldItem.archiveRootIndex ?? 0 },
      ...(Array.isArray(oldItem.alternatePaths) ? oldItem.alternatePaths : []),
    ];

    for (const src of candidateSources) {
      if (!src?.path) continue;
      const absOther = path.resolve(APP_DIR, src.path);
      if (normalizePathKey(absOther) === targetKey) continue;

      const rInfo = config.ROOTS[src.rootIndex] || resolveRootForDir(absOther, config.ROOTS);
      if (!isDirReachable(rInfo.absPath)) {
        offlineIndices.add(rInfo.index);
        continue;
      }

      const otherMeta = path.join(absOther, META_FOLDER_NAME);
      if (existsSync(otherMeta)) {
        const otherParsed = await parseSoftwareMetadata(absOther, otherMeta, config, rInfo);
        if (!scannedByRoot.has(rInfo.index)) scannedByRoot.set(rInfo.index, []);
        scannedByRoot.get(rInfo.index).push(otherParsed);
      }
    }
  }

  const mergedGroup = mergeMultiRootCatalogEntries(scannedByRoot, {
    existingEntries: relatedExisting,
    offlineRootIndices: Array.from(offlineIndices),
    roots: config.ROOTS,
  });

  const nextList = [...unrelatedEntries, ...mergedGroup];
  await writeCatalogAtomic(config.OUTPUT_FILE, nextList);
  console.log(`SINGLE_OK:${mergedGroup[0]?.id || parsed.id}`);
}

async function run() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const config = await loadConfig();

  // Blitzschneller Einzelordner-Rescan (z. B. direkt nach Web-Download)
  if (SINGLE_TARGET) {
    await runSingleScan(config);
    return;
  }

  const LOCK_FILE = path.join(DATA_DIR, 'scan.lock');

  if (existsSync(LOCK_FILE)) {
    try {
      const lockTime = parseInt(await fs.readFile(LOCK_FILE, 'utf-8'), 10);
      if (Date.now() - lockTime > 10 * 60 * 1000) {
        await fs.unlink(LOCK_FILE);
      } else {
        console.error('LOCKED: Ein Scan läuft bereits!');
        process.exit(1);
      }
    } catch (e) {
      console.error(`LOCKED: Fehler beim Lesen der Lock-Datei! Details: ${e.message}`);
      process.exit(1);
    }
  }

  try {
    await fs.writeFile(LOCK_FILE, Date.now().toString(), 'utf-8');
    process.stdout.write(`SCAN_START:${config.ROOTS.map((r) => r.label).join(', ')}\n`);

    const startTime = Date.now();
    let oldData = [];
    if (existsSync(config.OUTPUT_FILE)) {
      try {
        oldData = JSON.parse(await fs.readFile(config.OUTPUT_FILE, 'utf-8'));
      } catch (e) {
        console.error(`Fehler beim Laden des alten Katalogs: ${e.message}`);
      }
    }

    const cacheMap = buildCacheMapFromCatalog(oldData);
    /** @type {Map<number, any[]>} */
    const scannedByRoot = new Map();
    const offlineRootIndices = [];

    if (IS_UPDATE) {
      // Nur bekannte Einträge aus erreichbaren Wurzeln aktualisieren
      for (const root of config.ROOTS) {
        if (!isDirReachable(root.absPath)) {
          console.log(`SCAN_OFFLINE:${JSON.stringify({ index: root.index, path: root.rawPath, label: root.label })}`);
          offlineRootIndices.push(root.index);
          continue;
        }
        scannedByRoot.set(root.index, []);
      }

      const seenDirs = new Set();
      for (const item of oldData) {
        const candidates = [
          { path: item.primaryPath || item.path, rootIndex: item.archiveRootIndex ?? 0 },
          ...(Array.isArray(item.alternatePaths) ? item.alternatePaths : []),
        ];
        for (const cand of candidates) {
          if (!cand?.path) continue;
          const absDir = path.resolve(APP_DIR, cand.path);
          const dKey = normalizePathKey(absDir);
          if (seenDirs.has(dKey)) continue;
          seenDirs.add(dKey);

          const root = config.ROOTS[cand.rootIndex] || resolveRootForDir(absDir, config.ROOTS);
          if (offlineRootIndices.includes(root.index)) continue;
          if (!existsSync(absDir)) continue;

          process.stdout.write(`SCAN_DIR:${absDir}\n`);
          const metaPath = path.join(absDir, META_FOLDER_NAME);
          if (existsSync(metaPath)) {
            const parsed = await parseSoftwareMetadata(absDir, metaPath, config, root);
            if (!scannedByRoot.has(root.index)) scannedByRoot.set(root.index, []);
            scannedByRoot.get(root.index).push(parsed);
          }
        }
      }
    } else {
      for (const root of config.ROOTS) {
        if (!isDirReachable(root.absPath)) {
          console.log(`SCAN_OFFLINE:${JSON.stringify({ index: root.index, path: root.rawPath, label: root.label })}`);
          offlineRootIndices.push(root.index);
          continue;
        }
        process.stdout.write(`SCAN_ROOT:${root.rawPath}\n`);
        const entries = await scanDirectory(root.absPath, cacheMap, config, root);
        scannedByRoot.set(root.index, entries);
      }
    }

    const softwareList = mergeMultiRootCatalogEntries(scannedByRoot, {
      existingEntries: oldData,
      offlineRootIndices,
      roots: config.ROOTS,
    });

    await writeCatalogAtomic(config.OUTPUT_FILE, softwareList);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Fertig! ${softwareList.length} Programme erfasst in ${duration}s.`);
  } finally {
    if (existsSync(LOCK_FILE)) {
      await fs.unlink(LOCK_FILE).catch((e) => console.error(`Konnte Lock-Datei nicht löschen: ${e.message}`));
    }
  }
}

run();
