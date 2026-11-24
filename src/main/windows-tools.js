import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import {
  buildIconCacheKey,
  deriveGitHubAvatarUrl,
  expandWindowsEnvVars,
  extractCandidateHomepageUrls,
  isGenericIconSource,
  isIgnoredExecutableName,
  parseDisplayIcon,
  parseFaviconLinksFromHtml,
  scoreExecutableCandidate,
} from '../shared/icon-logic.js';
import { mergeInstalledSoftware } from '../shared/installed-merger.js';
import {
  normalizeInstallMode,
  resolveInstallExecutionPlan,
  sanitizeInnoInfFileName,
  sanitizeSilentArgs,
} from '../shared/installer-logic.js';
import { compareVersions, extractVersion } from '../shared/version.js';
import { loadCatalogWithLiveStatus, saveMetaJson } from './catalog-service.js';
import { getConfig, getIconCacheDir, isInsideTargetDir, saveConfig } from './config.js';
import { detectInstallerFile } from './installer-detector.js';
import { createJob } from './jobs.js';
import { isProviderEnabled } from './providers/registry.js';
import { getWingetCache, wingetProvider } from './providers/winget-provider.js';
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

    /** @type {any} */
    const child = spawn('powershell.exe', args);
    let stdout = '';
    let stderr = '';

    const onAbort = () => {
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {
          // Ignorieren
        }
      }
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

    const icon = await app.getFileIcon(exePath, { size: 'large' });
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

async function cleanupTempFiles(paths) {
  for (const p of paths) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) await fs.promises.unlink(p);
    } catch {
      // Manchmal hält ein Kindprozess die Datei kurz fest
    }
  }
}

/**
 * Kopiert das Setup lokal ins Temp-Verzeichnis, wartet auf den Abschluss,
 * wertet den Windows-ExitCode aus und verifiziert anschließend die installierte Version.
 * Respektiert `installMode` (`interactive` | `silent` | `interactive-required`) und optionale Inno-`.inf`-Dateien.
 */
