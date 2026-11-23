import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import { mergeInstalledSoftware } from '../shared/installed-merger.js';
import { compareVersions, extractVersion } from '../shared/version.js';
import { loadCatalogWithLiveStatus, saveMetaJson } from './catalog-service.js';
import { getConfig, getIconCacheDir, saveConfig } from './config.js';
import { createJob } from './jobs.js';
import { wingetProvider } from './providers/winget-provider.js';
import { scanSingleFolder } from './scanner-bridge.js';

function runPowerShell(script, { signal = null, asTempFile = false } = {}) {
  return new Promise((resolve) => {
    let tempFile = null;
    let args;

    if (asTempFile) {
      tempFile = path.join(app.getPath('temp'), `sk_ps_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
      fs.writeFileSync(tempFile, `\uFEFF${script}`, 'utf-8');
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempFile];
    } else {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
    }

    const child = spawn('powershell.exe', args);
    let stdout = '';
    let stderr = '';

    const onAbort = () => {
      if (!child.killed) child.kill('SIGTERM');
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (tempFile) {
        try {
          if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        } catch {
          // Ignorieren
        }
      }
    };

    child.on('exit', (code) => {
      cleanup();
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    child.on('error', (err) => {
      cleanup();
      resolve({ code: -1, stdout: '', stderr: err.message });
    });
  });
}

/**
 * Liest die Version einer einzelnen lokalen .exe oder .msi Datei aus (Fallback für Auto-Benennung).
 */
export async function getFileVersion(filePath) {
  const safePath = filePath.replace(/'/g, "''");
  const lower = filePath.toLowerCase();

  let psScript =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference = "SilentlyContinue"\n';
  if (lower.endsWith('.msi')) {
    psScript += `
      $wi = New-Object -ComObject WindowsInstaller.Installer
      $db = $wi.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $wi, @('${safePath}', 0))
      $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @("SELECT Value FROM Property WHERE Property = 'ProductVersion'"))
      $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
      $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
      if ($rec) { Write-Output ($rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, 1)) }
    `;
  } else {
    psScript += `
      $v = (Get-Item -LiteralPath '${safePath}').VersionInfo
      if ($v) {
        $raw = if ($v.ProductVersion) { $v.ProductVersion } else { $v.FileVersion }
        Write-Output $raw
      }
    `;
  }

  const { stdout } = await runPowerShell(psScript);
  return extractVersion(stdout);
}

/**
 * Prüft installierte PC-Versionen (alle oder gezielt für einzelne itemIds).
 */
export async function scanLocalVersions({ itemIds = null, silent = false } = {}) {
  const { absJsonPath, installedVersions } = getConfig();
  if (!fs.existsSync(absJsonPath)) return { success: false, error: 'Katalog nicht gefunden.' };

  let job = null;
  if (!silent) {
    job = createJob({
      type: 'local-versions',
      title: 'Installierte Versionen prüfen (PC)',
      dedupeKey: 'local-versions',
      cancelable: true,
    });
    if (!job) return { success: false, alreadyRunning: true };
  }

  try {
    const data = JSON.parse(fs.readFileSync(absJsonPath, 'utf-8'));
    const updatedVersions = { ...(installedVersions || {}) };
    const targets = [];

    for (const item of data) {
      if (itemIds && !itemIds.includes(item.id)) continue;

      const allPaths = [...(item.autoPaths || []), ...(item.installPaths || [])];
      const existingExe = allPaths.find((p) => fs.existsSync(p) && p.toLowerCase().endsWith('.exe')) || '';

      // Bei gezielter Prüfung (nach Installation) auch ohne Pfad über Registry-Namen prüfen
      if (existingExe || itemIds) {
        targets.push({
          id: item.id,
          path: existingExe,
          names: [item.name, ...(item.searchNames || [])].filter(Boolean),
        });
      }
    }

    if (targets.length === 0) {
      job?.finish('done', 'Keine lokal zugeordneten Programme gefunden.');
      return { success: true, count: 0, versions: updatedVersions };
    }

    job?.update(25, `Prüfe ${targets.length} Programme in Registry & Dateisystem...`);

    let psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $ErrorActionPreference = 'SilentlyContinue'
      $regPaths = @(
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      )
      $allReg = Get-ItemProperty -Path $regPaths -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -and $_.DisplayVersion }
    `;

    for (const t of targets) {
      const psNames = t.names.map((n) => `"${n.replace(/"/g, '""')}"`).join(',');
      const safePath = t.path.replace(/'/g, "''");

      psScript += `
        $ver = $null
        $names = @(${psNames})
        foreach ($name in $names) {
          if ([string]::IsNullOrWhiteSpace($name)) { continue }
          $escName = [regex]::Escape($name.Trim())
          $match = $allReg | Where-Object {
            $disp = [string]$_.DisplayName
            $m1 = $disp -match $escName
            $m2 = ($disp.Length -ge 5) -and ($disp.Length -ge ($name.Length * 0.8)) -and ($name -match [regex]::Escape($disp))
            $m1 -or $m2
          } | Select-Object -First 1
          if ($match) { $ver = $match.DisplayVersion; break }
        }
        if (-not $ver -and '${safePath}') {
          $v = (Get-Item -LiteralPath '${safePath}' -ErrorAction SilentlyContinue).VersionInfo
          if ($v) { $ver = if ($v.FileVersion) { $v.FileVersion } else { $v.ProductVersion } }
        }
        if ($ver) { Write-Output "${t.id}|$ver" }
      `;
    }

    const { stdout } = await runPowerShell(psScript, { signal: job?.signal, asTempFile: true });
    if (job?.signal.aborted) return { success: false, canceled: true };

    let updatedCount = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const [id, rawVer] = line.split('|');
      if (id && rawVer) {
        const ver = extractVersion(rawVer);
        if (ver) {
          updatedVersions[id.trim()] = ver;
          updatedCount++;
        }
      }
    }

    saveConfig({ installedVersions: updatedVersions });
    job?.finish('done', `${updatedCount} installierte Versionen aktualisiert.`);
    return { success: true, count: updatedCount, versions: updatedVersions };
  } catch (e) {
    job?.finish('error', e.message, { autoRemoveMs: 5000 });
    return { success: false, error: e.message };
  }
}

