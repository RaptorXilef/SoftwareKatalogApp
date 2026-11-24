import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { detectInstallKind, normalizeArch, resolveDataDir } from '../shared/app-update-logic.js';
import { DEFAULT_BACKGROUND_SETTINGS, normalizeBackgroundSettings } from '../shared/background-update-logic.js';
import {
  getArchiveRootLabel,
  isNormalizedPathInsideDir,
  normalizeArchivePaths,
  resolvePrimaryReachableRoot,
} from '../shared/multi-archive-logic.js';
import {
  DEFAULT_ENABLED_PROVIDERS,
  DEFAULT_PROVIDER_SETTINGS,
  normalizeEnabledProviders,
  normalizeProviderSettings,
} from '../shared/provider-lifecycle-logic.js';
import { DEFAULT_SORT_MODES, normalizeDefaultSortModes, normalizeStartTab } from '../shared/unified-packages.js';

const STATE_KEYS = ['lastUpdateCheck', 'favorites', 'installedVersions', 'notifiedUpdateVersions'];

const DEFAULT_CONFIG = {
  archivePaths: ['../software'],
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
  startTab: 'updates',
  defaultSortModes: { ...DEFAULT_SORT_MODES },
  // Komfortable Download- & Benennungs-Defaults
  autoSaveDownloads: true, // Direkt im Software-Ordner speichern ohne Dialog
  askSaveDialog: false, // Optional immer "Speichern unter" öffnen
  filenamePattern: '{Name}_v{Version}{Arch}{Ext}',
  keepOriginalNameIfVersioned: true,
  // Paketquellen & Archiv-Verknüpfung
  archiveSaveMode: 'ask', // 'ask' | 'auto-id' | 'none'
  enabledProviders: [...DEFAULT_ENABLED_PROVIDERS],
  providerSettings: { ...DEFAULT_PROVIDER_SETTINGS },
  // Sitzungsbasierter Admin-Ausfuehrungsmodus & Policy-Datei
  autoRequestAdminForBatch: false,
  authFilePath: '',
  ...DEFAULT_BACKGROUND_SETTINGS,
};

const DEFAULT_STATE = {
  lastUpdateCheck: 0,
  favorites: [],
  installedVersions: {},
  notifiedUpdateVersions: {},
};

let migrationChecked = false;
/** @type {{ installKind: 'installed' | 'portable-exe' | 'portable-dir', isAllUsersInstall: boolean, arch: 'x64' | 'ia32' | 'arm64', isPackaged: boolean, platform: string } | null} */
let cachedInstallInfo = null;
/** @type {string | null} */
let cachedDataDir = null;

/**
 * Echte Schreibprobe auf Verzeichnisebene (fs.accessSync W_OK ignoriert unter Windows oft NTFS-ACLs).
 * @param {string} dirPath
 * @returns {boolean}
 */
function canWriteDirectory(dirPath) {
  if (!dirPath) return false;
  const probeFile = path.join(dirPath, `.sk-write-test-${process.pid}-${Date.now()}`);
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(probeFile, '', 'utf-8');
    fs.unlinkSync(probeFile);
    return true;
  } catch {
    try {
      if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);
    } catch {
      // Ignorieren
    }
    return false;
  }
}

export function getInstallInfo() {
  if (cachedInstallInfo) return cachedInstallInfo;
  const detected = detectInstallKind({
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    env: process.env,
    platform: process.platform,
    existsSync: fs.existsSync,
    readdirSync: fs.readdirSync,
  });
  cachedInstallInfo = {
    installKind: detected.installKind,
    isAllUsersInstall: detected.isAllUsersInstall,
    arch: normalizeArch(process.arch),
    isPackaged: app.isPackaged,
    platform: process.platform,
  };
  return cachedInstallInfo;
}

export function getAppFolder() {
  if (app.isPackaged) {
    return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  }
  return app.getAppPath();
}

