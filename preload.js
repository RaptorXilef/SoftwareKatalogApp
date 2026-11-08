const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openPath: (path) => ipcRenderer.send('open-path', path),
  loadCatalog: () => ipcRenderer.invoke('load-catalog'),
  runScan: (isFull) => ipcRenderer.invoke('run-scan', isFull),
  downloadFiles: (files) => ipcRenderer.invoke('download-files', files),
  openUrl: (url) => ipcRenderer.send('open-url', url),
  onScanStart: (callback) => ipcRenderer.on('scan-start', (_event, path) => callback(path)),
  onScanProgress: (callback) => ipcRenderer.on('scan-progress', (_event, path) => callback(path)),
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  selectTargetDir: () => ipcRenderer.invoke('select-target-dir'),
  saveTargetDir: (path) => ipcRenderer.invoke('save-target-dir', path),
  getTargetDir: () => ipcRenderer.invoke('get-target-dir'),
});
