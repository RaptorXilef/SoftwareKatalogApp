/** @typedef {'installed' | 'portable-exe' | 'portable-dir'} InstallKind */
/** @typedef {'x64' | 'ia32' | 'arm64'} NormalizedArch */

const NON_WINDOWS_ASSET_RE = /(?:^|[-_.])(mac|darwin|osx|linux)(?:[-_.]|$)|\.(?:dmg|pkg|appimage|deb|rpm|snap)$/i;
const ARCH_X64_RE = /(?:^|[-_.])(x64|amd64|win64)(?:[-_.]|$)/i;
const ARCH_IA32_RE = /(?:^|[-_.])(ia32|x86|32bit|win32-ia32)(?:[-_.]|$)/i;
const ARCH_ARM64_RE = /(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/i;

function normalizeWinSlashes(rawPath) {
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) return '';
  const hasUnc = trimmed.startsWith('\\\\') || trimmed.startsWith('//');
  const collapsed = trimmed.replace(/[\\/]+/g, '\\');
  return hasUnc && !collapsed.startsWith('\\\\') ? `\\${collapsed}` : collapsed;
}

function joinSegments(platform, ...parts) {
  const sep = platform === 'win32' ? '\\' : '/';
  const filtered = parts.map((p) => String(p || '').trim()).filter(Boolean);
  if (filtered.length === 0) return '';
  return filtered
    .map((part, idx) => {
      const normalized = platform === 'win32' ? normalizeWinSlashes(part) : part.replace(/\/+/g, '/');
      if (idx === 0)
        return (
          normalized.replace(/[\\/]+$/, '') || (platform !== 'win32' && normalized.startsWith('/') ? '/' : normalized)
        );
      return normalized.replace(/^[\\/]+|[\\/]+$/g, '');
    })
    .filter(Boolean)
    .join(sep)
    .replace(/^\/\//, '/');
}

function dirnameWin(filePath) {
  const norm = normalizeWinSlashes(filePath).replace(/\\+$/, '');
  const idx = norm.lastIndexOf('\\');
  if (idx <= 0) return norm;
  const parent = norm.slice(0, idx);
  return /^[a-z]:$/i.test(parent) ? `${parent}\\` : parent;
}

/**
 * Normalisiert eine Node-/Electron-Architekturkennung auf 'x64', 'ia32' oder 'arm64'.
 * @param {unknown} arch
 * @returns {NormalizedArch}
 */
export function normalizeArch(arch) {
  const clean = String(arch || '')
    .trim()
    .toLowerCase();
  if (clean === 'ia32' || clean === 'x86') return 'ia32';
  if (clean === 'arm64' || clean === 'aarch64') return 'arm64';
  if (clean === 'x64' || clean === 'amd64') return 'x64';
  return 'x64';
}

function normalizeWinPathForCompare(rawPath) {
  return normalizeWinSlashes(rawPath)
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

function isInsideWinDir(candidateDir, rootDir) {
  const cleanCandidate = normalizeWinPathForCompare(candidateDir);
  const cleanRoot = normalizeWinPathForCompare(rootDir);
  if (!cleanCandidate || !cleanRoot) return false;
  return cleanCandidate === cleanRoot || cleanCandidate.startsWith(`${cleanRoot}\\`);
}

/**
 * Prueft, ob ein Windows-Verzeichnis unter Program Files oder Program Files (x86) liegt.
 * @param {string} dirPath
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isWindowsProgramFilesPath(dirPath, env = {}) {
  const clean = String(dirPath || '').trim();
  if (!clean) return false;

  const envRoots = [env?.ProgramFiles, env?.['ProgramFiles(x86)'], env?.ProgramW6432].filter(Boolean);
  for (const root of envRoots) {
    if (isInsideWinDir(clean, root)) return true;
  }

  return /^[a-z]:\\program files(?: \(x86\))?(?:\\|$)/i.test(normalizeWinSlashes(clean));
}

/**
 * Prueft, ob ein Windows-Verzeichnis unter AppData\Local\Programs liegt (NSIS Per-User-Standard).
 * @param {string} dirPath
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isWindowsLocalProgramsPath(dirPath, env = {}) {
  const clean = String(dirPath || '').trim();
  if (!clean) return false;

  if (env?.LOCALAPPDATA) {
    const localPrograms = joinSegments('win32', env.LOCALAPPDATA, 'Programs');
    if (isInsideWinDir(clean, localPrograms)) return true;
  }

  return /\\appdata\\local\\programs(?:\\|$)/i.test(normalizeWinSlashes(clean));
}

/**
 * Erkennt den Start-/Installationsmodus der App:
 * - 'portable-exe': PORTABLE_EXECUTABLE_DIR ist gesetzt
 * - 'installed': liegt in Program Files, AppData\Local\Programs oder enthaelt NSIS-Uninstaller
 * - 'portable-dir': entpackter ZIP-Ordner oder Dev-Modus
 * @param {{
 *   isPackaged?: boolean,
 *   execPath?: string,
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   existsSync?: (p: string) => boolean,
 *   readdirSync?: (p: string) => string[],
 * }} [options]
 * @returns {{ installKind: InstallKind, isAllUsersInstall: boolean }}
 */
export function detectInstallKind({
  isPackaged = false,
  execPath = '',
  env = {},
  platform = 'win32',
  existsSync = () => false,
  readdirSync = null,
} = {}) {
  if (String(env?.PORTABLE_EXECUTABLE_DIR || '').trim()) {
    return { installKind: 'portable-exe', isAllUsersInstall: false };
  }

  if (!isPackaged) {
    return { installKind: 'portable-dir', isAllUsersInstall: false };
  }

  if (platform === 'win32' && execPath) {
    const execDir = dirnameWin(execPath);
    const inProgramFiles = isWindowsProgramFilesPath(execDir, env);
    const inLocalPrograms = isWindowsLocalProgramsPath(execDir, env);

    let hasUninstaller = false;
    try {
      hasUninstaller = Boolean(existsSync(joinSegments('win32', execDir, 'Uninstall Software Katalog.exe')));
    } catch {
      hasUninstaller = false;
    }

    if (!hasUninstaller && typeof readdirSync === 'function') {
      try {
        const entries = readdirSync(execDir);
        if (Array.isArray(entries)) {
          hasUninstaller = entries.some((entry) => /^uninstall.*\.exe$/i.test(String(entry || '')));
        }
      } catch {
        // Ignorieren, falls Verzeichnis nicht gelistet werden kann
      }
    }

    if (inProgramFiles || inLocalPrograms || hasUninstaller) {
      return {
        installKind: 'installed',
        isAllUsersInstall: inProgramFiles,
      };
    }
  }

  return { installKind: 'portable-dir', isAllUsersInstall: false };
}

/**
 * Ermittelt den beschreibbaren data/-Ordner abhaengig vom Installationsmodus.
 * Bei installierter App in schreibgeschuetztem Program Files wird automatisch auf
 * ProgramData oder AppData ausgewichen.
 * @param {{
 *   installKind: InstallKind,
 *   isAllUsersInstall?: boolean,
 *   appFolder: string,
 *   appDataPath?: string,
 *   programDataPath?: string,
 *   platform?: string,
 *   isWritableDir?: (dirPath: string) => boolean,
 *   appDirName?: string,
 * }} options
 * @returns {{ dataDir: string, source: 'app-folder' | 'program-data' | 'app-data' }}
 */
export function resolveDataDir({
  installKind,
  isAllUsersInstall = false,
  appFolder,
  appDataPath = '',
  programDataPath = '',
  platform = 'win32',
  isWritableDir = () => true,
  appDirName = 'SoftwareKatalog',
}) {
  const appDataDir = joinSegments(platform, appFolder, 'data');

  if (installKind !== 'installed') {
    return { dataDir: appDataDir, source: 'app-folder' };
  }

  if (isAllUsersInstall) {
    if (programDataPath) {
      const programDataTarget = joinSegments(platform, programDataPath, appDirName, 'data');
      if (isWritableDir(programDataTarget)) {
        return { dataDir: programDataTarget, source: 'program-data' };
      }
    }
    if (appDataPath) {
      return { dataDir: joinSegments(platform, appDataPath, appDirName, 'data'), source: 'app-data' };
    }
    return { dataDir: appDataDir, source: 'app-folder' };
  }

  if (isWritableDir(appDataDir)) {
    return { dataDir: appDataDir, source: 'app-folder' };
  }

  if (appDataPath) {
    return { dataDir: joinSegments(platform, appDataPath, appDirName, 'data'), source: 'app-data' };
  }

  return { dataDir: appDataDir, source: 'app-folder' };
}

function getAssetArchTag(name) {
  if (ARCH_ARM64_RE.test(name)) return 'arm64';
  if (ARCH_IA32_RE.test(name)) return 'ia32';
  if (ARCH_X64_RE.test(name)) return 'x64';
  return null;
}

function pickByArchPreference(
  candidates,
  targetArch,
  { allowNeutralFallback = true, allowX64FallbackForArm64 = false } = {}
) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const exact = candidates.find((c) => getAssetArchTag(c.name) === targetArch);
  if (exact) return exact;

  if (allowX64FallbackForArm64 && targetArch === 'arm64') {
    const x64Match = candidates.find((c) => getAssetArchTag(c.name) === 'x64');
    if (x64Match) return x64Match;
  }

  if (allowNeutralFallback) {
    const neutral = candidates.find((c) => getAssetArchTag(c.name) === null);
    if (neutral) return neutral;
  }

  return null;
}

/**
 * Waehlt aus GitHub-Release-Assets das exakt passende Windows-Asset fuer installKind & Architektur.
 * @param {Array<{ name?: string, browser_download_url?: string }>} assets
 * @param {{ installKind?: InstallKind, arch?: string, platform?: string }} [options]
 * @returns {{ name: string, url: string, asset: { name: string, browser_download_url: string } } | null}
 */
export function selectReleaseAsset(assets, { installKind = 'portable-dir', arch = 'x64', platform = 'win32' } = {}) {
  if (!Array.isArray(assets) || assets.length === 0) return null;

  const targetArch = normalizeArch(arch);
  const validAssets = assets.filter((asset) => {
    const name = String(asset?.name || '').trim();
    const url = String(asset?.browser_download_url || '').trim();
    if (!name || !url) return false;
    if (name.toLowerCase().endsWith('.blockmap')) return false;
    if (platform === 'win32' && NON_WINDOWS_ASSET_RE.test(name)) return false;
    return true;
  });

  if (validAssets.length === 0) return null;

  let chosen = null;

  if (installKind === 'installed') {
    const setupCandidates = validAssets.filter((asset) => {
      const lower = asset.name.toLowerCase();
      return (
        lower.endsWith('.exe') &&
        !lower.includes('portable') &&
        (lower.includes('setup') || lower.includes('installer'))
      );
    });

    chosen = pickByArchPreference(setupCandidates, targetArch, {
      allowNeutralFallback: true,
      allowX64FallbackForArm64: true,
    });
  } else if (installKind === 'portable-exe') {
    const portableCandidates = validAssets.filter((asset) => {
      const lower = asset.name.toLowerCase();
      return lower.endsWith('.exe') && lower.includes('portable');
    });

    chosen = pickByArchPreference(portableCandidates, targetArch, {
      allowNeutralFallback: true,
      allowX64FallbackForArm64: true,
    });
  } else {
    const zipCandidates = validAssets.filter((asset) => asset.name.toLowerCase().endsWith('.zip'));

    chosen = pickByArchPreference(zipCandidates, targetArch, {
      allowNeutralFallback: true,
      allowX64FallbackForArm64: true,
    });
  }

  if (!chosen) return null;
  return {
    name: chosen.name,
    url: chosen.browser_download_url,
    asset: /** @type {{ name: string, browser_download_url: string }} */ (chosen),
  };
}

function tr(translateFn, key, params, fallback) {
  if (typeof translateFn === 'function') {
    const translated = translateFn(key, params);
    if (typeof translated === 'string' && translated && translated !== key) {
      return translated;
    }
  }
  return fallback;
}

/**
 * Formatiert Installationsmodus und Architektur fuer die Anzeige in den Einstellungen.
 * @param {string} [installKind]
 * @param {string} [arch]
 * @param {{ isPackaged?: boolean, isAllUsersInstall?: boolean, t?: (key: string, params?: Record<string, unknown>) => string }} [options]
 * @returns {{ label: string, detail: string, shortBadge: string, installKind: InstallKind, arch: NormalizedArch }}
 */
export function formatInstallModeInfo(
  installKind = 'portable-dir',
  arch = 'x64',
  { isPackaged = true, isAllUsersInstall = false, t = undefined } = {}
) {
  const normalizedKind =
    installKind === 'installed' || installKind === 'portable-exe' || installKind === 'portable-dir'
      ? installKind
      : 'portable-dir';
  const normalizedArch = normalizeArch(arch);
  const bitLabel =
    normalizedArch === 'ia32'
      ? tr(t, 'appUpdate.mode.arch32', {}, '32-Bit')
      : normalizedArch === 'arm64'
        ? 'ARM64'
        : tr(t, 'appUpdate.mode.arch64', {}, '64-Bit');

  if (normalizedKind === 'installed') {
    return {
      label: tr(t, 'appUpdate.mode.installedLabel', { arch: bitLabel }, `Installiert (${bitLabel})`),
      detail: isAllUsersInstall
        ? tr(t, 'appUpdate.mode.installedAllUsersDetail', {}, 'Systemweite Installation (Alle Benutzer)')
        : tr(t, 'appUpdate.mode.installedUserDetail', {}, 'Benutzer-Installation'),
      shortBadge: tr(t, 'appUpdate.mode.installedShort', { arch: bitLabel }, `Installiert - ${bitLabel}`),
      installKind: normalizedKind,
      arch: normalizedArch,
    };
  }

  if (normalizedKind === 'portable-exe') {
    return {
      label: tr(t, 'appUpdate.mode.portableExeLabel', { arch: bitLabel }, `Portabel (${bitLabel})`),
      detail: tr(t, 'appUpdate.mode.portableExeDetail', {}, 'Portable Einzel-EXE'),
      shortBadge: tr(t, 'appUpdate.mode.portableExeShort', { arch: bitLabel }, `Portabel - ${bitLabel}`),
      installKind: normalizedKind,
      arch: normalizedArch,
    };
  }

  return {
    label: tr(t, 'appUpdate.mode.portableDirLabel', { arch: bitLabel }, `Portabel (Ordner, ${bitLabel})`),
    detail: isPackaged
      ? tr(t, 'appUpdate.mode.portableDirPackagedDetail', {}, 'Entpacktes ZIP-Archiv')
      : tr(t, 'appUpdate.mode.portableDirDevDetail', {}, 'Entwicklungsmodus'),
    shortBadge: isPackaged
      ? tr(t, 'appUpdate.mode.portableDirPackagedShort', { arch: bitLabel }, `Portabel (ZIP) - ${bitLabel}`)
      : tr(t, 'appUpdate.mode.portableDirDevShort', { arch: bitLabel }, `Entwicklung - ${bitLabel}`),
    installKind: normalizedKind,
    arch: normalizedArch,
  };
}

/**
 * Escaped einen String sicher fuer einfach zitierte PowerShell-Literale ('...').
 * @param {unknown} value
 * @returns {string}
 */
export function escapePsSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

/**
 * Erzeugt das PowerShell-Update-Skript fuer NSIS-Installer, Portable-EXE oder ZIP-Ordner.
 * @param {{
 *   installKind: InstallKind,
 *   isAllUsersInstall?: boolean,
 *   tempFilePath: string,
 *   execPath: string,
 *   portableExecutableFile?: string,
 *   appFolder: string,
 *   pid?: number,
 * }} options
 * @returns {string}
 */
export function buildUpdatePowerShellScript({
  installKind,
  isAllUsersInstall = false,
  tempFilePath,
  execPath,
  portableExecutableFile = '',
  appFolder,
  pid = 0,
}) {
  const safeTempFile = escapePsSingleQuoted(tempFilePath);
  const safeExecPath = escapePsSingleQuoted(execPath);
  const safePortableTarget = escapePsSingleQuoted(portableExecutableFile || execPath);
  const safeAppFolder = escapePsSingleQuoted(appFolder);
  const cleanPid = Number.isFinite(pid) && pid > 0 ? Math.trunc(pid) : 0;

  const waitBlock = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    cleanPid > 0 ? `Wait-Process -Id ${cleanPid} -Timeout 30 -ErrorAction SilentlyContinue` : '',
    'Start-Sleep -Seconds 1',
  ]
    .filter(Boolean)
    .join('\n');

  if (installKind === 'installed') {
    const scopeArg = isAllUsersInstall ? "'/allusers'" : "'/currentuser'";
    const elevPart = isAllUsersInstall ? ' -Verb RunAs' : '';
    return [
      waitBlock,
      `$installerPath = '${safeTempFile}'`,
      `$execPath = '${safeExecPath}'`,
      `$argList = @(${scopeArg}, '/S')`,
      'try {',
      `  $proc = Start-Process -FilePath $installerPath -ArgumentList $argList${elevPart} -Wait -PassThru`,
      '  if ($proc -and $proc.ExitCode -eq 0 -and $execPath -and (Test-Path -LiteralPath $execPath)) {',
      '    Start-Process -FilePath $execPath',
      '  }',
      '} finally {',
      '  Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue',
      '  Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
      '}',
      '',
    ].join('\n');
  }

  if (installKind === 'portable-exe') {
    return [
      waitBlock,
      `$tempExe = '${safeTempFile}'`,
      `$targetExe = '${safePortableTarget}'`,
      '$oldExe = "$targetExe.old"',
      'try {',
      '  if (Test-Path -LiteralPath $oldExe) {',
      '    Remove-Item -LiteralPath $oldExe -Force -ErrorAction SilentlyContinue',
      '  }',
      '  if (Test-Path -LiteralPath $targetExe) {',
      '    Move-Item -LiteralPath $targetExe -Destination $oldExe -Force',
      '  }',
      '  Move-Item -LiteralPath $tempExe -Destination $targetExe -Force',
      '  if (Test-Path -LiteralPath $targetExe) {',
      '    Start-Process -FilePath $targetExe',
      '  }',
      '} finally {',
      '  Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
      '}',
      '',
    ].join('\n');
  }

  const tempDir = dirnameWin(tempFilePath);
  const safeExtractPath = escapePsSingleQuoted(joinSegments('win32', tempDir, 'sk_update_extract'));
  const safeBackupDir = escapePsSingleQuoted(joinSegments('win32', tempDir, 'sk_update_backup'));

  return [
    waitBlock,
    `$zipPath = '${safeTempFile}'`,
    `$appPath = '${safeAppFolder}'`,
    `$extractPath = '${safeExtractPath}'`,
    `$backupDir = '${safeBackupDir}'`,
    `$execPath = '${safeExecPath}'`,
    'try {',
    '  if (Test-Path -LiteralPath $extractPath) { Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue }',
    '  if (Test-Path -LiteralPath $backupDir) { Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue }',
    '  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force',
    '  $sourceDir = $extractPath',
    '  $subDirs = @(Get-ChildItem -LiteralPath $extractPath -Directory)',
    '  $filesInRoot = @(Get-ChildItem -LiteralPath $extractPath -File)',
    '  if ($subDirs.Count -eq 1 -and $filesInRoot.Count -eq 0) {',
    '    $sourceDir = $subDirs[0].FullName',
    '  }',
    '  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null',
    "  foreach ($item in @('data', 'config.json', 'catalog.json')) {",
    '    $fullPath = Join-Path $appPath $item',
    '    if (Test-Path -LiteralPath $fullPath) {',
    '      Copy-Item -LiteralPath $fullPath -Destination $backupDir -Recurse -Force',
    '    }',
    '  }',
    '  Copy-Item -Path (Join-Path $sourceDir "*") -Destination $appPath -Recurse -Force',
    '  if (Test-Path -LiteralPath (Join-Path $backupDir "*")) {',
    '    Copy-Item -Path (Join-Path $backupDir "*") -Destination $appPath -Recurse -Force',
    '  }',
    '  if ($execPath -and (Test-Path -LiteralPath $execPath)) {',
    '    Start-Process -FilePath $execPath',
    '  } else {',
    '    $exe = Get-ChildItem -LiteralPath $appPath -Filter "*.exe" | Where-Object { $_.Name -notlike "Uninstall*" } | Select-Object -First 1',
    '    if ($exe) { Start-Process -FilePath $exe.FullName }',
    '  }',
    '} finally {',
    '  Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue',
    '  Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
    '}',
    '',
  ].join('\n');
}
