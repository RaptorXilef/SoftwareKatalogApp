import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { detectInstallKind, normalizeArch, resolveDataDir } from '../shared/app-update-logic.js';
import { DEFAULT_BACKGROUND_SETTINGS, normalizeBackgroundSettings } from '../shared/background-update-logic.js';
import { normalizeConfiguredLanguage } from '../shared/i18n.js';
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

const STATE_KEYS = ['lastUpdateCheck', 'favorites', 'installedVersions', 'notifiedUpdateVersions', 'scanOnStartup'];

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
  showDevTab: true,
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
  language: 'en',
  ...DEFAULT_BACKGROUND_SETTINGS,
};

const DEFAULT_STATE = {
  lastUpdateCheck: 0,
  favorites: [],
  installedVersions: {},
  notifiedUpdateVersions: {},
  scanOnStartup: true,
};

let migrationChecked = false;
let userStateMigrationChecked = false;
/** @type {{ installKind: 'installed' | 'portable-exe' | 'portable-dir', isAllUsersInstall: boolean, arch: 'x64' | 'ia32' | 'arm64', isPackaged: boolean, platform: string } | null} */
let cachedInstallInfo = null;
/** @type {string | null} */
let cachedDataDir = null;
/** @type {string | null} */
let cachedUserDataDir = null;
/** @type {string | null} */
let cachedIconCacheDir = null;

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

function getRealAppDataPath() {
  try {
    const appData = app.getPath('appData');
    const appPath = app.getAppPath();
    // In isolierten Unit-Test-Mocks liefert app.getPath('appData') oft appDir zurueck -> dann nicht das echte OS-Profil nutzen
    if (appData && (!appPath || path.resolve(appData) !== path.resolve(appPath))) {
      return appData;
    }
  } catch {
    // Ignorieren
  }
  return '';
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
 * Liefert den persistenten nutzer-/PC-spezifischen Datenordner (`%APPDATA%\SoftwareKatalog`),
 * geteilt über alle 4 Startvarianten (Dev, Portabel, ZIP, Setup).
 * @returns {string}
 */
export function getUserDataFolder() {
  if (cachedUserDataDir) {
    if (!fs.existsSync(cachedUserDataDir)) {
      try {
        fs.mkdirSync(cachedUserDataDir, { recursive: true });
      } catch {
        // Ignorieren
      }
    }
    return cachedUserDataDir;
  }

  const realAppData = getRealAppDataPath();
  const candidates = [realAppData ? path.join(realAppData, 'SoftwareKatalog') : '', app.getPath('userData')].filter(
    Boolean
  );

  for (const candidate of candidates) {
    if (canWriteDirectory(candidate)) {
      cachedUserDataDir = candidate;
      return candidate;
    }
  }

  const fallback = app.getPath('userData');
  if (!fs.existsSync(fallback)) {
    fs.mkdirSync(fallback, { recursive: true });
  }
  cachedUserDataDir = fallback;
  return fallback;
}

/**
 * Migriert eine einzelne Datei einmalig aus einem Legacy-Ordner in den persistenten User-Ordner,
 * falls sie im Ziel noch nicht existiert.
 * @param {string} fileName
 * @param {string[]} legacyDirs
 */
export function migrateUserFileFromLegacy(fileName, legacyDirs = []) {
  const userDir = getUserDataFolder();
  const targetPath = path.join(userDir, fileName);
  if (fs.existsSync(targetPath)) return;

  const resolvedUserDir = path.resolve(userDir);
  for (const legacyDir of legacyDirs) {
    if (!legacyDir || path.resolve(legacyDir) === resolvedUserDir) continue;
    const oldPath = path.join(legacyDir, fileName);
    if (!fs.existsSync(oldPath)) continue;
    try {
      fs.copyFileSync(oldPath, targetPath);
      return;
    } catch (e) {
      console.warn(`Konnte ${fileName} nicht nach ${userDir} migrieren:`, e);
    }
  }
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

function ensureUserStateMigrated() {
  if (userStateMigrationChecked) return;
  userStateMigrationChecked = true;
  migrateUserFileFromLegacy('state.json', [app.getPath('userData')]);
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
  ensureUserStateMigrated();

  const configPath = path.join(dataDir, 'config.json');
  const statePath = path.join(getUserDataFolder(), 'state.json');

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
  const showDevTab = config.showDevTab !== false;
  const startTab = normalizeStartTab(config.startTab, { showDevTab });
  const language = normalizeConfiguredLanguage(config.language);
  const defaultSortModes = normalizeDefaultSortModes(config.defaultSortModes);
  const enabledProviders = normalizeEnabledProviders(config.enabledProviders);
  const providerSettings = normalizeProviderSettings(config.providerSettings);
  const backgroundSettings = normalizeBackgroundSettings(config);
  const scanOnStartup = state.scanOnStartup !== false;
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
    scanOnStartup,
    notifiedUpdateVersions,
    archivePaths,
    targetPath,
    archiveSaveMode,
    showDevTab,
    startTab,
    language,
    defaultSortModes,
    enabledProviders,
    providerSettings,
  };
}

export function saveConfig(newSettings) {
  const dataDir = getDataFolder();
  const configPath = path.join(dataDir, 'config.json');
  const statePath = path.join(getUserDataFolder(), 'state.json');
  const current = getConfig();
  const merged = { ...current, ...newSettings };
  Object.assign(merged, normalizeBackgroundSettings(merged));
  merged.language = normalizeConfiguredLanguage(merged.language);
  merged.showDevTab = merged.showDevTab !== false;
  merged.startTab = normalizeStartTab(merged.startTab, { showDevTab: merged.showDevTab });
  merged.defaultSortModes = normalizeDefaultSortModes(merged.defaultSortModes);
  merged.scanOnStartup = merged.scanOnStartup !== false;

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

/**
 * Liefert ein dauerhaft persistentes, lokales Icon-Cache-Verzeichnis auf der PC-Festplatte
 * (`%LOCALAPPDATA%\SoftwareKatalog\icon-cache`, Fallback `%APPDATA%\SoftwareKatalog\icon-cache`).
 * @returns {string}
 */
export function getIconCacheDir() {
  if (cachedIconCacheDir) {
    if (!fs.existsSync(cachedIconCacheDir)) {
      try {
        fs.mkdirSync(cachedIconCacheDir, { recursive: true });
      } catch {
        // Ignorieren
      }
    }
    return cachedIconCacheDir;
  }

  const realAppData = getRealAppDataPath();
  const localAppData = realAppData && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : '';

  const candidates = [
    localAppData ? path.join(localAppData, 'SoftwareKatalog', 'icon-cache') : '',
    realAppData ? path.join(realAppData, 'SoftwareKatalog', 'icon-cache') : '',
    path.join(app.getPath('userData'), 'icon-cache'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (canWriteDirectory(candidate)) {
      cachedIconCacheDir = candidate;
      return candidate;
    }
  }

  const fallback = path.join(app.getPath('userData'), 'icon-cache');
  if (!fs.existsSync(fallback)) {
    fs.mkdirSync(fallback, { recursive: true });
  }
  cachedIconCacheDir = fallback;
  return fallback;
}

export function isInsideIconCacheDir(filePath) {
  if (!filePath) return false;
  if (isPathInsideBase(filePath, getIconCacheDir())) return true;
  if (isPathInsideBase(filePath, path.join(getDataFolder(), 'icon-cache'))) return true;
  const legacyDir = path.join(app.getPath('userData'), 'icon-cache');
  return isPathInsideBase(filePath, legacyDir);
}
