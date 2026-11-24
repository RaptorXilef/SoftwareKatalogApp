import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, shell } from 'electron';
import {
  buildIconCacheKey,
  deriveGitHubAvatarUrl,
  expandWindowsEnvVars,
  extractCandidateHomepageUrls,
  isGenericIconSource,
  isIgnoredExecutableName,
  parseAppxManifestMetadata,
  parseDisplayIcon,
  parseFaviconLinksFromHtml,
  scoreExecutableCandidate,
  selectBestAppxLogoFile,
} from '../shared/icon-logic.js';
import {
  isCrypticStoreId,
  isUnknownVersionString,
  matchAppxEntryForPackage,
  mergeInstalledSoftware,
  pickBestDisplayName,
} from '../shared/installed-merger.js';
import {
  normalizeInstallMode,
  resolveInstallExecutionPlan,
  sanitizeInnoInfFileName,
  sanitizeSilentArgs,
} from '../shared/installer-logic.js';
import { normalizePythonPackageName } from '../shared/python-parser.js';
import { compareVersions, extractVersion } from '../shared/version.js';
import { loadCatalogWithLiveStatus, saveMetaJson } from './catalog-service.js';
import { getConfig, getIconCacheDir, isInsideTargetDir, saveConfig } from './config.js';
import { isAdminSessionActive, runStartProcessElevated } from './elevated-helper.js';
import { detectInstallerFile } from './installer-detector.js';
import { createJob } from './jobs.js';
import { getEnabledProviders, getProvider, initDefaultProviders, isProviderEnabled } from './providers/registry.js';
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

