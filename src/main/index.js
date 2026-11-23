import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { checkAppUpdate, downloadAndInstallAppUpdate } from './app-updater.js';
import { executeArchiveCleanup, previewArchiveCleanup, setKeepAllVersions } from './archive-cleaner.js';
import { checkArchiveTargetCollision, findExistingArchiveLink, linkPackageToArchive } from './archive-linker.js';
import { applyWingetMatches, runWingetMatcherScan } from './archive-matcher.js';
import { batchDownloadArchiveUpdates, batchUpdatePackages } from './batch-updater.js';
import {
  deleteBundle,
  duplicateBundle,
  exportBundle,
  importBundle,
  loadBundles,
  runBundleInstall,
  saveBundle,
} from './bundles-service.js';
import {
  addIconFile,
  addMediaFiles,
  createBackup,
  createSoftwareEntry,
  deleteMediaFile,
  loadCatalogWithLiveStatus,
  resetAllPaths,
  restoreBackup,
  saveMetaJson,
} from './catalog-service.js';
import { getAppFolder, getConfig, saveConfig } from './config.js';
import { detectInstallerFile } from './installer-detector.js';
import { cancelJob, dismissJob, getJobsSnapshot } from './jobs.js';
import { registerMediaScheme, setupMediaProtocolHandler } from './media-protocol.js';
import {
  checkProviderAvailability,
  clearProviderCache,
  getProviderCacheStats,
  initDefaultProviders,
  installPackage,
  listProvidersInfo,
  listUpgradesAcrossProviders,
  searchAcrossProviders,
  setProviderEnabled,
  showPackage,
  uninstallPackage,
} from './providers/registry.js';
import { runArchiveScan, scanSingleFolder } from './scanner-bridge.js';
import {
  checkAllWebVersions,
  checkSingleWebSource,
  downloadWebUpdate,
  fetchChangelog,
  fetchSoftwareMetadata,
  openVisualLinkPicker,
  openVisualScraper,
  searchWinget,
} from './web-updater.js';
import {
  autoDetectAllMissingPaths,
  autoDetectPath,
  executeAndVerifyInstaller,
  extractCachedAppIcon,
  extractExeIcon,
  getInstalledApps,
  recordInnoInfFile,
  scanInstalledSoftware,
  scanLocalVersions,
  uninstallSoftware,
} from './windows-tools.js';

