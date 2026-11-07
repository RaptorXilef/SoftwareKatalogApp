const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

function getConfig() {
  // Wenn als Exe gepackt, ist der Ordner da wo die Exe liegt. Sonst Entwicklungsordner.
  const appFolder = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  const configPath = path.join(appFolder, 'config.json');

  const config = { jsonPath: 'catalog.json', scriptPath: 'scanner.mjs' };
  if (fs.existsSync(configPath)) {
    try {
      Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf-8')));
    } catch (e) {}
  }

  return {
    appFolder,
    jsonPath: path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(appFolder, config.jsonPath),
    scriptPath: path.isAbsolute(config.scriptPath) ? config.scriptPath : path.resolve(appFolder, config.scriptPath),
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  ipcMain.on('open-path', (event, folderPath) => shell.openPath(folderPath));

  // Daten an Frontend schicken
  ipcMain.handle('load-catalog', async () => {
    const { jsonPath } = getConfig();
    if (fs.existsSync(jsonPath)) {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    }
    return [];
  });

  // Scanner ausführen
  ipcMain.handle('run-scan', async (event, isFull) => {
    const { scriptPath, appFolder } = getConfig();
    return new Promise((resolve, reject) => {
      // WICHTIG: Erfordert, dass auf dem ausführenden PC Node.js installiert ist!
      const cmd = `node "${scriptPath}" ${isFull ? '--full' : ''}`;
      exec(cmd, { cwd: appFolder }, (error, stdout, stderr) => {
        if (error) reject(error.message);
        else resolve(stdout);
      });
    });
  });

  // Dateien aus _last herunterladen (kopieren)
  ipcMain.handle('download-files', async (event, sourceFiles) => {
    // 1. Benutzer wählt Zielordner aus
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Speicherort für Download auswählen',
      properties: ['openDirectory'],
    });

    if (canceled || filePaths.length === 0) return { success: false };
    const destDir = filePaths[0];

    try {
      // 2. Alle Dateien asynchron kopieren
      for (const src of sourceFiles) {
        const fileName = path.basename(src);
        await fs.promises.copyFile(src, path.join(destDir, fileName));
      }
      return { success: true, dest: destDir };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Öffnet Web-Links im Standardbrowser (Chrome/Edge/Firefox)
  ipcMain.on('open-url', (event, url) => shell.openExternal(url));

  createWindow();
});
