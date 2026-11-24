import fs from 'node:fs';
import path from 'node:path';
import {
  buildMsiInstallArgs,
  buildMsiUninstallArgs,
  normalizeMsiProductCode,
  parseMsiRegistryEntries,
} from '../../shared/msi-parser.js';
import { normalizeProviderVersion } from '../../shared/provider-lifecycle-logic.js';
import { extractVersion } from '../../shared/version.js';
import { checkArchiveTargetCollision, linkPackageToArchive } from '../archive-linker.js';
import { isAdminSessionActive, runStartProcessElevated } from '../elevated-helper.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runPowerShellScript } from './cli-runner.js';

const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

function escapeSingleQuotedPs(value) {
  return String(value || '').replace(/'/g, "''");
}

function formatMsiExecArgumentString(args) {
  return args
    .map((arg) => {
      const s = String(arg || '');
      if (/\s|"/.test(s)) {
        return `"${s.replace(/"/g, '\\"')}"`;
      }
      return s;
    })
    .join(' ');
}

async function runMsiExec(args, { signal = null, timeoutMs = INSTALL_TIMEOUT_MS } = {}) {
  const argString = formatMsiExecArgumentString(args);
  if (isAdminSessionActive()) {
    const elevRes = await runStartProcessElevated('msiexec.exe', argString, { signal, timeoutMs });
    if (!elevRes.notElevated) {
      if (elevRes.aborted) {
        return { success: false, canceled: true, exitCode: -1 };
      }
      if (elevRes.timedOut) {
        return { success: false, exitCode: -1, error: elevRes.error || 'Zeitüberschreitung bei msiexec.exe.' };
      }
      if (elevRes.canceled || elevRes.code === 1602 || elevRes.code === 1223) {
        return { success: false, canceled: true, exitCode: elevRes.code || 1223 };
      }
      if (elevRes.code === 0 || elevRes.code === 3010) {
        return { success: true, exitCode: elevRes.code, rebootRequired: elevRes.code === 3010 };
      }
      return {
        success: false,
        exitCode: elevRes.code,
        error: elevRes.error || elevRes.stderr || `msiexec.exe meldete Fehlercode ${elevRes.code}.`,
      };
    }
  }

  const psScript = `
    $ErrorActionPreference = 'Stop'
    try {
      $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList '${escapeSingleQuotedPs(argString)}' -Wait -PassThru
      Write-Output "EXIT:$($p.ExitCode)"
    } catch {
      Write-Output "ERR:$($_.Exception.Message)"
    }
  `;

  const res = await runPowerShellScript(psScript, { signal, timeoutMs, asTempFile: true });
  if (res.aborted) {
    return { success: false, canceled: true, exitCode: -1 };
  }
  if (res.timedOut) {
    return { success: false, exitCode: -1, error: res.error || 'Zeitüberschreitung bei msiexec.exe.' };
  }

  const out = String(res.stdout || '').trim();
  const errLine = out.split(/\r?\n/).find((l) => l.startsWith('ERR:'));
  if (errLine) {
    const msg = errLine.slice(4).trim();
    const canceled = /abgebrochen|canceled|cancelled|1223/i.test(msg);
    return { success: false, canceled, exitCode: canceled ? 1223 : -1, error: msg };
  }

  const exitMatch = out.match(/EXIT:(-?\d+)/);
  const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : res.code;

  if (exitCode === 1602 || exitCode === 1223) {
    return { success: false, canceled: true, exitCode };
  }
  if (exitCode === 0 || exitCode === 3010) {
    return { success: true, exitCode, rebootRequired: exitCode === 3010 };
  }

  return {
    success: false,
    exitCode,
    error: res.stderr || `msiexec.exe meldete Fehlercode ${exitCode}.`,
  };
}

/**
 * Liest Metadaten (ProductName, ProductVersion, Manufacturer, ProductCode) einer lokalen `.msi`-Datei aus.
 * @param {string} msiFilePath
 */
export async function readMsiFileMetadata(msiFilePath) {
  const cleanPath = String(msiFilePath || '').trim();
  if (!cleanPath || !fs.existsSync(cleanPath)) {
    return { success: false, error: 'MSI-Datei nicht gefunden.' };
  }

  const fileName = path.basename(cleanPath);
  const fallbackName = path.basename(cleanPath, path.extname(cleanPath));
  const fallbackVersion = extractVersion(fileName) || '';

  const psScript = `
    $ErrorActionPreference = 'SilentlyContinue'
    $wi = New-Object -ComObject WindowsInstaller.Installer
    $db = $wi.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $wi, @('${escapeSingleQuotedPs(cleanPath)}', 0))
    $props = @{}
    foreach ($key in @('ProductName', 'ProductVersion', 'Manufacturer', 'ProductCode')) {
      $view = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @("SELECT Value FROM Property WHERE Property = '$key'"))
      $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
      $rec = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
      if ($rec) {
        $props[$key] = [string]$rec.GetType().InvokeMember('StringData', 'GetProperty', $null, $rec, 1)
      }
    }
    ConvertTo-Json -InputObject $props -Depth 2 -Compress
  `;

  try {
    const res = await runPowerShellScript(psScript, { timeoutMs: 12000, asTempFile: true });
    let props = {};
    if (res.code === 0 && res.stdout) {
      props = JSON.parse(res.stdout);
    }
    return {
      success: true,
      filePath: cleanPath,
      fileName,
      name: String(props.ProductName || fallbackName).trim(),
      version:
        extractVersion(String(props.ProductVersion || '')) || String(props.ProductVersion || fallbackVersion).trim(),
      publisher: String(props.Manufacturer || '').trim(),
      productCode: normalizeMsiProductCode(props.ProductCode || ''),
    };
  } catch {
    return {
      success: true,
      filePath: cleanPath,
      fileName,
      name: fallbackName,
      version: fallbackVersion,
      publisher: '',
      productCode: '',
    };
  }
}

/**
 * Installiert eine lokale `.msi`-Datei via `msiexec /i` und legt sie auf Wunsch im Archiv ab.
 * @param {{ filePath?: string, silent?: boolean, itemName?: string, saveToArchive?: boolean, targetDir?: string, collisionMode?: string }} [options]
 */
export async function installLocalMsi({
  filePath = '',
  silent = false,
  itemName = '',
  saveToArchive = false,
  targetDir = '',
  collisionMode = 'create',
} = {}) {
  const cleanPath = String(filePath || '').trim();
  if (!cleanPath || !fs.existsSync(cleanPath)) {
    return { success: false, error: 'Die ausgewählte .msi-Datei existiert nicht.' };
  }
  if (!/\.msi$/i.test(cleanPath)) {
    return { success: false, error: 'Bitte eine gültige .msi-Datei auswählen.' };
  }

  const meta = await readMsiFileMetadata(cleanPath);
  const displayName = String(itemName || meta.name || path.basename(cleanPath, '.msi')).trim();

  const installRes = await msiProvider.install(cleanPath, {
    silent: Boolean(silent),
    itemName: displayName,
    useJob: true,
  });

  if (!installRes?.success) {
    return installRes;
  }

  if (saveToArchive && targetDir) {
    const collision = checkArchiveTargetCollision(targetDir);
    if (!collision.valid) {
      return {
        ...installRes,
        archived: false,
        archiveError: collision.error,
      };
    }

    try {
      await fs.promises.mkdir(collision.targetDir, { recursive: true });
      const destFile = path.join(collision.targetDir, path.basename(cleanPath));
      if (path.resolve(cleanPath).toLowerCase() !== path.resolve(destFile).toLowerCase()) {
        await fs.promises.copyFile(cleanPath, destFile);
      }

      const linkRes = await linkPackageToArchive({
        packageManager: 'msi',
        packageId: meta.productCode || '',
        softwareName: displayName,
        targetDir: collision.targetDir,
        saveMode: 'ask',
        collisionMode,
        downloadSetup: false,
        metadata: {
          name: displayName,
          version: meta.version || '',
          publisher: meta.publisher || '',
        },
      });

      return {
        ...installRes,
        archived: Boolean(linkRes?.success),
        archiveItem: linkRes?.item || null,
        archiveError: linkRes?.success ? null : linkRes?.error || 'Archiv-Verknüpfung fehlgeschlagen.',
      };
    } catch (err) {
      return {
        ...installRes,
        archived: false,
        archiveError: err?.message || 'MSI-Datei konnte nicht ins Archiv kopiert werden.',
      };
    }
  }

  return installRes;
}

export const msiProvider = {
  id: 'msi',
  name: 'MSI',
  category: 'system',
  description: 'Lokale Windows Installer (.msi)-Pakete via msiexec.exe & Registry',
  requiresAdminForBootstrap: false,
  canInstallManager: false,
  canUninstallManager: false,
  isSystemComponent: true,
  capabilities: {
    search: false,
    listInstalled: true,
    listUpgrades: false,
    show: false,
    install: true,
    uninstall: true,
    supportsArchiveDownload: true,
  },

  async checkAvailability({ signal = null } = {}) {
    if (process.platform !== 'win32') {
      return {
        available: false,
        version: null,
        binaryPath: null,
        error: 'msiexec.exe ist nur unter Windows verfügbar.',
      };
    }

    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const binaryPath = await findBinaryPath('msiexec.exe', {
      signal,
      timeoutMs: 5000,
      extraPaths: [path.join(sysRoot, 'System32', 'msiexec.exe')],
    });

    if (!binaryPath) {
      return {
        available: false,
        version: null,
        binaryPath: null,
        error: 'msiexec.exe wurde auf diesem PC nicht gefunden.',
      };
    }

    // Niemals `msiexec /?` aufrufen (würde GUI-Dialog öffnen) -> Dateiversion per FileVersionInfo lesen
    let version = null;
    try {
      const verRes = await runPowerShellScript(
        `(Get-Item -LiteralPath '${escapeSingleQuotedPs(binaryPath)}').VersionInfo.ProductVersion`,
        { signal, timeoutMs: 5000 }
      );
      if (verRes.code === 0 && verRes.stdout) {
        const raw = verRes.stdout.trim().split(/\s+/)[0];
        version = normalizeProviderVersion(extractVersion(raw) || raw);
      }
    } catch {
      version = null;
    }

    return {
      available: true,
      version,
      binaryPath,
      error: null,
    };
  },

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  async installManager() {
    return { success: false, error: 'Windows Installer (msiexec.exe) ist eine feste Windows-Systemkomponente.' };
  },

  async uninstallManager() {
    return { success: false, error: 'Windows Installer (msiexec.exe) ist eine feste Windows-Systemkomponente.' };
  },

  async listInstalled({ includeSystemComponents = false, signal = null } = {}) {
    const psScript = `
      $ErrorActionPreference = 'SilentlyContinue'
      $paths = @(
        'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKCU:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      )
      $items = Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
        Where-Object { ($_.WindowsInstaller -eq 1) -and (-not [string]::IsNullOrWhiteSpace($_.DisplayName)) } |
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
            windowsInstaller = [int]$_.WindowsInstaller
            systemComponent = if ($null -ne $_.SystemComponent) { [int]$_.SystemComponent } else { 0 }
            parentKeyName = [string]$_.ParentKeyName
          }
        }
      ConvertTo-Json -InputObject @($items) -Depth 3 -Compress
    `;

    const res = await runPowerShellScript(psScript, { signal, timeoutMs: 30000, asTempFile: true });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.code !== 0 && !res.stdout) {
      return { success: false, packages: [], error: res.error || res.stderr || 'MSI-Registry-Scan fehlgeschlagen.' };
    }

    try {
      const parsed = res.stdout.trim() ? JSON.parse(res.stdout) : [];
      const rawEntries = Array.isArray(parsed) ? parsed : [parsed];
      const packages = parseMsiRegistryEntries(rawEntries, { includeSystemComponents });
      return { success: true, packages };
    } catch (err) {
      return { success: false, packages: [], error: err?.message || 'MSI-Registry-Daten ungültig.' };
    }
  },

  async install(msiFilePath, { silent = false, itemName = '', signal = null, useJob = true } = {}) {
    const cleanPath = String(msiFilePath || '').trim();
    const args = buildMsiInstallArgs(cleanPath, { silent: Boolean(silent) });
    if (!args || !fs.existsSync(cleanPath)) {
      return { success: false, error: 'Gültige lokale .msi-Datei erforderlich.' };
    }

    const displayName = itemName || path.basename(cleanPath);
    let job = null;
    if (useJob) {
      job = createJob({
        type: 'msi-install',
        title: `MSI-Installation: ${displayName}`,
        dedupeKey: `msi-install:${cleanPath.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'MSI-Installation läuft bereits.' };
      job.update(
        null,
        silent ? `Installiere ${displayName} still (msiexec /qn)...` : `Starte MSI-Assistent für ${displayName}...`
      );
    }

    const res = await runMsiExec(args, { signal });
    if (res.canceled) {
      job?.finish('canceled', 'MSI-Installation abgebrochen.', { autoRemoveMs: 3500 });
      return res;
    }
    if (res.success) {
      job?.finish('done', res.rebootRequired ? 'Installiert (Neustart empfohlen).' : 'MSI erfolgreich installiert.', {
        autoRemoveMs: 4000,
      });
      return res;
    }

    const errMsg = res.error || 'MSI-Installation fehlgeschlagen.';
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return res;
  },

  async uninstall(productCode, { silent = false, itemName = '', signal = null, useJob = true } = {}) {
    const normalizedCode = normalizeMsiProductCode(productCode);
    const args = buildMsiUninstallArgs(normalizedCode, { silent: Boolean(silent) });
    if (!args) {
      return { success: false, error: 'Ungültiger MSI-ProductCode ({GUID}).' };
    }

    const displayName = itemName || normalizedCode;
    let job = null;
    if (useJob) {
      job = createJob({
        type: 'msi-uninstall',
        title: `MSI-Deinstallation: ${displayName}`,
        dedupeKey: `msi-uninstall:${normalizedCode.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'MSI-Deinstallation läuft bereits.' };
      job.update(null, `Deinstalliere MSI-Paket ${displayName}...`);
    }

    const res = await runMsiExec(args, { signal });
    if (res.canceled) {
      job?.finish('canceled', 'MSI-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return res;
    }
    if (res.success) {
      job?.finish(
        'done',
        res.rebootRequired ? 'Deinstalliert (Neustart empfohlen).' : 'MSI erfolgreich deinstalliert.',
        {
          autoRemoveMs: 4000,
        }
      );
      return res;
    }

    const errMsg = res.error || 'MSI-Deinstallation fehlgeschlagen.';
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return res;
  },
};
