import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import { getAppFolder, saveConfig } from './config.js';
import { createJob } from './jobs.js';

export async function checkAppUpdate() {
  try {
    const currentVersion = app.getVersion();
    const response = await fetch('https://api.github.com/repos/RaptorXilef/SoftwareKatalogApp/releases/latest', {
      headers: { 'User-Agent': 'SoftwareKatalogApp' },
    });

    if (!response.ok) return { error: `GitHub API Fehler: ${response.statusText}` };

    const data = await response.json();
    const latestVersion = data.tag_name.replace(/^v/, '');
    saveConfig({ lastUpdateCheck: Date.now() });

    const isPortable = app.isPackaged && process.execPath.toLowerCase().includes('portable');
    let updateAssetUrl = null;

    if (isPortable) {
      const asset = data.assets.find((a) => a.name.endsWith('-Portable.exe'));
      if (asset) updateAssetUrl = asset.browser_download_url;
    } else {
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
    return { error: e.message };
  }
}

export async function downloadAndInstallAppUpdate(url, isPortable) {
  const tempDir = app.getPath('temp');
  const fileName = url.toLowerCase().includes('.zip') ? 'sk_update.zip' : 'sk_update.exe';
  const tempFilePath = path.join(tempDir, fileName);

  const job = createJob({
    type: 'app-update',
    title: 'App-Update wird heruntergeladen',
    dedupeKey: 'app-update',
    cancelable: true,
  });
  if (!job) return { success: false, alreadyRunning: true };

  try {
    const res = await fetch(url, { redirect: 'follow', signal: job.signal });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);

    const total = parseInt(res.headers.get('content-length') || '0', 10);
    let downloaded = 0;
    const fileStream = fs.createWriteStream(tempFilePath);

    for await (const chunk of res.body) {
      if (job.signal.aborted) {
        fileStream.destroy();
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        return { success: false, canceled: true };
      }
      fileStream.write(chunk);
      downloaded += chunk.length;
      if (total > 0) {
        job.update(Math.round((downloaded / total) * 100), 'Lade neue App-Version...');
      }
    }
    await new Promise((r) => fileStream.end(r));

    job.update(100, 'Starte Update & Neustart...');

    const updateScriptPath = path.join(tempDir, 'sk_update.ps1');
    const cmdScriptPath = path.join(tempDir, 'sk_update.cmd');
    const appPath = isPortable ? process.execPath : getAppFolder();

    const psScript = isPortable
      ? `
        Move-Item -Path "${process.execPath}" -Destination "${process.execPath}.old" -Force
        Move-Item -Path "${tempFilePath}" -Destination "${process.execPath}" -Force
        Start-Process "${process.execPath}"
      `
      : `
        $extractPath = "${path.join(tempDir, 'sk_update_extract')}"
        $backupDir = "${path.join(tempDir, 'sk_update_backup')}"
        Remove-Item -Path $extractPath -Recurse -Force -ErrorAction SilentlyContinue
        Expand-Archive -Path "${tempFilePath}" -DestinationPath $extractPath -Force

        $sourceDir = $extractPath
        $subDirs = Get-ChildItem -Path $extractPath -Directory
        $filesInRoot = Get-ChildItem -Path $extractPath -File
        if ($subDirs.Count -eq 1 -and $filesInRoot.Count -eq 0) {
          $sourceDir = $subDirs[0].FullName
        }

        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        foreach ($item in @("data", "config.json", "catalog.json")) {
          $fullPath = Join-Path "${appPath}" $item
          if (Test-Path $fullPath) {
            Copy-Item -Path $fullPath -Destination $backupDir -Recurse -Force
          }
        }

        Copy-Item -Path "$sourceDir\\*" -Destination "${appPath}" -Recurse -Force
        Copy-Item -Path "$backupDir\\*" -Destination "${appPath}" -Recurse -Force

        Remove-Item -Path $backupDir -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path $extractPath -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -Path "${tempFilePath}" -Force -ErrorAction SilentlyContinue

        $exe = Get-ChildItem -Path "${appPath}" -Filter "*.exe" | Select-Object -First 1
        if ($exe) { Start-Process $exe.FullName }
      `;

    fs.writeFileSync(updateScriptPath, psScript, 'utf-8');
    const cmdContent = `@echo off
echo Software Katalog wird aktualisiert...
timeout /t 4 /nobreak > nul
powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "${updateScriptPath}"
del "${updateScriptPath}"
del "%~f0"`;

    fs.writeFileSync(cmdScriptPath, cmdContent, 'utf-8');
    shell.openPath(cmdScriptPath);

    setTimeout(() => app.quit(), 500);
    return { success: true };
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, canceled: true };
    job.finish('error', err.message, { autoRemoveMs: 6000 });
    return { success: false, error: err.message };
  }
}
