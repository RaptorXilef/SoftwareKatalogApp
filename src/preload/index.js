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
  extractCachedAppIcon: (payload) => ipcRenderer.invoke('extract-cached-app-icon', payload),
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
  searchProviders: (query, opts) => ipcRenderer.invoke('providers-search', query, opts),
  showPackage: (providerId, packageId, opts) => ipcRenderer.invoke('providers-show', providerId, packageId, opts),
  listProviderUpgrades: (opts) => ipcRenderer.invoke('providers-list-upgrades', opts),
  installPackage: (providerId, packageId, opts) => ipcRenderer.invoke('providers-install', providerId, packageId, opts),
  uninstallPackage: (providerId, packageId, opts) =>
    ipcRenderer.invoke('providers-uninstall', providerId, packageId, opts),
  getProviderCacheStats: () => ipcRenderer.invoke('providers-cache-stats'),
  clearProviderCache: () => ipcRenderer.invoke('providers-cache-clear'),
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
  importBundle: () => ipcRenderer.invoke('bundles-import'),
  runBundleInstall: (bundleId, selectedItemIds, opts) =>
    ipcRenderer.invoke('bundles-run-install', bundleId, selectedItemIds, opts),

  // Online-Updates (GitHub, Winget, Web-Scraper)
  checkWebVersions: () => ipcRenderer.invoke('check-web-versions'),
  checkSingleWeb: (payload) => ipcRenderer.invoke('check-single-web', payload),
  searchWinget: (query) => ipcRenderer.invoke('search-winget', query),
  downloadWebUpdate: (item, opts) => ipcRenderer.invoke('download-web-update', item, opts),
  openVisualScraper: (url) => ipcRenderer.invoke('open-visual-scraper', url),
  openVisualLinkPicker: (url, knownVer) => ipcRenderer.invoke('open-visual-link-picker', url, knownVer),

  fetchSoftwareMetadata: (payload) => ipcRenderer.invoke('fetch-software-metadata', payload),
  fetchChangelog: (item) => ipcRenderer.invoke('fetch-changelog', item),

  // Einstellungen, Backup & Self-Update
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  selectDir: (opts) => ipcRenderer.invoke('select-dir', opts),
  selectFile: (filters, returnAbsolute = false) => ipcRenderer.invoke('select-file', filters, returnAbsolute),
  resetPaths: (type) => ipcRenderer.invoke('reset-paths', type),
  resetLocalVersions: () => ipcRenderer.invoke('reset-local-versions'),
  createBackup: () => ipcRenderer.invoke('create-backup'),
  restoreBackup: () => ipcRenderer.invoke('restore-backup'),
  checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
  installAppUpdate: (url, isPortable) => ipcRenderer.invoke('install-app-update', url, isPortable),
});
