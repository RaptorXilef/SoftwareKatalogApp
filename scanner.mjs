import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_FOLDER_NAME = '_metadata';
const IS_FULL_RESCAN = process.argv.includes('--full');
const IS_UPDATE = process.argv.includes('--update');

// Hilfsfunktion: Begrenzt gleichzeitige asynchrone Tasks, um SMB-Überlastungen zu verhindern
async function asyncPool(limit, tasks) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    executing.add(p);
    // Linter-Fix: Zuweisung entfernt, da 'clean' nicht weiter genutzt wird
    p.then(() => executing.delete(p));
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

async function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
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

  // Pfade auflösen (unterstützt absolute und relative Pfade)
  const resolvedTarget = path.isAbsolute(config.targetPath)
    ? config.targetPath
    : path.resolve(__dirname, config.targetPath);
  const resolvedJson = path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(__dirname, config.jsonPath);

  return { ...config, ROOT_DIR: resolvedTarget, OUTPUT_FILE: resolvedJson };
}

async function parseSoftwareMetadata(softwareDir, metaDir, config) {
  let customName = '',
    description = '',
    iconPath = null,
    screenshots = [];
  let os = [],
    mainCategory = '',
    subCategories = [],
    links = [],
    formats = [],
    searchNames = [],
    installPaths = [],
    autoPaths = [],
    softwareType = 'default',
    webVersionUrl = '',
    webVersionPrefix = '',
    webVersionSuffix = '',
    downloadUrl = '',
    dlPrefix = '',
    dlSuffix = '',
    webVersion = '',
    hiddenCategory = '';

  let addedAt = 0,
    updatedAt = 0;

  try {
    // Hole Erstellungs- und Änderungsdatum für Sortierung und "NEU"-Badge
    const swStat = await fs.stat(softwareDir);
    addedAt = swStat.birthtimeMs || swStat.mtimeMs;
    updatedAt = swStat.mtimeMs;

    const metaEntries = await fs.readdir(metaDir, { withFileTypes: true });

    // 1. Bilder & Videos einlesen (inkl. mp4, webm, ogg, mov, avi)
    metaEntries.forEach((entry) => {
      if (!entry.isFile()) return;
      const fullPath = path.join(metaDir, entry.name);
      const lowerName = entry.name.toLowerCase();
      if (lowerName.startsWith('icon.') && /\.(png|gif|jpg|jpeg|svg|webp|ico|avif)$/i.test(lowerName)) {
        iconPath = fullPath;
      } else if (/\.(png|gif|jpg|jpeg|svg|webp|ico|avif|mp4|webm|ogg|mov|avi)$/i.test(lowerName)) {
        screenshots.push(fullPath);
      }
    });

    // Sortierung: Bilder zuerst alphabetisch, DANN Videos alphabetisch
    screenshots.sort((a, b) => {
      const isVidA = /\.(mp4|webm|ogg|mov|avi)$/i.test(a);
      const isVidB = /\.(mp4|webm|ogg|mov|avi)$/i.test(b);
      if (isVidA !== isVidB) return isVidA ? 1 : -1; // Bilder (false) vor Videos (true)
      return a.localeCompare(b, 'de', { sensitivity: 'base' }); // Danach alphabetisch
    });

    // 2. meta.json auslesen
    const jsonPath = path.join(metaDir, 'meta.json');
    if (existsSync(jsonPath)) {
      try {
        const metaStat = await fs.stat(jsonPath);
        // Wenn Metadata neuer ist, Update-Datum anpassen
        if (metaStat.mtimeMs > updatedAt) updatedAt = metaStat.mtimeMs;

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
        if (data.softwareType) softwareType = data.softwareType;
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

        // Alternative Such-Namen auslesen
        if (data.searchNames) {
          searchNames = Array.isArray(data.searchNames)
            ? data.searchNames.filter(Boolean)
            : String(data.searchNames)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
        }

        // Lade die Liste möglicher lokaler Installationspfade
        if (data.installPaths) {
          installPaths = Array.isArray(data.installPaths)
            ? data.installPaths.filter(Boolean)
            : [data.installPaths].filter(Boolean);
        }

        if (data.autoPaths) {
          autoPaths = Array.isArray(data.autoPaths) ? data.autoPaths.filter(Boolean) : [data.autoPaths].filter(Boolean);
        }

        // Web-Variablen auslesen
        if (data.webVersionUrl) webVersionUrl = data.webVersionUrl.trim();
        if (data.webVersionPrefix) webVersionPrefix = data.webVersionPrefix;
        if (data.webVersionSuffix) webVersionSuffix = data.webVersionSuffix;
        if (data.downloadUrl) downloadUrl = data.downloadUrl.trim();
        if (data.dlPrefix) dlPrefix = data.dlPrefix;
        if (data.dlSuffix) dlSuffix = data.dlSuffix;
        if (data.webVersion) webVersion = data.webVersion.trim();

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
      const names = lEntries.filter((e) => e.isFile()).map((e) => e.name);

      // Absteigend sortieren (Z-A), damit höchste/neuste Version vorne steht (Index 0)
      // FIX: numeric: true stellt sicher, dass "v.2.10" höher gewichtet wird als "v.2.9"
      names.sort((a, b) => b.localeCompare(a, 'de', { numeric: true, sensitivity: 'base' }));
      lastFiles = names.map((e) => path.join(lastDir, e));
    } catch (e) {
      console.error(`Fehler beim Lesen des _last Ordners in ${softwareDir}: ${e.message}`);
    }
  }

  // Auto-Download Fallback, falls _last nicht existiert oder leer ist
  if (lastFiles.length === 0 && config.autoExtensions && config.autoExtensions.length > 0) {
    try {
      const rootEntries = await fs.readdir(softwareDir, { withFileTypes: true });
      const files = rootEntries.filter((e) => e.isFile()).map((e) => e.name);
      // Keine Einzeldatei-Beschränkung mehr! Wir holen uns ALLE Dateien der passenden Erweiterungen
      // und filtern sie sauber, damit sie im Dropdown-Menü der Detailansicht auswählbar werden.
      const foundFiles = [];
      // Die Reihenfolge im Array definiert die Priorität!
      for (const ext of config.autoExtensions) {
        let extLower = ext.toLowerCase().trim();
        if (extLower && !extLower.startsWith('.')) extLower = `.${extLower}`; // Punkt sicherstellen

        const matchingFiles = files.filter((f) => f.toLowerCase().endsWith(extLower));
        if (matchingFiles.length > 0) {
          // Absteigend sortieren (Z-A), damit höchste/neuste Version vorne steht
          // FIX: numeric: true stellt sicher, dass "v.2.10" höher gewichtet wird als "v.2.9"
          matchingFiles.sort((a, b) => b.localeCompare(a, 'de', { numeric: true, sensitivity: 'base' }));
          foundFiles.push(...matchingFiles);
        }
      }
      if (foundFiles.length > 0) {
        // Hinzufügen (bereits priorisiert und absteigend sortiert)
        lastFiles.push(...foundFiles.map((f) => path.join(softwareDir, f)));
      }
    } catch (e) {
      console.error(`Fehler beim Suchen nach Auto-Download in ${softwareDir}: ${e.message}`);
    }
  }

  // Hilfsfunktion: Wandelt absolute Pfade in relative Pfade um (ausgehend vom App-Ordner)
  const toRel = (p) => (p ? path.relative(__dirname, p) : null);

  return {
    id: Buffer.from(toRel(softwareDir)).toString('base64url'),
    name: customName || path.basename(softwareDir),
    path: toRel(softwareDir),
    // Relativ speichern
    description,
    icon: toRel(iconPath),
    screenshots: screenshots.map(toRel),
    os,
    mainCategory,
    subCategories,
    lastFiles: lastFiles.map(toRel),
    searchNames,
    installPaths,
    autoPaths,
    softwareType,
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
          : await parseSoftwareMetadata(currentDir, path.join(currentDir, metaEntry.name), config);

      let results = [currentItem];

      // Optional eine Ebene tiefer suchen, obwohl schon _metadata gefunden wurde
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
        // Concurrency-Limit von 8 Workers für NAS-Schonung
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

async function run() {
  const config = await loadConfig();

  // LOCK-MECHANISMUS
  const LOCK_FILE = path.join(__dirname, 'scan.lock');

  if (existsSync(LOCK_FILE)) {
    try {
      const lockTime = parseInt(await fs.readFile(LOCK_FILE, 'utf-8'), 10);
      // Timeout nach 10 Minuten, um verwaiste Locks (z.B. durch Absturz) aufzulösen
      if (Date.now() - lockTime > 10 * 60 * 1000) {
        console.error('Veraltete Lock-Datei gefunden. Wird überschrieben.');
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
      // Update-Modus liest nur bekannte Ordner neu ein, kriecht nicht durchs Filesystem
      for (const [absPath, _oldItem] of cacheMap.entries()) {
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

    softwareList.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));

    // Atomares Schreiben: Erst .tmp anlegen, dann atomar umbenennen
    // Dadurch wird verhindert, dass andere NAS-Nutzer eine halb fertige JSON-Datei auslesen
    const tmpFile = `${config.OUTPUT_FILE}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(softwareList, null, 2), 'utf-8');
    await fs.rename(tmpFile, config.OUTPUT_FILE);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Fertig! ${softwareList.length} Programme erfasst in ${duration}s.`);
  } finally {
    // Lock entfernen, egal ob Erfolg oder Fehler
    if (existsSync(LOCK_FILE))
      await fs.unlink(LOCK_FILE).catch((e) => console.error(`Konnte Lock-Datei nicht löschen: ${e.message}`));
  }
}

run();
