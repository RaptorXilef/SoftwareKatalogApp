const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

// Zwingt Electron, den Cache auf dem lokalen PC statt auf dem NAS abzulegen
app.setPath('userData', path.join(app.getPath('temp'), 'SoftwareKatalog_Data'));

// Behebt den "Unable to move the cache" Fehler in Electron
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// Behebt die "Failed to open persistent cache files (Dawn/Graphite)" Fehler
app.commandLine.appendSwitch('disable-dawn-features', 'use_dxc');
app.commandLine.appendSwitch('disable-features', 'DawnGraphiteCache');

// Behebt den "White-Screen-Absturz" bei Ausführung direkt vom Netzlaufwerk (SMB)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
// Unterdrückt den "GetGpuDriverOverlayInfo" Fehler (weil Hardwarebeschleunigung aus ist)
app.commandLine.appendSwitch('disable-direct-composition');

// Basis-Pfade definieren
function getAppFolder() {
  return app.isPackaged ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) : __dirname;
}

function getConfig() {
  const appFolder = getAppFolder();
  const configPath = path.join(appFolder, 'config.json');
  // Neuer lokaler State, wird NICHT auf's NAS synchronisiert, verhindert unnötige Schreibzugriffe
  const statePath = path.join(app.getPath('userData'), 'state.json');

  // Kern-Einstellungen (werden auf dem NAS für alle geteilt)
  const config = {
    targetPath: '../software',
    jsonPath: 'catalog.json',
    scriptPath: 'scanner.mjs',
    scanNested: false,
    nestedDepth: 1,
    visibleHiddenCats: [],
    updateInterval: 24, // Sucht alle 24 Stunden nach Updates
    autoExtensions: ['.exe', '.msi', '.zip'], // Dateiendungen für Auto-Download
    newBadgeDays: 14, // Dauer des NEU-Badges in Tagen
  };

  // Lokaler State (pro PC, z.B. Favoriten und wann zuletzt nach Updates gesucht wurde)
  const state = {
    lastUpdateCheck: 0,
    favorites: [],
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

  if (fs.existsSync(statePath)) {
    try {
      Object.assign(state, JSON.parse(fs.readFileSync(statePath, 'utf-8')));
    } catch (e) {
      console.error('Fehler beim Lesen der state.json:', e);
    }
  }

  // Für das Frontend führen wir beide Objekte transparent zusammen
  return {
    appFolder,
    statePath, // Wird dem Frontend übergeben, damit der Nutzer die Datei im Explorer öffnen kann
    ...config,
    ...state,
    absJsonPath: path.isAbsolute(config.jsonPath) ? config.jsonPath : path.resolve(appFolder, config.jsonPath),
    absScriptPath: path.isAbsolute(config.scriptPath) ? config.scriptPath : path.resolve(appFolder, config.scriptPath),
  };
}

function saveConfig(newSettings) {
  const appFolder = getAppFolder();
  const configPath = path.join(appFolder, 'config.json');
  const statePath = path.join(app.getPath('userData'), 'state.json');
  const currentFullConfig = getConfig();

  // Alle neuen Einstellungen zusammenführen
  Object.assign(currentFullConfig, newSettings);

  // Saubere Trennung: Welche Eigenschaft gehört wohin?
  const stateKeys = ['lastUpdateCheck', 'favorites'];

  const newState = {};
  const newConfig = {};

  for (const key in currentFullConfig) {
    if (['appFolder', 'statePath', 'absJsonPath', 'absScriptPath'].includes(key)) continue; // Ignorieren

    if (stateKeys.includes(key)) {
      newState[key] = currentFullConfig[key];
    } else {
      newConfig[key] = currentFullConfig[key];
    }
  }

  // Schreiben in die jeweiligen Dateien
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2), 'utf-8');
  fs.writeFileSync(statePath, JSON.stringify(newState, null, 2), 'utf-8');
}

let mainWindow = null;

