import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_FOLDER_NAME = '_metadata';
const IS_FULL_RESCAN = process.argv.includes('--full');
const IS_UPDATE = process.argv.includes('--update');

async function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  const config = {
    targetPath: '../software',
    jsonPath: 'catalog.json',
    scanNested: false,
    nestedDepth: 1,
  };

  if (existsSync(configPath)) {
    try {
      Object.assign(config, JSON.parse(await fs.readFile(configPath, 'utf-8')));
    } catch (e) {
      console.error(`Fehler beim Lesen der config.json: ${e.message}`);
    }
  }

  // Pfade auflösen (unterstützt absolute und relative Pfade)
  const resolvedTarget = path.isAbsolute(config.targetPath)
    ? config.targetPath
    : path.resolve(__dirname, config.targetPath);
  const resolvedJson = path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(__dirname, config.jsonPath);

  return { ...config, ROOT_DIR: resolvedTarget, OUTPUT_FILE: resolvedJson };
}

async function parseSoftwareMetadata(softwareDir, metaDir) {
  let customName = '',
    description = '',
    iconPath = null,
    screenshots = [];
  let os = [],
    mainCategory = '',
    subCategories = [],
    links = [],
    formats = [],
    hiddenCategory = '';

  try {
    const metaEntries = await fs.readdir(metaDir, { withFileTypes: true });

    // 1. Bilder einlesen (Icon und Screenshots)
    metaEntries.forEach((entry) => {
      if (!entry.isFile()) return;
      const fullPath = path.join(metaDir, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (lowerName.startsWith('icon.') && /\.(png|gif|jpg|jpeg|svg|webp|ico)$/i.test(lowerName)) iconPath = fullPath;
      else if (/\.(png|gif|jpg|jpeg|svg|webp|ico)$/i.test(lowerName)) screenshots.push(fullPath);
    });

    // 2. meta.json auslesen (falls vorhanden)
    const jsonPath = path.join(metaDir, 'meta.json');
    if (existsSync(jsonPath)) {
      try {
        const rawJson = await fs.readFile(jsonPath, 'utf-8');
        const data = JSON.parse(rawJson);

        if (data.name) customName = data.name;
        // Verbindet Arrays automatisch mit Zeilenumbrüchen (<br>), lässt normale Strings wie sie sind
        if (data.description)
          description = Array.isArray(data.description) ? data.description.join('<br>') : data.description;
        if (data.hiddenCategory) hiddenCategory = data.hiddenCategory.trim();

        // Erlaubt Arrays ["Win", "Mac"] oder Strings "Win, Mac"
        if (data.os)
          os = Array.isArray(data.os)
            ? data.os
            : String(data.os)
                .split(',')
                .map((s) => s.trim());
        if (data.category) mainCategory = data.category;
        if (data.tags)
          subCategories = Array.isArray(data.tags)
            ? data.tags
            : String(data.tags)
                .split(',')
                .map((s) => s.trim());

        // Formate parsen (Erlaubt Arrays [".mp4", ".mkv"] oder Strings ".mp4, .mkv")
        if (data.formats)
          formats = Array.isArray(data.formats)
            ? data.formats
            : String(data.formats)
                .split(',')
                .map((s) => s.trim());

        // Links parsen (Erlaubt {"Label": "URL"})
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

  // Check auf _last Ordner
  let lastFiles = [];
  const lastDir = path.join(softwareDir, '_last');
  if (existsSync(lastDir)) {
    try {
      const lEntries = await fs.readdir(lastDir, { withFileTypes: true });
      lastFiles = lEntries.filter((e) => e.isFile()).map((e) => path.join(lastDir, e.name));
    } catch (e) {
      console.error(`Fehler beim Lesen des _last Ordners in ${softwareDir}: ${e.message}`);
    }
  }

  // Hilfsfunktion: Wandelt absolute Pfade in relative Pfade um (ausgehend vom App-Ordner)
  const toRel = (p) => (p ? path.relative(__dirname, p) : null);

  return {
    id: Buffer.from(toRel(softwareDir)).toString('base64url'),
    name: customName || path.basename(softwareDir),
    path: toRel(softwareDir), // Relativ speichern
    description,
    icon: toRel(iconPath),
    screenshots: screenshots.map(toRel),
    os,
    mainCategory,
    subCategories,
    lastFiles: lastFiles.map(toRel),
    links,
    formats,
    hiddenCategory,
  };
}

async function scanDirectory(currentDir, cacheMap, config, currentDepth = 0, maxDepth = 6, nestedDepth = 0) {
  if (currentDepth > maxDepth) return [];

  // LIVE FEEDBACK: Melde jeden betretenen Ordner
  // Wichtig: Flush/direkter Write, damit Electron stdout sofort liest
  process.stdout.write(`SCAN_DIR:${currentDir}\n`);

  try {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const subDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    const metaEntry = subDirs.find((d) => d.name.toLowerCase() === META_FOLDER_NAME);

    if (metaEntry) {
      // Nutze Cache, außer bei Full-Scan
      const currentItem =
        !IS_FULL_RESCAN && cacheMap.has(currentDir)
          ? cacheMap.get(currentDir)
          : await parseSoftwareMetadata(currentDir, path.join(currentDir, metaEntry.name));

      let results = [currentItem];

      // NEU: Optional eine Ebene tiefer suchen, obwohl schon _metadata gefunden wurde
      if (config.scanNested && nestedDepth < config.nestedDepth) {
        const nestedResults = await Promise.all(
          subDirs.map((dir) =>
            scanDirectory(
              path.join(currentDir, dir.name),
              cacheMap,
              config,
              currentDepth + 1,
              maxDepth,
              nestedDepth + 1
            )
          )
        );
        results = results.concat(nestedResults.flat());
      }
      return results;
    }

    const results = await Promise.all(
      subDirs.map((dir) =>
        scanDirectory(path.join(currentDir, dir.name), cacheMap, config, currentDepth + 1, maxDepth, nestedDepth)
      )
    );
    return results.flat();
  } catch (err) {
    console.error(`Fehler beim Scannen von ${currentDir}: ${err.message}`);
    return [];
  }
}

async function run() {
  const config = await loadConfig();

  // LOCK-MECHANISMUS
  const LOCK_FILE = path.join(__dirname, 'scan.lock');

  if (existsSync(LOCK_FILE)) {
    console.error('LOCKED: Ein Scan läuft bereits!');
    process.exit(1); // Beendet das Skript sofort mit einem Fehlercode
  }

  try {
    // Lock setzen
    await fs.writeFile(LOCK_FILE, Date.now().toString(), 'utf-8');

    // Sende Start-Signal mit dem exakten Pfad an die UI
    process.stdout.write(`SCAN_START:${config.ROOT_DIR}\n`);
    const startTime = Date.now();
    const cacheMap = new Map();

    if (existsSync(config.OUTPUT_FILE)) {
      try {
        const oldData = JSON.parse(await fs.readFile(config.OUTPUT_FILE, 'utf-8'));
        oldData.forEach((item) => {
          cacheMap.set(path.resolve(__dirname, item.path), item);
        });
      } catch (e) {
        console.error(`Fehler beim Laden des alten Katalogs: ${e.message}`);
      }
    }

    let softwareList = [];

    if (IS_UPDATE) {
      // NEU: Update-Modus liest nur bekannte Ordner neu ein, kriecht nicht durchs Filesystem
      for (const [absPath, _oldItem] of cacheMap.entries()) {
        if (existsSync(absPath)) {
          process.stdout.write(`SCAN_DIR:${absPath}\n`);
          const metaPath = path.join(absPath, META_FOLDER_NAME);
          if (existsSync(metaPath)) {
            softwareList.push(await parseSoftwareMetadata(absPath, metaPath));
          }
        }
      }
    } else {
      softwareList = await scanDirectory(config.ROOT_DIR, cacheMap, config);
    }

    softwareList.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
    await fs.writeFile(config.OUTPUT_FILE, JSON.stringify(softwareList, null, 2), 'utf-8');

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Fertig! ${softwareList.length} Programme erfasst in ${duration}s.`);
  } finally {
    // Lock entfernen, egal ob Erfolg oder Fehler
    if (existsSync(LOCK_FILE))
      await fs.unlink(LOCK_FILE).catch((e) => console.error(`Konnte Lock-Datei nicht löschen: ${e.message}`));
  }
}

run();