async function runProcessAndGetExitCode(filePath, argsStr = '', { signal = null } = {}) {
  if (isAdminSessionActive()) {
    const elevatedRes = await runStartProcessElevated(filePath, argsStr, { signal });
    if (!elevatedRes.notElevated) {
      if (signal?.aborted || elevatedRes.aborted) {
        return { aborted: true, error: null, exitCode: -1 };
      }
      if (elevatedRes.canceled) {
        return { aborted: false, error: null, exitCode: elevatedRes.code || 1223 };
      }
      if (elevatedRes.error && elevatedRes.code < 0) {
        return { aborted: false, error: elevatedRes.error, exitCode: elevatedRes.code };
      }
      return { aborted: false, error: null, exitCode: elevatedRes.code };
    }
  }

  const safeFile = String(filePath || '').replace(/'/g, "''");
  const safeArgs = String(argsStr || '').replace(/'/g, "''");
  const argClause = safeArgs ? `-ArgumentList '${safeArgs}'` : '';
  const launchScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    try {
      $p = Start-Process -FilePath '${safeFile}' ${argClause} -Wait -PassThru
      Write-Output "EXIT:$($p.ExitCode)"
    } catch {
      Write-Output "ERR:$($_.Exception.Message)"
    }
  `;

  const { stdout } = await runPowerShell(launchScript, { signal });
  if (signal?.aborted) {
    return { aborted: true, error: null, exitCode: -1 };
  }
  if (stdout.startsWith('ERR:')) {
    return { aborted: false, error: stdout.replace('ERR:', '').trim(), exitCode: -1 };
  }
  const exitMatch = stdout.match(/EXIT:(-?\d+)/);
  return { aborted: false, error: null, exitCode: exitMatch ? parseInt(exitMatch[1], 10) : 0 };
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

    const adminHint = isAdminSessionActive() ? ' (Admin-Sitzung)' : '';
    reportProgress(null, `${plan.bannerHint}${adminHint}`);
    const msiArgs = plan.extraArgs ? `/i "${tempPath}" ${plan.extraArgs}` : `/i "${tempPath}"`;
    const procRes =
      ext === '.msi'
        ? await runProcessAndGetExitCode('msiexec.exe', msiArgs, { signal })
        : await runProcessAndGetExitCode(tempPath, plan.extraArgs || '', { signal });

    // Temp-Dateien aufräumen
    await cleanupTempFiles([tempPath, tempInfPath]);

    if (signal?.aborted || procRes.aborted) {
      job?.finish('canceled', 'Installation abgebrochen.', { autoRemoveMs: 3500 });
      return {
        success: false,
        canceled: true,
        effectiveSilent: plan.effectiveSilent,
        adwareProtected: plan.adwareProtected,
        usedInf: plan.usedInf,
      };
    }

    if (procRes.error) {
      const msg = procRes.error;
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

    const exitCode = procRes.exitCode;

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

    const procRes = await runProcessAndGetExitCode(tempExePath, plan.extraArgs || '');

    if (procRes.error) {
      const msg = procRes.error;
      const wasCanceled = /abgebrochen|canceled|cancelled|1223/i.test(msg);
      job.finish(wasCanceled ? 'canceled' : 'error', wasCanceled ? 'Aufzeichnung abgebrochen.' : msg, {
        autoRemoveMs: 4000,
      });
      return { success: false, canceled: wasCanceled, error: msg };
    }

    const exitCode = procRes.exitCode;

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
          windowsInstaller = if ($null -ne $_.WindowsInstaller) { [int]$_.WindowsInstaller } else { 0 }
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

function buildShowCacheKey(packageManager, packageId) {
  const cleanPm = String(packageManager || 'winget')
    .trim()
    .toLowerCase();
  const cleanPidLower = String(packageId || '')
    .trim()
    .toLowerCase();
  if (!cleanPidLower) return '';
  if (['npm', 'bun', 'pnpm'].includes(cleanPm)) {
    return `npm-registry:show:${cleanPidLower}`;
  }
  if (['pip', 'uv'].includes(cleanPm)) {
    return `pypi:show:${normalizePythonPackageName(cleanPidLower)}`;
  }
  if (['pwsh7', 'pwsh5'].includes(cleanPm)) {
    return `psgallery:show:${cleanPidLower}`;
  }
  if (cleanPm === 'vcpkg') {
    return `vcpkg:show:${cleanPidLower.split(':')[0]}`;
  }
  return `${cleanPm}:show:${cleanPidLower}`;
}

let appxInventoryCache = null;
let appxInventoryPromise = null;

/**
 * Liest installierte AppX-/MS-Store-Apps inkl. StartApps-Anzeigenamen und `AppxManifest.xml`-Metadaten.
 * @param {AbortSignal | null} [signal]
 */
export async function getInstalledAppxInventory(signal = null) {
  if (appxInventoryCache) return appxInventoryCache;
  if (appxInventoryPromise) return appxInventoryPromise;

  appxInventoryPromise = (async () => {
    const psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $ErrorActionPreference = 'SilentlyContinue'
      $startMap = @{}
      foreach ($sa in (Get-StartApps)) {
        if ($sa.AppID -and $sa.Name) {
          $fam = ($sa.AppID -split '!')[0]
          if ($fam -and -not $startMap.ContainsKey($fam)) {
            $startMap[$fam] = [string]$sa.Name
          }
        }
      }
      $items = Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage -and $_.InstallLocation } | ForEach-Object {
        $fam = [string]$_.PackageFamilyName
        [PSCustomObject]@{
          name = [string]$_.Name
          packageFamilyName = $fam
          version = [string]$_.Version
          installLocation = [string]$_.InstallLocation
          startAppName = if ($fam -and $startMap.ContainsKey($fam)) { [string]$startMap[$fam] } else { '' }
        }
      }
      ConvertTo-Json -InputObject @($items) -Depth 2 -Compress
    `;

    try {
      const { code, stdout } = await runPowerShell(psScript, { signal, asTempFile: true });
      if (signal?.aborted || code === -1 || !stdout) return [];

      const parsed = JSON.parse(stdout);
      const rawList = Array.isArray(parsed) ? parsed : [parsed];
      const inventory = [];

      for (const raw of rawList) {
        if (!raw || typeof raw !== 'object') continue;
        const installLocation = String(raw.installLocation || '').trim();
        const pkgName = String(raw.name || '').trim();
        if (!installLocation && !pkgName) continue;

        let manifestMeta = { displayName: '', publisherDisplayName: '', logoCandidates: [] };
        if (installLocation) {
          const manifestPath = path.join(installLocation, 'AppxManifest.xml');
          try {
            if (fs.existsSync(manifestPath)) {
              const xml = await fs.promises.readFile(manifestPath, 'utf-8');
              manifestMeta = parseAppxManifestMetadata(xml);
            }
          } catch {
            // Zugriff auf geschuetzten WindowsApps-Unterordner ignorieren
          }
        }

        const startAppName = String(raw.startAppName || '').trim();
        const cleanedPkgName = pkgName.includes('.') ? pkgName.slice(pkgName.indexOf('.') + 1) : pkgName;
        const displayName = startAppName || manifestMeta.displayName || cleanedPkgName || pkgName;

        inventory.push({
          name: pkgName,
          packageFamilyName: String(raw.packageFamilyName || '').trim(),
          displayName,
          publisherDisplayName: manifestMeta.publisherDisplayName,
          version: String(raw.version || '').trim(),
          installLocation,
          logoCandidates: manifestMeta.logoCandidates,
        });
      }

      appxInventoryCache = inventory;
      return inventory;
    } catch {
      return [];
    } finally {
      appxInventoryPromise = null;
    }
  })();

  return appxInventoryPromise;
}

