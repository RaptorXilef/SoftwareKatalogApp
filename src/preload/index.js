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
  autoDetectPath: (names) => ipcRenderer.invoke('auto-detect-path', names),
  autoDetectAll: () => ipcRenderer.invoke('auto-detect-all'),
  getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),
  executeInstaller: (payload) => ipcRenderer.invoke('execute-installer', payload),
  copyFilesToPc: (files) => ipcRenderer.invoke('copy-files-to-pc', files),

  // Online-Updates (GitHub, Winget, Web-Scraper)
  checkWebVersions: () => ipcRenderer.invoke('check-web-versions'),
  checkSingleWeb: (payload) => ipcRenderer.invoke('check-single-web', payload),
  searchWinget: (query) => ipcRenderer.invoke('search-winget', query),
  downloadWebUpdate: (item, opts) => ipcRenderer.invoke('download-web-update', item, opts),
  openVisualScraper: (url) => ipcRenderer.invoke('open-visual-scraper', url),
  openVisualLinkPicker: (url, knownVer) => ipcRenderer.invoke('open-visual-link-picker', url, knownVer),

  // Einstellungen, Backup & Self-Update
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  selectDir: () => ipcRenderer.invoke('select-dir'),
  selectFile: (filters, returnAbsolute = false) => ipcRenderer.invoke('select-file', filters, returnAbsolute),
  resetPaths: (type) => ipcRenderer.invoke('reset-paths', type),
  resetLocalVersions: () => ipcRenderer.invoke('reset-local-versions'),
  createBackup: () => ipcRenderer.invoke('create-backup'),
  restoreBackup: () => ipcRenderer.invoke('restore-backup'),
  checkAppUpdate: () => ipcRenderer.invoke('check-app-update'),
  installAppUpdate: (url, isPortable) => ipcRenderer.invoke('install-app-update', url, isPortable),
});
