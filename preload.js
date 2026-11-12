const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openPath: (path) => ipcRenderer.send('open-path', path),
  loadCatalog: () => ipcRenderer.invoke('load-catalog'),
  runScan: (mode) => ipcRenderer.invoke('run-scan', mode), // mode: 'quick', 'full', 'update'
  downloadFiles: (files) => ipcRenderer.invoke('download-files', files),
  openUrl: (url) => ipcRenderer.send('open-url', url),
  onScanStart: (callback) => ipcRenderer.on('scan-start', (_event, path) => callback(path)),
  onScanProgress: (callback) => ipcRenderer.on('scan-progress', (_event, path) => callback(path)),

  // Erweiterte Settings-API
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  selectTargetDir: () => ipcRenderer.invoke('select-target-dir'),
  selectFile: (filters) => ipcRenderer.invoke('select-file', filters),
});
