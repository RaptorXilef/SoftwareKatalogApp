import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { hasTrayStartupArg } from '../shared/background-update-logic.js';
import { buildExportPolicyPayload, validateImportPolicyPayload } from '../shared/policy-logic.js';
import { checkAppUpdate, downloadAndInstallAppUpdate } from './app-updater.js';
import { executeArchiveCleanup, previewArchiveCleanup, setKeepAllVersions } from './archive-cleaner.js';
import { checkArchiveTargetCollision, findExistingArchiveLink, linkPackageToArchive } from './archive-linker.js';
import { applyWingetMatches, runWingetMatcherScan } from './archive-matcher.js';
import {
  checkAdminIpcAccess,
  configureAuthService,
  getAccessPolicy,
  getAuthStatus,
  initAuthService,
  lockAuthPolicyInHklm,
  loginAuth,
  logoutAuth,
  setAuthPolicyPath,
  unlockAuthPolicyInHklm,
  updateAccessPolicy,
  updateAuthConfig,
} from './auth-service.js';
import { applyAutostartSettings, getAutostartStatus } from './autostart-service.js';
import {
  configureBackgroundUpdater,
  getBackgroundUpdaterStatus,
  initBackgroundUpdater,
  reloadBackgroundUpdaterSchedule,
  runBackgroundUpdateCheck,
  setAutoUpdatePaused,
  stopBackgroundUpdater,
  toggleAutoUpdatePaused,
} from './background-updater.js';
import { batchDownloadArchiveUpdates, batchUpdatePackages } from './batch-updater.js';
import {
  deleteBundle,
  duplicateBundle,
  exportAllBundles,
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
import {
  getAppFolder,
  getConfig,
  getDataFolder,
  getInstallInfo,
  inspectArchiveRootPath,
  saveConfig,
} from './config.js';
import {
  configureElevatedHelper,
  getAdminSessionStatus,
  isAdminSessionActive,
  isProcessElevated,
  resolveDefaultWorkerPath,
  startAdminSession,
  stopAdminSession,
} from './elevated-helper.js';
import {
  addIgnoredUpdate,
  clearIgnoredUpdates,
  exportIgnoredUpdates,
  importIgnoredUpdates,
  loadIgnoredUpdates,
  removeIgnoredUpdate,
} from './ignore-service.js';
import { detectInstallerFile } from './installer-detector.js';
import { cancelJob, dismissJob, getJobsSnapshot } from './jobs.js';
import { registerMediaScheme, setupMediaProtocolHandler } from './media-protocol.js';
import { installProviderManager, uninstallProviderManager } from './providers/manager-bootstrap.js';
import { installLocalMsi, readMsiFileMetadata } from './providers/msi-provider.js';
import { useNvmVersion } from './providers/nvm-provider.js';
import {
  addProviderSource,
  checkAllProvidersAvailability,
  checkProviderAvailability,
  clearProviderCache,
  getProviderCacheStats,
  initDefaultProviders,
  installPackage,
  listProviderSources,
  listProvidersInfo,
  listUpgradesAcrossProviders,
  removeProviderSource,
  searchAcrossProviders,
  setProviderEnabled,
  showPackage,
  uninstallPackage,
} from './providers/registry.js';
import { runArchiveScan, scanSingleFolder } from './scanner-bridge.js';
import {
  destroyTrayService,
  initTrayService,
  isTrayActive,
  resolveTrayIconPath,
  updateTrayState,
} from './tray-service.js';
import { cancelAllQueue, cancelQueueItem, enqueueUpdates, getQueueState, reorderQueue } from './update-queue.js';
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

if (process.platform === 'win32') {
  app.setAppUserModelId('io.github.raptorxilef.softwarekatalogapp');
}

// Muss VOR app.whenReady() registriert werden
registerMediaScheme();

const startedInTray = hasTrayStartupArg(process.argv);
let mainWindow = null;
let isQuitting = false;
let pendingNavTab = null;

function createWindow({ showOnReady = true } = {}) {
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

  const iconPath = resolveTrayIconPath();
  if (iconPath) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    if (showOnReady && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && isTrayActive() && getConfig().minimizeToTrayOnClose === true) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow({ targetTab = null } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingNavTab = targetTab || null;
    createWindow({ showOnReady: true });
    if (pendingNavTab && mainWindow) {
      const targetWin = mainWindow;
      targetWin.webContents.once('did-finish-load', () => {
        if (pendingNavTab && !targetWin.isDestroyed()) {
          targetWin.webContents.send('navigate-tab', pendingNavTab);
          pendingNavTab = null;
        }
      });
    }
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
  if (targetTab) {
    mainWindow.webContents.send('navigate-tab', targetTab);
  }
}

function quitApp() {
  isQuitting = true;
  stopBackgroundUpdater();
  destroyTrayService();
  app.quit();
}

function handleIpc(channel, handler) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...args) => {
    const access = checkAdminIpcAccess(channel);
    if (!access.allowed) {
      return {
        success: false,
        authRequired: true,
        code: access.code || 'AUTH_REQUIRED',
        error: access.error || 'Admin-Anmeldung erforderlich.',
      };
    }
    return handler(event, ...args);
  });
}