export function getDataFolder() {
  if (cachedDataDir) {
    if (!fs.existsSync(cachedDataDir)) {
      try {
        fs.mkdirSync(cachedDataDir, { recursive: true });
      } catch {
        // Ignorieren falls Verzeichnis zwischenzeitlich gesperrt ist
      }
    }
    return cachedDataDir;
  }

  const installInfo = getInstallInfo();
  const resolved = resolveDataDir({
    installKind: installInfo.installKind,
    isAllUsersInstall: installInfo.isAllUsersInstall,
    appFolder: getAppFolder(),
    appDataPath: app.getPath('appData'),
    programDataPath: process.env.ProgramData || '',
    platform: process.platform,
    isWritableDir: canWriteDirectory,
  });

  if (!fs.existsSync(resolved.dataDir)) {
    try {
      fs.mkdirSync(resolved.dataDir, { recursive: true });
    } catch (e) {
      console.error('Konnte data-Ordner nicht erstellen:', resolved.dataDir, e);
    }
  }
  cachedDataDir = resolved.dataDir;
  return cachedDataDir;
}

/**
 * Prüft ob ein Verzeichnis auf dem System erreichbar/vorhanden ist.
 * @param {string} absPath
 * @returns {boolean}
 */
function isArchiveRootReachable(absPath) {
  if (!absPath) return false;
  try {
    return fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Ermittelt Live-Status (absoluter Pfad, Label, Online) zu einem rohen Archiv-Pfad.
 * @param {string} rawPath
 * @param {number} [index]
 */
export function inspectArchiveRootPath(rawPath, index = 0) {
  const appFolder = getAppFolder();
  const cleanRaw = String(rawPath || '').trim();
  const absPath = cleanRaw
    ? path.isAbsolute(cleanRaw)
      ? path.normalize(cleanRaw)
      : path.resolve(appFolder, cleanRaw)
    : '';
  return {
    rawPath: cleanRaw,
    absPath,
    index,
    label: getArchiveRootLabel(cleanRaw, index),
    online: isArchiveRootReachable(absPath),
  };
}

/**
 * Einmalige Migration: Verschiebt alte config.json / catalog.json aus dem
 * Hauptordner sauber nach data/, damit bestehende Archiv-Setups weiterlaufen.
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
  if (path.resolve(dataDir) === path.resolve(appFolder, 'data')) {
    migrateLegacyFiles(appFolder, dataDir);
  }

  const configPath = path.join(dataDir, 'config.json');
  const statePath = path.join(app.getPath('userData'), 'state.json');

  /** @type {Record<string, any>} */
  const rawConfig = {};
  const config = { ...DEFAULT_CONFIG };
  const state = { ...DEFAULT_STATE };

  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      Object.assign(rawConfig, parsed);
      Object.assign(config, parsed);
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

  // Multi-Root Migration & Prioritätsnormalisierung (targetPath bleibt Alias auf archivePaths[0])
  const archivePaths = normalizeArchivePaths(rawConfig.archivePaths || rawConfig.targetPath ? rawConfig : config);
  const targetPath = archivePaths[0];
  const archiveRootsStatus = archivePaths.map((rawP, idx) => inspectArchiveRootPath(rawP, idx));
  const absArchivePaths = archiveRootsStatus.map((r) => r.absPath);
  const primaryAbsTargetPath = absArchivePaths[0];
  const absTargetPath = resolvePrimaryReachableRoot(absArchivePaths, isArchiveRootReachable) || primaryAbsTargetPath;

  // jsonPath liegt standardmäßig im data/-Ordner
  const absJsonPath = path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(dataDir, config.jsonPath);

  // Eingebauter Scanner, solange kein benutzerdefinierter Pfad gesetzt ist
  const useCustomScript = config.customScriptPath && config.customScriptPath !== 'scanner.mjs';
  const absScriptPath = useCustomScript
    ? path.isAbsolute(config.customScriptPath)
      ? config.customScriptPath
      : path.resolve(appFolder, config.customScriptPath)
    : getDefaultScannerPath(appFolder);

  const validSaveModes = new Set(['ask', 'auto-id', 'none']);
  const archiveSaveMode = validSaveModes.has(config.archiveSaveMode) ? config.archiveSaveMode : 'ask';
  const startTab = normalizeStartTab(config.startTab);
  const defaultSortModes = normalizeDefaultSortModes(config.defaultSortModes);
  const enabledProviders = normalizeEnabledProviders(config.enabledProviders);
  const providerSettings = normalizeProviderSettings(config.providerSettings);
  const backgroundSettings = normalizeBackgroundSettings(config);
  const notifiedUpdateVersions =
    state.notifiedUpdateVersions &&
    typeof state.notifiedUpdateVersions === 'object' &&
    !Array.isArray(state.notifiedUpdateVersions)
      ? state.notifiedUpdateVersions
      : {};

  return {
    appFolder,
    dataDir,
    statePath,
    absTargetPath,
    primaryAbsTargetPath,
    absArchivePaths,
    archiveRootsStatus,
    absJsonPath,
    absScriptPath,
    ...config,
    ...state,
    ...backgroundSettings,
    notifiedUpdateVersions,
    archivePaths,
    targetPath,
    archiveSaveMode,
    startTab,
    defaultSortModes,
    enabledProviders,
    providerSettings,
  };
}

export function saveConfig(newSettings) {
  const dataDir = getDataFolder();
  const configPath = path.join(dataDir, 'config.json');
  const statePath = path.join(app.getPath('userData'), 'state.json');
  const current = getConfig();
  const merged = { ...current, ...newSettings };
  Object.assign(merged, normalizeBackgroundSettings(merged));
  merged.defaultSortModes = normalizeDefaultSortModes(merged.defaultSortModes);

  if (newSettings?.enabledProviders !== undefined) {
    merged.enabledProviders = normalizeEnabledProviders(newSettings.enabledProviders);
  } else {
    merged.enabledProviders = normalizeEnabledProviders(merged.enabledProviders);
  }

  if (newSettings?.providerSettings && typeof newSettings.providerSettings === 'object') {
    merged.providerSettings = normalizeProviderSettings({
      ...current.providerSettings,
      ...newSettings.providerSettings,
    });
  } else {
    merged.providerSettings = normalizeProviderSettings(merged.providerSettings);
  }

  // Synchronisiere archivePaths und legacy Alias targetPath
  if (Array.isArray(newSettings?.archivePaths)) {
    const normalized = normalizeArchivePaths({ archivePaths: newSettings.archivePaths });
    merged.archivePaths = normalized;
    merged.targetPath = normalized[0];
  } else if (typeof newSettings?.targetPath === 'string' && newSettings.targetPath.trim()) {
    const rest = Array.isArray(current.archivePaths) ? current.archivePaths.slice(1) : [];
    const normalized = normalizeArchivePaths({ archivePaths: [newSettings.targetPath, ...rest] });
    merged.archivePaths = normalized;
    merged.targetPath = normalized[0];
  } else {
    const normalized = normalizeArchivePaths(merged);
    merged.archivePaths = normalized;
    merged.targetPath = normalized[0];
  }

  const ignoreKeys = new Set([
    'appFolder',
    'dataDir',
    'statePath',
    'absTargetPath',
    'primaryAbsTargetPath',
    'absArchivePaths',
    'archiveRootsStatus',
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

function isPathInsideBase(targetPath, baseDir) {
  if (!targetPath || !baseDir) return false;
  return isNormalizedPathInsideDir(path.resolve(targetPath), path.resolve(baseDir), {
    platform: process.platform,
  });
}

function isInsideAnyArchiveDir(targetPath) {
  if (!targetPath) return false;
  const { absArchivePaths } = getConfig();
  const resolved = path.resolve(targetPath);
  return absArchivePaths.some((rootDir) => isPathInsideBase(resolved, rootDir));
}

export function isInsideTargetDir(targetPath) {
  return isInsideAnyArchiveDir(targetPath);
}

export function getIconCacheDir() {
  const dir = path.join(app.getPath('userData'), 'icon-cache');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function isInsideIconCacheDir(filePath) {
  const cacheDir = path.join(app.getPath('userData'), 'icon-cache');
  return isPathInsideBase(filePath, cacheDir);
}