function createWindow() {
  const windowOptions = {
    width: 1200,
    height: 800,
    show: false, // Fenster versteckt starten
    backgroundColor: '#1e1e2e', // Passende Hintergrundfarbe setzen, verhindert weißes Aufblitzen
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, // Sicherheit: Isolierter Kontext für den Renderer
      nodeIntegration: false, // Sicherheit: Keine direkte Node.js API im Frontend
      sandbox: true, // Sicherheit: Strikte Sandbox aktivieren
    },
  };

  // electron-builder packt den 'build'-Ordner standardmäßig nicht ins app.asar, um Platz zu sparen.
  // Wir setzen das Icon also nur, wenn die Datei existiert (z. B. während der lokalen Entwicklung).
  // Im fertigen Build nutzt Windows ohnehin automatisch das Icon der .exe-Datei!
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  if (fs.existsSync(iconPath)) {
    windowOptions.icon = iconPath;
  }

  mainWindow = new BrowserWindow(windowOptions);
  mainWindow.loadFile('index.html');

  // Fenster erst einblenden, wenn Chromium komplett fertig mit dem Rendern ist
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Wenn schon eine Instanz läuft, beende diese neue sofort
  app.quit();
} else {
  // Wenn jemand versucht, eine zweite Instanz zu starten, fokussiere das bereits offene Fenster
  app.on('second-instance', (_event, _commandLine, _workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

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

    // Lokales Kopieren, Ausführen und Warten (Bypass für SMB-Probleme)
    ipcMain.handle('execute-temp-installer', async (_event, sourcePath) => {
      try {
        const tempDir = app.getPath('temp');
        const fileName = path.basename(sourcePath);
        const tempPath = path.join(tempDir, `sk_install_${Date.now()}_${fileName}`);

        // Linter-Fix: async/await außerhalb des Promise-Konstruktors!
        await fs.promises.copyFile(sourcePath, tempPath);

        return new Promise((resolve) => {
          // Führt die Datei über die Windows-Kommandozeile aus und blockiert (wait), bis sie geschlossen wird
          const child = spawn(`start /wait "" "${tempPath}"`, { shell: true });

          child.on('exit', async () => {
            // Wenn die Ausführung beendet ist, lösche die temporäre Datei
            try {
              if (fs.existsSync(tempPath)) {
                await fs.promises.unlink(tempPath);
              }
            } catch (e) {
              console.warn('Konnte Temp-Datei nicht bereinigen:', e);
            }
            resolve({ success: true });
          });

          child.on('error', (err) => {
            resolve({ success: false, error: err.message });
          });
        });
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

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

    // Sicherheit: Öffnet externe Web-Links im Standardbrowser nur bei gültigen Protokollen
    ipcMain.on('open-url', (_event, url) => {
      try {
        const parsedUrl = new URL(url);
        if (['http:', 'https:'].includes(parsedUrl.protocol)) {
          shell.openExternal(url);
        } else {
          console.warn(`Blockierte URL (ungültiges Protokoll): ${url}`);
        }
      } catch (e) {
        console.error(`Fehler beim Parsen der URL: ${url}`, e);
      }
    });

    // Settings API
    // Version ans Frontend senden
    ipcMain.handle('get-app-info', () => ({ version: app.getVersion() }));

    // Erweitertes Check-Update für das Auto-Update System
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

        // Assets analysieren für In-App Update
        const isPortable = app.isPackaged && process.execPath.toLowerCase().includes('portable');
        let updateAssetUrl = null;

        if (isPortable) {
          const asset = data.assets.find((a) => a.name.endsWith('-Portable.exe'));
          if (asset) updateAssetUrl = asset.browser_download_url;
        } else {
          // ZIP Version
          const asset = data.assets.find(
            (a) => a.name.endsWith('.zip') && !a.name.includes('mac') && !a.name.includes('linux')
          );
          if (asset) updateAssetUrl = asset.browser_download_url;
        }

        return {
          updateAvailable: currentVersion !== latestVersion,
          latestVersion,
          currentVersion,
          releaseUrl: data.html_url,
          updateAssetUrl,
          isPortable,
        };
      } catch (e) {
        console.error('Update-Check fehlgeschlagen:', e);
        return { error: e.message };
      }
    });

    // Führt das Auto-Update via PowerShell aus
    ipcMain.handle('install-update', async (event, assetUrl, isPortable) => {
      console.log(`Update-Installation angefordert von WebContents ID: ${event.sender.id}`);

      return new Promise((resolve) => {
        const tempDir = app.getPath('temp');
        const updateScriptPath = path.join(tempDir, 'sk_update.ps1');
        const appPath = isPortable ? process.execPath : getAppFolder();

        let psScript = '';
        if (isPortable) {
          const destExe = process.execPath;
          const tempExe = path.join(tempDir, 'SoftwareKatalog-Update.exe');
          psScript = `
            Write-Host "Lade Update herunter..."
            Invoke-WebRequest -Uri "${assetUrl}" -OutFile "${tempExe}"
            Write-Host "Warte auf Beendigung der App..."
            Start-Sleep -Seconds 3
            Move-Item -Path "${destExe}" -Destination "${destExe}.old" -Force
            Move-Item -Path "${tempExe}" -Destination "${destExe}" -Force
            Start-Process "${destExe}"
          `;
        } else {
          const zipPath = path.join(tempDir, 'SoftwareKatalog-Update.zip');
          psScript = `
            Write-Host "Lade Update herunter..."
            Invoke-WebRequest -Uri "${assetUrl}" -OutFile "${zipPath}"
            Write-Host "Warte auf Beendigung der App..."
            Start-Sleep -Seconds 3
            Expand-Archive -Path "${zipPath}" -DestinationPath "${tempDir}\\sk_update_extract" -Force

            # Kopiere alles außer config.json, catalog.json und _metadata
            $source = "${tempDir}\\sk_update_extract"
            $dest = "${appPath}"
            Get-ChildItem -Path $source -Recurse | Where-Object {
              $_.FullName -notmatch '\\\\config\\.json$' -and
              $_.FullName -notmatch '\\\\catalog\\.json$' -and
              $_.FullName -notmatch '\\\\_metadata\\\\'
            } | Copy-Item -Destination { $_.FullName.Replace($source, $dest) } -Force

            Start-Process "$dest\\SoftwareKatalog.exe"
            Remove-Item -Path "${zipPath}" -Force
            Remove-Item -Path "${tempDir}\\sk_update_extract" -Recurse -Force
          `;
        }

        fs.writeFileSync(updateScriptPath, psScript, 'utf-8');

        // Starte das PS-Skript entkoppelt
        const child = spawn(
          'powershell.exe',
          ['-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', updateScriptPath],
          {
            detached: true,
            stdio: 'ignore',
          }
        );
        child.unref();

        resolve({ success: true });
        // Beende die App sofort, damit das Skript die Dateien überschreiben kann
        setTimeout(() => app.quit(), 500);
      });
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

    // Neue Software hinzufügen (Ordner auswählen und Template erstellen)
    ipcMain.handle('add-software', async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Ordner der neuen Software auswählen',
        properties: ['openDirectory'],
      });
      if (canceled || filePaths.length === 0) return { success: false };

      const targetDir = filePaths[0];

      // Sicherheit: Pfad-Prüfung
      const config = getConfig();
      const resolvedRoot = path.normalize(
        path.isAbsolute(config.targetPath) ? config.targetPath : path.resolve(getAppFolder(), config.targetPath)
      );
      const ensureTrailingSlash = (p) => (p.endsWith(path.sep) ? p : p + path.sep);

      if (!ensureTrailingSlash(path.normalize(targetDir)).startsWith(ensureTrailingSlash(resolvedRoot))) {
        return { success: false, error: 'Sicherheitsverletzung: Ordner liegt außerhalb des Software-Verzeichnisses.' };
      }

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

    // Neue Software hinzufügen (Pfad wird durch Drag & Drop direkt übergeben)
    ipcMain.handle('add-software-from-path', async (event, targetDir) => {
      console.log(`Ordner-Drop registriert von WebContents ID: ${event.sender.id}`);

      const config = getConfig();
      const resolvedRoot = path.normalize(
        path.isAbsolute(config.targetPath) ? config.targetPath : path.resolve(getAppFolder(), config.targetPath)
      );
      const ensureTrailingSlash = (p) => (p.endsWith(path.sep) ? p : p + path.sep);

      if (!ensureTrailingSlash(path.normalize(targetDir)).startsWith(ensureTrailingSlash(resolvedRoot))) {
        return {
          success: false,
          error: 'Sicherheitsverletzung: Ordner liegt außerhalb des konfigurierten Software-Verzeichnisses.',
        };
      }

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
        console.error('Fehler beim Hinzufügen der Software via Drop:', e);
        return { success: false, error: e.message };
      }
    });

    // Medien (Bilder, Videos) via Drag & Drop ins _metadata kopieren
    ipcMain.handle('add-media', async (event, targetPath, filePaths) => {
      console.log(`Media-Drop registriert von WebContents ID: ${event.sender.id}`);

      try {
        const config = getConfig();
        const resolvedRoot = path.normalize(
          path.isAbsolute(config.targetPath) ? config.targetPath : path.resolve(getAppFolder(), config.targetPath)
        );
        const resolvedTarget = path.normalize(targetPath);
        const ensureTrailingSlash = (p) => (p.endsWith(path.sep) ? p : p + path.sep);

        if (!ensureTrailingSlash(resolvedTarget).startsWith(ensureTrailingSlash(resolvedRoot))) {
          throw new Error('Sicherheitsverletzung: Zielpfad liegt außerhalb des zulässigen Software-Verzeichnisses.');
        }

        const metaDir = path.join(resolvedTarget, '_metadata');
        if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });

        for (const file of filePaths) {
          const fileName = path.basename(file);
          // Einfaches Kopieren (Bilder und Videos behalten ihren Dateinamen)
          await fs.promises.copyFile(file, path.join(metaDir, fileName));
        }

        return { success: true };
      } catch (e) {
        console.error('Fehler beim Hinzufügen von Medien:', e);
        return { success: false, error: e.message };
      }
    });

    // Handler speziell nur für das extrahieren/umbenennen des Icons
    ipcMain.handle('add-icon', async (event, targetPath, filePath) => {
      console.log(`Icon-Drop registriert von WebContents ID: ${event.sender.id}`);

      try {
        const config = getConfig();
        const resolvedRoot = path.normalize(
          path.isAbsolute(config.targetPath) ? config.targetPath : path.resolve(getAppFolder(), config.targetPath)
        );
        const resolvedTarget = path.normalize(targetPath);
        const ensureTrailingSlash = (p) => (p.endsWith(path.sep) ? p : p + path.sep);

        if (!ensureTrailingSlash(resolvedTarget).startsWith(ensureTrailingSlash(resolvedRoot))) {
          throw new Error('Sicherheitsverletzung: Zielpfad liegt außerhalb des zulässigen Software-Verzeichnisses.');
        }

        const metaDir = path.join(resolvedTarget, '_metadata');
        if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });

        // Alte Icons aufräumen, damit wir keine Konflikte haben (z.B. icon.png und icon.jpg)
        const existing = await fs.promises.readdir(metaDir);
        for (const f of existing) {
          if (f.toLowerCase().startsWith('icon.')) {
            await fs.promises.unlink(path.join(metaDir, f));
          }
        }

        // Kopieren und in icon.* umbenennen
        const ext = path.extname(filePath);
        const destName = `icon${ext}`;
        await fs.promises.copyFile(filePath, path.join(metaDir, destName));

        return { success: true };
      } catch (e) {
        console.error('Fehler beim Hinzufügen des Icons:', e);
        return { success: false, error: e.message };
      }
    });

    // Optimiert! Schreibt die JSON und aktualisiert catalog.json direkt, OHNE langen Scan!
    ipcMain.handle('save-meta-json', async (_event, targetPath, data) => {
      try {
        const config = getConfig();
        const resolvedRoot = path.normalize(
          path.isAbsolute(config.targetPath) ? config.targetPath : path.resolve(getAppFolder(), config.targetPath)
        );
        const resolvedTarget = path.normalize(targetPath);

        const ensureTrailingSlash = (p) => (p.endsWith(path.sep) ? p : p + path.sep);

        // Sicherheit: Pfad muss innerhalb des konfigurierten Software-Verzeichnisses liegen
        if (!ensureTrailingSlash(resolvedTarget).startsWith(ensureTrailingSlash(resolvedRoot))) {
          throw new Error(
            'Sicherheitsverletzung: Speicherpfad liegt außerhalb des zulässigen Software-Verzeichnisses.'
          );
        }

        const metaDir = path.join(resolvedTarget, '_metadata');
        if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
        const metaFile = path.join(metaDir, 'meta.json');

        fs.writeFileSync(metaFile, JSON.stringify(data, null, 2), 'utf-8');

        // catalog.json direkt aktualisieren (Performance Boost)
        if (fs.existsSync(config.absJsonPath)) {
          const relPath = path.relative(config.appFolder, resolvedTarget);
          const catData = JSON.parse(fs.readFileSync(config.absJsonPath, 'utf-8'));
          const catIdx = catData.findIndex((i) => i.path === relPath);

          if (catIdx > -1) {
            catData[catIdx].name = data.name || path.basename(resolvedTarget);
            catData[catIdx].description = Array.isArray(data.description)
              ? data.description.join('<br>')
              : data.description;
            catData[catIdx].hiddenCategory = data.hiddenCategory ? data.hiddenCategory.trim() : '';
            catData[catIdx].os = data.os || [];
            catData[catIdx].mainCategory = data.category || '';
            catData[catIdx].subCategories = data.tags || [];
            catData[catIdx].formats = data.formats || [];
            catData[catIdx].links = Object.entries(data.links || {}).map(([label, url]) => ({ label, url }));

            // Atomares Schreiben für catalog.json
            const tmpFile = `${config.absJsonPath}.tmp`;
            fs.writeFileSync(tmpFile, JSON.stringify(catData, null, 2), 'utf-8');
            fs.renameSync(tmpFile, config.absJsonPath);
          }
        }

        return { success: true };
      } catch (e) {
        console.error('Fehler beim Speichern der meta.json:', e);
        return { success: false, error: e.message };
      }
    });

    createWindow();
  });
}
