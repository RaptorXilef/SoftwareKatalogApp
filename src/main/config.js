import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const STATE_KEYS = ['lastUpdateCheck', 'favorites', 'installedVersions'];

const DEFAULT_CONFIG = {
  targetPath: '../software',
  jsonPath: 'catalog.json',
  customScriptPath: '', // Leer = eingebauter Scanner unter src/scanner/scanner.mjs bzw. resources/
  scanNested: false,
  nestedDepth: 1,
  visibleHiddenCats: [],
  updateInterval: 24,
  autoExtensions: ['.exe', '.msi', '.zip'],
  newBadgeDays: 14,
  versionCompareDepth: 3,
  // Komfortable Download- & Benennungs-Defaults
  autoSaveDownloads: true, // Direkt im Software-Ordner speichern ohne Dialog
  askSaveDialog: false, // Optional immer "Speichern unter" öffnen
  filenamePattern: '{Name}_v{Version}{Arch}{Ext}',
  keepOriginalNameIfVersioned: true,
};

const DEFAULT_STATE = {
  lastUpdateCheck: 0,
  favorites: [],
  installedVersions: {},
};

let migrationChecked = false;

export function getAppFolder() {
  if (app.isPackaged) {
    return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  }
  return app.getAppPath();
}

export function getDataFolder() {
  const dataDir = path.join(getAppFolder(), 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

/**
 * Einmalige Migration: Verschiebt alte config.json / catalog.json aus dem
 * Hauptordner sauber nach data/, damit bestehende NAS-Setups weiterlaufen.
 */
function migrateLegacyFiles(appFolder, dataDir) {
  if (migrationChecked) return;
  migrationChecked = true;

  for (const fileName of ['config.json', 'catalog.json']) {
    const oldPath = path.join(appFolder, fileName);
    const newPath = path.join(dataDir, fileName);
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      try {
        fs.renameSync(oldPath, newPath);
      } catch (e) {
        console.warn(`Konnte ${fileName} nicht nach data/ migrieren:`, e);
      }
    }
  }
}

function getDefaultScannerPath(appFolder) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'scanner.mjs')
    : path.join(appFolder, 'src', 'scanner', 'scanner.mjs');
}

export function getConfig() {
  const appFolder = getAppFolder();
  const dataDir = getDataFolder();
  migrateLegacyFiles(appFolder, dataDir);

  const configPath = path.join(dataDir, 'config.json');
  const statePath = path.join(app.getPath('userData'), 'state.json');

  const config = { ...DEFAULT_CONFIG };
  const state = { ...DEFAULT_STATE };

  if (fs.existsSync(configPath)) {
    try {
      Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf-8')));
    } catch (e) {
      console.error('Fehler beim Lesen der data/config.json:', e);
    }
  } else {
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
      console.error('Fehler beim Erstellen der data/config.json:', e);
    }
  }

  if (fs.existsSync(statePath)) {
    try {
      Object.assign(state, JSON.parse(fs.readFileSync(statePath, 'utf-8')));
    } catch (e) {
      console.error('Fehler beim Lesen der state.json:', e);
    }
  }

  // targetPath bleibt relativ zum appFolder (z.B. ../software)
  const absTargetPath = path.isAbsolute(config.targetPath)
    ? config.targetPath
    : path.resolve(appFolder, config.targetPath);

  // jsonPath liegt standardmäßig im data/-Ordner
  const absJsonPath = path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(dataDir, config.jsonPath);

  // Eingebauter Scanner, solange kein benutzerdefinierter Pfad gesetzt ist
  const useCustomScript = config.customScriptPath && config.customScriptPath !== 'scanner.mjs';
  const absScriptPath = useCustomScript
    ? path.isAbsolute(config.customScriptPath)
      ? config.customScriptPath
      : path.resolve(appFolder, config.customScriptPath)
    : getDefaultScannerPath(appFolder);

  return {
    appFolder,
    dataDir,
    statePath,
    absTargetPath,
    absJsonPath,
    absScriptPath,
    ...config,
    ...state,
  };
}

export function saveConfig(newSettings) {
  const dataDir = getDataFolder();
  const configPath = path.join(dataDir, 'config.json');
  const statePath = path.join(app.getPath('userData'), 'state.json');
  const merged = { ...getConfig(), ...newSettings };

  const ignoreKeys = new Set([
    'appFolder',
    'dataDir',
    'statePath',
    'absTargetPath',
    'absJsonPath',
    'absScriptPath',
    'scriptPath', // Altlast aus alter config.json nicht mehr mitschleppen
  ]);
  const newState = {};
  const newConfig = {};

  for (const [key, value] of Object.entries(merged)) {
    if (ignoreKeys.has(key)) continue;
    if (STATE_KEYS.includes(key)) {
      newState[key] = value;
    } else {
      newConfig[key] = value;
    }
  }

  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf-8');
  fs.writeFileSync(statePath, JSON.stringify(newState, null, 2), 'utf-8');
}

export function isInsideTargetDir(targetPath) {
  const { absTargetPath } = getConfig();
  const ensureSlash = (p) => (p.endsWith(path.sep) ? p : p + path.sep);
  return ensureSlash(path.normalize(targetPath)).startsWith(ensureSlash(path.normalize(absTargetPath)));
}
