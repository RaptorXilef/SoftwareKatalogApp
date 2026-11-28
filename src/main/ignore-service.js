import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';
import {
  buildExportIgnoredUpdatesPayload,
  mergeIgnoredUpdates,
  mergeScopedIgnoredUpdates,
  normalizeIgnoreEntry,
  normalizeIgnoreScope,
  removeIgnoredUpdateEntry,
  upsertIgnoredUpdate,
  validateImportIgnoredUpdatesPayload,
} from '../shared/ignore-logic.js';
import { getAuthStatus } from './auth-service.js';
import { getDataFolder, getUserDataFolder } from './config.js';

const IGNORED_FILENAME = 'ignored-updates.json';
let writeSeq = 0;

function getAdminIgnoredFilePath() {
  return path.join(getDataFolder(), IGNORED_FILENAME);
}

function getUserIgnoredFilePath() {
  return path.join(getUserDataFolder(), IGNORED_FILENAME);
}

function areScopePathsIdentical() {
  return path.resolve(getAdminIgnoredFilePath()) === path.resolve(getUserIgnoredFilePath());
}

function canManageAdminIgnored() {
  try {
    const status = getAuthStatus();
    return !status?.enabled || Boolean(status?.isAuthenticated);
  } catch {
    return true;
  }
}

