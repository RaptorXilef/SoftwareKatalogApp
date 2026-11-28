import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { hasTrayStartupArg } from '../shared/background-update-logic.js';
import { t } from '../shared/i18n.js';
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
  getUserDataFolder,
  inspectArchiveRootPath,
  migrateUserFileFromLegacy,
  saveConfig,
} from './config.js';
import {
  configureDevActions,
  devAuditFixProject,
  devAuditProject,
  devInstallPackage,
  devInstallPackagesBatch,
  devSearchPackages,
  devSyncProject,
  devToggleScope,
  devUninstallPackage,
  devUpdatePackage,
} from './dev-projects/dev-actions.js';
import {
  configureDevBundlesService,
  deleteDevBundle,
  duplicateDevBundle,
  exportDevBundle,
  importDevBundle,
  installDevBundleInProject,
  loadDevBundles,
  saveDevBundle,
} from './dev-projects/dev-bundles-service.js';
import { configureDevCli } from './dev-projects/dev-cli.js';
import {
  addDevProject,
  configureDevProjectsService,
  getDevProject,
  listDevProjects,
  markDevProjectScanned,
  removeDevProject,
  updateDevProject,
} from './dev-projects/dev-projects-service.js';
import { configureDevScanner, scanDevProject } from './dev-projects/dev-scanner.js';
import {
  configureElevatedHelper,
  getAdminSessionStatus,
  isAdminSessionActive,
  isProcessElevated,
  resolveDefaultWorkerPath,
  startAdminSession,
  stopAdminSession,
} from './elevated-helper.js';
import { configureI18nService, getI18nState, initI18nService, setLanguage } from './i18n-service.js';
import {
  addIgnoredUpdate,
  clearIgnoredUpdates,
  exportIgnoredUpdates,
  importIgnoredUpdates,
  loadIgnoredUpdates,
  removeIgnoredUpdate,
  setIgnoredUpdateScope,
} from './ignore-service.js';
import { loadInstalledSnapshot, saveInstalledSnapshot } from './installed-snapshot.js';
import { detectInstallerFile } from './installer-detector.js';
import { cancelJob, createJob, dismissJob, getJobsSnapshot } from './jobs.js';
import { registerMediaScheme, setupMediaProtocolHandler } from './media-protocol.js';
import { installProviderManager, uninstallProviderManager } from './providers/manager-bootstrap.js';
import { installLocalMsi, readMsiFileMetadata } from './providers/msi-provider.js';
import { useNvmVersion } from './providers/nvm-provider.js';
import {
  addProviderSource,
  checkAllProvidersAvailability,
  checkProviderAvailability,
  clearProviderCache,
  getProvider,
  getProviderCacheStats,
  initDefaultProviders,
  installPackage,
  listPackageVersions,
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
  loadAppWindowIcon,
  resolveAppIconPath,
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
  clearIconCache,
  executeAndVerifyInstaller,
  extractCachedAppIcon,
  extractExeIcon,
  getIconCacheStats,
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

const APP_USER_MODEL_ID = app.isPackaged
  ? 'io.github.raptorxilef.softwarekatalogapp'
  : 'io.github.raptorxilef.softwarekatalogapp.dev';

const startedInTray = hasTrayStartupArg(process.argv);
let mainWindow = null;
let isQuitting = false;
let pendingNavTab = null;
let pendingOpenSettings = false;

function isSettingsLockedByAuth(authStatus) {
  return Boolean(authStatus?.enabled && !authStatus?.isAuthenticated);
}

function applyWindowTaskbarIcon(win, windowIcon, iconPath) {
  if (!win || win.isDestroyed()) return;
  if (windowIcon && !windowIcon.isEmpty()) {
    win.setIcon(windowIcon);
  }
  if (process.platform === 'win32' && iconPath) {
    try {
      win.setAppDetails({
        appId: APP_USER_MODEL_ID,
        appIconPath: iconPath,
        appIconIndex: 0,
      });
    } catch {
      // Ignorieren, falls Windows-Shell-Properties nicht verfuegbar sind
    }
  }
}

function createWindow({ showOnReady = true } = {}) {
  const iconPath = resolveAppIconPath();
  const windowIcon = loadAppWindowIcon(iconPath);

  /** @type {Electron.BrowserWindowConstructorOptions} */
  const windowOptions = {
    title: t('app.title'),
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

  if (windowIcon && !windowIcon.isEmpty()) {
    windowOptions.icon = windowIcon;
  } else if (iconPath) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);
  applyWindowTaskbarIcon(mainWindow, windowIcon, iconPath);

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    if (showOnReady && mainWindow && !mainWindow.isDestroyed()) {
      applyWindowTaskbarIcon(mainWindow, windowIcon, iconPath);
      mainWindow.show();
    }
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && isTrayActive() && getConfig().minimizeToTrayOnClose !== false) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow({ targetTab = null, openSettings = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingNavTab = targetTab || null;
    pendingOpenSettings = Boolean(openSettings);
    createWindow({ showOnReady: true });
    if ((pendingNavTab || pendingOpenSettings) && mainWindow) {
      const targetWin = mainWindow;
      targetWin.webContents.once('did-finish-load', () => {
        if (targetWin.isDestroyed()) return;
        if (pendingNavTab) {
          targetWin.webContents.send('navigate-tab', pendingNavTab);
          pendingNavTab = null;
        }
        if (pendingOpenSettings) {
          targetWin.webContents.send('open-settings', 'general');
          pendingOpenSettings = false;
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
  if (openSettings) {
    mainWindow.webContents.send('open-settings', 'general');
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
        error: access.error || t('dialogs.authRequiredError'),
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

function registerDevProjectsIpcHandlers() {
  // DEV-Projekte (nutzerspezifisch in %APPDATA%\SoftwareKatalog\dev-projects.json)
  handleIpc('dev-projects-list', () => listDevProjects());
  handleIpc('dev-projects-add', (_e, payload) => addDevProject(payload || {}));
  handleIpc('dev-projects-update', (_e, projectId, patch) => updateDevProject(projectId, patch || {}));
  handleIpc('dev-projects-remove', (_e, projectId) => removeDevProject(projectId));
  handleIpc('dev-projects-scan', (_e, projectId, opts) => scanDevProject(projectId, opts || {}));
  handleIpc('dev-projects-install-package', (_e, projectId, payload, opts) =>
    devInstallPackage(projectId, payload || {}, opts || {})
  );
  handleIpc('dev-projects-update-package', (_e, projectId, payload, opts) =>
    devUpdatePackage(projectId, payload || {}, opts || {})
  );
  handleIpc('dev-projects-uninstall-package', (_e, projectId, payload, opts) =>
    devUninstallPackage(projectId, payload || {}, opts || {})
  );
  handleIpc('dev-projects-toggle-scope', (_e, projectId, payload, opts) =>
    devToggleScope(projectId, payload || {}, opts || {})
  );
  handleIpc('dev-projects-sync', (_e, projectId, manager, opts) => devSyncProject(projectId, manager, opts || {}));
  handleIpc('dev-projects-search-packages', (_e, manager, query, opts) =>
    devSearchPackages(manager, query, opts || {})
  );
  handleIpc('dev-projects-audit', (_e, projectId, opts) => devAuditProject(projectId, opts || {}));
  handleIpc('dev-projects-audit-fix', (_e, projectId, payload, opts) =>
    devAuditFixProject(projectId, payload || {}, opts || {})
  );

  // Dev-Buendel (nutzerspezifisch in %APPDATA%\SoftwareKatalog\dev-bundles.json)
  handleIpc('dev-bundles-load', () => loadDevBundles());
  handleIpc('dev-bundles-save', (_e, bundle) => saveDevBundle(bundle));
  handleIpc('dev-bundles-delete', (_e, bundleId) => deleteDevBundle(bundleId));
  handleIpc('dev-bundles-duplicate', (_e, bundleId) => duplicateDevBundle(bundleId));
  handleIpc('dev-bundles-export', (_e, bundleId) => exportDevBundle(bundleId));
  handleIpc('dev-bundles-import', () => importDevBundle());
  handleIpc('dev-bundles-install', (_e, projectId, bundleId, selectedPackageNames, opts) =>
    installDevBundleInProject(projectId, bundleId, selectedPackageNames, opts || {})
  );
}

function resolvePreferredArchiveDialogPath() {
  const cfg = getConfig();
  const candidates = [
    ...(Array.isArray(cfg.absArchivePaths) ? cfg.absArchivePaths : []),
    cfg.absTargetPath,
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        return dir;
      }
    } catch {
      // Nicht erreichbare Quelle überspringen
    }
  }
  return undefined;
}

function showOpenDialogAnchored(options) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showOpenDialog(mainWindow, options)
    : dialog.showOpenDialog(options);
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

  // Ignorierliste fuer Updates (Persoenlich in %APPDATA% + Global/Admin in data/)
  handleIpc('ignore-load', () => loadIgnoredUpdates());
  handleIpc('ignore-add', (_e, entry) => addIgnoredUpdate(entry));
  handleIpc('ignore-remove', (_e, entryId, opts) => removeIgnoredUpdate(entryId, opts || {}));
  handleIpc('ignore-set-scope', (_e, entryId, scope) => setIgnoredUpdateScope(entryId, scope));
  handleIpc('ignore-clear', (_e, opts) => clearIgnoredUpdates(opts || {}));
  handleIpc('ignore-export', (_e, opts) => exportIgnoredUpdates(opts || {}));
  handleIpc('ignore-import', (_e, opts) => importIgnoredUpdates(opts || {}));

  // Katalog & Scans
  handleIpc('load-catalog', () => loadCatalogWithLiveStatus());
  handleIpc('run-scan', (_e, mode) => runArchiveScan(mode));
  handleIpc('scan-single', (_e, folderPath) => scanSingleFolder(folderPath));
  handleIpc('save-meta-json', (_e, targetPath, data) => saveMetaJson(targetPath, data));

  handleIpc('add-software', async () => {
    const defaultPath = resolvePreferredArchiveDialogPath();
    const { canceled, filePaths } = await showOpenDialogAnchored({
      title: t('dialogs.addSoftwareTitle'),
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openDirectory', 'createDirectory'],
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
  handleIpc('scan-installed-software', async (_e, opts) => {
    const res = await scanInstalledSoftware(opts || {});
    if (res?.success && Array.isArray(res.programs)) {
      saveInstalledSnapshot(res.programs, res.scannedAt);
    }
    return res;
  });
  handleIpc('load-installed-snapshot', () => loadInstalledSnapshot());
  handleIpc('extract-cached-app-icon', (_e, payload) => extractCachedAppIcon(payload || {}));
  handleIpc('icon-cache-stats', () => getIconCacheStats());
  handleIpc('icon-cache-clear', () => clearIconCache());
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
  handleIpc('providers-list-versions', (_e, providerId, packageId, opts) =>
    listPackageVersions(providerId, packageId, opts || {})
  );
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
  registerDevProjectsIpcHandlers();

  handleIpc('copy-files-to-pc', async (_e, sourceFiles) => {
    const { canceled, filePaths } = await showOpenDialogAnchored({
      title: t('dialogs.copyFilesTitle'),
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
      const prevLanguage = getConfig().language;
      saveConfig(settings);
      const nextLanguage = getConfig().language;
      if (settings?.language !== undefined) {
        const currentI18n = getI18nState();
        if (nextLanguage !== prevLanguage || currentI18n.configuredLanguage !== nextLanguage) {
          setLanguage(nextLanguage);
        }
      }
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

  // Mehrsprachigkeit (i18n)
  handleIpc('i18n-get-state', () => getI18nState({ reload: true }));
  handleIpc('i18n-set-language', (_e, code) => setLanguage(code));

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
    let defaultPath;
    if (typeof opts?.defaultPath === 'string' && opts.defaultPath.trim()) {
      try {
        if (fs.existsSync(opts.defaultPath) && fs.statSync(opts.defaultPath).isDirectory()) {
          defaultPath = opts.defaultPath;
        }
      } catch {
        // Ignorieren
      }
    }
    if (!defaultPath && opts?.defaultToArchive) {
      defaultPath = resolvePreferredArchiveDialogPath();
    }
    const { canceled, filePaths } = await showOpenDialogAnchored({
      title: opts?.title || t('dialogs.selectDirTitle'),
      ...(defaultPath ? { defaultPath } : {}),
      properties: ['openDirectory', 'createDirectory'],
    });
    return canceled ? null : filePaths[0];
  });
  handleIpc('select-file', async (_e, filters, returnAbsolute = false) => {
    const { canceled, filePaths } = await showOpenDialogAnchored({
      title: t('dialogs.selectFileTitle'),
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
        title: t('dialogs.policyExportTitle'),
        defaultPath: 'SoftwareKatalog_Zugriffsrichtlinien.json',
        filters: [{ name: t('dialogs.policyFilterName'), extensions: ['json'] }],
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
      const { canceled, filePaths } = await showOpenDialogAnchored({
        title: t('dialogs.policyImportTitle'),
        properties: ['openFile'],
        filters: [{ name: t('dialogs.policyFilterName'), extensions: ['json'] }],
      });
      if (canceled || filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      const rawText = await fs.promises.readFile(filePaths[0], 'utf-8');
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return { success: false, error: t('dialogs.invalidJsonFile') };
      }
      const validation = validateImportPolicyPayload(parsed);
      if (!validation.valid) {
        return { success: false, error: 'error' in validation ? validation.error : t('dialogs.invalidPolicy') };
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
      updateTrayState({ settingsLocked: isSettingsLockedByAuth(status) });
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('auth-status-updated', status);
        }
      }
    },
  });

  // Einmalige Migration nutzerspezifischer DEV-Daten aus data/ nach %APPDATA%\SoftwareKatalog
  migrateUserFileFromLegacy('dev-projects.json', [getDataFolder()]);
  migrateUserFileFromLegacy('dev-bundles.json', [getDataFolder()]);

  configureDevProjectsService({ getDataFolderFn: getUserDataFolder });
  configureDevCli({ getConfigFn: getConfig });
  configureDevScanner({
    getProjectFn: getDevProject,
    markScannedFn: markDevProjectScanned,
    createJobFn: createJob,
  });
  configureDevActions({
    getProjectFn: getDevProject,
    scanProjectFn: scanDevProject,
    createJobFn: createJob,
    searchProviderFn: async (providerId, query, opts) => {
      const provider = getProvider(providerId);
      if (!provider?.search) {
        return { success: false, results: [], error: `Provider "${providerId}" unterstuetzt keine Suche.` };
      }
      return provider.search(query, opts);
    },
  });
  configureDevBundlesService({
    getDataFolderFn: getUserDataFolder,
    getProjectFn: getDevProject,
    scanProjectFn: scanDevProject,
    installPackagesBatchFn: devInstallPackagesBatch,
    createJobFn: createJob,
    showSaveDialogFn: (opts) => dialog.showSaveDialog(opts),
    showOpenDialogFn: (opts) => dialog.showOpenDialog(opts),
  });

  configureI18nService({
    onLanguageChanged: (i18nState) => {
      updateTrayState({});
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.setTitle(t('app.title'));
          win.webContents.send('language-changed', i18nState);
        }
      }
    },
  });

  registerIpcHandlers();

  app.on('second-instance', () => {
    showMainWindow();
  });

  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

  app.whenReady().then(async () => {
    try {
      initI18nService();
    } catch (err) {
      console.error('Fehler beim Initialisieren des i18n-Service:', err);
    }
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
    const initialAuthStatus = getAuthStatus({ refreshDisk: true });
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
          onOpenSettings: () => {
            const authNow = getAuthStatus({ refreshDisk: true });
            if (isSettingsLockedByAuth(authNow)) {
              updateTrayState({ settingsLocked: true });
              return;
            }
            showMainWindow({ openSettings: true });
          },
          onQuitApp: () => quitApp(),
        },
        {
          appVersion: app.getVersion(),
          updateCount: 0,
          isChecking: false,
          autoUpdateEnabled: Boolean(initialCfg.autoUpdateEnabled),
          autoUpdatePaused: false,
          isElevated: elevated,
          settingsLocked: isSettingsLockedByAuth(initialAuthStatus),
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
    if (
      isTrayActive() &&
      !isQuitting &&
      (cfg.minimizeToTrayOnClose !== false || cfg.backgroundCheckEnabled || startedInTray)
    ) {
      return;
    }
    if (process.platform !== 'darwin') app.quit();
  });
}