/**
 * Kombiniert `winget export`, `winget upgrade`, Provider-Daten, Registry und AppX-Inventar
 * zu einer vollstaendigen Liste aller auf diesem PC installierten Programme.
 */
export async function scanInstalledSoftware({ includeSystemComponents = false, silent = false } = {}) {
  startMenuShortcutsCache = null;
  appxInventoryCache = null;
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
    initDefaultProviders();
    job?.update(15, 'Lese Windows-Registry & aktive Paketmanager...');

    const wingetEnabled = isProviderEnabled('winget');
    const msstoreEnabled = isProviderEnabled('msstore');
    const msiEnabled = isProviderEnabled('msi');
    const msstoreProv = msstoreEnabled ? getProvider('msstore') : null;
    const extraProviders = getEnabledProviders().filter((p) => !['archive', 'winget', 'msstore', 'msi'].includes(p.id));

    const emptyInstalled = Promise.resolve({ success: false, packages: [] });
    const emptyUpgrades = Promise.resolve({ success: false, upgrades: [] });

    const [
      registryEntries,
      appxEntries,
      exportRes,
      upgradeRes,
      msstoreInstalledRes,
      msstoreUpgradeRes,
      extraProviderResults,
    ] = await Promise.all([
      readRegistryUninstallEntries(signal),
      msstoreEnabled || wingetEnabled ? getInstalledAppxInventory(signal) : Promise.resolve([]),
      wingetEnabled ? wingetProvider.listInstalled({ signal }) : emptyInstalled,
      wingetEnabled ? wingetProvider.listUpgrades({ signal }) : emptyUpgrades,
      msstoreProv ? msstoreProv.listInstalled({ signal }) : emptyInstalled,
      msstoreProv ? msstoreProv.listUpgrades({ signal }) : emptyUpgrades,
      Promise.all(
        extraProviders.map(async (provider) => {
          const [installedSettled, upgradesSettled] = await Promise.allSettled([
            provider.capabilities?.listInstalled && typeof provider.listInstalled === 'function'
              ? provider.listInstalled({ signal })
              : emptyInstalled,
            provider.capabilities?.listUpgrades && typeof provider.listUpgrades === 'function'
              ? provider.listUpgrades({ signal })
              : emptyUpgrades,
          ]);
          return {
            installed:
              installedSettled.status === 'fulfilled' ? installedSettled.value : { success: false, packages: [] },
            upgrades: upgradesSettled.status === 'fulfilled' ? upgradesSettled.value : { success: false, upgrades: [] },
          };
        })
      ),
    ]);

    if (signal?.aborted) {
      return { success: false, canceled: true };
    }

    job?.update(80, 'Verknüpfe installierte Programme mit Archiv-Katalog...');
    const catalogItems = loadCatalogWithLiveStatus();

    const wingetExports = exportRes.success ? exportRes.packages : [];
    const wingetUpgrades = upgradeRes.success ? upgradeRes.upgrades : [];

    const msstoreFromWingetExport =
      wingetEnabled && msstoreEnabled
        ? wingetExports
            .filter((pkg) => String(pkg.source || '').toLowerCase() === 'msstore')
            .map((pkg) => ({ ...pkg, packageManager: 'msstore', source: 'msstore' }))
        : [];

    const msstoreById = new Map();
    for (const pkg of [
      ...(msstoreInstalledRes.success ? msstoreInstalledRes.packages : []),
      ...msstoreFromWingetExport,
    ]) {
      const pid = String(pkg?.packageId || pkg?.id || '').trim();
      if (!pid) continue;
      const key = pid.toLowerCase();
      const prev = msstoreById.get(key);
      if (!prev) {
        msstoreById.set(key, pkg);
      } else {
        msstoreById.set(key, {
          ...prev,
          ...pkg,
          name: pickBestDisplayName({ candidates: [prev.name, pkg.name], packageId: pid, packageManager: 'msstore' }),
          version: !isUnknownVersionString(prev.version) ? prev.version : pkg.version || prev.version || '',
          availableVersion: prev.availableVersion || pkg.availableVersion || '',
          installedVersionIsLowerBound: Boolean(prev.installedVersionIsLowerBound || pkg.installedVersionIsLowerBound),
        });
      }
    }

    const providerInstalled = [...msstoreById.values()];
    const providerUpgrades = [...(msstoreUpgradeRes.success ? msstoreUpgradeRes.upgrades : [])];

    for (const extra of extraProviderResults) {
      if (extra.installed?.success && Array.isArray(extra.installed.packages)) {
        providerInstalled.push(...extra.installed.packages);
      }
      if (extra.upgrades?.success && Array.isArray(extra.upgrades.upgrades)) {
        providerUpgrades.push(...extra.upgrades.upgrades);
      }
    }

    const cache = getWingetCache();
    const cachedMetadata = new Map();
    const collectCachedMeta = (pm, pid) => {
      const cleanPm = String(pm || '')
        .trim()
        .toLowerCase();
      const cleanPid = String(pid || '').trim();
      if (!cleanPm || !cleanPid) return;
      const mapKey = `${cleanPm}:${cleanPid.toLowerCase()}`;
      if (cachedMetadata.has(mapKey)) return;
      const cacheKey = buildShowCacheKey(cleanPm, cleanPid);
      if (!cacheKey) return;
      const cached = cache.get(cacheKey)?.data;
      if (cached) cachedMetadata.set(mapKey, cached);
    };

    for (const pkg of wingetExports) collectCachedMeta('winget', pkg.packageId);
    for (const up of wingetUpgrades) collectCachedMeta('winget', up.packageId);
    for (const pkg of providerInstalled) collectCachedMeta(pkg.packageManager, pkg.packageId || pkg.id);
    for (const up of providerUpgrades) collectCachedMeta(up.packageManager, up.packageId || up.id);

    const programs = mergeInstalledSoftware({
      wingetExports,
      wingetUpgrades,
      providerInstalled,
      providerUpgrades,
      registryEntries,
      appxEntries,
      cachedMetadata,
      catalogItems,
      includeSystemComponents,
      msiEnabled,
    });

    // Fuer MS-Store-Apps, die noch keinen lesbaren Namen haben, optional `msstore.show()` (max. 12, Parallelitaet 3)
    if (msstoreProv && typeof msstoreProv.show === 'function' && !signal?.aborted) {
      const unresolvedMsStore = programs
        .filter((p) => p.packageManager === 'msstore' && isCrypticStoreId(p.name) && p.packageId)
        .slice(0, 12);

      if (unresolvedMsStore.length > 0) {
        const executing = new Set();
        for (const prog of unresolvedMsStore) {
          if (signal?.aborted) break;
          const task = (async () => {
            try {
              const showRes = await msstoreProv.show(prog.packageId, { signal });
              const data = showRes?.success ? showRes.package : null;
              if (!data) return;
              if (data.name && !isCrypticStoreId(data.name)) {
                prog.name = data.name;
              }
              if (!prog.publisher && (data.publisher || data.author)) {
                prog.publisher = data.publisher || data.author;
              }
              if (!prog.homepage && (data.homepage || data.publisherUrl)) {
                prog.homepage = data.homepage || data.publisherUrl;
              }
              if (!prog.installLocation && appxEntries.length > 0) {
                const matchedAppx = matchAppxEntryForPackage(prog, appxEntries);
                if (matchedAppx) {
                  prog.installLocation = matchedAppx.installLocation || prog.installLocation;
                  prog.appxPackageFamilyName = matchedAppx.packageFamilyName || prog.appxPackageFamilyName;
                  if (isUnknownVersionString(prog.installedVersion) && matchedAppx.version) {
                    prog.installedVersion = matchedAppx.version;
                  }
                }
              }
            } catch {
              // Einzelne show()-Fehler blockieren keinen PC-Scan
            }
          })();
          executing.add(task);
          task.finally(() => executing.delete(task));
          if (executing.size >= 3) {
            await Promise.race(executing);
          }
        }
        await Promise.all(executing);
      }
    }

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

function createConcurrencyLimiter(maxConcurrent) {
  let active = 0;
  const waiting = [];
  return async (fn) => {
    if (active >= maxConcurrent) {
      await new Promise((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = waiting.shift();
      if (next) next();
    }
  };
}

const runBgCliShowLimited = createConcurrencyLimiter(2);
const runBgHttpShowLimited = createConcurrencyLimiter(4);
const HTTP_SHOW_PROVIDERS = new Set(['npm', 'bun', 'pnpm', 'pip', 'uv', 'cargo', 'composer', 'dotnet', 'nvm']);

async function collectRelImageFilesInDir(rootDir, subRelDir, maxDepth = 1) {
  const results = [];
  const startDir = subRelDir ? path.join(rootDir, subRelDir) : rootDir;
  if (!fs.existsSync(startDir)) return results;

  const walk = async (dir, relPrefix, depth) => {
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          await walk(fullPath, relPath, depth + 1);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CACHE_IMAGE_EXTS.includes(ext)) {
          results.push(relPath);
        }
      }
    }
  };

  await walk(startDir, subRelDir ? subRelDir.replace(/\\/g, '/') : '', 0);
  return results;
}