export async function autoDetectPath(namesArray, signal = null) {
  const psNames = (namesArray || [])
    .filter(Boolean)
    .map((n) => `"${n.replace(/"/g, '""')}"`)
    .join(',');

  if (!psNames) return { success: false, error: 'Keine Suchnamen angegeben.' };

  const psScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $ErrorActionPreference = 'SilentlyContinue'

    function Get-MainExeFromFolder($dir, $appName) {
      $wsh = New-Object -ComObject WScript.Shell
      $smPaths = @([Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs'))
      $dir = $dir -replace '^"|"$', ''
      $parentDir = $dir
      $cleanAppName = $appName.Trim() -replace '[\\*\\?]', ''
      $searchEscaped = [regex]::Escape($cleanAppName)

      try {
        $parent = [System.IO.Directory]::GetParent($dir)
        if ($parent -and $parent.Name -notmatch '(?i)^Program Files|^Programme|^Windows|^Appdata|^Local|^Roaming') {
          $parentDir = $parent.FullName
        }
      } catch {}

      $validTargets = @()
      foreach ($sm in $smPaths) {
        $lnks = Get-ChildItem -LiteralPath $sm -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue
        foreach ($lnkFile in $lnks) {
          $target = $wsh.CreateShortcut($lnkFile.FullName).TargetPath
          if ($target -match '(?i)\\.exe$' -and (Test-Path -LiteralPath $target)) {
            if ($target.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase) -or $target.StartsWith($parentDir, [System.StringComparison]::OrdinalIgnoreCase)) {
              $validTargets += [PSCustomObject]@{ LnkName = $lnkFile.Name; Target = $target }
            }
          }
        }
      }

      if ($validTargets.Count -gt 0) {
        $bestByExe = $validTargets | Where-Object { [System.IO.Path]::GetFileName($_.Target) -match "(?i)$searchEscaped" } | Select-Object -First 1
        if ($bestByExe) { return $bestByExe.Target }
        $bestByLnk = $validTargets | Where-Object { $_.LnkName -match "(?i)$searchEscaped" } | Select-Object -First 1
        if ($bestByLnk) { return $bestByLnk.Target }
        return $validTargets[0].Target
      }

      $exes = Get-ChildItem -LiteralPath $dir -Filter "*.exe" -Recurse -Depth 2 -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '(?i)unins|uninstall|remove|update|crash|setup|agent' }
      if ($exes) {
        $bestExe = $exes | Where-Object { $_.Name -match "(?i)$searchEscaped" } | Sort-Object Length -Descending | Select-Object -First 1
        if ($bestExe) { return $bestExe.FullName }
        return ($exes | Sort-Object Length -Descending | Select-Object -First 1).FullName
      }
      return $null
    }

    $names = @(${psNames})
    $paths = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    )
    $allItems = Get-ItemProperty -Path $paths | Where-Object { $_.DisplayName }
    $found = $null

    foreach ($name in $names) {
      if ([string]::IsNullOrWhiteSpace($name) -or $name.Length -lt 2) { continue }
      $search = [regex]::Escape($name.Trim())
      $matchedItems = $allItems | Where-Object {
        $disp = [string]$_.DisplayName
        $m1 = $disp -match $search
        $m2 = ($disp.Length -ge 5) -and ($disp.Length -ge ($name.Length * 0.8)) -and ($name -match [regex]::Escape($disp))
        $m1 -or $m2
      }

      foreach ($item in $matchedItems) {
        if ($item.DisplayIcon -match '(?i)\\.exe') {
          $icon = $item.DisplayIcon -replace '",?\\d*$', '' -replace '^"|"$', ''
          if (Test-Path -LiteralPath $icon) { $found = $icon; break }
        }
        if ($item.InstallLocation) {
          $loc = $item.InstallLocation -replace '^"|"$', ''
          if (Test-Path -LiteralPath $loc) {
            $found = Get-MainExeFromFolder $loc $name
            if ($found) { break }
          }
        }
        if ($item.UninstallString -match '(?i)([a-z]:\\\\[^"]+\\.exe)') {
          $uninst = $matches[1]
          if (Test-Path -LiteralPath $uninst) {
            $found = Get-MainExeFromFolder (Split-Path $uninst) $name
            if ($found) { break } else { $found = $uninst; break }
          }
        }
      }

      if (-not $found) {
        $cleanName = $name.Trim() -replace '[\\*\\?]', ''
        $pfs = @([Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86')) | Select-Object -Unique
        foreach ($pf in $pfs) {
          $exes = Get-ChildItem -LiteralPath $pf -Filter "*$cleanName*.exe" -Recurse -Depth 3 -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '(?i)unins|uninstall|remove|update|crash|setup|agent' }
          if ($exes) {
            $found = ($exes | Sort-Object Length -Descending | Select-Object -First 1).FullName
            break
          }
        }
      }
      if ($found) { break }
    }
    if ($found) { Write-Output $found.Trim() }
  `;

  const { stdout } = await runPowerShell(psScript, { signal });
  if (stdout && stdout.length > 3) {
    return { success: true, path: stdout };
  }
  return { success: false, error: 'Kein passender Eintrag gefunden.' };
}

export async function autoDetectAllMissingPaths(catalogItems) {
  const targets = catalogItems.filter(
    (i) => (!i.softwareType || i.softwareType === 'default') && (!i.autoPaths || i.autoPaths.length === 0)
  );
  if (targets.length === 0) return { success: true, found: 0, total: 0 };

  const job = createJob({
    type: 'auto-detect',
    title: 'Installationspfade suchen',
    dedupeKey: 'auto-detect',
    cancelable: true,
  });
  if (!job) return { success: false, alreadyRunning: true };

  let foundCount = 0;
  for (let idx = 0; idx < targets.length; idx++) {
    if (job.signal.aborted) return { success: false, canceled: true };
    const item = targets[idx];
    job.update((idx / targets.length) * 100, `Prüfe ${item.name} (${idx + 1}/${targets.length})...`);

    const res = await autoDetectPath([item.name, ...(item.searchNames || [])], job.signal);
    if (res.success && res.path) {
      if (!item.icon) {
        await extractExeIcon(res.path, item.path);
      }

      const metaPath = path.join(item.path, '_metadata', 'meta.json');
      const existingMeta = fs.existsSync(metaPath)
        ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
        : { name: item.name };
      existingMeta.autoPaths = [res.path];
      await saveMetaJson(item.path, existingMeta);
      foundCount++;
    }
  }

  job.update(98, 'Lese lokale Versionen aus...');
  await scanLocalVersions({ silent: true });
  job.finish('done', `${foundCount} von ${targets.length} Pfaden gefunden.`);
  return { success: true, found: foundCount, total: targets.length };
}

export async function getInstalledApps() {
  const psScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $ErrorActionPreference = 'SilentlyContinue'
    $paths = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    )
    $items = Get-ItemProperty -Path $paths | Select-Object -ExpandProperty DisplayName -Unique | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    $items | Sort-Object | ForEach-Object { Write-Output $_.Trim() }
  `;
  const { stdout } = await runPowerShell(psScript);
  return stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function extractExeIcon(exePath, targetSoftwareDir) {
  try {
    const metaDir = path.join(targetSoftwareDir, '_metadata');
    if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });

    const icon = await app.getFileIcon(exePath, { size: 'normal' });
    if (icon.isEmpty()) return { success: false, error: 'Kein Icon in Datei gefunden.' };

    const existing = await fs.promises.readdir(metaDir);
    for (const f of existing) {
      if (f.toLowerCase().startsWith('icon.')) {
        await fs.promises.unlink(path.join(metaDir, f));
      }
    }

    await fs.promises.writeFile(path.join(metaDir, 'icon.png'), icon.toPNG());
    await scanSingleFolder(targetSoftwareDir);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Kopiert das Setup lokal ins Temp-Verzeichnis, wartet auf den Abschluss,
 * wertet den Windows-ExitCode aus und verifiziert anschließend die installierte Version.
 */
export async function executeAndVerifyInstaller({
  itemId,
  itemName,
  sourcePath,
  targetVersion = null,
  useJob = true,
  onProgress = null,
}) {
  const cfg = getConfig();
  const depth = cfg.versionCompareDepth ?? 3;
  const oldVersion = cfg.installedVersions?.[itemId] || null;
  const expectedVersion = targetVersion || extractVersion(path.basename(sourcePath));
  const ext = path.extname(sourcePath).toLowerCase();

  // Archive (.zip, .7z, .rar) lassen sich nicht als Installer überwachen -> direkt öffnen
  if (!['.exe', '.msi', '.msix', '.bat', '.cmd'].includes(ext)) {
    const err = await shell.openPath(sourcePath);
    return err ? { success: false, error: err } : { success: true, status: 'opened' };
  }

  let job = null;
  if (useJob) {
    job = createJob({
      type: 'install',
      title: `Installation: ${itemName || path.basename(sourcePath)}`,
      dedupeKey: `install:${itemId}`,
      cancelable: false,
    });
    if (!job) return { success: false, alreadyRunning: true };
  }

  const reportProgress = (pct, detail) => {
    job?.update(pct, detail);
    onProgress?.(pct, detail);
  };

  const tempDir = app.getPath('temp');
  const tempPath = path.join(tempDir, `sk_install_${Date.now()}_${path.basename(sourcePath)}`);

  try {
    reportProgress(15, 'Kopiere Setup-Datei aus dem Archiv in lokalen Temp-Ordner...');
    await fs.promises.copyFile(sourcePath, tempPath);

    reportProgress(null, 'Installer läuft - bitte Setup-Assistent abschließen...');
    const safeTemp = tempPath.replace(/'/g, "''");

    const launchScript =
      ext === '.msi'
        ? `
          try {
            $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', '${safeTemp}') -Wait -PassThru
            Write-Output "EXIT:$($p.ExitCode)"
          } catch {
            Write-Output "ERR:$($_.Exception.Message)"
          }
        `
        : `
          try {
            $p = Start-Process -FilePath '${safeTemp}' -Wait -PassThru
            Write-Output "EXIT:$($p.ExitCode)"
          } catch {
            Write-Output "ERR:$($_.Exception.Message)"
          }
        `;

    const { stdout } = await runPowerShell(launchScript);

    // Temp-Datei aufräumen
    try {
      if (fs.existsSync(tempPath)) await fs.promises.unlink(tempPath);
    } catch {
      // Manchmal hält ein Kindprozess die Datei kurz fest
    }

    if (stdout.startsWith('ERR:')) {
      const msg = stdout.replace('ERR:', '').trim();
      const wasCanceled = /abgebrochen|canceled|cancelled|1223/i.test(msg);
      job?.finish(wasCanceled ? 'canceled' : 'error', wasCanceled ? 'Installation durch Benutzer abgebrochen.' : msg, {
        autoRemoveMs: 4000,
      });
      return { success: false, canceled: wasCanceled, error: msg };
    }

    const exitMatch = stdout.match(/EXIT:(-?\d+)/);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;

    if (exitCode === 1602 || exitCode === 1223) {
      job?.finish('canceled', 'Installation wurde abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode };
    }

    // Kurz warten (Windows-Registry braucht manchmal ~1 Sekunde zum Flushen)
    reportProgress(85, 'Prüfe installierte Version auf diesem PC...');
    await new Promise((r) => setTimeout(r, 1500));

    const verifyRes = await scanLocalVersions({ itemIds: [itemId], silent: true });
    const newVersion = verifyRes.versions?.[itemId] || null;

    const reachedTarget = expectedVersion && newVersion && compareVersions(newVersion, expectedVersion, depth) >= 0;
    const bumpedVersion = newVersion && oldVersion && compareVersions(newVersion, oldVersion, depth) > 0;

    if (reachedTarget || bumpedVersion) {
      job?.finish('done', `Erfolgreich installiert (v${newVersion})`, { autoRemoveMs: 4000 });
      return { success: true, verified: true, newVersion, exitCode };
    }

    if (exitCode === 0 || exitCode === 3010) {
      const rebootHint = exitCode === 3010 ? ' (Neustart empfohlen)' : '';
      job?.finish('done', `Setup beendet${rebootHint} - neue Version noch nicht erkannt (läuft ggf. im Hintergrund).`, {
        autoRemoveMs: 0, // Bleibt sichtbar mit Aktion!
        action: { label: 'Status erneut prüfen', type: 'recheck-local', itemId },
      });
      return { success: true, verified: false, newVersion, exitCode };
    }

    job?.finish('error', `Installer meldete Fehlercode ${exitCode}.`, { autoRemoveMs: 6000 });
    return { success: false, exitCode, error: `ExitCode ${exitCode}` };
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) await fs.promises.unlink(tempPath);
    } catch {
      // Ignorieren
    }
    job?.finish('error', err.message, { autoRemoveMs: 5000 });
    return { success: false, error: err.message };
  }
}

// ==========================================
// ERWEITERTER PC-SCANNER, ICON-CACHE & DEINSTALLATION
// ==========================================
export async function readRegistryUninstallEntries(signal = null) {
  const psScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $ErrorActionPreference = 'SilentlyContinue'
    $paths = @(
      'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    )
    $items = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_.DisplayName) } |
      ForEach-Object {
        [PSCustomObject]@{
          displayName = [string]$_.DisplayName
          displayVersion = [string]$_.DisplayVersion
          publisher = [string]$_.Publisher
          uninstallString = [string]$_.UninstallString
          quietUninstallString = [string]$_.QuietUninstallString
          displayIcon = [string]$_.DisplayIcon
          installLocation = [string]$_.InstallLocation
          registryKey = [string]$_.PSChildName
          systemComponent = if ($null -ne $_.SystemComponent) { [int]$_.SystemComponent } else { 0 }
          parentKeyName = [string]$_.ParentKeyName
        }
      }
    ConvertTo-Json -InputObject @($items) -Depth 3 -Compress
  `;

  const { code, stdout } = await runPowerShell(psScript, { signal, asTempFile: true });
  if (signal?.aborted || code === -1 || !stdout) return [];

  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    console.warn('Registry-JSON konnte nicht geparst werden:', e.message);
    return [];
  }
}

function syncArchiveInstalledVersions(programs) {
  const cfg = getConfig();
  const nextVersions = { ...(cfg.installedVersions || {}) };
  let changed = false;

  for (const prog of programs) {
    if (prog.archiveItemId && prog.installedVersion) {
      const normalized = extractVersion(prog.installedVersion) || prog.installedVersion;
      if (nextVersions[prog.archiveItemId] !== normalized) {
        nextVersions[prog.archiveItemId] = normalized;
        changed = true;
      }
    }
  }

  if (changed) {
    saveConfig({ installedVersions: nextVersions });
  }
}

/**
 * Kombiniert `winget export`, `winget upgrade` und Windows-Registry-Uninstall-Daten
 * zu einer vollständigen Liste aller auf diesem PC installierten Programme.
 */
export async function scanInstalledSoftware({ includeSystemComponents = false, silent = false } = {}) {
  let job = null;
  if (!silent) {
    job = createJob({
      type: 'pc-scan',
      title: 'PC-Programme & Updates scannen',
      dedupeKey: 'pc-scan',
      cancelable: true,
    });
    if (!job) return { success: false, alreadyRunning: true, error: 'Ein PC-Scan läuft bereits.' };
  }

  const signal = job?.signal || null;

  try {
    job?.update(15, 'Lese Windows-Registry, Winget-Export & verfügbare Updates...');

    const [registryEntries, exportRes, upgradeRes] = await Promise.all([
      readRegistryUninstallEntries(signal),
      wingetProvider.listInstalled({ signal }),
      wingetProvider.listUpgrades({ signal }),
    ]);

    if (signal?.aborted) {
      return { success: false, canceled: true };
    }

    job?.update(80, 'Verknüpfe installierte Programme mit Archiv-Katalog...');
    const catalogItems = loadCatalogWithLiveStatus();

    const wingetExports = exportRes.success ? exportRes.packages : [];
    const wingetUpgrades = upgradeRes.success ? upgradeRes.upgrades : [];

    const programs = mergeInstalledSoftware({
      wingetExports,
      wingetUpgrades,
      registryEntries,
      catalogItems,
      includeSystemComponents,
    });

    syncArchiveInstalledVersions(programs);

    const stats = {
      total: programs.length,
      updatesAvailable: programs.filter((p) => p.hasUpdate).length,
      wingetManaged: programs.filter((p) => p.packageManager === 'winget').length,
      inArchive: programs.filter((p) => p.inArchive).length,
    };

    job?.finish('done', `${stats.total} Programme erfasst (${stats.updatesAvailable} Updates verfügbar)`);
    return {
      success: true,
      programs,
      stats,
      wingetAvailable: exportRes.success || upgradeRes.success,
      scannedAt: Date.now(),
    };
  } catch (e) {
    job?.finish('error', e.message, { autoRemoveMs: 5000 });
    return { success: false, error: e.message };
  }
}

function cleanDisplayIconPath(raw) {
  if (!raw) return '';
  return String(raw)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/,-?\d+$/, '')
    .trim();
}

async function resolveExecutableForIcon({ displayIcon = '', installLocation = '', executablePath = '' }) {
  const candidates = [];
  const cleanedIcon = cleanDisplayIconPath(displayIcon);
  if (cleanedIcon) candidates.push(cleanedIcon);
  if (executablePath)
    candidates.push(
      String(executablePath)
        .trim()
        .replace(/^["']|["']$/g, '')
    );

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  const cleanLoc = String(installLocation || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (cleanLoc && fs.existsSync(cleanLoc)) {
    try {
      const entries = await fs.promises.readdir(cleanLoc, { withFileTypes: true });
      const exeFiles = entries
        .filter((e) => e.isFile() && /\.exe$/i.test(e.name) && !/unins|uninstall|setup|update|crash/i.test(e.name))
        .map((e) => path.join(cleanLoc, e.name));
      if (exeFiles.length > 0) return exeFiles[0];
    } catch {
      // Ordner nicht lesbar
    }
  }

  return '';
}

/**
 * Extrahiert ein Programm-Icon on-demand sicher in `userData/icon-cache/` für `catalog-media://`.
 */
export async function extractCachedAppIcon({ id, displayIcon = '', installLocation = '', executablePath = '' }) {
  if (!id) return { success: false, error: 'Keine Programm-ID für Icon-Cache angegeben.' };

  try {
    const cacheDir = getIconCacheDir();
    const hash = crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 24);
    const iconPath = path.join(cacheDir, `${hash}.png`);

    if (fs.existsSync(iconPath)) {
      return { success: true, iconPath, fromCache: true };
    }

    const sourceFile = await resolveExecutableForIcon({ displayIcon, installLocation, executablePath });
    if (!sourceFile) {
      return { success: false, error: 'Keine ausführbare Datei oder Icon-Quelle gefunden.' };
    }

    const icon = await app.getFileIcon(sourceFile, { size: 'normal' });
    if (icon.isEmpty()) {
      return { success: false, error: 'Kein Icon in Quelldatei gefunden.' };
    }

    const tmpPath = `${iconPath}.tmp`;
    await fs.promises.writeFile(tmpPath, icon.toPNG());
    await fs.promises.rename(tmpPath, iconPath);

    return { success: true, iconPath, fromCache: false };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function parseRegistryUninstallCommand(rawCommand, silent = false) {
  const cmd = String(rawCommand || '').trim();
  if (!cmd) return null;

  if (/(?:^|[\\/])msiexec(?:\.exe)?\b/i.test(cmd)) {
    let argsStr = cmd.replace(/^["']?[^"'\s]*msiexec(?:\.exe)?["']?\s*/i, '').trim();
    argsStr = argsStr.replace(/(^|\s)\/I(?=\{|\s)/gi, '$1/X');
    if (silent && !/\/q[nrb]?\b/i.test(argsStr)) {
      argsStr = `${argsStr} /qn /norestart`.trim();
    }
    return { filePath: 'msiexec.exe', argsStr };
  }

  const quotedMatch = cmd.match(/^"([^"]+)"\s*(.*)$/);
  if (quotedMatch) {
    return { filePath: quotedMatch[1], argsStr: quotedMatch[2].trim() };
  }

  const exeMatch = cmd.match(/^(.*?\.exe)(?:\s+(.*))?$/i);
  if (exeMatch) {
    return { filePath: exeMatch[1].trim(), argsStr: (exeMatch[2] || '').trim() };
  }

  return { filePath: cmd, argsStr: '' };
}

async function runRegistryUninstall(rawCommand, silent = false) {
  const parsed = parseRegistryUninstallCommand(rawCommand, silent);
  if (!parsed?.filePath) {
    return { success: false, error: 'Ungültiger Deinstallationsbefehl.' };
  }

  const safeFile = parsed.filePath.replace(/'/g, "''");
  const safeArgs = parsed.argsStr.replace(/'/g, "''");
  const argClause = safeArgs ? `-ArgumentList '${safeArgs}'` : '';

  const psScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    try {
      $p = Start-Process -FilePath '${safeFile}' ${argClause} -Wait -PassThru
      Write-Output "EXIT:$($p.ExitCode)"
    } catch {
      Write-Output "ERR:$($_.Exception.Message)"
    }
  `;

  const { stdout } = await runPowerShell(psScript);
  if (stdout.startsWith('ERR:')) {
    const msg = stdout.replace('ERR:', '').trim();
    const wasCanceled = /abgebrochen|canceled|cancelled|1223/i.test(msg);
    return { success: false, canceled: wasCanceled, error: msg };
  }

  const exitMatch = stdout.match(/EXIT:(-?\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;

  if (exitCode === 1602 || exitCode === 1223) {
    return { success: false, canceled: true, exitCode };
  }
  if (exitCode === 0 || exitCode === 3010) {
    return { success: true, exitCode, rebootRequired: exitCode === 3010 };
  }
  return { success: false, exitCode, error: `Deinstaller meldete Fehlercode ${exitCode}.` };
}

function clearAndRefreshAffectedItems({ archiveItemId = null, packageId = '' }) {
  const cfg = getConfig();
  const affectedIds = new Set();
  if (archiveItemId) affectedIds.add(archiveItemId);

  if (packageId) {
    const pkgLower = packageId.toLowerCase();
    for (const item of loadCatalogWithLiveStatus()) {
      const itemPkg = (item.packageId || item.wingetId || '').toLowerCase();
      if (itemPkg && itemPkg === pkgLower) {
        affectedIds.add(item.id);
      }
    }
  }

  if (affectedIds.size === 0) return [];

  const updatedVersions = { ...(cfg.installedVersions || {}) };
  let removed = false;
  for (const id of affectedIds) {
    if (Object.hasOwn(updatedVersions, id)) {
      delete updatedVersions[id];
      removed = true;
    }
  }
  if (removed) {
    saveConfig({ installedVersions: updatedVersions });
  }

  return [...affectedIds];
}

/**
 * Deinstalliert ein Programm (bevorzugt über `winget uninstall --id <ID> --exact`, sonst Registry UninstallString),
 * wartet auf Abschluss über den Job-Manager und aktualisiert den PC-Status.
 */
export async function uninstallSoftware({
  packageId = '',
  packageManager = '',
  uninstallString = '',
  quietUninstallString = '',
  itemName = '',
  archiveItemId = null,
  silent = false,
}) {
  const displayTitle = itemName || packageId || 'Programm';
  const useWinget = Boolean(packageId) && (!packageManager || packageManager === 'winget');
  const regCommand = silent && quietUninstallString ? quietUninstallString : uninstallString;

  if (!useWinget && !regCommand) {
    return { success: false, error: 'Keine Winget-ID oder Deinstallations-Befehl vorhanden.' };
  }

  const job = createJob({
    type: 'uninstall',
    title: `Deinstallation: ${displayTitle}`,
    dedupeKey: `uninstall:${packageId || displayTitle}`,
    cancelable: false,
  });
  if (!job) return { success: false, alreadyRunning: true, error: 'Deinstallation läuft bereits.' };

  try {
    let res;
    let method = 'registry';

    if (useWinget) {
      method = 'winget';
      job.update(null, `Deinstalliere ${displayTitle} über Winget...`);
      res = await wingetProvider.uninstall(packageId, { silent, itemName: displayTitle, useJob: false });

      if (!res.success && !res.canceled && regCommand) {
        method = 'registry-fallback';
        job.update(null, 'Winget fehlgeschlagen - starte Registry-Deinstaller...');
        res = await runRegistryUninstall(regCommand, silent);
      }
    } else {
      job.update(null, 'Deinstallationsprogramm läuft - bitte abschließen...');
      res = await runRegistryUninstall(regCommand, silent);
    }

    if (res.canceled) {
      job.finish('canceled', 'Deinstallation wurde abgebrochen.', { autoRemoveMs: 3500 });
      return { ...res, method };
    }

    if (!res.success) {
      job.finish('error', res.error || 'Deinstallation fehlgeschlagen.', { autoRemoveMs: 6000 });
      return { ...res, method };
    }

    job.update(85, 'Aktualisiere lokalen PC-Status...');
    await new Promise((r) => setTimeout(r, 1500));

    const affectedIds = clearAndRefreshAffectedItems({ archiveItemId, packageId });
    if (affectedIds.length > 0) {
      await scanLocalVersions({ itemIds: affectedIds, silent: true });
    }

    const msg = res.rebootRequired ? 'Deinstalliert (Neustart empfohlen).' : 'Erfolgreich deinstalliert.';
    job.finish('done', msg, { autoRemoveMs: 4000 });
    return { success: true, method, exitCode: res.exitCode ?? 0, rebootRequired: Boolean(res.rebootRequired) };
  } catch (e) {
    job.finish('error', e.message, { autoRemoveMs: 5000 });
    return { success: false, error: e.message };
  }
}
