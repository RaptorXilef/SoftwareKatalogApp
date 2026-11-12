const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Zwingt Electron, den Cache auf dem lokalen PC statt auf dem NAS abzulegen
app.setPath('userData', path.join(app.getPath('temp'), 'SoftwareKatalog_Data'));

// Behebt den "Unable to move the cache" Fehler in Electron
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// Basis-Pfade definieren
function getAppFolder() {
  return app.isPackaged ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) : __dirname;
}

function getConfig() {
  const appFolder = getAppFolder();
  const configPath = path.join(appFolder, 'config.json');

  // Erweiterte Standard-Werte
  const config = {
    targetPath: '../software',
    jsonPath: 'catalog.json',
    scriptPath: 'scanner.mjs',
    scanNested: false,
    nestedDepth: 1,
    visibleHiddenCats: [],
  };

  if (fs.existsSync(configPath)) {
    try {
      Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf-8')));
    } catch (e) {
      console.error('Fehler beim Lesen der config.json:', e);
    }
  } else {
    try {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
      console.error('Fehler beim Erstellen der config.json:', e);
    }
  }

  return {
    appFolder,
    ...config,
    absJsonPath: path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(appFolder, config.jsonPath),
    absScriptPath: path.isAbsolute(config.scriptPath) ? config.scriptPath : path.resolve(appFolder, config.scriptPath),
  };
}

function saveConfig(newSettings) {
  const appFolder = getAppFolder();
  const configPath = path.join(appFolder, 'config.json');
  const currentConfig = getConfig();

  // Neue Einstellungen zusammenführen
  Object.assign(currentConfig, newSettings);

  // Hilfs-Attribute entfernen, bevor in JSON geschrieben wird
  delete currentConfig.appFolder;
  delete currentConfig.absJsonPath;
  delete currentConfig.absScriptPath;

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
    const { absJsonPath, appFolder } = getConfig();
    if (fs.existsSync(absJsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(absJsonPath, 'utf-8'));
        // Pfade on-the-fly für das Frontend wieder in absolute Pfade umwandeln
        return data.map((item) => {
          if (item.path) item.path = path.resolve(appFolder, item.path);
          if (item.icon) item.icon = path.resolve(appFolder, item.icon);
          if (item.screenshots) item.screenshots = item.screenshots.map((s) => path.resolve(appFolder, s));
          if (item.lastFiles) item.lastFiles = item.lastFiles.map((f) => path.resolve(appFolder, f));
          return item;
        });
      } catch (e) {
        console.error('Fehler beim Verarbeiten des Katalogs:', e);
      }
    }
    return [];
  });

  // Scanner ausführen
  ipcMain.handle('run-scan', async (event, mode) => {
    const { absScriptPath, appFolder } = getConfig();
    return new Promise((resolve, reject) => {
      const { spawn } = require('node:child_process');
      const args = [absScriptPath];
      if (mode === 'full') args.push('--full');
      if (mode === 'update') args.push('--update');

      // Der Gamechanger: spawn statt exec & ELECTRON_RUN_AS_NODE.
      // process.execPath ist die SoftwareKatalog.exe selbst. Mit der env-Variable
      // verhält sie sich für diesen Unterprozess exakt wie die node.exe!
      const child = spawn(process.execPath, args, {
        cwd: appFolder,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });

      let fullOutput = '',
        fullError = '',
        buffer = '';

      // Lese den Live-Output des Scanners Zeile für Zeile
      child.stdout.on('data', (data) => {
        const text = data.toString();
        fullOutput += text;
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Unvollständige Zeile im Puffer behalten

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('SCAN_START:'))
            event.sender.send('scan-start', trimmed.replace('SCAN_START:', '').trim());
          else if (trimmed.startsWith('SCAN_DIR:'))
            event.sender.send('scan-progress', trimmed.replace('SCAN_DIR:', '').trim());
        }
      });

      // Fehler-Stream erfassen
      child.stderr.on('data', (data) => (fullError += data.toString()));
      // Wenn der Prozess gar nicht erst starten kann
      child.on('error', (err) => reject(new Error(`Spawn-Fehler: ${err.message}`)));
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

  // Settings API
  // Version ans Frontend senden
  ipcMain.handle('get-app-info', () => ({ version: app.getVersion() }));
  ipcMain.handle('get-settings', () => getConfig());
  ipcMain.handle('save-settings', (_event, settings) => {
    try {
      saveConfig(settings);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Ordnerauswahl für Einstellungen öffnen
  ipcMain.handle('select-target-dir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Ordner auswählen',
      properties: ['openDirectory'],
    });
    return canceled ? null : filePaths[0];
  });

  ipcMain.handle('select-file', async (_event, filters) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Datei auswählen',
      properties: ['openFile'],
      filters,
    });
    if (canceled || filePaths.length === 0) return null;
    return path.relative(getAppFolder(), filePaths[0]); // Speichert Pfad relativ zur App
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
