import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function loadConfig() {
  const configPath = path.join(DATA_DIR, 'config.json');
  const config = {
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

  const resolvedTarget = path.isAbsolute(config.targetPath)
    ? config.targetPath
    : path.resolve(APP_DIR, config.targetPath);
  const resolvedJson = path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(DATA_DIR, config.jsonPath);

  return { ...config, ROOT_DIR: resolvedTarget, OUTPUT_FILE: resolvedJson };
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

async function parseSoftwareMetadata(softwareDir, metaDir, config) {
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
  let webSourceType = '';
  let wingetId = '';
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

        // Online-Update Felder (inkl. Abwärtskompatibilität)
        if (data.webSourceType) webSourceType = data.webSourceType.trim();
        if (data.wingetId) wingetId = data.wingetId.trim();
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
          if (wingetId) webSourceType = 'winget';
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

  const scanMtime = await getFolderSignature(softwareDir);
  const toRel = (p) => (p ? path.relative(APP_DIR, p) : null);

  return {
    id: Buffer.from(toRel(softwareDir)).toString('base64url'),
    name: customName || path.basename(softwareDir),
    path: toRel(softwareDir),
    description,
    icon: toRel(iconPath),
    screenshots: screenshots.map(toRel),
    os,
    mainCategory,
    subCategories,
    lastFiles: lastFiles.map(toRel),
    hasPinnedLast,
    searchNames,
    installPaths,
    autoPaths,
    softwareType,
    webSourceType: webSourceType || 'none',
    wingetId,
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

async function scanDirectory(currentDir, cacheMap, config, currentDepth = 0, maxDepth = 6, nestedDepth = 0) {
  if (currentDepth > maxDepth) return [];

  process.stdout.write(`SCAN_DIR:${currentDir}\n`);

  try {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const subDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    const metaEntry = subDirs.find((d) => d.name.toLowerCase() === META_FOLDER_NAME);

    if (metaEntry) {
      let currentItem;
      const cached = cacheMap.get(currentDir);

      if (!IS_FULL_RESCAN && cached) {
        // Smart-Check: Nur neu parsen, wenn sich Ordner, _last oder meta.json verändert haben
        const currentSig = await getFolderSignature(currentDir);
        currentItem =
          cached.scanMtime && cached.scanMtime === currentSig
            ? cached
            : await parseSoftwareMetadata(currentDir, path.join(currentDir, metaEntry.name), config);
      } else {
        currentItem = await parseSoftwareMetadata(currentDir, path.join(currentDir, metaEntry.name), config);
      }

      let results = [currentItem];

      if (config.scanNested && nestedDepth < config.nestedDepth) {
        const tasks = subDirs.map(
          (dir) => () =>
            scanDirectory(
              path.join(currentDir, dir.name),
              cacheMap,
              config,
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
        scanDirectory(path.join(currentDir, dir.name), cacheMap, config, currentDepth + 1, maxDepth, nestedDepth)
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

async function run() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const config = await loadConfig();

  // Blitzschneller Einzelordner-Rescan (z. B. direkt nach Web-Download)
  if (SINGLE_TARGET) {
    const metaDir = path.join(SINGLE_TARGET, META_FOLDER_NAME);
    let existingList = [];
    if (existsSync(config.OUTPUT_FILE)) {
      try {
        existingList = JSON.parse(await fs.readFile(config.OUTPUT_FILE, 'utf-8'));
      } catch {
        existingList = [];
      }
    }

    const relTarget = path.relative(APP_DIR, SINGLE_TARGET);
    if (existsSync(metaDir)) {
      const parsed = await parseSoftwareMetadata(SINGLE_TARGET, metaDir, config);
      const idx = existingList.findIndex((i) => i.path === relTarget || i.id === parsed.id);
      if (idx !== -1) existingList[idx] = parsed;
      else existingList.push(parsed);
      await writeCatalogAtomic(config.OUTPUT_FILE, existingList);
      console.log(`SINGLE_OK:${parsed.id}`);
    }
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
    process.stdout.write(`SCAN_START:${config.ROOT_DIR}\n`);

    const startTime = Date.now();
    const cacheMap = new Map();

    if (existsSync(config.OUTPUT_FILE)) {
      try {
        const oldData = JSON.parse(await fs.readFile(config.OUTPUT_FILE, 'utf-8'));
        for (const item of oldData) {
          cacheMap.set(path.resolve(APP_DIR, item.path), item);
        }
      } catch (e) {
        console.error(`Fehler beim Laden des alten Katalogs: ${e.message}`);
      }
    }

    let softwareList = [];

    if (IS_UPDATE) {
      for (const [absPath] of cacheMap.entries()) {
        if (existsSync(absPath)) {
          process.stdout.write(`SCAN_DIR:${absPath}\n`);
          const metaPath = path.join(absPath, META_FOLDER_NAME);
          if (existsSync(metaPath)) {
            softwareList.push(await parseSoftwareMetadata(absPath, metaPath, config));
          }
        }
      }
    } else {
      softwareList = await scanDirectory(config.ROOT_DIR, cacheMap, config);
    }

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
