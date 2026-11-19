import fs from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';
import { getConfig, isInsideTargetDir, saveConfig } from './config.js';
import { scanSingleFolder } from './scanner-bridge.js';

export function loadCatalogWithLiveStatus() {
  const { absJsonPath, appFolder, installedVersions } = getConfig();
  if (!fs.existsSync(absJsonPath)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(absJsonPath, 'utf-8'));
    return data.map((item) => {
      const absPath = item.path ? path.resolve(appFolder, item.path) : '';
      const enriched = {
        ...item,
        path: absPath,
        icon: item.icon ? path.resolve(appFolder, item.icon) : null,
        screenshots: (item.screenshots || []).map((s) => path.resolve(appFolder, s)),
        lastFiles: (item.lastFiles || []).map((f) => path.resolve(appFolder, f)),
        isInstalled: false,
        validInstallPath: null,
        installedVersion: installedVersions?.[item.id] ?? null,
      };

      const allPaths = [...(item.autoPaths || []), ...(item.installPaths || [])];
      for (const p of allPaths) {
        if (fs.existsSync(p)) {
          enriched.isInstalled = true;
          enriched.validInstallPath = p;
          break;
        }
      }
      return enriched;
    });
  } catch (e) {
    console.error('Fehler beim Laden des Katalogs:', e);
    return [];
  }
}

export function writeCatalogAtomic(catData) {
  const { absJsonPath } = getConfig();
  const tmpFile = `${absJsonPath}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(catData, null, 2), 'utf-8');
  fs.renameSync(tmpFile, absJsonPath);
}

/**
 * Speichert eine erkannte Web-Version konsistent in meta.json UND catalog.json.
 */
export function persistWebVersion(itemId, webVersion) {
  const { absJsonPath, appFolder } = getConfig();
  if (!fs.existsSync(absJsonPath)) return false;

  const catData = JSON.parse(fs.readFileSync(absJsonPath, 'utf-8'));
  const item = catData.find((i) => i.id === itemId);
  if (!item) return false;

  item.webVersion = webVersion;
  const metaPath = path.join(appFolder, item.path, '_metadata', 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      meta.webVersion = webVersion;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
    } catch (e) {
      console.warn(`Konnte meta.json für ${item.name} nicht aktualisieren:`, e);
    }
  }

  writeCatalogAtomic(catData);
  return true;
}

export async function saveMetaJson(targetPath, data) {
  try {
    const resolvedTarget = path.normalize(targetPath);
    if (!isInsideTargetDir(resolvedTarget)) {
      throw new Error('Sicherheitsverletzung: Speicherpfad liegt außerhalb des Software-Verzeichnisses.');
    }

    const metaDir = path.join(resolvedTarget, '_metadata');
    if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });

    const metaFile = path.join(metaDir, 'meta.json');
    fs.writeFileSync(metaFile, JSON.stringify(data, null, 2), 'utf-8');

    // Einzelordner-Rescan hält catalog.json (inkl. scanMtime) sofort synchron
    const res = await scanSingleFolder(resolvedTarget);
    if (!res.success) {
      throw new Error(res.error || 'Katalog konnte nicht aktualisiert werden.');
    }
    return { success: true };
  } catch (e) {
    console.error('Fehler beim Speichern der meta.json:', e);
    return { success: false, error: e.message };
  }
}

export async function createSoftwareEntry(targetDir) {
  if (!isInsideTargetDir(targetDir)) {
    return {
      success: false,
      error: 'Sicherheitsverletzung: Ordner liegt außerhalb des konfigurierten Software-Verzeichnisses.',
    };
  }

  const metaDir = path.join(targetDir, '_metadata');
  const metaFile = path.join(metaDir, 'meta.json');

  try {
    if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
    if (!fs.existsSync(metaFile)) {
      const template = {
        name: path.basename(targetDir),
        softwareType: 'default',
        category: '',
        hiddenCategory: '',
        tags: [],
        formats: [],
        os: ['Windows 10', 'Windows 11'],
        description: '',
        installPaths: [],
        autoPaths: [],
        webSourceType: 'none',
        links: {},
      };
      fs.writeFileSync(metaFile, JSON.stringify(template, null, 2), 'utf-8');
    }

    await scanSingleFolder(targetDir);
    return { success: true, path: targetDir };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function addMediaFiles(targetPath, filePaths) {
  try {
    if (!isInsideTargetDir(targetPath)) {
      throw new Error('Zielpfad liegt außerhalb des Software-Verzeichnisses.');
    }
    const metaDir = path.join(targetPath, '_metadata');
    if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });

    for (const file of filePaths) {
      await fs.promises.copyFile(file, path.join(metaDir, path.basename(file)));
    }
    await scanSingleFolder(targetPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function addIconFile(targetPath, filePath) {
  try {
    if (!isInsideTargetDir(targetPath)) {
      throw new Error('Zielpfad liegt außerhalb des Software-Verzeichnisses.');
    }
    const metaDir = path.join(targetPath, '_metadata');
    if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });

    const existing = await fs.promises.readdir(metaDir);
    for (const f of existing) {
      if (f.toLowerCase().startsWith('icon.')) {
        await fs.promises.unlink(path.join(metaDir, f));
      }
    }

    const ext = path.extname(filePath);
    await fs.promises.copyFile(filePath, path.join(metaDir, `icon${ext}`));
    await scanSingleFolder(targetPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function deleteMediaFile(targetPath, mediaFilePath) {
  try {
    const metaDir = path.normalize(path.join(targetPath, '_metadata')) + path.sep;
    const normalizedFile = path.normalize(mediaFilePath);
    if (!isInsideTargetDir(targetPath) || !normalizedFile.startsWith(metaDir)) {
      throw new Error('Ungültiger Dateipfad.');
    }
    if (fs.existsSync(normalizedFile)) {
      await fs.promises.unlink(normalizedFile);
    }
    await scanSingleFolder(targetPath);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function resetAllPaths(type) {
  try {
    const { absJsonPath, appFolder } = getConfig();
    if (!fs.existsSync(absJsonPath)) return { success: false, error: 'Katalog nicht gefunden.' };

    const catData = JSON.parse(fs.readFileSync(absJsonPath, 'utf-8'));
    let modified = 0;

    for (const item of catData) {
      const metaPath = path.join(appFolder, item.path, '_metadata', 'meta.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (type === 'auto') {
          meta.autoPaths = [];
          item.autoPaths = [];
        } else if (type === 'manual') {
          meta.installPaths = [];
          item.installPaths = [];
        }
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
        modified++;
      }
    }

    writeCatalogAtomic(catData);
    return { success: true, count: modified };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function createBackup() {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Backup speichern',
    defaultPath: 'SoftwareKatalog_Backup.json',
    filters: [{ name: 'JSON Backup', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { success: false, canceled: true };

  try {
    const cfg = { ...getConfig() };
    delete cfg.appFolder;
    delete cfg.dataDir;
    delete cfg.statePath;
    delete cfg.absTargetPath;
    delete cfg.absJsonPath;
    delete cfg.absScriptPath;
    fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2), 'utf-8');
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function restoreBackup() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Backup wiederherstellen',
    filters: [{ name: 'JSON Backup', extensions: ['json'] }],
  });
  if (canceled || filePaths.length === 0) return { success: false, canceled: true };

  try {
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
    saveConfig(data);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}
