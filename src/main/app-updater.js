import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { buildUpdatePowerShellScript, selectReleaseAsset } from '../shared/app-update-logic.js';
import { getAppFolder, getInstallInfo, saveConfig } from './config.js';
import { createJob } from './jobs.js';

function resolveUpdateInstallKind(installKindOrIsPortable) {
  if (
    installKindOrIsPortable === 'installed' ||
    installKindOrIsPortable === 'portable-exe' ||
    installKindOrIsPortable === 'portable-dir'
  ) {
    return installKindOrIsPortable;
  }
  if (typeof installKindOrIsPortable === 'boolean') {
    return installKindOrIsPortable ? 'portable-exe' : getInstallInfo().installKind;
  }
  return getInstallInfo().installKind;
}

export async function checkAppUpdate() {
  try {
    const currentVersion = app.getVersion();
    const { installKind, arch, isAllUsersInstall, platform } = getInstallInfo();
    const response = await fetch('https://api.github.com/repos/RaptorXilef/SoftwareKatalogApp/releases/latest', {
      headers: { 'User-Agent': 'SoftwareKatalogApp' },
    });

    if (!response.ok) return { error: `GitHub API Fehler: ${response.statusText}` };

    const data = await response.json();
    const latestVersion = String(data.tag_name || '').replace(/^v/, '');
    saveConfig({ lastUpdateCheck: Date.now() });

    const selected = selectReleaseAsset(data.assets, { installKind, arch, platform });

    return {
      updateAvailable: currentVersion !== latestVersion,
      latestVersion,
      currentVersion,
      releaseUrl: data.html_url,
      updateAssetUrl: selected?.url || null,
      updateAssetName: selected?.name || null,
      installKind,
      arch,
      isAllUsersInstall,
      isPortable: installKind === 'portable-exe',
    };
  } catch (e) {
    return { error: e.message };
  }
}

export async function downloadAndInstallAppUpdate(url, installKindOrIsPortable) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(url || ''));
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return { success: false, error: 'Ungueltige Update-URL.' };
    }
  } catch {
    return { success: false, error: 'Ungueltige Update-URL.' };
  }

  const installInfo = getInstallInfo();
  const installKind = resolveUpdateInstallKind(installKindOrIsPortable);
  const tempDir = app.getPath('temp');
  const fileName =
    installKind === 'installed'
      ? 'sk_update_setup.exe'
      : installKind === 'portable-exe'
        ? 'sk_update_portable.exe'
        : 'sk_update.zip';
  const tempFilePath = path.join(tempDir, fileName);

  const job = createJob({
    type: 'app-update',
    title: 'App-Update wird heruntergeladen',
    dedupeKey: 'app-update',
    cancelable: true,
  });
  if (!job) return { success: false, alreadyRunning: true };

  try {
    const res = await fetch(parsedUrl.toString(), { redirect: 'follow', signal: job.signal });
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
    const psScript = buildUpdatePowerShellScript({
      installKind,
      isAllUsersInstall: installInfo.isAllUsersInstall,
      tempFilePath,
      execPath: process.execPath,
      portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE || '',
      appFolder: getAppFolder(),
      pid: process.pid,
    });

    // UTF-8 BOM stellt sicher, dass PowerShell 5.1 Sonderzeichen/Umlaute in Pfaden korrekt liest
    fs.writeFileSync(updateScriptPath, `\uFEFF${psScript}`, 'utf-8');

    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        updateScriptPath,
      ],
      {
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      }
    );
    child.unref();

    setTimeout(() => app.quit(), 500);
    return { success: true };
  } catch (err) {
    if (err.name === 'AbortError') return { success: false, canceled: true };
    job.finish('error', err.message, { autoRemoveMs: 6000 });
    return { success: false, error: err.message };
  }
}
