const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Basis-Pfade definieren
function getAppFolder() {
  if (app.isPackaged) {
    return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  }
  return __dirname;
}

function getConfig() {
  const appFolder = getAppFolder();
  const configPath = path.join(appFolder, 'config.json');

  // Standard-Werte
  const config = { targetPath: '../software', jsonPath: 'catalog.json', scriptPath: 'scanner.mjs' };

  if (fs.existsSync(configPath)) {
    try {
      Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf-8')));
    } catch (_e) {}
  } else {
    // NEU: config.json automatisch erstellen, falls sie fehlt
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (_e) {}
  }

  return {
    appFolder,
    targetPath: config.targetPath,
    jsonPath: path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(appFolder, config.jsonPath),
    scriptPath: path.isAbsolute(config.scriptPath) ? config.scriptPath : path.resolve(appFolder, config.scriptPath),
  };
}

function saveConfig(newTargetPath) {
  const appFolder = getAppFolder();
  const configPath = path.join(appFolder, 'config.json');
  const currentConfig = { targetPath: newTargetPath, jsonPath: 'catalog.json', scriptPath: 'scanner.mjs' };

  if (fs.existsSync(configPath)) {
    try {
      Object.assign(currentConfig, JSON.parse(fs.readFileSync(configPath, 'utf-8')));
      currentConfig.targetPath = newTargetPath; // Überschreiben
    } catch (_e) {}
  }

  fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), 'utf-8');
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
      const { spawn } = require('node:child_process');

      const args = [scriptPath];
      if (isFull) args.push('--full');

      // Der Gamechanger: spawn statt exec & ELECTRON_RUN_AS_NODE.
      // process.execPath ist die SoftwareKatalog.exe selbst. Mit der env-Variable
      // verhält sie sich für diesen Unterprozess exakt wie die node.exe!
      const child = spawn(process.execPath, args, {
        cwd: appFolder,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });

      let fullOutput = '';
      let fullError = '';
      let buffer = '';

      // Lese den Live-Output des Scanners Zeile für Zeile
      child.stdout.on('data', (data) => {
        const text = data.toString();
        fullOutput += text;
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Unvollständige Zeile im Puffer behalten

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('SCAN_START:')) {
            event.sender.send('scan-start', trimmed.replace('SCAN_START:', '').trim());
          } else if (trimmed.startsWith('SCAN_DIR:')) {
            event.sender.send('scan-progress', trimmed.replace('SCAN_DIR:', '').trim());
          }
        }
      });

      // Fehler-Stream erfassen
      child.stderr.on('data', (data) => {
        fullError += data.toString();
      });

      // Wenn der Prozess gar nicht erst starten kann
      child.on('error', (err) => {
        reject(new Error(`Spawn-Fehler: ${err.message}`));
      });

      child.on('exit', (code) => {
        if (code === 0) resolve(fullOutput);
        else if (fullError.includes('LOCKED')) reject(new Error('LOCKED'));
        else reject(new Error(`Scanner-Absturz (Code ${code}):\n${fullError}`));
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

  // Version ans Frontend senden
  ipcMain.handle('get-app-info', () => {
    return { version: app.getVersion() };
  });

  // Ordnerauswahl für Einstellungen öffnen
  ipcMain.handle('select-target-dir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Software-Hauptordner auswählen',
      properties: ['openDirectory'],
    });
    if (canceled || filePaths.length === 0) return null;
    return filePaths[0];
  });

  // Pfad in config.json speichern
  ipcMain.handle('save-target-dir', (_event, newPath) => {
    try {
      saveConfig(newPath);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Aktuellen Pfad abfragen
  ipcMain.handle('get-target-dir', () => {
    return getConfig().targetPath;
  });

  createWindow();
});
