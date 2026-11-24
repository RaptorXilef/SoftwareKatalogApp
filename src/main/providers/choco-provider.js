import path from 'node:path';
import {
  isValidChocoPackageId,
  parseChocoInfoOutput,
  parseChocoListOutput,
  parseChocoOutdatedOutput,
  parseChocoSearchOutput,
} from '../../shared/choco-parser.js';
import {
  isValidSourceName,
  isValidSourceUrl,
  PROVIDER_SOURCE_TEMPLATES,
  parseChocoSourceListOutput,
} from '../../shared/provider-sources-parser.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli, runElevatedPowerShell } from './cli-runner.js';
import { createCliAvailabilityChecker, createPowerShellBootstrapRunner } from './manager-bootstrap.js';
import { getWingetCache } from './winget-provider.js';

const DEFAULT_TIMEOUT_MS = 45000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;

function getChocoExtraPaths() {
  const chocoRoot = process.env.ChocolateyInstall || 'C:\\ProgramData\\chocolatey';
  return [path.join(chocoRoot, 'bin', 'choco.exe')];
}

function escapeSingleQuotedPs(value) {
  return String(value || '').replace(/'/g, "''");
}

async function runChoco(args, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const chocoExe = await findBinaryPath('choco.exe', {
    signal,
    timeoutMs: 5000,
    extraPaths: getChocoExtraPaths(),
  });
  return runCli(chocoExe || 'choco', args, { signal, timeoutMs, windowsHide: true });
}

async function fetchChocoShowFresh(packageId, { signal = null } = {}) {
  const cleanId = String(packageId || '').trim();
  if (!isValidChocoPackageId(cleanId)) {
    throw new Error('Ungültige Chocolatey-Paket-ID angegeben.');
  }

  const res = await runChoco(['info', cleanId], { signal });
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (res.notFound) {
    throw new Error('Chocolatey ist auf diesem PC nicht verfügbar.');
  }

  const parsed = parseChocoInfoOutput(res.stdout, cleanId);
  if (res.code !== 0 || (!parsed.version && !parsed.description && !parsed.shortDescription)) {
    const errMsg = res.stderr || res.stdout || `Chocolatey-Paket "${cleanId}" konnte nicht abgerufen werden.`;
    throw new Error(errMsg.trim());
  }

  return parsed;
}

const CHOCO_INSTALL_SCRIPT = [
  'Set-ExecutionPolicy Bypass -Scope Process -Force',
  '[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072',
  "iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))",
].join('; ');

const CHOCO_UNINSTALL_SCRIPT = `
$chocoDir = if ($env:ChocolateyInstall) { $env:ChocolateyInstall } else { 'C:\\ProgramData\\chocolatey' }
$resolved = [System.IO.Path]::GetFullPath($chocoDir)
if ($resolved -and ($resolved -match '(?i)chocolatey') -and (Test-Path -LiteralPath $resolved)) {
  Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
}
[Environment]::SetEnvironmentVariable('ChocolateyInstall', $null, 'Machine')
[Environment]::SetEnvironmentVariable('ChocolateyInstall', $null, 'User')
$binDir = Join-Path $resolved 'bin'
foreach ($scope in @('Machine', 'User')) {
  $curPath = [Environment]::GetEnvironmentVariable('Path', $scope)
  if ($curPath) {
    $parts = $curPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne $binDir.TrimEnd('\\')) }
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), $scope)
  }
}
`;

export const chocoProvider = {
  id: 'chocolatey',
  name: 'Chocolatey',
  category: 'system',
  description: 'Windows-Paketmanager für System- und Entwicklerpakete (erfordert Adminrechte)',
  requiresAdminForBootstrap: true,
  canInstallManager: true,
  canUninstallManager: true,
  isSystemComponent: false,
  uninstallWarning:
    'Sicherheitswarnung: Beim Deinstallieren von Chocolatey wird das gesamte %ChocolateyInstall%-Verzeichnis gelöscht und aus PATH entfernt. Bereits installierte Anwendungen bleiben meist bestehen, werden aber nicht mehr über Chocolatey verwaltet.',
  capabilities: {
    search: true,
    listInstalled: true,
    listUpgrades: true,
    show: true,
    install: true,
    uninstall: true,
    supportsArchiveDownload: false,
    manageSources: true,
  },

  checkAvailability: createCliAvailabilityChecker({
    binary: 'choco',
    versionArgs: ['--version'],
    extraPaths: getChocoExtraPaths,
    notFoundMessage: 'Chocolatey ist auf diesem PC nicht installiert.',
  }),

  async isAvailable(opts = {}) {
    return this.checkAvailability(opts);
  },

  installManager: createPowerShellBootstrapRunner({
    script: CHOCO_INSTALL_SCRIPT,
    requiresAdmin: true,
    label: 'Installiere Chocolatey (erfordert UAC-Bestätigung)...',
  }),

  uninstallManager: createPowerShellBootstrapRunner({
    script: CHOCO_UNINSTALL_SCRIPT,
    requiresAdmin: true,
    label: 'Entferne Chocolatey und %ChocolateyInstall%...',
  }),

  async search(query, { limit = 25, signal = null } = {}) {
    const cleanQuery = String(query || '').trim();
    if (cleanQuery.length < 2) {
      return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
    }

    const pageSize = Number.isFinite(limit) && limit > 0 ? Math.min(Math.max(Math.round(limit), 1), 100) : 25;
    const res = await runChoco(['search', cleanQuery, '-r', `--page-size=${pageSize}`], {
      signal,
      timeoutMs: 60000,
    });
    if (res.aborted) return { success: false, results: [], canceled: true };
    if (res.notFound || (res.code === -1 && !res.stdout)) {
      return {
        success: false,
        results: [],
        error: res.error || res.stderr || 'Chocolatey ist auf diesem PC nicht verfügbar.',
      };
    }

    const results = parseChocoSearchOutput(res.stdout, limit);
    return {
      success: true,
      results,
      hint: results.length === 0 ? res.stderr || 'Keine Chocolatey-Treffer gefunden.' : '',
    };
  },

  async listInstalled({ signal = null } = {}) {
    const res = await runChoco(['list', '-r'], { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, packages: [], canceled: true };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        packages: [],
        error: res.error || res.stderr || 'choco list -r fehlgeschlagen.',
      };
    }

    const packages = parseChocoListOutput(res.stdout);
    return { success: true, packages };
  },

  async listUpgrades({ signal = null } = {}) {
    const res = await runChoco(['outdated', '-r'], { signal, timeoutMs: 60000 });
    if (res.aborted) return { success: false, upgrades: [], canceled: true };
    if (res.notFound || (res.code === -1 && !res.stdout)) {
      return {
        success: false,
        upgrades: [],
        error: res.error || res.stderr || 'Chocolatey ist auf diesem PC nicht verfügbar.',
      };
    }

    const upgrades = parseChocoOutdatedOutput(res.stdout);
    return { success: true, upgrades };
  },

  async show(packageId, { forceRefresh = false, signal = null } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!cleanId) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: 'Keine Chocolatey-Paket-ID angegeben.',
      };
    }

    const cacheKey = `chocolatey:show:${cleanId.toLowerCase()}`;
    const cache = getWingetCache();
    const res = await cache.getOrFetch(cacheKey, () => fetchChocoShowFresh(cleanId, { signal }), {
      forceRefresh,
    });

    if (!res.data) {
      return {
        success: false,
        package: null,
        fromCache: false,
        isStale: false,
        updatedAt: null,
        error: res.error || `Chocolatey-Paket "${cleanId}" nicht gefunden.`,
      };
    }

    return {
      success: true,
      package: res.data,
      fromCache: res.fromCache,
      isStale: res.isStale,
      updatedAt: res.updatedAt,
      error: res.error,
    };
  },

  async install(packageId, { upgrade = false, version = '', itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidChocoPackageId(cleanId)) {
      return { success: false, error: 'Ungültige Chocolatey-Paket-ID angegeben.' };
    }

    const cleanVer = String(version || '').trim();
    if (cleanVer && !/^[A-Za-z0-9._+-]+$/.test(cleanVer)) {
      return { success: false, error: 'Ungültige Chocolatey-Versionsnummer angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: upgrade ? 'choco-upgrade' : 'choco-install',
        title: `Chocolatey-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
        dedupeKey: `choco-install:${cleanId.toLowerCase()}`,
        cancelable: true,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Chocolatey-Aktion läuft bereits.' };
      job.update(null, 'Warte auf Administrator-Bestätigung (UAC) für Chocolatey...');
    }

    const activeSignal = job ? job.signal : signal;
    const actionVerb = upgrade ? 'upgrade' : 'install';
    const verArg = cleanVer ? ` '--version' '${escapeSingleQuotedPs(cleanVer)}'` : '';
    const chocoScript = [
      "$chocoBin = if (Get-Command choco -ErrorAction SilentlyContinue) { 'choco' } else { Join-Path ($env:ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey') 'bin\\choco.exe' }",
      `& $chocoBin '${actionVerb}' '${escapeSingleQuotedPs(cleanId)}' '-y'${verArg}`,
    ].join('\n');

    const res = await runElevatedPowerShell(chocoScript, {
      signal: activeSignal,
      timeoutMs: INSTALL_TIMEOUT_MS,
      onProgress: (pct, detail) => job?.update(pct, detail),
    });

    if (activeSignal?.aborted || res.aborted || res.canceled) {
      job?.finish('canceled', 'Chocolatey-Vorgang abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }

    if (res.code === 0 || res.code === 3010 || res.code === 1641) {
      const rebootRequired = res.code === 3010 || res.code === 1641;
      const msg = rebootRequired
        ? 'Über Chocolatey ausgeführt (Neustart empfohlen).'
        : upgrade
          ? 'Erfolgreich über Chocolatey aktualisiert.'
          : 'Erfolgreich über Chocolatey installiert.';
      job?.finish('done', msg, { autoRemoveMs: 4000 });
      return { success: true, exitCode: res.code, rebootRequired };
    }

    const errMsg = (res.error || res.stderr || res.stdout || `Chocolatey-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async upgrade(packageId, opts = {}) {
    return this.install(packageId, { ...opts, upgrade: true });
  },

  async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
    const cleanId = String(packageId || '').trim();
    if (!isValidChocoPackageId(cleanId)) {
      return { success: false, error: 'Ungültige Chocolatey-Paket-ID angegeben.' };
    }

    let job = null;
    if (useJob) {
      job = createJob({
        type: 'choco-uninstall',
        title: `Chocolatey-Deinstallation: ${itemName || cleanId}`,
        dedupeKey: `choco-uninstall:${cleanId.toLowerCase()}`,
        cancelable: false,
      });
      if (!job) return { success: false, alreadyRunning: true, error: 'Chocolatey-Deinstallation läuft bereits.' };
      job.update(null, 'Warte auf Administrator-Bestätigung (UAC) für Chocolatey...');
    }

    const chocoScript = [
      "$chocoBin = if (Get-Command choco -ErrorAction SilentlyContinue) { 'choco' } else { Join-Path ($env:ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey') 'bin\\choco.exe' }",
      `& $chocoBin 'uninstall' '${escapeSingleQuotedPs(cleanId)}' '-y'`,
    ].join('\n');

    const res = await runElevatedPowerShell(chocoScript, {
      signal,
      timeoutMs: INSTALL_TIMEOUT_MS,
      onProgress: (pct, detail) => job?.update(pct, detail),
    });

    if (res.canceled || res.aborted) {
      job?.finish('canceled', 'Chocolatey-Deinstallation abgebrochen.', { autoRemoveMs: 3500 });
      return { success: false, canceled: true, exitCode: res.code };
    }

    if (res.code === 0 || res.code === 3010 || res.code === 1641) {
      const rebootRequired = res.code === 3010 || res.code === 1641;
      job?.finish(
        'done',
        rebootRequired ? 'Deinstalliert (Neustart empfohlen).' : 'Erfolgreich über Chocolatey deinstalliert.',
        {
          autoRemoveMs: 4000,
        }
      );
      return { success: true, exitCode: res.code, rebootRequired };
    }

    const errMsg = (res.error || res.stderr || res.stdout || `Chocolatey-Fehlercode ${res.code}`).trim();
    job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return { success: false, exitCode: res.code, error: errMsg };
  },

  async listSources({ signal = null } = {}) {
    const res = await runChoco(['source', 'list', '-r'], { signal, timeoutMs: 30000 });
    if (res.aborted) return { success: false, canceled: true, sources: [] };
    if (res.notFound || (res.code !== 0 && !res.stdout)) {
      return {
        success: false,
        sources: [],
        templates: PROVIDER_SOURCE_TEMPLATES.chocolatey,
        requiresAdmin: true,
        mode: 'cli',
        error: res.error || res.stderr || 'Chocolatey-Quellen konnten nicht abgerufen werden.',
      };
    }

    const sources = parseChocoSourceListOutput(res.stdout).map((src) => ({
      ...src,
      builtIn: false,
    }));
    return {
      success: true,
      mode: 'cli',
      requiresAdmin: true,
      sources,
      templates: PROVIDER_SOURCE_TEMPLATES.chocolatey,
      hint: 'Aenderungen an Chocolatey-Quellen erfordern Administratorrechte (UAC).',
    };
  },

  async addSource({ name = '', url = '' } = {}, { signal = null } = {}) {
    const cleanName = String(name || '').trim();
    const cleanUrl = String(url || '').trim();
    if (!isValidSourceName(cleanName)) {
      return { success: false, error: 'Ungueltiger Quellenname (erlaubt: Buchstaben, Ziffern, . _ -).' };
    }
    if (!isValidSourceUrl(cleanUrl)) {
      return { success: false, error: 'Bitte eine gueltige HTTP/HTTPS-URL angeben.' };
    }

    const chocoScript = [
      "$chocoBin = if (Get-Command choco -ErrorAction SilentlyContinue) { 'choco' } else { Join-Path ($env:ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey') 'bin\\choco.exe' }",
      `& $chocoBin 'source' 'add' '-n=${escapeSingleQuotedPs(cleanName)}' '-s=${escapeSingleQuotedPs(cleanUrl)}'`,
    ].join('\n');

    const res = await runElevatedPowerShell(chocoScript, { signal, timeoutMs: 2 * 60 * 1000 });
    if (res.canceled || res.aborted) return { success: false, canceled: true };
    if (res.code === 0) return { success: true };
    return {
      success: false,
      error: (res.error || res.stderr || res.stdout || `Chocolatey-Quelle konnte nicht hinzugefuegt werden.`).trim(),
    };
  },

  async removeSource(name, { signal = null } = {}) {
    const cleanName = String(name || '').trim();
    if (!isValidSourceName(cleanName)) {
      return { success: false, error: 'Ungueltiger Quellenname.' };
    }

    const chocoScript = [
      "$chocoBin = if (Get-Command choco -ErrorAction SilentlyContinue) { 'choco' } else { Join-Path ($env:ChocolateyInstall ?? 'C:\\ProgramData\\chocolatey') 'bin\\choco.exe' }",
      `& $chocoBin 'source' 'remove' '-n=${escapeSingleQuotedPs(cleanName)}'`,
    ].join('\n');

    const res = await runElevatedPowerShell(chocoScript, { signal, timeoutMs: 2 * 60 * 1000 });
    if (res.canceled || res.aborted) return { success: false, canceled: true };
    if (res.code === 0) return { success: true };
    return {
      success: false,
      error: (res.error || res.stderr || res.stdout || `Chocolatey-Quelle konnte nicht entfernt werden.`).trim(),
    };
  },
};
