const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openPath: (path) => ipcRenderer.send('open-path', path),
  loadCatalog: () => ipcRenderer.invoke('load-catalog'),
  runScan: (isFull) => ipcRenderer.invoke('run-scan', isFull),
  downloadFiles: (files) => ipcRenderer.invoke('download-files', files),
  openUrl: (url) => ipcRenderer.send('open-url', url),
});
