import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

const STATE_KEYS = ['lastUpdateCheck', 'favorites', 'installedVersions'];

const DEFAULT_CONFIG = {
  targetPath: '../software',
  jsonPath: 'catalog.json',
  scriptPath: 'scanner.mjs',
  scanNested: false,
  nestedDepth: 1,
  visibleHiddenCats: [],
  updateInterval: 24,
  autoExtensions: ['.exe', '.msi', '.zip'],
  newBadgeDays: 14,
  versionCompareDepth: 3,
  // Neu: Komfortable Download- & Benennungs-Defaults
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

export function getAppFolder() {
  if (app.isPackaged) {
    return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  }
  return app.getAppPath();
}

export function getConfig() {
  const appFolder = getAppFolder();
  const configPath = path.join(appFolder, 'config.json');
  const statePath = path.join(app.getPath('userData'), 'state.json');

  const config = { ...DEFAULT_CONFIG };
  const state = { ...DEFAULT_STATE };

  if (fs.existsSync(configPath)) {
    try {
      Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf-8')));
    } catch (e) {
      console.error('Fehler beim Lesen der config.json:', e);
    }
  } else {
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
      console.error('Fehler beim Erstellen der config.json:', e);
    }
  }

  if (fs.existsSync(statePath)) {
    try {
      Object.assign(state, JSON.parse(fs.readFileSync(statePath, 'utf-8')));
    } catch (e) {
      console.error('Fehler beim Lesen der state.json:', e);
    }
  }

  const absTargetPath = path.isAbsolute(config.targetPath)
    ? config.targetPath
    : path.resolve(appFolder, config.targetPath);

  return {
    appFolder,
    statePath,
    absTargetPath,
    absJsonPath: path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(appFolder, config.jsonPath),
    absScriptPath: path.isAbsolute(config.scriptPath) ? config.scriptPath : path.resolve(appFolder, config.scriptPath),
    ...config,
    ...state,
  };
}

export function saveConfig(newSettings) {
  const appFolder = getAppFolder();
  const configPath = path.join(appFolder, 'config.json');
  const statePath = path.join(app.getPath('userData'), 'state.json');
  const merged = { ...getConfig(), ...newSettings };

  const ignoreKeys = new Set(['appFolder', 'statePath', 'absTargetPath', 'absJsonPath', 'absScriptPath']);
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
