import {
  isValidSourceName,
  isValidSourceUrl,
  PROVIDER_SOURCE_TEMPLATES,
  parsePowerShellRepositoriesJson,
} from '../../shared/provider-sources-parser.js';
import {
  isValidPsModuleName,
  parsePowerShellVersionOutput,
  parsePsGalleryODataAtomXml,
  parsePsGalleryODataJson,
  parsePsGalleryShowEntry,
  parsePsInstalledModulesJson,
} from '../../shared/psgallery-parser.js';
import { compareVersions } from '../../shared/version.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli } from './cli-runner.js';
import { createWingetBootstrapRunner } from './manager-bootstrap.js';
import { getWingetCache } from './winget-provider.js';

const DEFAULT_TIMEOUT_MS = 60000;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const PSGALLERY_API_BASE = 'https://www.powershellgallery.com/api/v2';

function escapeSingleQuotedPs(value) {
  return String(value || '').replace(/'/g, "''");
}

function escapeODataString(value) {
  return String(value || '').replace(/'/g, "''");
}

async function runPowerShellBinary(binary, extraPaths, script, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const resolvedExtra = typeof extraPaths === 'function' ? extraPaths() : extraPaths || [];
  const exePath = await findBinaryPath(binary, { signal, timeoutMs: 5000, extraPaths: resolvedExtra });
  if (!exePath && !binary) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: Boolean(signal?.aborted),
      notFound: true,
      error: `${binary} ist auf diesem PC nicht verfuegbar.`,
      errorCode: 'ENOENT',
      binaryPath: null,
    };
  }

  const fullScript = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    "$ProgressPreference = 'SilentlyContinue'",
    String(script || ''),
  ].join('\n');

  const encoded = Buffer.from(fullScript, 'utf16le').toString('base64');
  const res = await runCli(exePath || binary, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    signal,
    timeoutMs,
    windowsHide: true,
  });

  return { ...res, binaryPath: exePath || binary };
}

