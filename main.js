const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { exec } = require('node:child_process');

function getConfig() {
  // Wenn als Exe gepackt, ist der Ordner da wo die Exe liegt. Sonst Entwicklungsordner.
  const appFolder = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  const configPath = path.join(appFolder, 'config.json');

  const config = { jsonPath: 'catalog.json', scriptPath: 'scanner.mjs' };
  if (fs.existsSync(configPath)) {
    try {
      Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf-8')));
    } catch (_e) {}
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
    icon: path.join(__dirname, 'build', 'icon.ico'), // Lade das Icon in die Fensterleiste
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
}

app.whenReady().then(() => {
  ipcMain.on('open-path', (_event, folderPath) => shell.openPath(folderPath));

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
      const child = exec(cmd, { cwd: appFolder });

      let fullOutput = '';
      let buffer = '';

      // Lese den Live-Output des Scanners Zeile für Zeile
      child.stdout.on('data', (data) => {
        fullOutput += data;
        buffer += data;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Unvollständige Zeile behalten

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('SCAN_START:')) {
            event.sender.send('scan-start', trimmed.replace('SCAN_START:', '').trim());
          } else if (trimmed.startsWith('SCAN_DIR:')) {
            event.sender.send('scan-progress', trimmed.replace('SCAN_DIR:', '').trim());
          }
        }
      });

      child.stderr.on('data', (data) => {
        if (data.includes('LOCKED')) reject(new Error('LOCKED'));
      });

      child.on('exit', (code) => {
        if (code === 0) resolve(fullOutput);
        else reject(new Error('Scan fehlgeschlagen oder Node.js nicht im Pfad des Ziel-PCs.'));
      });
    });
  });

  // Dateien aus _last herunterladen (kopieren)
  ipcMain.handle('download-files', async (_event, sourceFiles) => {
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
  ipcMain.on('open-url', (_event, url) => shell.openExternal(url));

  createWindow();
});