function writeIgnoredAtomic(filePath, entries) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;
  const payload = JSON.stringify(entries, null, 2);
  try {
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    try {
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.writeFileSync(filePath, payload, 'utf-8');
    }
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

function readIgnoredFile(filePath, scope) {
  if (!filePath || !fs.existsSync(filePath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
    return list.map((entry) => normalizeIgnoreEntry({ ...entry, scope }, { defaultScope: scope })).filter(Boolean);
  } catch (e) {
    console.error(`Fehler beim Lesen von ${filePath}:`, e);
    return [];
  }
}

function loadScopedSnapshot() {
  const adminEntries = readIgnoredFile(getAdminIgnoredFilePath(), 'admin');
  const userEntries = areScopePathsIdentical() ? [] : readIgnoredFile(getUserIgnoredFilePath(), 'user');
  const entries = mergeScopedIgnoredUpdates(adminEntries, userEntries);
  return {
    entries,
    userEntries,
    adminEntries,
    canManageAdmin: canManageAdminIgnored(),
  };
}

export function loadIgnoredUpdates() {
  try {
    return { success: true, ...loadScopedSnapshot() };
  } catch (e) {
    return {
      success: false,
      entries: [],
      userEntries: [],
      adminEntries: [],
      canManageAdmin: canManageAdminIgnored(),
      error: e.message,
    };
  }
}

export function addIgnoredUpdate(entryInput) {
  try {
    const targetScope = normalizeIgnoreScope(entryInput?.scope);
    if (targetScope === 'admin' && !canManageAdminIgnored()) {
      return {
        success: false,
        authRequired: true,
        error: 'Admin-Anmeldung erforderlich, um globale Ignorier-Regeln für alle Nutzer festzulegen.',
      };
    }

    const filePath = targetScope === 'admin' ? getAdminIgnoredFilePath() : getUserIgnoredFilePath();
    const existing = readIgnoredFile(filePath, targetScope);
    const res = upsertIgnoredUpdate(
      existing,
      { ...entryInput, scope: targetScope },
      {
        defaultScope: targetScope,
        generateId: () => crypto.randomUUID(),
      }
    );
    if (!res.success) {
      return { success: false, error: res.error };
    }

    writeIgnoredAtomic(filePath, res.entries);
    return { success: true, entry: res.entry, ...loadScopedSnapshot() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function removeIgnoredUpdate(entryId, opts = {}) {
  try {
    const cleanId = String(entryId || '').trim();
    if (!cleanId) {
      return { success: false, error: 'Keine Eintrags-ID angegeben.' };
    }

    const requestedScope = opts?.scope === 'admin' ? 'admin' : opts?.scope === 'user' ? 'user' : '';

    if (requestedScope !== 'admin' && !areScopePathsIdentical()) {
      const userPath = getUserIgnoredFilePath();
      const userEntries = readIgnoredFile(userPath, 'user');
      const userRes = removeIgnoredUpdateEntry(userEntries, cleanId);
      if (userRes.removed) {
        writeIgnoredAtomic(userPath, userRes.entries);
        return { success: true, ...loadScopedSnapshot() };
      }
    }

    if (requestedScope !== 'user') {
      const adminPath = getAdminIgnoredFilePath();
      const adminEntries = readIgnoredFile(adminPath, 'admin');
      const adminRes = removeIgnoredUpdateEntry(adminEntries, cleanId);
      if (adminRes.removed) {
        if (!canManageAdminIgnored()) {
          return {
            success: false,
            authRequired: true,
            error: 'Diese Regel wurde global vom Administrator festgelegt und erfordert eine Admin-Anmeldung.',
          };
        }
        writeIgnoredAtomic(adminPath, adminRes.entries);
        return { success: true, ...loadScopedSnapshot() };
      }
    }

    return { success: false, error: 'Ignorier-Eintrag nicht gefunden.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function setIgnoredUpdateScope(entryId, targetScopeRaw) {
  try {
    const cleanId = String(entryId || '').trim();
    const targetScope = normalizeIgnoreScope(targetScopeRaw);
    if (!cleanId) {
      return { success: false, error: 'Keine Eintrags-ID angegeben.' };
    }
    if (!canManageAdminIgnored()) {
      return {
        success: false,
        authRequired: true,
        error: 'Admin-Anmeldung erforderlich, um Regeln zwischen Persönlich und Global zu verschieben.',
      };
    }
    if (areScopePathsIdentical()) {
      return { success: true, ...loadScopedSnapshot() };
    }

    const sourceScope = targetScope === 'admin' ? 'user' : 'admin';
    const sourcePath = sourceScope === 'admin' ? getAdminIgnoredFilePath() : getUserIgnoredFilePath();
    const destPath = targetScope === 'admin' ? getAdminIgnoredFilePath() : getUserIgnoredFilePath();

    const sourceEntries = readIgnoredFile(sourcePath, sourceScope);
    const found = sourceEntries.find((e) => e.id === cleanId || e.packageKey.toLowerCase() === cleanId.toLowerCase());
    if (!found) {
      return { success: false, error: 'Ignorier-Eintrag nicht gefunden.' };
    }

    const removedRes = removeIgnoredUpdateEntry(sourceEntries, found.id);
    const destEntries = readIgnoredFile(destPath, targetScope);
    const upsertedRes = upsertIgnoredUpdate(
      destEntries,
      { ...found, scope: targetScope },
      {
        defaultScope: targetScope,
        generateId: () => crypto.randomUUID(),
      }
    );
    if (!upsertedRes.success) {
      return { success: false, error: upsertedRes.error };
    }

    writeIgnoredAtomic(destPath, upsertedRes.entries);
    writeIgnoredAtomic(sourcePath, removedRes.entries);
    return { success: true, entry: upsertedRes.entry, ...loadScopedSnapshot() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function clearIgnoredUpdates(opts = {}) {
  try {
    const scope = opts?.scope === 'admin' ? 'admin' : opts?.scope === 'all' ? 'all' : 'user';
    if ((scope === 'admin' || scope === 'all') && !canManageAdminIgnored()) {
      return {
        success: false,
        authRequired: true,
        error: 'Admin-Anmeldung erforderlich, um globale Admin-Regeln zu entfernen.',
      };
    }

    if (scope === 'user' || scope === 'all') {
      if (!areScopePathsIdentical()) {
        writeIgnoredAtomic(getUserIgnoredFilePath(), []);
      }
    }
    if (scope === 'admin' || scope === 'all') {
      writeIgnoredAtomic(getAdminIgnoredFilePath(), []);
    }

    return { success: true, ...loadScopedSnapshot() };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function exportIgnoredUpdates(opts = {}) {
  try {
    const scope = opts?.scope === 'admin' ? 'admin' : opts?.scope === 'user' ? 'user' : 'all';
    const snap = loadScopedSnapshot();
    const entries = scope === 'admin' ? snap.adminEntries : scope === 'user' ? snap.userEntries : snap.entries;

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
    const targetScope = normalizeIgnoreScope(opts?.scope);
    if (targetScope === 'admin' && !canManageAdminIgnored()) {
      return {
        success: false,
        authRequired: true,
        error: 'Admin-Anmeldung erforderlich, um Regeln in die globale Admin-Liste zu importieren.',
      };
    }

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

    const targetPath = targetScope === 'admin' ? getAdminIgnoredFilePath() : getUserIgnoredFilePath();
    const existing = readIgnoredFile(targetPath, targetScope);
    const merged = mergeIgnoredUpdates(existing, validation.entries, {
      mode,
      defaultScope: targetScope,
      generateId: () => crypto.randomUUID(),
    });

    writeIgnoredAtomic(targetPath, merged.entries);
    return {
      success: true,
      mode,
      scope: targetScope,
      added: merged.added,
      updated: merged.updated,
      skipped: merged.skipped,
      importedCount: merged.added + merged.updated,
      ...loadScopedSnapshot(),
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