// SMB/NAS-Kompatibilitäts-Flags
app.setPath('userData', path.join(app.getPath('temp'), 'SoftwareKatalog_Data'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-dawn-features', 'use_dxc');
app.commandLine.appendSwitch('disable-features', 'DawnGraphiteCache');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-direct-composition');

// Muss VOR app.whenReady() registriert werden
registerMediaScheme();

let mainWindow = null;

function createWindow() {
  const windowOptions = {
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };

  const iconPath = path.join(getAppFolder(), 'build', 'icon.ico');
  if (fs.existsSync(iconPath)) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  // Navigation & System
  ipcMain.on('open-path', async (_e, folderPath) => {
    const err = await shell.openPath(folderPath);
    if (err) console.error(`Fehler beim Öffnen: ${folderPath}`, err);
  });

  ipcMain.on('open-url', (_e, url) => {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol)) {
        shell.openExternal(url);
      }
    } catch {
      console.warn('Ungültige URL blockiert:', url);
    }
  });

  // Jobs
  ipcMain.handle('get-jobs', () => getJobsSnapshot());
  ipcMain.handle('cancel-job', (_e, jobId) => cancelJob(jobId));
  ipcMain.handle('dismiss-job', (_e, jobId) => dismissJob(jobId));

  // Katalog & Scans
  ipcMain.handle('load-catalog', () => loadCatalogWithLiveStatus());
  ipcMain.handle('run-scan', (_e, mode) => runArchiveScan(mode));
  ipcMain.handle('scan-single', (_e, folderPath) => scanSingleFolder(folderPath));
  ipcMain.handle('save-meta-json', (_e, targetPath, data) => saveMetaJson(targetPath, data));

  ipcMain.handle('add-software', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Ordner der neuen Software auswählen',
      properties: ['openDirectory'],
    });
    if (canceled || filePaths.length === 0) return { success: false, canceled: true };
    return createSoftwareEntry(filePaths[0]);
  });
  ipcMain.handle('add-software-from-path', (_e, targetDir) => createSoftwareEntry(targetDir));

  // Medien
  ipcMain.handle('add-media', (_e, targetPath, filePaths) => addMediaFiles(targetPath, filePaths));
  ipcMain.handle('add-icon', (_e, targetPath, filePath) => addIconFile(targetPath, filePath));
  ipcMain.handle('delete-media', (_e, targetPath, mediaPath) => deleteMediaFile(targetPath, mediaPath));
  ipcMain.handle('extract-exe-icon', (_e, exePath, targetDir) => extractExeIcon(exePath, targetDir));

  // Lokale PC-Tools & Installation
  ipcMain.handle('scan-local-versions', (_e, opts) => scanLocalVersions(opts || {}));
  ipcMain.handle('scan-installed-software', (_e, opts) => scanInstalledSoftware(opts || {}));
  ipcMain.handle('extract-cached-app-icon', (_e, payload) => extractCachedAppIcon(payload || {}));
  ipcMain.handle('uninstall-software', (_e, payload) => uninstallSoftware(payload || {}));
  ipcMain.handle('auto-detect-path', (_e, names) => autoDetectPath(names));
  ipcMain.handle('auto-detect-all', () => autoDetectAllMissingPaths(loadCatalogWithLiveStatus()));
  ipcMain.handle('get-installed-apps', () => getInstalledApps());
  ipcMain.handle('detect-installer', (_e, payload) => detectInstallerFile(payload?.filePath, payload || {}));
  ipcMain.handle('record-inno-inf', (_e, payload) => recordInnoInfFile(payload || {}));
  ipcMain.handle('execute-installer', (_e, payload) => executeAndVerifyInstaller(payload));

  // Paket-Provider (Registry, Suche, Details, Updates, Install/Uninstall)
  ipcMain.handle('providers-list', () => listProvidersInfo());
  ipcMain.handle('providers-set-enabled', (_e, id, enabled) => setProviderEnabled(id, Boolean(enabled)));
  ipcMain.handle('providers-check-availability', (_e, id) => checkProviderAvailability(id));
  ipcMain.handle('providers-search', (_e, query, opts) => searchAcrossProviders(query, opts || {}));
  ipcMain.handle('providers-show', (_e, providerId, packageId, opts) => showPackage(providerId, packageId, opts || {}));
  ipcMain.handle('providers-list-upgrades', (_e, opts) => listUpgradesAcrossProviders(opts || {}));
  ipcMain.handle('providers-install', (_e, providerId, packageId, opts) =>
    installPackage(providerId, packageId, opts || {})
  );
  ipcMain.handle('providers-uninstall', (_e, providerId, packageId, opts) =>
    uninstallPackage(providerId, packageId, opts || {})
  );
  ipcMain.handle('providers-cache-stats', () => getProviderCacheStats());
  ipcMain.handle('providers-cache-clear', () => clearProviderCache());

  // Archiv-Linker (Aufnehmen & Verknüpfen generischer Pakete im Archiv)
  ipcMain.handle('archive-check-collision', (_e, targetDir) => checkArchiveTargetCollision(targetDir));
  ipcMain.handle('archive-find-link', (_e, packageManager, packageId) =>
    findExistingArchiveLink(packageManager, packageId)
  );
  ipcMain.handle('archive-link-package', (_e, payload) => linkPackageToArchive(payload || {}));

  // Schritt D Power-Werkzeuge (Winget-Matcher, Massenaktionen, Manueller Archiv-Aufräumer)
  ipcMain.handle('winget-matcher-scan', (_e, opts) => runWingetMatcherScan(opts || {}));
  ipcMain.handle('winget-matcher-apply', (_e, assignments) => applyWingetMatches(assignments || []));
  ipcMain.handle('batch-download-archive-updates', (_e, itemIds) => batchDownloadArchiveUpdates(itemIds));
  ipcMain.handle('batch-update-packages', (_e, tasks, opts) => batchUpdatePackages(tasks || [], opts || {}));
  ipcMain.handle('archive-cleanup-preview', (_e, opts) => previewArchiveCleanup(opts || {}));
  ipcMain.handle('archive-cleanup-set-keep', (_e, itemPath, keepAllVersions) =>
    setKeepAllVersions(itemPath, keepAllVersions)
  );
  ipcMain.handle('archive-cleanup-execute', (_e, opts) => executeArchiveCleanup(opts || {}));

  // Paketbündel (zentral in data/bundles.json)
  ipcMain.handle('bundles-load', () => loadBundles());
  ipcMain.handle('bundles-save', (_e, bundle) => saveBundle(bundle));
  ipcMain.handle('bundles-delete', (_e, bundleId) => deleteBundle(bundleId));
  ipcMain.handle('bundles-duplicate', (_e, bundleId) => duplicateBundle(bundleId));
  ipcMain.handle('bundles-export', (_e, bundleId) => exportBundle(bundleId));
  ipcMain.handle('bundles-import', () => importBundle());
  ipcMain.handle('bundles-run-install', (_e, bundleId, selectedItemIds, opts) =>
    runBundleInstall(bundleId, selectedItemIds, opts || {})
  );

  ipcMain.handle('copy-files-to-pc', async (_e, sourceFiles) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Speicherort auf diesem PC auswählen',
      properties: ['openDirectory'],
    });
    if (canceled || filePaths.length === 0) return { success: false, canceled: true };
    try {
      for (const src of sourceFiles) {
        await fs.promises.copyFile(src, path.join(filePaths[0], path.basename(src)));
      }
      return { success: true, dest: filePaths[0] };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Online-Updates (GitHub, Winget, Web-Scraper, Downloads)
  ipcMain.handle('check-web-versions', () => checkAllWebVersions());
  ipcMain.handle('check-single-web', (_e, payload) => checkSingleWebSource(payload));
  ipcMain.handle('search-winget', (_e, query) => searchWinget(query));
  ipcMain.handle('download-web-update', (_e, item, opts) => downloadWebUpdate(item, opts));
  ipcMain.handle('open-visual-scraper', (_e, url) => openVisualScraper(url));
  ipcMain.handle('open-visual-link-picker', (_e, url, knownVer) => openVisualLinkPicker(url, knownVer));

  ipcMain.handle('fetch-software-metadata', (_e, payload) => fetchSoftwareMetadata(payload));
  ipcMain.handle('fetch-changelog', (_e, item) => fetchChangelog(item));

  // Einstellungen, Backup & Reset
  ipcMain.handle('get-app-info', () => ({ version: app.getVersion() }));
  ipcMain.handle('get-settings', () => getConfig());
  ipcMain.handle('save-settings', (_e, settings) => {
    try {
      saveConfig(settings);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  ipcMain.handle('select-dir', async (_e, opts = {}) => {
    const defaultPath = opts?.defaultToArchive ? getConfig().absTargetPath : opts?.defaultPath || undefined;
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: opts?.title || 'Ordner auswählen',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0];
  });
  ipcMain.handle('select-file', async (_e, filters, returnAbsolute = false) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Datei auswählen',
      properties: ['openFile'],
      filters,
    });
    if (canceled || filePaths.length === 0) return null;
    return returnAbsolute ? filePaths[0] : path.relative(getAppFolder(), filePaths[0]);
  });

  ipcMain.handle('reset-paths', (_e, type) => resetAllPaths(type));
  ipcMain.handle('reset-local-versions', () => {
    saveConfig({ installedVersions: {} });
    return { success: true };
  });
  ipcMain.handle('create-backup', () => createBackup());
  ipcMain.handle('restore-backup', () => restoreBackup());

  // App Self-Update
  ipcMain.handle('check-app-update', () => checkAppUpdate());
  ipcMain.handle('install-app-update', (_e, url, isPortable) => downloadAndInstallAppUpdate(url, isPortable));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    initDefaultProviders();
    setupMediaProtocolHandler();
    registerIpcHandlers();
    createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
