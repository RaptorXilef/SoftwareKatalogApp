const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openPath: (path) => ipcRenderer.send('open-path', path),
  loadCatalog: () => ipcRenderer.invoke('load-catalog'),
  runScan: (mode) => ipcRenderer.invoke('run-scan', mode), // mode: 'quick', 'full', 'update'
  downloadFiles: (files) => ipcRenderer.invoke('download-files', files),
  executeTempInstaller: (path) => ipcRenderer.invoke('execute-temp-installer', path), // Installer via Temp ausführen
  openUrl: (url) => ipcRenderer.send('open-url', url),
  onScanStart: (callback) => ipcRenderer.on('scan-start', (_event, path) => callback(path)),
  onScanProgress: (callback) => ipcRenderer.on('scan-progress', (_event, path) => callback(path)),

  // Erweiterte Settings-API
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),

  // Separater Download mit Fortschritt
  downloadUpdate: (url) => ipcRenderer.invoke('download-update', url),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_event, pct) => callback(pct)),
  installUpdate: (assetPath, isPortable) => ipcRenderer.invoke('install-update', assetPath, isPortable),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  selectTargetDir: () => ipcRenderer.invoke('select-target-dir'),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),

  // Launcher & Software Features
  markAsInstalled: (id, version) => ipcRenderer.invoke('mark-as-installed', id, version),
  scanLocalVersions: () => ipcRenderer.invoke('scan-local-versions'),

  // Installierte Programme auflisten
  getInstalledApps: () => ipcRenderer.invoke('get-installed-apps'),

  // Debug & Backup Funktionen
  resetPaths: (type) => ipcRenderer.invoke('reset-paths', type),
  resetVersions: (type) => ipcRenderer.invoke('reset-versions', type),
  createBackup: () => ipcRenderer.invoke('create-backup'),
  restoreBackup: () => ipcRenderer.invoke('restore-backup'),

  autoDetectPath: (namesArray) => ipcRenderer.invoke('auto-detect-path', namesArray),
  extractExeIcon: (exePath, targetPath) => ipcRenderer.invoke('extract-exe-icon', exePath, targetPath),
  addSoftware: () => ipcRenderer.invoke('add-software'),
  addSoftwareFromPath: (path) => ipcRenderer.invoke('add-software-from-path', path),
  addMedia: (targetPath, filePaths) => ipcRenderer.invoke('add-media', targetPath, filePaths),
  addIcon: (targetPath, filePath) => ipcRenderer.invoke('add-icon', targetPath, filePath),
  saveMetaJson: (targetPath, data) => ipcRenderer.invoke('save-meta-json', targetPath, data),
});
