const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// Zwingt Electron, den Cache auf dem lokalen PC statt auf dem NAS abzulegen
app.setPath('userData', path.join(app.getPath('temp'), 'SoftwareKatalog_Data'));

// Behebt den "Unable to move the cache" Fehler in Electron
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// Behebt die "Failed to open persistent cache files (Dawn/Graphite)" Fehler
app.commandLine.appendSwitch('disable-dawn-features', 'use_dxc');
app.commandLine.appendSwitch('disable-features', 'DawnGraphiteCache');

// Zwingt Electron, den Cache auf dem lokalen PC statt auf dem NAS abzulegen
app.setPath('userData', path.join(app.getPath('temp'), 'SoftwareKatalog_Data'));

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
    updateInterval: 24, // Sucht alle 24 Stunden nach Updates
    lastUpdateCheck: 0, // Zeitstempel der letzten Prüfung
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

  ipcMain.handle('check-update', async () => {
    try {
      const currentVersion = app.getVersion();
      const response = await fetch('https://api.github.com/repos/RaptorXilef/SoftwareKatalogApp/releases/latest', {
        headers: { 'User-Agent': 'SoftwareKatalogApp' },
      });

      if (!response.ok) return { error: `GitHub API Fehler: ${response.statusText}` };

      const data = await response.json();
      // Entfernt ein eventuelles 'v' aus dem Tag (z.B. 'v1.6.1' -> '1.6.1')
      const latestVersion = data.tag_name.replace(/^v/, '');

      // Zeitstempel für automatische Update-Prüfung speichern
      saveConfig({ lastUpdateCheck: Date.now() });

      return {
        updateAvailable: currentVersion !== latestVersion,
        latestVersion,
        currentVersion,
        releaseUrl: data.html_url,
      };
    } catch (e) {
      console.error('Update-Check fehlgeschlagen:', e);
      return { error: e.message };
    }
  });

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

  // Neue Software hinzufügen (Ordner auswählen und Template erstellen)
  ipcMain.handle('add-software', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Ordner der neuen Software auswählen',
      properties: ['openDirectory'],
    });
    if (canceled || filePaths.length === 0) return { success: false };

    const targetDir = filePaths[0];
    const metaDir = path.join(targetDir, '_metadata');
    const metaFile = path.join(metaDir, 'meta.json');

    try {
      if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
      if (!fs.existsSync(metaFile)) {
        const template = {
          name: path.basename(targetDir),
          category: '',
          hiddenCategory: '',
          tags: [],
          formats: [],
          os: ['Windows 10', 'Windows 11'],
          description: ['Hier eine kurze Beschreibung einfügen...'],
          links: {},
        };
        fs.writeFileSync(metaFile, JSON.stringify(template, null, 2), 'utf-8');
      }
      return { success: true, path: targetDir };
    } catch (e) {
      console.error('Fehler beim Hinzufügen der Software:', e);
      return { success: false, error: e.message };
    }
  });

  // meta.json speichern
  ipcMain.handle('save-meta-json', async (_event, targetPath, data) => {
    try {
      const metaDir = path.join(targetPath, '_metadata');
      if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
      const metaFile = path.join(metaDir, 'meta.json');

      fs.writeFileSync(metaFile, JSON.stringify(data, null, 2), 'utf-8');
      return { success: true };
    } catch (e) {
      console.error('Fehler beim Speichern der meta.json:', e);
      return { success: false, error: e.message };
    }
  });

  createWindow();
});