async function findAppxLogoInInstallLocation(installLocation, cachedLogoCandidates = null) {
  if (!installLocation || !fs.existsSync(installLocation)) return null;

  let candidates = Array.isArray(cachedLogoCandidates) ? cachedLogoCandidates : [];
  if (candidates.length === 0) {
    const manifestPath = path.join(installLocation, 'AppxManifest.xml');
    try {
      if (fs.existsSync(manifestPath)) {
        const xml = await fs.promises.readFile(manifestPath, 'utf-8');
        candidates = parseAppxManifestMetadata(xml).logoCandidates;
      }
    } catch {
      return null;
    }
  }
  if (candidates.length === 0) return null;

  const dirFilesCache = new Map();
  for (const logicalRel of candidates) {
    const normRel = String(logicalRel || '').replace(/\\/g, '/');
    const slashIdx = normRel.lastIndexOf('/');
    const subDir = slashIdx !== -1 ? normRel.slice(0, slashIdx) : '';
    const cacheKey = subDir.toLowerCase();

    if (!dirFilesCache.has(cacheKey)) {
      dirFilesCache.set(cacheKey, await collectRelImageFilesInDir(installLocation, subDir, 1));
    }

    const available = dirFilesCache.get(cacheKey) || [];
    const bestRel = selectBestAppxLogoFile(normRel, available);
    if (bestRel) {
      const absPath = path.join(installLocation, bestRel);
      if (fs.existsSync(absPath)) {
        return absPath;
      }
    }
  }

  return null;
}

