import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';
import {
  buildExportIgnoredUpdatesPayload,
  mergeIgnoredUpdates,
  normalizeIgnoreEntry,
  removeIgnoredUpdateEntry,
  upsertIgnoredUpdate,
  validateImportIgnoredUpdatesPayload,
} from '../shared/ignore-logic.js';
import { getDataFolder } from './config.js';

function getIgnoredUpdatesFilePath() {
  return path.join(getDataFolder(), 'ignored-updates.json');
}

function writeIgnoredAtomic(entries) {
  const filePath = getIgnoredUpdatesFilePath();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(entries, null, 2);
  try {
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Temp-Datei konnte nicht bereinigt werden
    }
  }
}

function readIgnoredFromDisk() {
  const filePath = getIgnoredUpdatesFilePath();
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
    return list.map((entry) => normalizeIgnoreEntry(entry)).filter(Boolean);
  } catch (e) {
    console.error('Fehler beim Lesen der data/ignored-updates.json:', e);
    return [];
  }
}

export function loadIgnoredUpdates() {
  try {
    const entries = readIgnoredFromDisk();
    return { success: true, entries };
  } catch (e) {
    return { success: false, entries: [], error: e.message };
  }
}

export function addIgnoredUpdate(entryInput) {
  try {
    const entries = readIgnoredFromDisk();
    const res = upsertIgnoredUpdate(entries, entryInput, {
      generateId: () => crypto.randomUUID(),
    });
    if (!res.success) {
      return { success: false, error: res.error };
    }

    writeIgnoredAtomic(res.entries);
    return { success: true, entry: res.entry, entries: res.entries };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function removeIgnoredUpdate(entryId) {
  try {
    const cleanId = String(entryId || '').trim();
    if (!cleanId) {
      return { success: false, error: 'Keine Eintrags-ID angegeben.' };
    }

    const entries = readIgnoredFromDisk();
    const res = removeIgnoredUpdateEntry(entries, cleanId);
    if (!res.removed) {
      return { success: false, error: 'Ignorier-Eintrag nicht gefunden.' };
    }

    writeIgnoredAtomic(res.entries);
    return { success: true, entries: res.entries };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function clearIgnoredUpdates() {
  try {
    writeIgnoredAtomic([]);
    return { success: true, entries: [] };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function exportIgnoredUpdates() {
  try {
    const entries = readIgnoredFromDisk();
    if (entries.length === 0) {
      return { success: false, error: 'Es sind keine ignorierten Updates zum Exportieren vorhanden.' };
    }

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Ignorierliste als JSON exportieren',
      defaultPath: 'SoftwareKatalog_Ignorierte_Updates.json',
      filters: [{ name: 'Software-Katalog Ignorierliste (JSON)', extensions: ['json'] }],
    });
    if (canceled || !filePath) {
      return { success: false, canceled: true };
    }

    const payload = buildExportIgnoredUpdatesPayload(entries);
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return { success: true, filePath, count: entries.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function importIgnoredUpdates(opts = {}) {
  try {
    const mode = opts?.mode === 'replace' ? 'replace' : 'merge';
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Ignorierliste aus JSON importieren',
      properties: ['openFile'],
      filters: [{ name: 'Software-Katalog Ignorierliste (JSON)', extensions: ['json'] }],
    });
    if (canceled || filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const rawText = await fs.promises.readFile(filePaths[0], 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { success: false, error: 'Ungueltige JSON-Datei.' };
    }

    const validation = validateImportIgnoredUpdatesPayload(parsed);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const existing = readIgnoredFromDisk();
    const merged = mergeIgnoredUpdates(existing, validation.entries, {
      mode,
      generateId: () => crypto.randomUUID(),
    });

    writeIgnoredAtomic(merged.entries);
    return {
      success: true,
      mode,
      added: merged.added,
      updated: merged.updated,
      skipped: merged.skipped,
      importedCount: merged.added + merged.updated,
      entries: merged.entries,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