async function fetchPsGalleryApi(url, { signal = null, timeoutMs = 15000 } = {}) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const onExternalAbort = () => controller.abort();
  if (signal) {
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json, application/atom+xml, application/xml;q=0.9',
        'User-Agent': 'SoftwareKatalogApp',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`PowerShell Gallery HTTP-Fehler ${res.status}`);
    }
    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    const text = await res.text();
    return { text, isJson: contentType.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[') };
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

function parseGalleryApiPayload(payload, limit, packageManager) {
  if (!payload?.text) return [];
  if (payload.isJson) {
    return parsePsGalleryODataJson(payload.text, limit, { packageManager });
  }
  return parsePsGalleryODataAtomXml(payload.text, limit, { packageManager });
}

/**
 * Erstellt einen PowerShell-Gallery-Provider mit strikt isolierter Runtime (`pwsh.exe` oder `powershell.exe`).
 * @param {{
 *   id: 'pwsh7' | 'pwsh5',
 *   name: string,
 *   description: string,
 *   binary: string,
 *   extraPaths?: string[] | (() => string[]),
 *   preferPsResourceGet?: boolean,
 *   isSystemComponent?: boolean,
 *   canInstallManager?: boolean,
 *   canUninstallManager?: boolean,
 *   requiresAdminForBootstrap?: boolean,
 *   uninstallWarning?: string,
 *   wingetId?: string,
 * }} config
 */
export function createPowerShellGalleryProvider({
  id,
  name,
  description,
  binary,
  extraPaths = [],
  preferPsResourceGet = false,
  isSystemComponent = false,
  canInstallManager = false,
  canUninstallManager = false,
  requiresAdminForBootstrap = false,
  uninstallWarning = '',
  wingetId = '',
}) {
  const runRuntime = (script, opts = {}) => runPowerShellBinary(binary, extraPaths, script, opts);

  const fetchShowFresh = async (moduleName, { signal = null } = {}) => {
    const cleanName = String(moduleName || '').trim();
    if (!isValidPsModuleName(cleanName)) {
      throw new Error(`Ungueltiger PowerShell-Modulname: "${cleanName}".`);
    }

    try {
      const escaped = escapeODataString(cleanName);
      const url = `${PSGALLERY_API_BASE}/FindPackagesById()?id='${encodeURIComponent(escaped)}'`;
      const payload = await fetchPsGalleryApi(url, { signal });
      const entries = parseGalleryApiPayload(payload, 25, id);
      if (entries.length > 0) {
        const latest =
          entries.find((e) => e.isLatestVersion) ||
          [...entries].sort((a, b) => compareVersions(b.version || '0', a.version || '0', 4))[0];
        const parsed = parsePsGalleryShowEntry(latest, cleanName, { packageManager: id });
        if (parsed) return parsed;
      }
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') throw err;
    }

    const safeName = escapeSingleQuotedPs(cleanName);
    const cliScript = `
      $ErrorActionPreference = 'Stop'
      $m = Find-Module -Name '${safeName}' | Select-Object -First 1 Name,@{Name='Version';Expression={[string]$_.Version}},Author,Description,@{Name='ProjectUri';Expression={[string]$_.ProjectUri}},@{Name='LicenseUri';Expression={[string]$_.LicenseUri}},Tags
      if ($m) { $m | ConvertTo-Json -Depth 3 -Compress }
    `;
    const res = await runRuntime(cliScript, { signal, timeoutMs: 45000 });
    if (res.code === 0 && res.stdout.trim()) {
      const cliEntries = parsePsGalleryODataJson(res.stdout, 1, { packageManager: id });
      if (cliEntries.length > 0) {
        const parsed = parsePsGalleryShowEntry(cliEntries[0], cleanName, { packageManager: id });
        if (parsed) return parsed;
      }
    }

    throw new Error(`PowerShell-Modul "${cleanName}" nicht gefunden.`);
  };

  return {
    id,
    name,
    category: 'system',
    description,
    requiresAdminForBootstrap,
    canInstallManager,
    canUninstallManager,
    isSystemComponent,
    uninstallWarning,
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

    async checkAvailability({ signal = null } = {}) {
      try {
        const res = await runRuntime('$PSVersionTable.PSVersion.ToString()', { signal, timeoutMs: 10000 });
        if (res.notFound || res.code !== 0) {
          return {
            available: false,
            version: null,
            binaryPath: null,
            error: res.error || res.stderr || `${name} (${binary}) ist auf diesem PC nicht verfuegbar.`,
          };
        }
        return {
          available: true,
          version: parsePowerShellVersionOutput(res.stdout),
          binaryPath: res.binaryPath || binary,
          error: null,
        };
      } catch (err) {
        return {
          available: false,
          version: null,
          binaryPath: null,
          error: err?.message || `Fehler beim Pruefen von ${name}.`,
        };
      }
    },

    async isAvailable(opts = {}) {
      return this.checkAvailability(opts);
    },

    installManager:
      canInstallManager && wingetId
        ? createWingetBootstrapRunner({ wingetId, action: 'install', name })
        : async () => ({ success: false, error: `${name} ist eine integrierte Windows-Systemkomponente.` }),

    uninstallManager:
      canUninstallManager && wingetId
        ? createWingetBootstrapRunner({ wingetId, action: 'uninstall', name })
        : async () => ({ success: false, error: `${name} ist eine integrierte Windows-Systemkomponente.` }),

    async search(query, { limit = 25, signal = null } = {}) {
      const cleanQuery = String(query || '').trim();
      if (cleanQuery.length < 2) {
        return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
      }

      const maxResults = Number.isFinite(limit) && limit > 0 ? Math.min(Math.max(Math.round(limit), 1), 50) : 25;
      try {
        const escaped = escapeODataString(cleanQuery);
        const url = `${PSGALLERY_API_BASE}/Search()?$filter=IsLatestVersion&searchTerm='${encodeURIComponent(escaped)}'&targetFramework=''&includePrerelease=false&$top=${maxResults}`;
        const payload = await fetchPsGalleryApi(url, { signal });
        const results = parseGalleryApiPayload(payload, maxResults, id);
        return {
          success: true,
          results,
          hint: results.length === 0 ? 'Keine PowerShell-Gallery-Treffer gefunden.' : '',
        };
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') {
          return { success: false, results: [], canceled: true };
        }
      }

      // Fallback ueber Find-Module in der jeweiligen PowerShell-Runtime
      const safePattern = escapeSingleQuotedPs(`*${cleanQuery}*`);
      const cliScript = `
        $ErrorActionPreference = 'SilentlyContinue'
        $items = @(Find-Module -Name '${safePattern}' | Select-Object -First ${maxResults} Name,@{Name='Version';Expression={[string]$_.Version}},Author,Description,@{Name='ProjectUri';Expression={[string]$_.ProjectUri}},@{Name='LicenseUri';Expression={[string]$_.LicenseUri}},Tags)
        ConvertTo-Json -InputObject $items -Depth 3 -Compress
      `;
      const res = await runRuntime(cliScript, { signal, timeoutMs: 60000 });
      if (res.aborted) return { success: false, results: [], canceled: true };
      if (res.notFound || (res.code !== 0 && !res.stdout)) {
        return {
          success: false,
          results: [],
          error: res.error || res.stderr || `${name}-Suche fehlgeschlagen.`,
        };
      }

      const results = parsePsGalleryODataJson(res.stdout, maxResults, { packageManager: id });
      return {
        success: true,
        results,
        hint: results.length === 0 ? 'Keine PowerShell-Module gefunden.' : '',
      };
    },

    async listInstalled({ signal = null } = {}) {
      const listScript = preferPsResourceGet
        ? `
          $ErrorActionPreference = 'SilentlyContinue'
          if (Get-Command Get-InstalledPSResource -ErrorAction SilentlyContinue) {
            $mods = @(Get-InstalledPSResource | Select-Object Name,@{Name='Version';Expression={[string]$_.Version}},Author,Description,@{Name='ProjectUri';Expression={[string]$_.ProjectUri}},@{Name='LicenseUri';Expression={[string]$_.LicenseUri}})
          } else {
            $mods = @(Get-InstalledModule | Select-Object Name,@{Name='Version';Expression={[string]$_.Version}},Author,Description,@{Name='ProjectUri';Expression={[string]$_.ProjectUri}},@{Name='LicenseUri';Expression={[string]$_.LicenseUri}})
          }
          ConvertTo-Json -InputObject $mods -Depth 3 -Compress
        `
        : `
          $ErrorActionPreference = 'SilentlyContinue'
          $mods = @(Get-InstalledModule | Select-Object Name,@{Name='Version';Expression={[string]$_.Version}},Author,Description,@{Name='ProjectUri';Expression={[string]$_.ProjectUri}},@{Name='LicenseUri';Expression={[string]$_.LicenseUri}})
          ConvertTo-Json -InputObject $mods -Depth 3 -Compress
        `;

      const res = await runRuntime(listScript, { signal, timeoutMs: 60000 });
      if (res.aborted) return { success: false, packages: [], canceled: true };
      if (res.notFound || (res.code !== 0 && !res.stdout)) {
        return {
          success: false,
          packages: [],
          error: res.error || res.stderr || `${name} Get-InstalledModule fehlgeschlagen.`,
        };
      }

      const packages = parsePsInstalledModulesJson(res.stdout, { packageManager: id });
      return { success: true, packages };
    },

    async listUpgrades({ signal = null } = {}) {
      const installed = await this.listInstalled({ signal });
      if (installed.canceled) return { success: false, upgrades: [], canceled: true };
      if (!installed.success) return { success: false, upgrades: [], error: installed.error };

      const list = installed.packages.filter((p) => isValidPsModuleName(p.packageId));
      if (list.length === 0) return { success: true, upgrades: [] };

      const upgrades = [];
      const executing = new Set();
      const concurrency = 6;

      for (const pkg of list) {
        if (signal?.aborted) break;
        const task = (async () => {
          try {
            const latest = await fetchShowFresh(pkg.packageId, { signal });
            if (!latest?.version) return;
            const isOutdated = pkg.version ? compareVersions(latest.version, pkg.version, 4) > 0 : false;
            if (isOutdated) {
              upgrades.push({
                packageManager: id,
                packageId: pkg.packageId,
                id: pkg.packageId,
                name: pkg.name || pkg.packageId,
                installedVersion: pkg.version,
                availableVersion: latest.version,
                source: id,
              });
            }
          } catch {
            // Einzelne Gallery-Fehler blockieren keine weiteren Checks
          }
        })();

        executing.add(task);
        task.finally(() => executing.delete(task));
        if (executing.size >= concurrency) {
          await Promise.race(executing);
        }
      }

      await Promise.all(executing);
      if (signal?.aborted) return { success: false, upgrades: [], canceled: true };
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
          error: 'Kein PowerShell-Modulname angegeben.',
        };
      }

      const cacheKey = `psgallery:show:${cleanId.toLowerCase()}`;
      const cache = getWingetCache();
      const res = await cache.getOrFetch(cacheKey, () => fetchShowFresh(cleanId, { signal }), { forceRefresh });

      if (!res.data) {
        return {
          success: false,
          package: null,
          fromCache: false,
          isStale: false,
          updatedAt: null,
          error: res.error || `PowerShell-Modul "${cleanId}" nicht gefunden.`,
        };
      }

      return {
        success: true,
        package: { ...res.data, packageManager: id },
        fromCache: res.fromCache,
        isStale: res.isStale,
        updatedAt: res.updatedAt,
        error: res.error,
      };
    },

    async install(packageId, { upgrade = false, version = '', itemName = '', signal = null, useJob = true } = {}) {
      const cleanId = String(packageId || '').trim();
      if (!isValidPsModuleName(cleanId)) {
        return { success: false, error: 'Ungueltiger PowerShell-Modulname angegeben.' };
      }

      const cleanVer = String(version || '').trim();
      if (cleanVer && !/^[A-Za-z0-9._+-]+$/.test(cleanVer)) {
        return { success: false, error: 'Ungueltige Versionsangabe.' };
      }

      const safeId = escapeSingleQuotedPs(cleanId);
      const safeVer = escapeSingleQuotedPs(cleanVer);
      const psGetVersionArg = cleanVer ? `-RequiredVersion '${safeVer}'` : '';
      const psResVersionArg = cleanVer ? `-Version '${safeVer}'` : '';

      const fallbackCmd =
        upgrade && !cleanVer
          ? `Update-Module -Name '${safeId}' -Force`
          : `Install-Module -Name '${safeId}' ${psGetVersionArg} -Scope CurrentUser -Force -AllowClobber`;

      const psScript = preferPsResourceGet
        ? `
          $ErrorActionPreference = 'Stop'
          if (Get-Command ${upgrade && !cleanVer ? 'Update-PSResource' : 'Install-PSResource'} -ErrorAction SilentlyContinue) {
            ${
              upgrade && !cleanVer
                ? `Update-PSResource -Name '${safeId}' -TrustRepository -Quiet`
                : `Install-PSResource -Name '${safeId}' ${psResVersionArg} -Scope CurrentUser -TrustRepository -AcceptLicense -Quiet`
            }
          } else {
            ${fallbackCmd}
          }
        `
        : `
          $ErrorActionPreference = 'Stop'
          ${fallbackCmd}
        `;

      let job = null;
      if (useJob) {
        job = createJob({
          type: upgrade ? `${id}-upgrade` : `${id}-install`,
          title: `${name}-${upgrade ? 'Update' : 'Installation'}: ${itemName || cleanId}`,
          dedupeKey: `${id}-install:${cleanId.toLowerCase()}`,
          cancelable: true,
        });
        if (!job) return { success: false, alreadyRunning: true, error: `${name}-Aktion laeuft bereits.` };
        job.update(
          null,
          upgrade
            ? `Aktualisiere ${itemName || cleanId} via ${name}...`
            : `Installiere ${itemName || cleanId} via ${name}...`
        );
      }

      const activeSignal = job ? job.signal : signal;
      const res = await runRuntime(psScript, { signal: activeSignal, timeoutMs: INSTALL_TIMEOUT_MS });

      if (activeSignal?.aborted || res.aborted) {
        job?.finish('canceled', `${name}-Aktion abgebrochen.`, { autoRemoveMs: 3500 });
        return { success: false, canceled: true, exitCode: res.code };
      }
      if (res.notFound) {
        const msg = `${name} ist auf diesem PC nicht verfuegbar.`;
        job?.finish('error', msg, { autoRemoveMs: 6000 });
        return { success: false, exitCode: res.code, error: msg };
      }
      if (res.code === 0) {
        const msg = upgrade ? `Erfolgreich ueber ${name} aktualisiert.` : `Erfolgreich ueber ${name} installiert.`;
        job?.finish('done', msg, { autoRemoveMs: 4000 });
        return { success: true, exitCode: 0 };
      }

      const errMsg = (res.stderr || res.stdout || res.error || `${name}-Fehlercode ${res.code}`).trim();
      job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: errMsg };
    },

    async upgrade(packageId, opts = {}) {
      return this.install(packageId, { ...opts, upgrade: true });
    },

    async uninstall(packageId, { itemName = '', signal = null, useJob = true } = {}) {
      const cleanId = String(packageId || '').trim();
      if (!isValidPsModuleName(cleanId)) {
        return { success: false, error: 'Ungueltiger PowerShell-Modulname angegeben.' };
      }

      const safeId = escapeSingleQuotedPs(cleanId);
      const psScript = preferPsResourceGet
        ? `
          $ErrorActionPreference = 'Stop'
          if (Get-Command Uninstall-PSResource -ErrorAction SilentlyContinue) {
            Uninstall-PSResource -Name '${safeId}' -Version '*' -Quiet
          } else {
            Uninstall-Module -Name '${safeId}' -AllVersions -Force
          }
        `
        : `
          $ErrorActionPreference = 'Stop'
          Uninstall-Module -Name '${safeId}' -AllVersions -Force
        `;

      let job = null;
      if (useJob) {
        job = createJob({
          type: `${id}-uninstall`,
          title: `${name}-Deinstallation: ${itemName || cleanId}`,
          dedupeKey: `${id}-uninstall:${cleanId.toLowerCase()}`,
          cancelable: false,
        });
        if (!job) return { success: false, alreadyRunning: true, error: `${name}-Deinstallation laeuft bereits.` };
        job.update(null, `Deinstalliere ${itemName || cleanId} via ${name}...`);
      }

      const res = await runRuntime(psScript, { signal, timeoutMs: INSTALL_TIMEOUT_MS });
      if (res.aborted) {
        job?.finish('canceled', `${name}-Deinstallation abgebrochen.`, { autoRemoveMs: 3500 });
        return { success: false, canceled: true, exitCode: res.code };
      }
      if (res.code === 0) {
        job?.finish('done', `Erfolgreich ueber ${name} deinstalliert.`, { autoRemoveMs: 4000 });
        return { success: true, exitCode: 0 };
      }

      const errMsg = (res.stderr || res.stdout || res.error || `${name}-Fehlercode ${res.code}`).trim();
      job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
      return { success: false, exitCode: res.code, error: errMsg };
    },

    async listSources({ signal = null } = {}) {
      const listScript = preferPsResourceGet
        ? `
          $ErrorActionPreference = 'Stop'
          if (Get-Command Get-PSResourceRepository -ErrorAction SilentlyContinue) {
            $repos = @(Get-PSResourceRepository | Select-Object Name,@{Name='Uri';Expression={[string]$_.Uri}},Trusted,Priority)
          } else {
            $repos = @(Get-PSRepository | Select-Object Name,SourceLocation,InstallationPolicy)
          }
          ConvertTo-Json -InputObject $repos -Depth 3 -Compress
        `
        : `
          $ErrorActionPreference = 'Stop'
          $repos = @(Get-PSRepository | Select-Object Name,SourceLocation,InstallationPolicy)
          ConvertTo-Json -InputObject $repos -Depth 3 -Compress
        `;

      const res = await runRuntime(listScript, { signal, timeoutMs: 30000 });
      if (res.aborted) return { success: false, canceled: true, sources: [] };
      if (res.notFound || (res.code !== 0 && !res.stdout)) {
        return {
          success: false,
          sources: [],
          templates: PROVIDER_SOURCE_TEMPLATES[id] || [],
          requiresAdmin: false,
          mode: 'cli',
          error: res.error || res.stderr || `${name}-Repositories konnten nicht gelesen werden.`,
        };
      }

      const sources = parsePowerShellRepositoriesJson(res.stdout).map((repo) => ({
        ...repo,
        builtIn: false,
      }));
      return {
        success: true,
        mode: 'cli',
        requiresAdmin: false,
        sources,
        templates: PROVIDER_SOURCE_TEMPLATES[id] || [],
        hint: `Verwaltet Paketquellen direkt ueber ${preferPsResourceGet ? 'PSResourceGet / PowerShellGet' : 'PowerShellGet'} in ${name}.`,
      };
    },

    async addSource({ name: sourceName = '', url = '' } = {}, { signal = null } = {}) {
      const cleanName = String(sourceName || '').trim();
      const cleanUrl = String(url || '').trim();
      if (!isValidSourceName(cleanName)) {
        return { success: false, error: 'Ungueltiger Repository-Name (erlaubt: Buchstaben, Ziffern, . _ -).' };
      }
      const isPsGalleryDefault = cleanName.toLowerCase() === 'psgallery' && !cleanUrl;
      if (!isPsGalleryDefault && !isValidSourceUrl(cleanUrl)) {
        return { success: false, error: 'Bitte eine gueltige HTTP/HTTPS-URL angeben.' };
      }

      const safeName = escapeSingleQuotedPs(cleanName);
      const safeUrl = escapeSingleQuotedPs(cleanUrl);
      const isPsGalleryName = cleanName.toLowerCase() === 'psgallery';

      const psScript = preferPsResourceGet
        ? `
          $ErrorActionPreference = 'Stop'
          if (Get-Command Register-PSResourceRepository -ErrorAction SilentlyContinue) {
            ${
              isPsGalleryName
                ? 'Register-PSResourceRepository -PSGallery -Trusted'
                : `Register-PSResourceRepository -Name '${safeName}' -Uri '${safeUrl}' -Trusted`
            }
          } else {
            ${
              isPsGalleryName
                ? 'Register-PSRepository -Default -InstallationPolicy Trusted'
                : `Register-PSRepository -Name '${safeName}' -SourceLocation '${safeUrl}' -InstallationPolicy Trusted`
            }
          }
        `
        : `
          $ErrorActionPreference = 'Stop'
          ${
            isPsGalleryName
              ? 'Register-PSRepository -Default -InstallationPolicy Trusted'
              : `Register-PSRepository -Name '${safeName}' -SourceLocation '${safeUrl}' -InstallationPolicy Trusted`
          }
        `;

      const res = await runRuntime(psScript, { signal, timeoutMs: 45000 });
      if (res.aborted) return { success: false, canceled: true };
      if (res.code === 0) return { success: true };
      return {
        success: false,
        error: (res.stderr || res.stdout || res.error || `${name}-Repository konnte nicht registriert werden.`).trim(),
      };
    },

    async removeSource(sourceName, { signal = null } = {}) {
      const cleanName = String(sourceName || '').trim();
      if (!isValidSourceName(cleanName)) {
        return { success: false, error: 'Ungueltiger Repository-Name.' };
      }

      const safeName = escapeSingleQuotedPs(cleanName);
      const psScript = preferPsResourceGet
        ? `
          $ErrorActionPreference = 'Stop'
          if (Get-Command Unregister-PSResourceRepository -ErrorAction SilentlyContinue) {
            Unregister-PSResourceRepository -Name '${safeName}'
          } else {
            Unregister-PSRepository -Name '${safeName}'
          }
        `
        : `
          $ErrorActionPreference = 'Stop'
          Unregister-PSRepository -Name '${safeName}'
        `;

      const res = await runRuntime(psScript, { signal, timeoutMs: 45000 });
      if (res.aborted) return { success: false, canceled: true };
      if (res.code === 0) return { success: true };
      return {
        success: false,
        error: (res.stderr || res.stdout || res.error || `${name}-Repository konnte nicht entfernt werden.`).trim(),
      };
    },
  };
}