/**
 * Extrahiert ein Programm-Icon on-demand über mehrstufige Fallback-Kette in `userData/icon-cache/`:
 * 1. Registry DisplayIcon (inkl. .ico/.png/.svg & .exe/.dll mit Index)
 * 1.5. AppX-/MS-Store-Manifest-Logos (`AppxManifest.xml` inkl. `.scale-200.png` / `.targetsize-48`)
 * 2. Installationsordner (inkl. Scoop-Apps) & Startmenü-.lnk-Ziele
 * 3. Optionaler Online-Favicon-/GitHub-Avatar-Fallback über bekannte oder per `show()` geladene Homepage-URLs
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
  appxPackageFamilyName = '',
  homepage = '',
  webVersionUrl = '',
  links = [],
  allowOnlineFallback = true,
}) {
  if (!id) return { success: false, error: 'Keine Programm-ID für Icon-Cache angegeben.' };

  const appKey = String(id).trim();
  const failFingerprint = `${appKey}|${displayIcon}|${installLocation}|${executablePath}|${packageId}|${appxPackageFamilyName}|${homepage}`;
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

    // Stufe 1.5: AppX-/MS-Store-Logo aus `AppxManifest.xml` extrahieren
    const cleanPm = String(packageManager || '')
      .trim()
      .toLowerCase();
    const looksLikeAppx =
      cleanPm === 'msstore' || Boolean(appxPackageFamilyName) || /\\windowsapps\\/i.test(String(installLocation || ''));
    if (looksLikeAppx) {
      let appxLoc = normalizeDirPath(installLocation);
      let logoCandidates = [];
      if (!appxLoc || !fs.existsSync(appxLoc)) {
        const inventory = await getInstalledAppxInventory();
        const matched = matchAppxEntryForPackage(
          {
            packageId,
            name,
            appxPackageFamilyName,
          },
          inventory
        );
        if (matched?.installLocation) {
          appxLoc = matched.installLocation;
          logoCandidates = matched.logoCandidates || [];
        }
      }
      if (appxLoc && fs.existsSync(appxLoc)) {
        const logoPath = await findAppxLogoInInstallLocation(appxLoc, logoCandidates);
        if (logoPath) {
          const stageAppx = await extractFileIconToCache({
            appKey,
            sourceType: 'appx-logo',
            sourcePath: logoPath,
            cacheDir,
          });
          if (stageAppx?.success) return stageAppx;
        }
      }
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

    // Stufe 2b: InstallLocation, UninstallString & Scoop-App-Ordner nach Haupt-.exe / .ico durchsuchen
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
    if (cleanPm === 'scoop' && packageId) {
      const scoopAppName = String(packageId).split('/').pop();
      if (scoopAppName) {
        if (process.env.SCOOP) {
          pushDir(path.join(process.env.SCOOP, 'apps', scoopAppName, 'current'));
        }
        pushDir(path.join(os.homedir(), 'scoop', 'apps', scoopAppName, 'current'));
      }
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

    // Stufe 3: Optionaler Online-Favicon-Fallback (aus Provider-Cache, show() oder hinterlegten URLs)
    if (allowOnlineFallback) {
      const effectivePm = cleanPm || (packageId ? 'winget' : '');
      let cachedPkg = null;
      if (packageId && effectivePm) {
        const cacheKey = buildShowCacheKey(effectivePm, packageId);
        if (cacheKey) {
          cachedPkg = getWingetCache().get(cacheKey)?.data || null;
        }
      }

      let homepageUrls = extractCandidateHomepageUrls({
        homepage: homepage || cachedPkg?.homepage || (effectivePm === 'nvm' ? 'https://nodejs.org/' : ''),
        repositoryUrl: cachedPkg?.repositoryUrl || '',
        publisherUrl: cachedPkg?.publisherUrl || '',
        webVersionUrl,
        links,
      });

      if (!cachedPkg && homepageUrls.length === 0 && packageId && effectivePm) {
        initDefaultProviders();
        const provider = getProvider(effectivePm);
        if (provider?.capabilities?.show && typeof provider.show === 'function') {
          const runLimited = HTTP_SHOW_PROVIDERS.has(effectivePm) ? runBgHttpShowLimited : runBgCliShowLimited;
          try {
            const showRes = await runLimited(() => provider.show(packageId));
            if (showRes?.success && showRes.package) {
              cachedPkg = showRes.package;
              homepageUrls = extractCandidateHomepageUrls({
                homepage: homepage || cachedPkg.homepage || '',
                repositoryUrl: cachedPkg.repositoryUrl || '',
                publisherUrl: cachedPkg.publisherUrl || '',
                webVersionUrl,
                links,
              });
            }
          } catch {
            // Ignorieren, Platzhalter bleibt bestehen
          }
        }
      }

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

  const procRes = await runProcessAndGetExitCode(parsed.filePath, parsed.argsStr || '');
  if (procRes.error) {
    const msg = procRes.error;
    const wasCanceled = /abgebrochen|canceled|cancelled|1223/i.test(msg);
    return { success: false, canceled: wasCanceled, error: msg };
  }

  const exitCode = procRes.exitCode;

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
  initDefaultProviders();
  const displayTitle = itemName || packageId || 'Programm';
  const effectivePm = String(packageManager || (packageId ? 'winget' : ''))
    .trim()
    .toLowerCase();
  const provider = effectivePm ? getProvider(effectivePm) : null;
  const useProvider = Boolean(
    packageId && provider?.capabilities?.uninstall && typeof provider.uninstall === 'function'
  );
  const regCommand = silent && quietUninstallString ? quietUninstallString : uninstallString;

  if (!useProvider && !regCommand) {
    return { success: false, error: 'Keine Paket-ID oder Deinstallations-Befehl vorhanden.' };
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

    if (useProvider && provider) {
      method = effectivePm;
      job.update(null, `Deinstalliere ${displayTitle} über ${provider.name}...`);
      res = await provider.uninstall(packageId, { silent, itemName: displayTitle, useJob: false });

      if (!res.success && !res.canceled && regCommand && effectivePm !== 'msi') {
        method = 'registry-fallback';
        job.update(null, `${provider.name} fehlgeschlagen - starte Registry-Deinstaller...`);
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