function registerBundleIpcHandlers() {
  // Paketbündel (zentral in data/bundles.json)
  handleIpc('bundles-load', () => loadBundles());
  handleIpc('bundles-save', (_e, bundle) => saveBundle(bundle));
  handleIpc('bundles-delete', (_e, bundleId) => deleteBundle(bundleId));
  handleIpc('bundles-duplicate', (_e, bundleId) => duplicateBundle(bundleId));
  handleIpc('bundles-export', (_e, bundleId) => exportBundle(bundleId));
  handleIpc('bundles-export-all', () => exportAllBundles());
  handleIpc('bundles-import', () => importBundle());
  handleIpc('bundles-run-install', (_e, bundleId, selectedItemIds, opts) =>
    runBundleInstall(bundleId, selectedItemIds, opts || {})
  );
}

let ipcRegistered = false;

function registerIpcHandlers() {
  if (!ipcRegistered) {
    ipcRegistered = true;

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
  }

  // Jobs
  handleIpc('get-jobs', () => getJobsSnapshot());
  handleIpc('cancel-job', (_e, jobId) => cancelJob(jobId));
  handleIpc('dismiss-job', (_e, jobId) => dismissJob(jobId));

  // Update-Warteschlange (streng sequentiell)
  handleIpc('queue-enqueue', (_e, items, opts) => enqueueUpdates(items, opts || {}));
  handleIpc('queue-reorder', (_e, fromIndex, toIndex) => reorderQueue(fromIndex, toIndex));
  handleIpc('queue-cancel-item', (_e, queueId) => cancelQueueItem(queueId));
  handleIpc('queue-cancel-all', () => cancelAllQueue());
  handleIpc('queue-get-state', () => getQueueState());

  // Ignorierliste fuer Updates (zentral in data/ignored-updates.json)
  handleIpc('ignore-load', () => loadIgnoredUpdates());
  handleIpc('ignore-add', (_e, entry) => addIgnoredUpdate(entry));
  handleIpc('ignore-remove', (_e, entryId) => removeIgnoredUpdate(entryId));
  handleIpc('ignore-clear', () => clearIgnoredUpdates());
  handleIpc('ignore-export', () => exportIgnoredUpdates());
  handleIpc('ignore-import', (_e, opts) => importIgnoredUpdates(opts || {}));

  // Katalog & Scans
  handleIpc('load-catalog', () => loadCatalogWithLiveStatus());
  handleIpc('run-scan', (_e, mode) => runArchiveScan(mode));
  handleIpc('scan-single', (_e, folderPath) => scanSingleFolder(folderPath));
  handleIpc('save-meta-json', (_e, targetPath, data) => saveMetaJson(targetPath, data));

  handleIpc('add-software', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Ordner der neuen Software auswählen',
      properties: ['openDirectory'],
    });
    if (canceled || filePaths.length === 0) return { success: false, canceled: true };
    return createSoftwareEntry(filePaths[0]);
  });
  handleIpc('add-software-from-path', (_e, targetDir) => createSoftwareEntry(targetDir));

  // Medien
  handleIpc('add-media', (_e, targetPath, filePaths) => addMediaFiles(targetPath, filePaths));
  handleIpc('add-icon', (_e, targetPath, filePath) => addIconFile(targetPath, filePath));
  handleIpc('delete-media', (_e, targetPath, mediaPath) => deleteMediaFile(targetPath, mediaPath));
  handleIpc('extract-exe-icon', (_e, exePath, targetDir) => extractExeIcon(exePath, targetDir));

  // Lokale PC-Tools & Installation
  handleIpc('scan-local-versions', (_e, opts) => scanLocalVersions(opts || {}));
  handleIpc('scan-installed-software', (_e, opts) => scanInstalledSoftware(opts || {}));
  handleIpc('extract-cached-app-icon', (_e, payload) => extractCachedAppIcon(payload || {}));
  handleIpc('uninstall-software', (_e, payload) => uninstallSoftware(payload || {}));
  handleIpc('auto-detect-path', (_e, names) => autoDetectPath(names));
  handleIpc('auto-detect-all', () => autoDetectAllMissingPaths(loadCatalogWithLiveStatus()));
  handleIpc('get-installed-apps', () => getInstalledApps());
  handleIpc('detect-installer', (_e, payload) => detectInstallerFile(payload?.filePath, payload || {}));
  handleIpc('record-inno-inf', (_e, payload) => recordInnoInfFile(payload || {}));
  handleIpc('execute-installer', (_e, payload) => executeAndVerifyInstaller(payload));

  // Paket-Provider (Registry, Suche, Details, Updates, Install/Uninstall)
  handleIpc('providers-list', () => listProvidersInfo());
  handleIpc('providers-set-enabled', (_e, id, enabled) => setProviderEnabled(id, Boolean(enabled)));
  handleIpc('providers-check-availability', (_e, id) => checkProviderAvailability(id));
  handleIpc('providers-check-all-availability', () => checkAllProvidersAvailability());
  handleIpc('providers-install-manager', (_e, providerId) => installProviderManager(providerId));
  handleIpc('providers-uninstall-manager', (_e, providerId) => uninstallProviderManager(providerId));
  handleIpc('providers-search', (_e, query, opts) => searchAcrossProviders(query, opts || {}));
  handleIpc('providers-show', (_e, providerId, packageId, opts) => showPackage(providerId, packageId, opts || {}));
  handleIpc('providers-list-upgrades', (_e, opts) => listUpgradesAcrossProviders(opts || {}));
  handleIpc('providers-install', (_e, providerId, packageId, opts) =>
    installPackage(providerId, packageId, opts || {})
  );
  handleIpc('providers-uninstall', (_e, providerId, packageId, opts) =>
    uninstallPackage(providerId, packageId, opts || {})
  );
  handleIpc('providers-list-sources', (_e, providerId) => listProviderSources(providerId));
  handleIpc('providers-add-source', (_e, providerId, sourceSpec) => addProviderSource(providerId, sourceSpec || {}));
  handleIpc('providers-remove-source', (_e, providerId, sourceName) => removeProviderSource(providerId, sourceName));
  handleIpc('providers-cache-stats', () => getProviderCacheStats());
  handleIpc('providers-cache-clear', () => clearProviderCache());
  handleIpc('msi-inspect-file', (_e, filePath) => readMsiFileMetadata(filePath));
  handleIpc('msi-install-local', (_e, payload) => installLocalMsi(payload || {}));
  handleIpc('nvm-use-version', (_e, version) => useNvmVersion(version));

  // Archiv-Linker (Aufnehmen & Verknüpfen generischer Pakete im Archiv)
  handleIpc('archive-check-collision', (_e, targetDir) => checkArchiveTargetCollision(targetDir));
  handleIpc('archive-find-link', (_e, packageManager, packageId) => findExistingArchiveLink(packageManager, packageId));
  handleIpc('archive-link-package', (_e, payload) => linkPackageToArchive(payload || {}));

  // Schritt D Power-Werkzeuge (Winget-Matcher, Massenaktionen, Manueller Archiv-Aufräumer)
  handleIpc('winget-matcher-scan', (_e, opts) => runWingetMatcherScan(opts || {}));
  handleIpc('winget-matcher-apply', (_e, assignments) => applyWingetMatches(assignments || []));
  handleIpc('batch-download-archive-updates', (_e, itemIds) => batchDownloadArchiveUpdates(itemIds));
  handleIpc('batch-update-packages', (_e, tasks, opts) => batchUpdatePackages(tasks || [], opts || {}));
  handleIpc('archive-cleanup-preview', (_e, opts) => previewArchiveCleanup(opts || {}));
  handleIpc('archive-cleanup-set-keep', (_e, itemPath, keepAllVersions) =>
    setKeepAllVersions(itemPath, keepAllVersions)
  );
  handleIpc('archive-cleanup-execute', (_e, opts) => executeArchiveCleanup(opts || {}));

  registerBundleIpcHandlers();

  handleIpc('copy-files-to-pc', async (_e, sourceFiles) => {
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
  handleIpc('check-web-versions', () => checkAllWebVersions());
  handleIpc('check-single-web', (_e, payload) => checkSingleWebSource(payload));
  handleIpc('search-winget', (_e, query, opts) => searchWinget(query, opts || {}));
  handleIpc('download-web-update', (_e, item, opts) => downloadWebUpdate(item, opts));
  handleIpc('open-visual-scraper', (_e, url) => openVisualScraper(url));
  handleIpc('open-visual-link-picker', (_e, url, knownVer) => openVisualLinkPicker(url, knownVer));

  handleIpc('fetch-software-metadata', (_e, payload) => fetchSoftwareMetadata(payload));
  handleIpc('fetch-changelog', (_e, item) => fetchChangelog(item));

  // Einstellungen, Backup & Reset
  handleIpc('get-app-info', () => {
    const installInfo = getInstallInfo();
    return {
      version: app.getVersion(),
      installKind: installInfo.installKind,
      arch: installInfo.arch,
      isAllUsersInstall: installInfo.isAllUsersInstall,
      isPackaged: installInfo.isPackaged,
      dataDir: getDataFolder(),
    };
  });
  handleIpc('get-settings', () => getConfig());
  handleIpc('check-archive-path', (_e, rawPath, index = 0) => inspectArchiveRootPath(rawPath, index));
  handleIpc('save-settings', (_e, settings) => {
    try {
      saveConfig(settings);
      reloadBackgroundUpdaterSchedule();
      const bgStatus = getBackgroundUpdaterStatus();
      updateTrayState({
        updateCount: bgStatus.availableUpdateCount,
        isChecking: bgStatus.isChecking,
        autoUpdateEnabled: bgStatus.autoUpdateEnabled,
        autoUpdatePaused: bgStatus.autoUpdatePaused,
        isElevated: bgStatus.isElevated,
      });
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Autostart & Hintergrund-Updater
  handleIpc('autostart-get-status', () => getAutostartStatus());
  handleIpc('autostart-apply', (_e, payload) => applyAutostartSettings(payload || {}));
  handleIpc('background-get-status', () => getBackgroundUpdaterStatus());
  handleIpc('background-check-now', () => runBackgroundUpdateCheck({ manual: true }));
  handleIpc('background-set-auto-update-paused', (_e, paused) => setAutoUpdatePaused(Boolean(paused)));
  handleIpc('save-favorites', (_e, favorites) => {
    try {
      const cleanFavorites = Array.isArray(favorites)
        ? [...new Set(favorites.filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))]
        : [];
      saveConfig({ favorites: cleanFavorites });
      return { success: true, favorites: cleanFavorites };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  handleIpc('select-dir', async (_e, opts = {}) => {
    const defaultPath = opts?.defaultPath || (opts?.defaultToArchive ? getConfig().absTargetPath : undefined);
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: opts?.title || 'Ordner auswählen',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0];
  });
  handleIpc('select-file', async (_e, filters, returnAbsolute = false) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Datei auswählen',
      properties: ['openFile'],
      filters,
    });
    if (canceled || filePaths.length === 0) return null;
    return returnAbsolute ? filePaths[0] : path.relative(getAppFolder(), filePaths[0]);
  });

  handleIpc('reset-paths', (_e, type) => resetAllPaths(type));
  handleIpc('reset-local-versions', () => {
    saveConfig({ installedVersions: {} });
    return { success: true };
  });
  handleIpc('create-backup', () => createBackup());
  handleIpc('restore-backup', () => restoreBackup());

  // App Self-Update
  handleIpc('check-app-update', () => checkAppUpdate());
  handleIpc('install-app-update', (_e, url, installKindOrIsPortable) =>
    downloadAndInstallAppUpdate(url, installKindOrIsPortable)
  );

  // Sitzungsbasierter Admin-Ausfuehrungsmodus (Elevated Helper)
  handleIpc('admin-session-status', async () => {
    await isProcessElevated();
    return getAdminSessionStatus();
  });
  handleIpc('admin-session-start', () => startAdminSession());
  handleIpc('admin-session-stop', () => stopAdminSession());

  // Admin-Authentifizierung & Policy-Schutz
  handleIpc('auth-get-status', () => getAuthStatus());
  handleIpc('auth-login', (_e, username, password) => loginAuth(username, password));
  handleIpc('auth-logout', () => logoutAuth());
  handleIpc('auth-update-config', (_e, payload) => updateAuthConfig(payload || {}));
  handleIpc('auth-set-policy-path', (_e, policyPath, opts) => setAuthPolicyPath(policyPath, opts || {}));
  handleIpc('auth-lock-hklm', (_e, policyPath) => lockAuthPolicyInHklm(policyPath));
  handleIpc('auth-unlock-hklm', () => unlockAuthPolicyInHklm());

  // Zugriffsrichtlinien (Whitelist / Blacklist + Modus-Beschraenkung)
  handleIpc('policy-get', () => getAccessPolicy());
  handleIpc('policy-update', (_e, policy) => updateAccessPolicy(policy));
  handleIpc('policy-export', async () => {
    try {
      const current = getAccessPolicy();
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Zugriffsrichtlinien als JSON exportieren',
        defaultPath: 'SoftwareKatalog_Zugriffsrichtlinien.json',
        filters: [{ name: 'Software-Katalog Richtlinien (JSON)', extensions: ['json'] }],
      });
      if (canceled || !filePath) {
        return { success: false, canceled: true };
      }
      const payload = buildExportPolicyPayload(current.accessPolicy);
      await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
      return { success: true, filePath };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  handleIpc('policy-import', async () => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Zugriffsrichtlinien aus JSON importieren',
        properties: ['openFile'],
        filters: [{ name: 'Software-Katalog Richtlinien (JSON)', extensions: ['json'] }],
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
      const validation = validateImportPolicyPayload(parsed);
      if (!validation.valid) {
        return { success: false, error: 'error' in validation ? validation.error : 'Ungueltige Richtlinie.' };
      }
      return updateAccessPolicy(validation.accessPolicy);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  configureElevatedHelper({
    resolveWorkerPath: () =>
      resolveDefaultWorkerPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath || '',
        appPath: app.isPackaged ? getAppFolder() : app.getAppPath(),
        moduleDir: __dirname,
      }),
    onStatusChange: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('admin-session-updated', status);
        }
      }
    },
  });

  configureAuthService({
    getConfigFn: getConfig,
    saveConfigFn: saveConfig,
    getAppFolderFn: getAppFolder,
    getDataFolderFn: getDataFolder,
    onStatusChange: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('auth-status-updated', status);
        }
      }
    },
  });

  registerIpcHandlers();

  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(async () => {
    const elevated = await isProcessElevated();
    try {
      await initAuthService();
    } catch (err) {
      console.error('Fehler beim Initialisieren des Auth-Services:', err);
    }
    try {
      initDefaultProviders();
    } catch (err) {
      console.error('Fehler beim Initialisieren der Paket-Provider:', err);
    }
    try {
      setupMediaProtocolHandler();
    } catch (err) {
      console.error('Fehler beim Registrieren des catalog-media-Protokolls:', err);
    }

    const initialCfg = getConfig();
    try {
      initTrayService(
        {
          onOpenWindow: () => showMainWindow(),
          onCheckUpdatesNow: () => {
            void runBackgroundUpdateCheck({ manual: true });
          },
          onToggleAutoUpdatePaused: () => {
            toggleAutoUpdatePaused();
          },
          onQuitApp: () => quitApp(),
        },
        {
          updateCount: 0,
          isChecking: false,
          autoUpdateEnabled: Boolean(initialCfg.autoUpdateEnabled),
          autoUpdatePaused: false,
          isElevated: elevated,
        }
      );
    } catch (err) {
      console.error('Fehler beim Initialisieren des System-Trays:', err);
    }

    configureBackgroundUpdater({
      onStatusChange: (status) => {
        updateTrayState({
          updateCount: status.availableUpdateCount,
          isChecking: status.isChecking,
          autoUpdateEnabled: status.autoUpdateEnabled,
          autoUpdatePaused: status.autoUpdatePaused,
          isElevated: status.isElevated,
        });
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('background-status-updated', status);
          }
        }
      },
      onOpenUpdatesTab: () => showMainWindow({ targetTab: 'updates' }),
    });

    registerIpcHandlers();
    createWindow({ showOnReady: !startedInTray });
    void initBackgroundUpdater({ startedInTray });
  });

  let isQuittingWithHelperCleanup = false;
  app.on('before-quit', (event) => {
    isQuitting = true;
    stopBackgroundUpdater();
    destroyTrayService();
    if (isQuittingWithHelperCleanup || !isAdminSessionActive()) return;
    event.preventDefault();
    isQuittingWithHelperCleanup = true;
    stopAdminSession()
      .catch((err) => console.error('Fehler beim Beenden der Admin-Sitzung:', err))
      .finally(() => {
        app.quit();
      });
  });

  app.on('window-all-closed', () => {
    const cfg = getConfig();
    if (isTrayActive() && !isQuitting && (cfg.minimizeToTrayOnClose || cfg.backgroundCheckEnabled || startedInTray)) {
      return;
    }
    if (process.platform !== 'darwin') app.quit();
  });
}
