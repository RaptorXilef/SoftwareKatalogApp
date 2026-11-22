import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { checkAppUpdate, downloadAndInstallAppUpdate } from './app-updater.js';
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
import { cancelJob, dismissJob, getJobsSnapshot } from './jobs.js';
import { registerMediaScheme, setupMediaProtocolHandler } from './media-protocol.js';
import { runArchiveScan, scanSingleFolder } from './scanner-bridge.js';
import {
  checkAllWebVersions,
  checkSingleWebSource,
  downloadWebUpdate,
  openVisualLinkPicker,
  openVisualScraper,
  searchWinget,
} from './web-updater.js';
import {
  autoDetectAllMissingPaths,
  autoDetectPath,
  executeAndVerifyInstaller,
  extractExeIcon,
  getInstalledApps,
  scanLocalVersions,
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
  ipcMain.handle('auto-detect-path', (_e, names) => autoDetectPath(names));
  ipcMain.handle('auto-detect-all', () => autoDetectAllMissingPaths(loadCatalogWithLiveStatus()));
  ipcMain.handle('get-installed-apps', () => getInstalledApps());
  ipcMain.handle('execute-installer', (_e, payload) => executeAndVerifyInstaller(payload));

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
  ipcMain.handle('select-dir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Ordner auswählen',
      properties: ['openDirectory'],
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
    setupMediaProtocolHandler();
    registerIpcHandlers();
    createWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
