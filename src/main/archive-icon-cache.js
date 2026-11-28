import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as electron from 'electron';
import { extractPngFromIcoBuffer } from '../shared/ico-logic.js';
import { getIconCacheDir } from './config.js';

const ARCHIVE_ICON_SUBDIR = 'archive';
const ARCHIVE_ICON_INDEX_FILENAME = 'archive-icon-index.json';
const MAX_ICON_DIMENSION = 128;
const MAX_CONCURRENT_JOBS = 4;

let loadedCacheDir = '';
/** @type {{ version: number, entries: Record<string, { relIcon: string, scanMtime: number, fileName: string, updatedAt: number }> }} */
let store = { version: 1, entries: {} };
let persistTimer = null;
let writeSeq = 0;

/** @type {Array<{ itemId: string, relIcon: string, absSourcePath: string, scanMtime: number }>} */
const warmQueue = [];
const queuedKeys = new Set();
let activeJobs = 0;

function getArchiveCacheDir() {
  const dir = path.join(getIconCacheDir(), ARCHIVE_ICON_SUBDIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getIndexPath(cacheDir) {
  return path.join(cacheDir, ARCHIVE_ICON_INDEX_FILENAME);
}

function ensureLoaded() {
  const cacheDir = getArchiveCacheDir();
  if (loadedCacheDir === cacheDir) return cacheDir;
  loadedCacheDir = cacheDir;
  store = { version: 1, entries: {} };

  const idxPath = getIndexPath(cacheDir);
  try {
    if (fs.existsSync(idxPath)) {
      const parsed = JSON.parse(fs.readFileSync(idxPath, 'utf-8'));
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        store = {
          version: Number(parsed.version) || 1,
          entries: { ...parsed.entries },
        };
      }
    }
  } catch {
    store = { version: 1, entries: {} };
  }
  return cacheDir;
}

function persistIndexNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const cacheDir = ensureLoaded();
  const idxPath = getIndexPath(cacheDir);
  const payload = JSON.stringify(store, null, 2);
  const tmpPath = `${idxPath}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;

  try {
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    try {
      fs.renameSync(tmpPath, idxPath);
    } catch {
      fs.writeFileSync(idxPath, payload, 'utf-8');
    }
  } catch {
    // Index-Schreibfehler nicht fatal machen
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignorieren
    }
  }
}

function schedulePersistIndex() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistIndexNow();
  }, 200);
}

function buildArchiveIconFileBase(itemId) {
  return `arch_${crypto
    .createHash('sha256')
    .update(String(itemId || ''))
    .digest('hex')
    .slice(0, 24)}`;
}

async function writeBytesAtomic(targetPath, bytes) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, bytes);
    try {
      await fs.promises.rename(tmpPath, targetPath);
    } catch {
      await fs.promises.writeFile(targetPath, bytes);
    }
  } finally {
    try {
      if (fs.existsSync(tmpPath)) await fs.promises.unlink(tmpPath);
    } catch {
      // Ignorieren
    }
  }
}

function encodeCompressedIcon(rawBuffer, ext) {
  if (ext === '.svg') {
    return { bytes: rawBuffer, ext: '.svg' };
  }

  const nativeImg = electron.nativeImage;
  if (typeof nativeImg?.createFromBuffer !== 'function') {
    return { bytes: rawBuffer, ext: ext || '.png' };
  }

  let img = null;
  if (ext === '.ico') {
    const embeddedPng = extractPngFromIcoBuffer(rawBuffer);
    if (embeddedPng) {
      img = nativeImg.createFromBuffer(embeddedPng);
    }
  }

  if (!img || img.isEmpty()) {
    img = nativeImg.createFromBuffer(rawBuffer);
  }

  if (!img || img.isEmpty()) {
    // Formate, die nativeImage nicht dekodiert (z. B. avif/webp/gif), unveraendert lokal cachen
    return { bytes: rawBuffer, ext: ext || '.png' };
  }

  const size = img.getSize();
  let processed = img;
  if (size.width > MAX_ICON_DIMENSION || size.height > MAX_ICON_DIMENSION) {
    const resizeOpts =
      size.width >= size.height
        ? { width: MAX_ICON_DIMENSION, quality: 'best' }
        : { height: MAX_ICON_DIMENSION, quality: 'best' };
    processed = img.resize(/** @type {Electron.ResizeOptions} */ (resizeOpts));
  }

  const pngBytes = processed.toPNG();
  if (pngBytes.length > 0) {
    // Wenn das Original nicht groesser als 128px war und kleiner als das re-encodete PNG ist, Original behalten
    const wasOversized = size.width > MAX_ICON_DIMENSION || size.height > MAX_ICON_DIMENSION;
    if (!wasOversized && rawBuffer.length < pngBytes.length && ext !== '.ico') {
      return { bytes: rawBuffer, ext };
    }
    return { bytes: pngBytes, ext: '.png' };
  }

  return { bytes: rawBuffer, ext: ext || '.png' };
}

async function processSingleArchiveIcon(task) {
  const { itemId, relIcon, absSourcePath, scanMtime } = task;
  if (!itemId || !absSourcePath) return;

  try {
    if (!fs.existsSync(absSourcePath)) return;
    const rawBuffer = await fs.promises.readFile(absSourcePath);
    if (!rawBuffer || rawBuffer.length === 0) return;

    const srcExt = path.extname(absSourcePath).toLowerCase();
    const encoded = encodeCompressedIcon(rawBuffer, srcExt);
    if (!encoded?.bytes || encoded.bytes.length === 0) return;

    const cacheDir = ensureLoaded();
    const fileName = `${buildArchiveIconFileBase(itemId)}${encoded.ext}`;
    const targetPath = path.join(cacheDir, fileName);

    const prevEntry = store.entries[itemId];
    if (prevEntry?.fileName && prevEntry.fileName !== fileName) {
      const oldFile = path.join(cacheDir, path.basename(prevEntry.fileName));
      try {
        if (fs.existsSync(oldFile)) await fs.promises.unlink(oldFile);
      } catch {
        // Ignorieren
      }
    }

    await writeBytesAtomic(targetPath, encoded.bytes);
    store.entries[itemId] = {
      relIcon: String(relIcon || ''),
      scanMtime: Number(scanMtime) || 0,
      fileName,
      updatedAt: Date.now(),
    };
    schedulePersistIndex();
  } catch {
    // Einzelner Icon-Fehler darf den Katalog nicht blockieren
  }
}

function pumpWarmQueue() {
  while (activeJobs < MAX_CONCURRENT_JOBS && warmQueue.length > 0) {
    const task = warmQueue.shift();
    if (!task) continue;
    const dedupeKey = `${task.itemId}|${task.relIcon}|${task.scanMtime}`;
    activeJobs++;
    processSingleArchiveIcon(task).finally(() => {
      queuedKeys.delete(dedupeKey);
      activeJobs--;
      pumpWarmQueue();
    });
  }
}

/**
 * Prueft rein lokal (0 NAS-IO), ob fuer das Archiv-Icon ein gueltiges verkleinertes Thumbnail existiert.
 * @param {{ itemId: string, relIcon: string, scanMtime?: number }} params
 * @returns {string | null}
 */
export function lookupCachedArchiveIcon({ itemId, relIcon, scanMtime = 0 }) {
  if (!itemId || !relIcon) return null;
  const cacheDir = ensureLoaded();
  const entry = store.entries[itemId];
  if (!entry?.fileName) return null;

  const expectedMtime = Number(scanMtime) || 0;
  if (entry.relIcon !== String(relIcon) || Number(entry.scanMtime || 0) !== expectedMtime) {
    return null;
  }

  const localPath = path.join(cacheDir, path.basename(entry.fileName));
  try {
    if (!fs.existsSync(localPath)) return null;
    const st = fs.statSync(localPath);
    if (!st.isFile() || st.size <= 0) return null;
    return localPath;
  } catch {
    return null;
  }
}

/**
 * Reiht ein noch nicht lokal gecachtes Archiv-Icon zur gedrosselten Hintergrund-Verkleinerung ein.
 * @param {{ itemId: string, relIcon: string, absSourcePath: string, scanMtime?: number }} task
 */
export function queueArchiveIconWarm({ itemId, relIcon, absSourcePath, scanMtime = 0 }) {
  if (!itemId || !relIcon || !absSourcePath) return;
  const mtime = Number(scanMtime) || 0;
  const dedupeKey = `${itemId}|${relIcon}|${mtime}`;
  if (queuedKeys.has(dedupeKey)) return;
  queuedKeys.add(dedupeKey);
  warmQueue.push({ itemId, relIcon, absSourcePath, scanMtime: mtime });
  pumpWarmQueue();
}

/**
 * Invalidiert gezielt das gecachte Archiv-Icon fuer eine Software (z. B. nach addIcon / extractExeIcon).
 * @param {string} targetPathOrItemId
 */
export function invalidateArchiveIcon(targetPathOrItemId) {
  if (!targetPathOrItemId) return;
  const cacheDir = ensureLoaded();
  const needle = String(targetPathOrItemId).trim();
  const needleLower = needle.toLowerCase();
  let dirty = false;

  for (const [id, entry] of Object.entries(store.entries)) {
    const matchById = id === needle;
    const matchByPath =
      entry?.relIcon && path.normalize(entry.relIcon).toLowerCase().includes(path.basename(needleLower));
    if (!matchById && !matchByPath) continue;

    if (entry?.fileName) {
      const filePath = path.join(cacheDir, path.basename(entry.fileName));
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // Ignorieren
      }
    }
    delete store.entries[id];
    dirty = true;
  }

  if (dirty) persistIndexNow();
}

/**
 * Leert den gesamten lokalen Archiv-Icon-Cache (z. B. bei "Alle Metadaten neu einlesen" oder Cache leeren).
 */
export function clearArchiveIconCache() {
  const cacheDir = ensureLoaded();
  warmQueue.length = 0;
  queuedKeys.clear();
  store = { version: 1, entries: {} };

  let removedFiles = 0;
  try {
    if (fs.existsSync(cacheDir)) {
      for (const item of fs.readdirSync(cacheDir, { withFileTypes: true })) {
        if (!item.isFile()) continue;
        try {
          fs.unlinkSync(path.join(cacheDir, item.name));
          if (item.name !== ARCHIVE_ICON_INDEX_FILENAME) removedFiles++;
        } catch {
          // Ignorieren
        }
      }
    }
  } catch {
    // Ignorieren
  }

  persistIndexNow();
  return { success: true, removedFiles };
}

/**
 * Liefert Groesse & Dateianzahl des lokalen Archiv-Icon-Caches fuer die Einstellungs-Statistik.
 */
export function getArchiveIconCacheStats() {
  const cacheDir = ensureLoaded();
  let fileCount = 0;
  let totalBytes = 0;
  try {
    if (fs.existsSync(cacheDir)) {
      for (const item of fs.readdirSync(cacheDir, { withFileTypes: true })) {
        if (!item.isFile()) continue;
        const st = fs.statSync(path.join(cacheDir, item.name));
        totalBytes += st.size;
        if (item.name !== ARCHIVE_ICON_INDEX_FILENAME && !item.name.endsWith('.tmp')) {
          fileCount++;
        }
      }
    }
  } catch {
    // Ignorieren
  }
  return {
    entryCount: Object.keys(store.entries).length,
    fileCount,
    totalBytes,
  };
}
