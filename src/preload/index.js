import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  // Drag & Drop Dateipfad-Auflösung (Pflicht in modernen Electron-Versionen)
  getFilePath: (file) => webUtils.getPathForFile(file),

  // Navigation
  openPath: (p) => ipcRenderer.send('open-path', p),
  openUrl: (url) => ipcRenderer.send('open-url', url),

  // Multi-Job-Manager
  getJobs: () => ipcRenderer.invoke('get-jobs'),
  cancelJob: (jobId) => ipcRenderer.invoke('cancel-job', jobId),
  dismissJob: (jobId) => ipcRenderer.invoke('dismiss-job', jobId),
  onJobsUpdated: (cb) => {
    const listener = (_event, jobs) => cb(jobs);
    ipcRenderer.on('jobs-updated', listener);
    return () => ipcRenderer.off('jobs-updated', listener);
  },

  // Sequentielle Update-Warteschlange
  enqueueUpdates: (items, opts) => ipcRenderer.invoke('queue-enqueue', items, opts),
  reorderQueue: (fromIndex, toIndex) => ipcRenderer.invoke('queue-reorder', fromIndex, toIndex),
  cancelQueueItem: (queueId) => ipcRenderer.invoke('queue-cancel-item', queueId),
  cancelAllQueue: () => ipcRenderer.invoke('queue-cancel-all'),
  getQueueState: () => ipcRenderer.invoke('queue-get-state'),
  onQueueUpdated: (cb) => {
    const listener = (_event, queueState) => cb(queueState);
    ipcRenderer.on('queue-updated', listener);
    return () => ipcRenderer.off('queue-updated', listener);
  },

  // Ignorierliste fuer Updates (Persoenlich in %APPDATA% + Admin in data/)
  loadIgnoredUpdates: () => ipcRenderer.invoke('ignore-load'),
  addIgnoredUpdate: (entry) => ipcRenderer.invoke('ignore-add', entry),
  removeIgnoredUpdate: (entryId, opts) => ipcRenderer.invoke('ignore-remove', entryId, opts),
  setIgnoredUpdateScope: (entryId, scope) => ipcRenderer.invoke('ignore-set-scope', entryId, scope),
  clearIgnoredUpdates: (opts) => ipcRenderer.invoke('ignore-clear', opts),
  exportIgnoredUpdates: (opts) => ipcRenderer.invoke('ignore-export', opts),
  importIgnoredUpdates: (opts) => ipcRenderer.invoke('ignore-import', opts),

  // Katalog & Scanner
  loadCatalog: () => ipcRenderer.invoke('load-catalog'),
  runScan: (mode) => ipcRenderer.invoke('run-scan', mode),
  scanSingle: (folderPath) => ipcRenderer.invoke('scan-single', folderPath),
  saveMetaJson: (targetPath, data) => ipcRenderer.invoke('save-meta-json', targetPath, data),
  addSoftware: () => ipcRenderer.invoke('add-software'),
  addSoftwareFromPath: (p) => ipcRenderer.invoke('add-software-from-path', p),

  // Medien
  addMedia: (targetPath, filePaths) => ipcRenderer.invoke('add-media', targetPath, filePaths),
  addIcon: (targetPath, filePath) => ipcRenderer.invoke('add-icon', targetPath, filePath),
  deleteMedia: (targetPath, mediaPath) => ipcRenderer.invoke('delete-media', targetPath, mediaPath),
  extractExeIcon: (exePath, targetDir) => ipcRenderer.invoke('extract-exe-icon', exePath, targetDir),

  // PC-Versionen & Installation
  scanLocalVersions: (opts) => ipcRenderer.invoke('scan-local-versions', opts),
  scanInstalledSoftware: (opts) => ipcRenderer.invoke('scan-installed-software', opts),
  loadInstalledSnapshot: () => ipcRenderer.invoke('load-installed-snapshot'),
  onInstalledScanProgress: (cb) => {
    const listener = (_event, progress) => cb(progress);
    ipcRenderer.on('installed-scan-progress', listener);
    return () => ipcRenderer.off('installed-scan-progress', listener);
  },
  extractCachedAppIcon: (payload) => ipcRenderer.invoke('extract-cached-app-icon', payload),
  getIconCacheStats: () => ipcRenderer.invoke('icon-cache-stats'),
  clearIconCache: () => ipcRenderer.invoke('icon-cache-clear'),
  uninstallSoftware: (payload) => ipcRenderer.invoke('uninstall-software', payload),
  autoDetectPath: (names) => ipcRenderer.invoke('auto-detect-path', names),
  autoDetectAll: () => ipcRenderer.invoke('auto-detect-all'),
  getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),
  detectInstaller: (payload) => ipcRenderer.invoke('detect-installer', payload),
  recordInnoInf: (payload) => ipcRenderer.invoke('record-inno-inf', payload),
  executeInstaller: (payload) => ipcRenderer.invoke('execute-installer', payload),
  copyFilesToPc: (files) => ipcRenderer.invoke('copy-files-to-pc', files),

  // Paket-Provider & Archiv-Verknüpfung
  listProviders: () => ipcRenderer.invoke('providers-list'),
  setProviderEnabled: (id, enabled) => ipcRenderer.invoke('providers-set-enabled', id, enabled),
  checkProviderAvailability: (id) => ipcRenderer.invoke('providers-check-availability', id),
  checkAllProvidersAvailability: () => ipcRenderer.invoke('providers-check-all-availability'),
  installProviderManager: (providerId) => ipcRenderer.invoke('providers-install-manager', providerId),
  uninstallProviderManager: (providerId) => ipcRenderer.invoke('providers-uninstall-manager', providerId),
  searchProviders: (query, opts) => ipcRenderer.invoke('providers-search', query, opts),
  showPackage: (providerId, packageId, opts) => ipcRenderer.invoke('providers-show', providerId, packageId, opts),
  listPackageVersions: (providerId, packageId, opts) =>
    ipcRenderer.invoke('providers-list-versions', providerId, packageId, opts),
  listProviderUpgrades: (opts) => ipcRenderer.invoke('providers-list-upgrades', opts),
  installPackage: (providerId, packageId, opts) => ipcRenderer.invoke('providers-install', providerId, packageId, opts),
  uninstallPackage: (providerId, packageId, opts) =>
    ipcRenderer.invoke('providers-uninstall', providerId, packageId, opts),
  listProviderSources: (providerId) => ipcRenderer.invoke('providers-list-sources', providerId),
  addProviderSource: (providerId, sourceSpec) => ipcRenderer.invoke('providers-add-source', providerId, sourceSpec),
  removeProviderSource: (providerId, sourceName) =>
    ipcRenderer.invoke('providers-remove-source', providerId, sourceName),
  getProviderCacheStats: () => ipcRenderer.invoke('providers-cache-stats'),
  clearProviderCache: () => ipcRenderer.invoke('providers-cache-clear'),
  inspectMsiFile: (filePath) => ipcRenderer.invoke('msi-inspect-file', filePath),
  installLocalMsi: (payload) => ipcRenderer.invoke('msi-install-local', payload),
  useNvmVersion: (version) => ipcRenderer.invoke('nvm-use-version', version),
  checkArchiveCollision: (targetDir) => ipcRenderer.invoke('archive-check-collision', targetDir),
  findArchiveLink: (packageManager, packageId) => ipcRenderer.invoke('archive-find-link', packageManager, packageId),
  linkPackageToArchive: (payload) => ipcRenderer.invoke('archive-link-package', payload),

  // Power-Werkzeuge (Winget-Zuordnung, Massenaktionen, Archiv-Aufräumer)
  scanWingetMatches: (opts) => ipcRenderer.invoke('winget-matcher-scan', opts),
  applyWingetMatches: (assignments) => ipcRenderer.invoke('winget-matcher-apply', assignments),
  batchDownloadArchiveUpdates: (itemIds) => ipcRenderer.invoke('batch-download-archive-updates', itemIds),
  batchUpdatePackages: (tasks, opts) => ipcRenderer.invoke('batch-update-packages', tasks, opts),
  previewArchiveCleanup: (opts) => ipcRenderer.invoke('archive-cleanup-preview', opts),
  setKeepAllVersions: (itemPath, keepAllVersions) =>
    ipcRenderer.invoke('archive-cleanup-set-keep', itemPath, keepAllVersions),
  executeArchiveCleanup: (opts) => ipcRenderer.invoke('archive-cleanup-execute', opts),

  // Paketbündel
  loadBundles: () => ipcRenderer.invoke('bundles-load'),
  saveBundle: (bundle) => ipcRenderer.invoke('bundles-save', bundle),
  deleteBundle: (bundleId) => ipcRenderer.invoke('bundles-delete', bundleId),
  duplicateBundle: (bundleId) => ipcRenderer.invoke('bundles-duplicate', bundleId),
  exportBundle: (bundleId) => ipcRenderer.invoke('bundles-export', bundleId),
  exportAllBundles: () => ipcRenderer.invoke('bundles-export-all'),
  importBundle: () => ipcRenderer.invoke('bundles-import'),
  runBundleInstall: (bundleId, selectedItemIds, opts) =>
    ipcRenderer.invoke('bundles-run-install', bundleId, selectedItemIds, opts),

  // DEV-Projekte (lokale Entwicklungsprojekte & Projekt-Pakete)
  listDevProjects: () => ipcRenderer.invoke('dev-projects-list'),
  addDevProject: (payload) => ipcRenderer.invoke('dev-projects-add', payload),
  updateDevProject: (projectId, patch) => ipcRenderer.invoke('dev-projects-update', projectId, patch),
  removeDevProject: (projectId) => ipcRenderer.invoke('dev-projects-remove', projectId),
  scanDevProject: (projectId, opts) => ipcRenderer.invoke('dev-projects-scan', projectId, opts),
  devInstallPackage: (projectId, payload, opts) =>
    ipcRenderer.invoke('dev-projects-install-package', projectId, payload, opts),
  devUpdatePackage: (projectId, payload, opts) =>
    ipcRenderer.invoke('dev-projects-update-package', projectId, payload, opts),
  devUninstallPackage: (projectId, payload, opts) =>
    ipcRenderer.invoke('dev-projects-uninstall-package', projectId, payload, opts),
  devToggleScope: (projectId, payload, opts) =>
    ipcRenderer.invoke('dev-projects-toggle-scope', projectId, payload, opts),
  devSyncProject: (projectId, manager, opts) => ipcRenderer.invoke('dev-projects-sync', projectId, manager, opts),
  devSearchPackages: (manager, query, opts) => ipcRenderer.invoke('dev-projects-search-packages', manager, query, opts),
  devAuditProject: (projectId, opts) => ipcRenderer.invoke('dev-projects-audit', projectId, opts),
  devAuditFixProject: (projectId, payload, opts) =>
    ipcRenderer.invoke('dev-projects-audit-fix', projectId, payload, opts),
  loadDevBundles: () => ipcRenderer.invoke('dev-bundles-load'),
  saveDevBundle: (bundle) => ipcRenderer.invoke('dev-bundles-save', bundle),
  deleteDevBundle: (bundleId) => ipcRenderer.invoke('dev-bundles-delete', bundleId),
  duplicateDevBundle: (bundleId) => ipcRenderer.invoke('dev-bundles-duplicate', bundleId),
  exportDevBundle: (bundleId) => ipcRenderer.invoke('dev-bundles-export', bundleId),
  importDevBundle: () => ipcRenderer.invoke('dev-bundles-import'),
  installDevBundle: (projectId, bundleId, selectedPackages, opts) =>
    ipcRenderer.invoke('dev-bundles-install', projectId, bundleId, selectedPackages, opts),

  // Online-Updates (GitHub, Winget, Web-Scraper)
  checkWebVersions: () => ipcRenderer.invoke('check-web-versions'),
  checkSingleWeb: (payload) => ipcRenderer.invoke('check-single-web', payload),
  searchWinget: (query, opts) => ipcRenderer.invoke('search-winget', query, opts),
  downloadWebUpdate: (item, opts) => ipcRenderer.invoke('download-web-update', item, opts),
  openVisualScraper: (url) => ipcRenderer.invoke('open-visual-scraper', url),
  openVisualLinkPicker: (url, knownVer) => ipcRenderer.invoke('open-visual-link-picker', url, knownVer),

  fetchSoftwareMetadata: (payload) => ipcRenderer.invoke('fetch-software-metadata', payload),
  fetchChangelog: (item) => ipcRenderer.invoke('fetch-changelog', item),

  // Einstellungen, Backup & Self-Update
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  checkArchivePath: (rawPath, index) => ipcRenderer.invoke('check-archive-path', rawPath, index),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  saveFavorites: (favorites) => ipcRenderer.invoke('save-favorites', favorites),
  selectDir: (opts) => ipcRenderer.invoke('select-dir', opts),
  selectFile: (filters, returnAbsolute = false) => ipcRenderer.invoke('select-file', filters, returnAbsolute),
  resetPaths: (type) => ipcRenderer.invoke('reset-paths', type),
  resetLocalVersions: () => ipcRenderer.invoke('reset-local-versions'),
  createBackup: () => ipcRenderer.invoke('create-backup'),
  restoreBackup: () => ipcRenderer.invoke('restore-backup'),
  // App Self-Update & Admin-Sitzung
  checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
  installAppUpdate: (url, installKindOrIsPortable) =>
    ipcRenderer.invoke('install-app-update', url, installKindOrIsPortable),
  getAdminSessionStatus: () => ipcRenderer.invoke('admin-session-status'),
  startAdminSession: () => ipcRenderer.invoke('admin-session-start'),
  stopAdminSession: () => ipcRenderer.invoke('admin-session-stop'),
  onAdminSessionUpdated: (cb) => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on('admin-session-updated', listener);
    return () => ipcRenderer.off('admin-session-updated', listener);
  },

  // Admin-Authentifizierung & Policy-Schutz
  getAuthStatus: () => ipcRenderer.invoke('auth-get-status'),
  loginAuth: (username, password) => ipcRenderer.invoke('auth-login', username, password),
  logoutAuth: () => ipcRenderer.invoke('auth-logout'),
  updateAuthConfig: (payload) => ipcRenderer.invoke('auth-update-config', payload),
  setAuthPolicyPath: (policyPath, opts) => ipcRenderer.invoke('auth-set-policy-path', policyPath, opts),
  lockAuthPolicyInHklm: (policyPath) => ipcRenderer.invoke('auth-lock-hklm', policyPath),
  unlockAuthPolicyInHklm: () => ipcRenderer.invoke('auth-unlock-hklm'),
  getAccessPolicy: () => ipcRenderer.invoke('policy-get'),
  updateAccessPolicy: (policy) => ipcRenderer.invoke('policy-update', policy),
  exportAccessPolicy: () => ipcRenderer.invoke('policy-export'),
  importAccessPolicy: () => ipcRenderer.invoke('policy-import'),
  onAuthStatusUpdated: (cb) => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on('auth-status-updated', listener);
    return () => ipcRenderer.off('auth-status-updated', listener);
  },

  // System-Tray, Autostart & Hintergrund-Updater
  getAutostartStatus: () => ipcRenderer.invoke('autostart-get-status'),
  applyAutostart: (payload) => ipcRenderer.invoke('autostart-apply', payload),
  getBackgroundStatus: () => ipcRenderer.invoke('background-get-status'),
  runBackgroundCheckNow: () => ipcRenderer.invoke('background-check-now'),
  setAutoUpdatePaused: (paused) => ipcRenderer.invoke('background-set-auto-update-paused', paused),

  // Mehrsprachigkeit (i18n)
  getI18nState: () => ipcRenderer.invoke('i18n-get-state'),
  setLanguage: (code) => ipcRenderer.invoke('i18n-set-language', code),
  onLanguageChanged: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('language-changed', listener);
    return () => ipcRenderer.off('language-changed', listener);
  },
  onNavigateTab: (cb) => {
    const listener = (_event, tab) => cb(tab);
    ipcRenderer.on('navigate-tab', listener);
    return () => ipcRenderer.off('navigate-tab', listener);
  },
  onOpenSettings: (cb) => {
    const listener = (_event, tab) => cb(tab);
    ipcRenderer.on('open-settings', listener);
    return () => ipcRenderer.off('open-settings', listener);
  },
  onBackgroundStatusUpdated: (cb) => {
    const listener = (_event, status) => cb(status);
    ipcRenderer.on('background-status-updated', listener);
    return () => ipcRenderer.off('background-status-updated', listener);
  },
});
