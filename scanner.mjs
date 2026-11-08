import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_FOLDER_NAME = '_metadata';
const IS_FULL_RESCAN = process.argv.includes('--full');

async function loadConfig() {
  let targetPath = '../software';
  let jsonPath = 'catalog.json';

  const configPath = path.join(__dirname, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
      if (config.targetPath) targetPath = config.targetPath;
      if (config.jsonPath) jsonPath = config.jsonPath;
    } catch (_e) {
      console.warn('Fehler beim Lesen der config.json, nutze Standardwerte.');
    }
  }

  // Pfade auflösen (unterstützt absolute und relative Pfade)
  const resolvedTarget = path.isAbsolute(targetPath) ? targetPath : path.resolve(__dirname, targetPath);
  const resolvedJson = path.isAbsolute(jsonPath) ? jsonPath : path.resolve(__dirname, jsonPath);

  return { ROOT_DIR: resolvedTarget, OUTPUT_FILE: resolvedJson };
}

async function parseSoftwareMetadata(softwareDir, metaDir) {
  let customName = '',
    description = '',
    iconPath = null,
    screenshots = [];
  let os = [],
    mainCategory = '',
    subCategories = [],
    links = [];

  try {
    const metaEntries = await fs.readdir(metaDir, { withFileTypes: true });
    await Promise.all(
      metaEntries.map(async (entry) => {
        if (!entry.isFile()) return;
        const fullPath = path.join(metaDir, entry.name);
        const lowerName = entry.name.toLowerCase();

        if (lowerName === 'beschreibung.txt' || lowerName === 'info.txt') {
          description = (await fs.readFile(fullPath, 'utf-8')).trim();
        } else if (lowerName === 'name.txt' || lowerName === 'titel.txt') {
          customName = (await fs.readFile(fullPath, 'utf-8')).trim();
        } else if (lowerName === 'os.txt' || lowerName === 'betriebssystem.txt') {
          const rawOS = await fs.readFile(fullPath, 'utf-8');
          os = rawOS
            .split(/[\r\n,]+/)
            .map((t) => t.trim())
            .filter(Boolean);
        } else if (lowerName === 'kategorie.txt') {
          const rawCat = await fs.readFile(fullPath, 'utf-8');
          const lines = rawCat
            .split(/[\r\n]+/)
            .map((t) => t.trim())
            .filter(Boolean);
          if (lines.length > 0) mainCategory = lines[0];
          if (lines.length > 1)
            subCategories = lines[1]
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean);
        } else if (lowerName === 'links.txt' || lowerName === 'urls.txt') {
          const rawLinks = await fs.readFile(fullPath, 'utf-8');
          links = rawLinks
            .split(/[\r\n]+/)
            .filter(Boolean)
            .map((line) => {
              const parts = line.split('|');
              if (parts.length > 1) return { label: parts[0].trim(), url: parts.slice(1).join('|').trim() };
              return { label: 'Link', url: line.trim() };
            });
        } else if (lowerName.startsWith('icon.') && /\.(png|ico|svg|jpg|webp)$/i.test(lowerName)) {
          iconPath = fullPath;
        } else if (/\.(png|jpg|jpeg|webp)$/i.test(lowerName)) {
          screenshots.push(fullPath); // Alles andere an Bildern landet hier
        }
      })
    );
  } catch (_err) {
    /* Fehler ignorieren */
  }

  // Check auf _last Ordner
  let lastFiles = [];
  const lastDir = path.join(softwareDir, '_last');
  if (existsSync(lastDir)) {
    try {
      const lEntries = await fs.readdir(lastDir, { withFileTypes: true });
      lastFiles = lEntries.filter((e) => e.isFile()).map((e) => path.join(lastDir, e.name));
    } catch (_e) {}
  }

  return {
    id: Buffer.from(softwareDir).toString('base64url'),
    name: customName || path.basename(softwareDir), // <-- Wenn customName existiert, wird der Ordnername ignoriert!
    path: softwareDir,
    description,
    icon: iconPath,
    screenshots,
    os,
    mainCategory,
    subCategories,
    lastFiles,
    links,
  };
}

async function scanDirectory(currentDir, cacheMap, currentDepth = 0, maxDepth = 4) {
  if (currentDepth > maxDepth) return [];

  // LIVE FEEDBACK: Melde jeden betretenen Ordner
  // Wichtig: Flush/direkter Write, damit Electron stdout sofort liest
  process.stdout.write(`SCAN_DIR:${currentDir}\n`);

  try {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    const subDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    const metaEntry = subDirs.find((d) => d.name.toLowerCase() === META_FOLDER_NAME);

    if (metaEntry) {
      if (!IS_FULL_RESCAN && cacheMap.has(currentDir)) return [cacheMap.get(currentDir)];
      const metaPath = path.join(currentDir, metaEntry.name);
      return [await parseSoftwareMetadata(currentDir, metaPath)];
    }
    const results = await Promise.all(
      subDirs.map((dir) => scanDirectory(path.join(currentDir, dir.name), cacheMap, currentDepth + 1, maxDepth))
    );
    return results.flat();
  } catch (_err) {
    return [];
  }
}

async function run() {
  const { ROOT_DIR, OUTPUT_FILE } = await loadConfig();

  // LOCK-MECHANISMUS HINZUGEFÜGT
  const LOCK_FILE = path.join(__dirname, 'scan.lock');
  if (existsSync(LOCK_FILE)) {
    console.error('LOCKED: Ein Scan läuft bereits!');
    process.exit(1); // Beendet das Skript sofort mit einem Fehlercode
  }

  try {
    // Lock setzen
    await fs.writeFile(LOCK_FILE, Date.now().toString(), 'utf-8');

    // Sende Start-Signal mit dem exakten Pfad an die UI
    process.stdout.write(`SCAN_START:${ROOT_DIR}\n`);
    const startTime = Date.now();
    const cacheMap = new Map();

    if (!IS_FULL_RESCAN && existsSync(OUTPUT_FILE)) {
      try {
        const oldData = JSON.parse(await fs.readFile(OUTPUT_FILE, 'utf-8'));
        oldData.forEach((item) => {
          cacheMap.set(item.path, item);
        });
      } catch (_e) {}
    }

    const softwareList = await scanDirectory(ROOT_DIR, cacheMap);
    softwareList.sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }));
    await fs.writeFile(OUTPUT_FILE, JSON.stringify(softwareList, null, 2), 'utf-8');

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Fertig! ${softwareList.length} Programme erfasst in ${duration}s.`);
  } finally {
    // Lock entfernen, egal ob Erfolg oder Fehler
    if (existsSync(LOCK_FILE)) {
      await fs.unlink(LOCK_FILE).catch(() => {});
    }
  }
}

run();