export async function executeAndVerifyInstaller({
  itemId,
  itemName,
  sourcePath,
  targetVersion = null,
  useJob = true,
  onProgress = null,
  signal = null,
  allowSilent = false,
  silent = null,
  installMode = null,
  silentArgs = null,
  innoInfFile = null,
  itemPath = null,
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

  let catItem = null;
  if (
    itemId &&
    (installMode === null ||
      installMode === undefined ||
      silentArgs === null ||
      silentArgs === undefined ||
      innoInfFile === null ||
      innoInfFile === undefined ||
      !itemPath)
  ) {
    catItem = loadCatalogWithLiveStatus().find((c) => c.id === itemId) || null;
  }

  const effectiveMode = normalizeInstallMode(installMode ?? catItem?.installMode);
  let effectiveSilentArgs = sanitizeSilentArgs(silentArgs ?? catItem?.silentArgs ?? '');
  const effectiveInfName = sanitizeInnoInfFileName(innoInfFile ?? catItem?.innoInfFile ?? '');
  const effectiveItemPath = itemPath || catItem?.path || '';
  const effectiveAllowSilent = silent === null ? Boolean(allowSilent) : Boolean(silent);
  const forceSilent = silent === true;

  if (forceSilent && effectiveMode !== 'interactive-required' && !effectiveSilentArgs && fs.existsSync(sourcePath)) {
    const detected = await detectInstallerFile(sourcePath, {
      name: itemName || catItem?.name || '',
      packageId: catItem?.packageId || catItem?.wingetId || '',
      publisher: catItem?.publisher || '',
    });
    if (detected?.success && detected.suggestedArgs) {
      effectiveSilentArgs = sanitizeSilentArgs(detected.suggestedArgs);
    }
  }

  const tempDir = app.getPath('temp');
  const stamp = Date.now();
  const tempPath = path.join(tempDir, `sk_install_${stamp}_${path.basename(sourcePath)}`);

  const sourceInfPath =
    (effectiveMode === 'silent' || forceSilent) &&
    effectiveAllowSilent &&
    effectiveMode !== 'interactive-required' &&
    effectiveInfName &&
    effectiveItemPath
      ? path.join(effectiveItemPath, '_metadata', effectiveInfName)
      : '';
  const hasValidSourceInf = Boolean(sourceInfPath && fs.existsSync(sourceInfPath));
  const tempInfPath = hasValidSourceInf ? path.join(tempDir, `sk_inf_${stamp}_${effectiveInfName}`) : '';

  const plan = resolveInstallExecutionPlan({
    installMode: effectiveMode,
    silentArgs: effectiveSilentArgs,
    innoInfPath: tempInfPath,
    ext,
    allowSilent: effectiveAllowSilent,
    forceSilent,
  });

  const displayName = itemName || catItem?.name || path.basename(sourcePath);
  let job = null;
  if (useJob) {
    const jobTitle = plan.adwareProtected
      ? `Installation: ${displayName} · 🛡️ Interaktiv (Adware-Schutz)`
      : plan.effectiveSilent
        ? `Stille Installation: ${displayName} ⚡`
        : `Installation: ${displayName}`;
    job = createJob({
      type: 'install',
      title: jobTitle,
      dedupeKey: `install:${itemId}`,
      cancelable: false,
    });
    if (!job) return { success: false, alreadyRunning: true };
  }

  const reportProgress = (pct, detail) => {
    job?.update(pct, detail);
    onProgress?.(pct, detail);
  };

  try {
    if (signal?.aborted) {
      job?.finish('canceled', 'Installation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true };
    }

    reportProgress(15, 'Kopiere Setup-Datei aus dem Archiv in lokalen Temp-Ordner...');
    await fs.promises.copyFile(sourcePath, tempPath);
    if (tempInfPath && sourceInfPath) {
      await fs.promises.copyFile(sourceInfPath, tempInfPath);
    }

    if (signal?.aborted) {
      await cleanupTempFiles([tempPath, tempInfPath]);
      job?.finish('canceled', 'Installation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true };
    }

    reportProgress(null, plan.bannerHint);
    const safeTemp = tempPath.replace(/'/g, "''");
    const safeExtraArgs = plan.extraArgs.replace(/'/g, "''");
    const msiArgList = safeExtraArgs ? `/i "${safeTemp}" ${safeExtraArgs}` : `/i "${safeTemp}"`;
    const exeArgClause = safeExtraArgs ? `-ArgumentList '${safeExtraArgs}'` : '';

    const launchScript =
      ext === '.msi'
        ? `
          try {
            $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList '${msiArgList}' -Wait -PassThru
            Write-Output "EXIT:$($p.ExitCode)"
          } catch {
            Write-Output "ERR:$($_.Exception.Message)"
          }
        `
        : `
          try {
            $p = Start-Process -FilePath '${safeTemp}' ${exeArgClause} -Wait -PassThru
            Write-Output "EXIT:$($p.ExitCode)"
          } catch {
            Write-Output "ERR:$($_.Exception.Message)"
          }
        `;

    const { stdout } = await runPowerShell(launchScript, { signal });

    // Temp-Dateien aufräumen
    await cleanupTempFiles([tempPath, tempInfPath]);

    if (signal?.aborted) {
      job?.finish('canceled', 'Installation abgebrochen.', { autoRemoveMs: 3500 });
      return {
        success: false,
        canceled: true,
        effectiveSilent: plan.effectiveSilent,
        adwareProtected: plan.adwareProtected,
        usedInf: plan.usedInf,
      };
    }

    if (stdout.startsWith('ERR:')) {
      const msg = stdout.replace('ERR:', '').trim();
      const wasCanceled = /abgebrochen|canceled|cancelled|1223/i.test(msg);
      job?.finish(wasCanceled ? 'canceled' : 'error', wasCanceled ? 'Installation durch Benutzer abgebrochen.' : msg, {
        autoRemoveMs: 4000,
      });
      return {
        success: false,
        canceled: wasCanceled,
        error: msg,
        effectiveSilent: plan.effectiveSilent,
        adwareProtected: plan.adwareProtected,
        usedInf: plan.usedInf,
      };
    }

    const exitMatch = stdout.match(/EXIT:(-?\d+)/);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;

    if (exitCode === 1602 || exitCode === 1223) {
      job?.finish('canceled', 'Installation wurde abgebrochen.', { autoRemoveMs: 3500 });
      return {
        success: false,
        canceled: true,
        exitCode,
        effectiveSilent: plan.effectiveSilent,
        adwareProtected: plan.adwareProtected,
        usedInf: plan.usedInf,
      };
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
      return {
        success: true,
        verified: true,
        newVersion,
        exitCode,
        effectiveSilent: plan.effectiveSilent,
        adwareProtected: plan.adwareProtected,
        usedInf: plan.usedInf,
      };
    }

    if (exitCode === 0 || exitCode === 3010) {
      const rebootHint = exitCode === 3010 ? ' (Neustart empfohlen)' : '';
      job?.finish('done', `Setup beendet${rebootHint} - neue Version noch nicht erkannt (läuft ggf. im Hintergrund).`, {
        autoRemoveMs: 0, // Bleibt sichtbar mit Aktion!
        action: { label: 'Status erneut prüfen', type: 'recheck-local', itemId },
      });
      return {
        success: true,
        verified: false,
        newVersion,
        exitCode,
        effectiveSilent: plan.effectiveSilent,
        adwareProtected: plan.adwareProtected,
        usedInf: plan.usedInf,
      };
    }

    job?.finish('error', `Installer meldete Fehlercode ${exitCode}.`, { autoRemoveMs: 6000 });
    return {
      success: false,
      exitCode,
      error: `ExitCode ${exitCode}`,
      effectiveSilent: plan.effectiveSilent,
      adwareProtected: plan.adwareProtected,
      usedInf: plan.usedInf,
    };
  } catch (err) {
    await cleanupTempFiles([tempPath, tempInfPath]);
    job?.finish('error', err.message, { autoRemoveMs: 5000 });
    return {
      success: false,
      error: err.message,
      effectiveSilent: plan.effectiveSilent,
      adwareProtected: plan.adwareProtected,
      usedInf: plan.usedInf,
    };
  }
}

/**
 * Startet einen Inno-Setup-Installer einmalig interaktiv mit `/SAVEINF`,
 * damit der Benutzer seine gewünschten Optionen wählt, und speichert die erzeugte `.inf` in `_metadata/`.
 */
export async function recordInnoInfFile({
  itemId = '',
  itemName = '',
  itemPath = '',
  sourcePath = '',
  infFileName = 'silent.inf',
}) {
  if (!itemPath || !isInsideTargetDir(itemPath)) {
    return { success: false, error: 'Sicherheitsverletzung: Zielordner liegt außerhalb des Archivs.' };
  }
  if (!sourcePath || !fs.existsSync(sourcePath) || path.extname(sourcePath).toLowerCase() !== '.exe') {
    return { success: false, error: 'Für die Antwortdatei-Aufzeichnung wird eine gültige .exe-Setup-Datei benötigt.' };
  }

  const cleanInfName = sanitizeInnoInfFileName(infFileName) || 'silent.inf';
  const job = createJob({
    type: 'inno-record',
    title: `Antwortdatei (.inf) aufzeichnen: ${itemName || path.basename(sourcePath)}`,
    dedupeKey: `install:${itemId || itemPath}`,
    cancelable: false,
  });
  if (!job) {
    return { success: false, alreadyRunning: true, error: 'Für dieses Programm läuft bereits eine Installation.' };
  }

  const tempDir = app.getPath('temp');
  const stamp = Date.now();
  const tempExePath = path.join(tempDir, `sk_record_${stamp}_${path.basename(sourcePath)}`);
  const tempInfPath = path.join(tempDir, `sk_saveinf_${stamp}.inf`);

  try {
    job.update(15, 'Kopiere Setup in lokalen Temp-Ordner...');
    await fs.promises.copyFile(sourcePath, tempExePath);

    const plan = resolveInstallExecutionPlan({ recordInfPath: tempInfPath, ext: '.exe' });
    job.update(null, plan.bannerHint);

    const safeExe = tempExePath.replace(/'/g, "''");
    const safeArgs = plan.extraArgs.replace(/'/g, "''");
    const launchScript = `
      try {
        $p = Start-Process -FilePath '${safeExe}' -ArgumentList '${safeArgs}' -Wait -PassThru
        Write-Output "EXIT:$($p.ExitCode)"
      } catch {
        Write-Output "ERR:$($_.Exception.Message)"
      }
    `;

    const { stdout } = await runPowerShell(launchScript);

    if (stdout.startsWith('ERR:')) {
      const msg = stdout.replace('ERR:', '').trim();
      const wasCanceled = /abgebrochen|canceled|cancelled|1223/i.test(msg);
      job.finish(wasCanceled ? 'canceled' : 'error', wasCanceled ? 'Aufzeichnung abgebrochen.' : msg, {
        autoRemoveMs: 4000,
      });
      return { success: false, canceled: wasCanceled, error: msg };
    }

    const exitMatch = stdout.match(/EXIT:(-?\d+)/);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : 0;

    if (exitCode === 1602 || exitCode === 1223) {
      job.finish('canceled', 'Aufzeichnung wurde abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode };
    }

    const infExists = fs.existsSync(tempInfPath) && (await fs.promises.stat(tempInfPath)).size > 0;
    if (!infExists) {
      const msg = 'Setup hat keine .inf-Antwortdatei erstellt (kein Inno Setup oder vorzeitig beendet).';
      job.finish('error', msg, { autoRemoveMs: 6000 });
      return { success: false, exitCode, error: msg };
    }

    const metaDir = path.join(itemPath, '_metadata');
    if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
    const targetInfPath = path.join(metaDir, cleanInfName);
    await fs.promises.copyFile(tempInfPath, targetInfPath);
    await scanSingleFolder(itemPath);

    job.finish('done', `Antwortdatei ${cleanInfName} gespeichert.`, { autoRemoveMs: 4500 });
    return { success: true, infFile: cleanInfName, infPath: targetInfPath, exitCode };
  } catch (err) {
    job.finish('error', err.message, { autoRemoveMs: 5000 });
    return { success: false, error: err.message };
  } finally {
    await cleanupTempFiles([tempExePath, tempInfPath]);
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
  startMenuShortcutsCache = null;
  failedIconKeys.clear();
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

    const wingetEnabled = isProviderEnabled('winget');
    const [registryEntries, exportRes, upgradeRes] = await Promise.all([
      readRegistryUninstallEntries(signal),
      wingetEnabled ? wingetProvider.listInstalled({ signal }) : Promise.resolve({ success: false, packages: [] }),
      wingetEnabled ? wingetProvider.listUpgrades({ signal }) : Promise.resolve({ success: false, upgrades: [] }),
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

const GENERIC_SCAN_DIRS = new Set([
  'c:',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\program files\\common files',
  'c:\\program files (x86)\\common files',
  'c:\\windows',
  'c:\\windows\\system32',
  'c:\\windows\\syswow64',
  'c:\\programdata',
]);

const SKIP_SUBDIRS = new Set([
  'node_modules',
  '.git',
  'locales',
  'locale',
  'cache',
  'temp',
  'tmp',
  'logs',
  '__pycache__',
]);
const CACHE_IMAGE_EXTS = ['.png', '.ico', '.svg', '.webp', '.jpg', '.jpeg', '.gif', '.avif'];
const ICON_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'image/avif,image/webp,image/png,image/svg+xml,image/x-icon,image/*;q=0.8,*/*;q=0.5',
};

let startMenuShortcutsCache = null;
let startMenuShortcutsPromise = null;
const failedIconKeys = new Set();

function normalizeDirPath(rawDir) {
  const expanded = expandWindowsEnvVars(String(rawDir || ''), process.env)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '');
  return expanded;
}

function isSafeScanDir(dirPath) {
  if (!dirPath) return false;
  const lower = dirPath.toLowerCase();
  if (GENERIC_SCAN_DIRS.has(lower)) return false;
  if (/^[a-z]:$/.test(lower)) return false;
  if (/\\appdata\\(local|roaming|local\\programs)$/.test(lower)) return false;
  return fs.existsSync(dirPath);
}

function extractExeFromCommandString(cmd) {
  const raw = String(cmd || '').trim();
  if (!raw) return '';
  const quoted = raw.match(/^"([^"]+\.exe)"/i);
  if (quoted) return expandWindowsEnvVars(quoted[1], process.env);
  const plain = raw.match(/^([a-z]:\\[^"]*?\.exe)\b/i);
  return plain ? expandWindowsEnvVars(plain[1], process.env) : '';
}

async function writeFileAtomic(targetPath, data) {
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, data);
    await fs.promises.rename(tmpPath, targetPath);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) await fs.promises.unlink(tmpPath);
    } catch {
      // Temp-Datei ignorieren
    }
  }
}

async function getStartMenuShortcuts() {
  if (startMenuShortcutsCache) return startMenuShortcutsCache;
  if (startMenuShortcutsPromise) return startMenuShortcutsPromise;

  startMenuShortcutsPromise = (async () => {
    const psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $ErrorActionPreference = 'SilentlyContinue'
      $wsh = New-Object -ComObject WScript.Shell
      $roots = @([Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
      $results = @()
      foreach ($root in $roots) {
        $lnks = Get-ChildItem -LiteralPath $root -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue
        foreach ($lnk in $lnks) {
          try {
            $sc = $wsh.CreateShortcut($lnk.FullName)
            $results += [PSCustomObject]@{
              name = [System.IO.Path]::GetFileNameWithoutExtension($lnk.Name)
              target = [string]$sc.TargetPath
              iconLocation = [string]$sc.IconLocation
            }
          } catch {}
        }
      }
      ConvertTo-Json -InputObject @($results) -Depth 2 -Compress
    `;

    const { code, stdout } = await runPowerShell(psScript, { asTempFile: true });
    if (code === -1 || !stdout) return [];

    try {
      const parsed = JSON.parse(stdout);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      startMenuShortcutsCache = list.filter((s) => s && (s.target || s.iconLocation));
      return startMenuShortcutsCache;
    } catch {
      return [];
    } finally {
      startMenuShortcutsPromise = null;
    }
  })();

  return startMenuShortcutsPromise;
}

function normalizeNameSimple(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+\(?(?:x64|x86|64-bit|32-bit|current user|user)\)?/gi, '')
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim();
}

async function findStartMenuIconCandidate({ appName = '', installDirs = [] }) {
  const shortcuts = await getStartMenuShortcuts();
  if (!shortcuts.length) return null;

  const cleanAppNorm = normalizeNameSimple(appName);
  const normInstallDirs = installDirs.map((d) => d.toLowerCase()).filter(Boolean);

  let bestMatch = null;

  for (const sc of shortcuts) {
    const target = expandWindowsEnvVars(String(sc.target || '').trim(), process.env);
    const targetLower = target.toLowerCase();
    const scNameNorm = normalizeNameSimple(sc.name);

    const matchesInstallDir =
      targetLower &&
      normInstallDirs.some((dir) => targetLower === dir || targetLower.startsWith(`${dir}\\`)) &&
      /\.exe$/i.test(target) &&
      !isGenericIconSource(target) &&
      !isIgnoredExecutableName(target);

    const matchesExactName = Boolean(cleanAppNorm && scNameNorm && scNameNorm === cleanAppNorm);
    if (!matchesInstallDir && !matchesExactName) continue;

    const parsedLoc = parseDisplayIcon(sc.iconLocation, process.env);
    if (parsedLoc.path && !parsedLoc.isGeneric && fs.existsSync(parsedLoc.path)) {
      return { sourcePath: parsedLoc.path, iconIndex: parsedLoc.index };
    }
    if (target && !isGenericIconSource(target) && !isIgnoredExecutableName(target) && fs.existsSync(target)) {
      bestMatch = { sourcePath: target, iconIndex: null };
      if (matchesInstallDir) return bestMatch;
    }
  }

  return bestMatch;
}

async function extractIconViaPowerShell(sourcePath, iconIndex, targetPngPath) {
  const safeSrc = sourcePath.replace(/'/g, "''");
  const idx = Number.isFinite(iconIndex) ? iconIndex : 0;
  const tmpOut = `${targetPngPath}.${process.pid}.${Date.now()}.tmp`;
  const safeTmp = tmpOut.replace(/'/g, "''");

  const psScript = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Drawing
    Add-Type -TypeDefinition @"
      using System;
      using System.Runtime.InteropServices;
      public static class SkIconNative {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern uint ExtractIconEx(string lpszFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);
        [DllImport("user32.dll")]
        public static extern bool DestroyIcon(IntPtr hIcon);
      }
"@
    $bmp = $null
    $hLarge = New-Object IntPtr[] 1
    $count = [SkIconNative]::ExtractIconEx('${safeSrc}', ${idx}, $hLarge, $null, 1)
    if ($count -gt 0 -and $hLarge[0] -ne [IntPtr]::Zero) {
      try {
        $ico = [System.Drawing.Icon]::FromHandle($hLarge[0])
        $bmp = $ico.ToBitmap()
        $ico.Dispose()
      } finally {
        [SkIconNative]::DestroyIcon($hLarge[0]) | Out-Null
      }
    }
    if (-not $bmp) {
      $assoc = [System.Drawing.Icon]::ExtractAssociatedIcon('${safeSrc}')
      if ($assoc) {
        $bmp = $assoc.ToBitmap()
        $assoc.Dispose()
      }
    }
    if (-not $bmp) { throw 'No icon extracted' }
    $bmp.Save('${safeTmp}', [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  `;

  try {
    const { code } = await runPowerShell(psScript, { asTempFile: true });
    if (code === 0 && fs.existsSync(tmpOut)) {
      const stat = await fs.promises.stat(tmpOut);
      if (stat.size > 0) {
        await fs.promises.rename(tmpOut, targetPngPath);
        return true;
      }
    }
  } catch {
    // Fallback gescheitert
  } finally {
    try {
      if (fs.existsSync(tmpOut)) await fs.promises.unlink(tmpOut);
    } catch {
      // Ignorieren
    }
  }
  return false;
}

async function extractFileIconToCache({ appKey, sourceType, sourcePath, iconIndex = null, cacheDir }) {
  if (!sourcePath || isGenericIconSource(sourcePath) || !fs.existsSync(sourcePath)) {
    return null;
  }

  const parsed = parseDisplayIcon(sourcePath, process.env);
  const actualPath = parsed.path || sourcePath;
  const effectiveIndex = iconIndex !== null ? iconIndex : parsed.index;
  const ext = path.extname(actualPath).toLowerCase();

  const cacheKey = buildIconCacheKey({
    appKey,
    sourceType,
    sourcePath: actualPath,
    iconIndex: effectiveIndex,
  });
  const hash = crypto.createHash('sha256').update(cacheKey).digest('hex').slice(0, 32);

  if (parsed.isDirectImage) {
    const targetPath = path.join(cacheDir, `${hash}${ext}`);
    if (fs.existsSync(targetPath)) {
      const st = await fs.promises.stat(targetPath);
      if (st.size > 0) return { success: true, iconPath: targetPath, fromCache: true };
    }
    const bytes = await fs.promises.readFile(actualPath);
    if (bytes.length === 0) return null;
    await writeFileAtomic(targetPath, bytes);
    return { success: true, iconPath: targetPath, fromCache: false };
  }

  if (!parsed.isExecutableResource) return null;

  const targetPngPath = path.join(cacheDir, `${hash}.png`);
  if (fs.existsSync(targetPngPath)) {
    const st = await fs.promises.stat(targetPngPath);
    if (st.size > 0) return { success: true, iconPath: targetPngPath, fromCache: true };
  }

  const preferPowerShell = ext !== '.exe' || (effectiveIndex !== null && effectiveIndex !== 0);
  if (preferPowerShell) {
    const ok = await extractIconViaPowerShell(actualPath, effectiveIndex, targetPngPath);
    if (ok) return { success: true, iconPath: targetPngPath, fromCache: false };
  }

  if (ext === '.exe') {
    try {
      const nativeIcon = await app.getFileIcon(actualPath, { size: 'large' });
      if (nativeIcon && !nativeIcon.isEmpty()) {
        const png = nativeIcon.toPNG();
        if (png.length > 0) {
          await writeFileAtomic(targetPngPath, png);
          return { success: true, iconPath: targetPngPath, fromCache: false };
        }
      }
    } catch {
      // Fallback zu PowerShell
    }
  }

  if (!preferPowerShell) {
    const ok = await extractIconViaPowerShell(actualPath, effectiveIndex, targetPngPath);
    if (ok) return { success: true, iconPath: targetPngPath, fromCache: false };
  }

  return null;
}

async function findBestLocalIconInDirectory(rootDir, { appName = '', packageId = '' }) {
  if (!isSafeScanDir(rootDir)) return null;

  const icoCandidates = [];
  const exeCandidates = [];
  const queue = [{ dir: rootDir, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

    let entries = [];
    try {
      entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < 2 && !SKIP_SUBDIRS.has(entry.name.toLowerCase())) {
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        }
        continue;
      }
      if (!entry.isFile()) continue;

      const lower = entry.name.toLowerCase();
      if (lower.endsWith('.ico') && current.depth <= 1) {
        icoCandidates.push({ path: fullPath, name: lower, depth: current.depth });
      } else if (lower.endsWith('.exe')) {
        const score = scoreExecutableCandidate(fullPath, { appName, packageId, rootDir });
        if (score >= 0) {
          let size = 0;
          try {
            size = (await fs.promises.stat(fullPath)).size;
          } catch {
            size = 0;
          }
          exeCandidates.push({ path: fullPath, score, size });
        }
      }
    }
  }

  if (icoCandidates.length > 0) {
    const cleanApp = normalizeNameSimple(appName).replace(/\s+/g, '');
    icoCandidates.sort((a, b) => {
      const aPreferred = a.name === 'app.ico' || (cleanApp && a.name.replace(/\.ico$/, '') === cleanApp);
      const bPreferred = b.name === 'app.ico' || (cleanApp && b.name.replace(/\.ico$/, '') === cleanApp);
      if (aPreferred !== bPreferred) return aPreferred ? -1 : 1;
      return a.depth - b.depth;
    });
    return { sourcePath: icoCandidates[0].path, iconIndex: null };
  }

  if (exeCandidates.length > 0) {
    exeCandidates.sort((a, b) => b.score - a.score || b.size - a.size);
    return { sourcePath: exeCandidates[0].path, iconIndex: null };
  }

  return null;
}

function resolveOnlineIconExtension(contentType, urlStr) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('image/png')) return '.png';
  if (ct.includes('image/svg')) return '.svg';
  if (ct.includes('image/webp')) return '.webp';
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return '.jpg';
  if (ct.includes('image/x-icon') || ct.includes('image/vnd.microsoft.icon')) return '.ico';
  if (ct.includes('image/gif')) return '.gif';
  if (ct.includes('image/avif')) return '.avif';

  try {
    const ext = path.extname(new URL(urlStr).pathname).toLowerCase();
    if (CACHE_IMAGE_EXTS.includes(ext)) return ext;
  } catch {
    // Ignorieren
  }
  return '';
}

async function downloadIconImage(urlStr, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(urlStr, { headers: ICON_FETCH_HEADERS, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (
      contentType &&
      !contentType.toLowerCase().includes('image/') &&
      !contentType.toLowerCase().includes('octet-stream')
    ) {
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64 || buf.length > 2 * 1024 * 1024) return null;

    const ext = resolveOnlineIconExtension(contentType, res.url || urlStr);
    if (!ext) return null;
    return { buffer: buf, ext };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOnlineFaviconToCache({ appKey, homepageUrls, cacheDir }) {
  if (!Array.isArray(homepageUrls) || homepageUrls.length === 0) return null;

  for (const pageUrl of homepageUrls) {
    const hash = crypto
      .createHash('sha256')
      .update(buildIconCacheKey({ appKey, sourceType: 'web', sourcePath: pageUrl }))
      .digest('hex')
      .slice(0, 32);

    for (const ext of CACHE_IMAGE_EXTS) {
      const existing = path.join(cacheDir, `${hash}${ext}`);
      if (fs.existsSync(existing)) {
        const st = await fs.promises.stat(existing);
        if (st.size > 0) return { success: true, iconPath: existing, fromCache: true };
      }
    }

    const iconCandidates = [];
    const ghAvatar = deriveGitHubAvatarUrl(pageUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(pageUrl, { headers: ICON_FETCH_HEADERS, signal: controller.signal, redirect: 'follow' });
      if (res.ok) {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html') || ct.includes('application/xhtml')) {
          const html = await res.text();
          iconCandidates.push(...parseFaviconLinksFromHtml(html, res.url || pageUrl));
        }
      }
    } catch {
      // Weiter mit Origin-/GitHub-Fallback
    } finally {
      clearTimeout(timer);
    }

    if (ghAvatar && !iconCandidates.includes(ghAvatar)) {
      iconCandidates.push(ghAvatar);
    }
    try {
      const fallbackIco = `${new URL(pageUrl).origin}/favicon.ico`;
      if (!iconCandidates.includes(fallbackIco)) iconCandidates.push(fallbackIco);
    } catch {
      // Ungültige URL
    }

    for (const iconUrl of iconCandidates.slice(0, 6)) {
      const downloaded = await downloadIconImage(iconUrl, 5000);
      if (!downloaded) continue;
      const targetPath = path.join(cacheDir, `${hash}${downloaded.ext}`);
      await writeFileAtomic(targetPath, downloaded.buffer);
      return { success: true, iconPath: targetPath, fromCache: false };
    }
  }

  return null;
}

/**
 * Extrahiert ein Programm-Icon on-demand über mehrstufige Fallback-Kette in `userData/icon-cache/`:
 * 1. Registry DisplayIcon (inkl. .ico/.png/.svg & .exe/.dll mit Index)
 * 2. Installationsordner & Startmenü-.lnk-Ziele
 * 3. Optionaler Online-Favicon-/GitHub-Avatar-Fallback über bekannte Homepage-URLs
 */
export async function extractCachedAppIcon({
  id,
  name = '',
  displayIcon = '',
  installLocation = '',
  executablePath = '',
  uninstallString = '',
  packageManager = '',
  packageId = '',
  homepage = '',
  webVersionUrl = '',
  links = [],
  allowOnlineFallback = true,
}) {
  if (!id) return { success: false, error: 'Keine Programm-ID für Icon-Cache angegeben.' };

  const appKey = String(id).trim();
  const failFingerprint = `${appKey}|${displayIcon}|${installLocation}|${executablePath}|${packageId}|${homepage}`;
  if (failedIconKeys.has(failFingerprint)) {
    return { success: false, error: 'Icon für diesen Eintrag in dieser Sitzung nicht gefunden.' };
  }

  try {
    const cacheDir = getIconCacheDir();

    // Stufe 1: Registry DisplayIcon (bereinigt von Anführungszeichen, ,0 / ,-101 & %ENV%)
    const parsedDisplay = parseDisplayIcon(displayIcon, process.env);
    if (parsedDisplay.path && !parsedDisplay.isGeneric && fs.existsSync(parsedDisplay.path)) {
      const stage1 = await extractFileIconToCache({
        appKey,
        sourceType: 'display-icon',
        sourcePath: parsedDisplay.path,
        iconIndex: parsedDisplay.index,
        cacheDir,
      });
      if (stage1?.success) return stage1;
    }

    // Stufe 2a: Expliziter Executable-Pfad (z. B. validInstallPath / autoPaths)
    if (executablePath) {
      const parsedExe = parseDisplayIcon(executablePath, process.env);
      if (parsedExe.path && !parsedExe.isGeneric && fs.existsSync(parsedExe.path)) {
        const stage2a = await extractFileIconToCache({
          appKey,
          sourceType: 'executable',
          sourcePath: parsedExe.path,
          iconIndex: parsedExe.index,
          cacheDir,
        });
        if (stage2a?.success) return stage2a;
      }
    }

    // Stufe 2b: InstallLocation & UninstallString-Verzeichnis nach Haupt-.exe / .ico durchsuchen
    const candidateDirs = [];
    const seenDirs = new Set();
    const pushDir = (d) => {
      const norm = normalizeDirPath(d);
      if (norm && !seenDirs.has(norm.toLowerCase()) && isSafeScanDir(norm)) {
        seenDirs.add(norm.toLowerCase());
        candidateDirs.push(norm);
      }
    };

    pushDir(installLocation);
    const uninstallExe = extractExeFromCommandString(uninstallString);
    if (uninstallExe && !isGenericIconSource(uninstallExe)) {
      pushDir(path.dirname(uninstallExe));
    }

    for (const dir of candidateDirs) {
      const best = await findBestLocalIconInDirectory(dir, { appName: name, packageId });
      if (best) {
        const stage2b = await extractFileIconToCache({
          appKey,
          sourceType: 'install-dir',
          sourcePath: best.sourcePath,
          iconIndex: best.iconIndex,
          cacheDir,
        });
        if (stage2b?.success) return stage2b;
      }
    }

    // Stufe 2c: Startmenü-.lnk-Ziele prüfen
    const shortcutCandidate = await findStartMenuIconCandidate({
      appName: name,
      installDirs: candidateDirs,
    });
    if (shortcutCandidate?.sourcePath) {
      const stage2c = await extractFileIconToCache({
        appKey,
        sourceType: 'shortcut',
        sourcePath: shortcutCandidate.sourcePath,
        iconIndex: shortcutCandidate.iconIndex,
        cacheDir,
      });
      if (stage2c?.success) return stage2c;
    }

    // Stufe 3: Optionaler Online-Favicon-Fallback (aus Winget-Cache oder hinterlegten URLs)
    if (allowOnlineFallback) {
      let cachedPkg = null;
      if (packageId && (!packageManager || packageManager.toLowerCase() === 'winget')) {
        cachedPkg = getWingetCache().get(`winget:show:${String(packageId).trim().toLowerCase()}`)?.data || null;
      }

      const homepageUrls = extractCandidateHomepageUrls({
        homepage: homepage || cachedPkg?.homepage || '',
        publisherUrl: cachedPkg?.publisherUrl || '',
        webVersionUrl,
        links,
      });

      const stage3 = await fetchOnlineFaviconToCache({
        appKey,
        homepageUrls,
        cacheDir,
      });
      if (stage3?.success) return stage3;
    }

    failedIconKeys.add(failFingerprint);
    return { success: false, error: 'Keine ausführbare Datei oder Icon-Quelle gefunden.' };
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
