import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildUpdatePowerShellScript,
  detectInstallKind,
  escapePsSingleQuoted,
  formatInstallModeInfo,
  normalizeArch,
  resolveDataDir,
  selectReleaseAsset,
} from '../src/shared/app-update-logic.js';

const SAMPLE_RELEASE_ASSETS = [
  {
    name: 'SoftwareKatalog-Setup-x64.exe',
    browser_download_url:
      'https://github.com/RaptorXilef/SoftwareKatalogApp/releases/download/v1.27.0/SoftwareKatalog-Setup-x64.exe',
  },
  {
    name: 'SoftwareKatalog-Setup-x64.exe.blockmap',
    browser_download_url:
      'https://github.com/RaptorXilef/SoftwareKatalogApp/releases/download/v1.27.0/SoftwareKatalog-Setup-x64.exe.blockmap',
  },
  {
    name: 'SoftwareKatalog-Setup-ia32.exe',
    browser_download_url:
      'https://github.com/RaptorXilef/SoftwareKatalogApp/releases/download/v1.27.0/SoftwareKatalog-Setup-ia32.exe',
  },
  {
    name: 'SoftwareKatalog-Portable.exe',
    browser_download_url:
      'https://github.com/RaptorXilef/SoftwareKatalogApp/releases/download/v1.27.0/SoftwareKatalog-Portable.exe',
  },
  {
    name: 'Software.Katalog-1.27.0-win.zip',
    browser_download_url:
      'https://github.com/RaptorXilef/SoftwareKatalogApp/releases/download/v1.27.0/Software.Katalog-1.27.0-win.zip',
  },
  {
    name: 'Software.Katalog-1.27.0-mac.zip',
    browser_download_url:
      'https://github.com/RaptorXilef/SoftwareKatalogApp/releases/download/v1.27.0/Software.Katalog-1.27.0-mac.zip',
  },
  {
    name: 'Software.Katalog-1.27.0.AppImage',
    browser_download_url:
      'https://github.com/RaptorXilef/SoftwareKatalogApp/releases/download/v1.27.0/Software.Katalog-1.27.0.AppImage',
  },
];

describe('app-update-logic: detectInstallKind', () => {
  it('erkennt portable-exe anhand von PORTABLE_EXECUTABLE_DIR', () => {
    const res = detectInstallKind({
      isPackaged: true,
      execPath: 'C:\\Users\\Max\\AppData\\Local\\Temp\\app\\Software Katalog.exe',
      env: { PORTABLE_EXECUTABLE_DIR: 'D:\\Tools\\SoftwareKatalog' },
      platform: 'win32',
    });
    assert.deepEqual(res, { installKind: 'portable-exe', isAllUsersInstall: false });
  });

  it('erkennt systemweite NSIS-Installation in Program Files', () => {
    const res = detectInstallKind({
      isPackaged: true,
      execPath: 'C:\\Program Files\\Software Katalog\\Software Katalog.exe',
      env: { ProgramFiles: 'C:\\Program Files' },
      platform: 'win32',
    });
    assert.deepEqual(res, { installKind: 'installed', isAllUsersInstall: true });
  });

  it('erkennt 32-Bit NSIS-Installation in Program Files (x86)', () => {
    const res = detectInstallKind({
      isPackaged: true,
      execPath: 'C:\\Program Files (x86)\\Software Katalog\\Software Katalog.exe',
      env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      platform: 'win32',
    });
    assert.deepEqual(res, { installKind: 'installed', isAllUsersInstall: true });
  });

  it('erkennt Per-User NSIS-Installation in AppData\\Local\\Programs', () => {
    const res = detectInstallKind({
      isPackaged: true,
      execPath: 'C:\\Users\\Max\\AppData\\Local\\Programs\\Software Katalog\\Software Katalog.exe',
      env: { LOCALAPPDATA: 'C:\\Users\\Max\\AppData\\Local' },
      platform: 'win32',
    });
    assert.deepEqual(res, { installKind: 'installed', isAllUsersInstall: false });
  });

  it('erkennt benutzerdefinierte NSIS-Installation anhand des Uninstallers', () => {
    const res = detectInstallKind({
      isPackaged: true,
      execPath: 'D:\\Apps\\SoftwareKatalog\\Software Katalog.exe',
      env: {},
      platform: 'win32',
      existsSync: (p) => p === 'D:\\Apps\\SoftwareKatalog\\Uninstall Software Katalog.exe',
    });
    assert.deepEqual(res, { installKind: 'installed', isAllUsersInstall: false });
  });

  it('erkennt portable-dir fuer entpacktes ZIP und Dev-Modus', () => {
    const zipDir = detectInstallKind({
      isPackaged: true,
      execPath: 'D:\\Portable\\SoftwareKatalog\\Software Katalog.exe',
      env: {},
      platform: 'win32',
      existsSync: () => false,
      readdirSync: () => ['Software Katalog.exe', 'resources'],
    });
    assert.deepEqual(zipDir, { installKind: 'portable-dir', isAllUsersInstall: false });

    const devMode = detectInstallKind({
      isPackaged: false,
      execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
      env: {},
      platform: 'win32',
    });
    assert.deepEqual(devMode, { installKind: 'portable-dir', isAllUsersInstall: false });
  });
});

describe('app-update-logic: resolveDataDir', () => {
  it('weicht bei All-Users Program Files auf ProgramData aus oder auf AppData', () => {
    const withProgramData = resolveDataDir({
      installKind: 'installed',
      isAllUsersInstall: true,
      appFolder: 'C:\\Program Files\\Software Katalog',
      appDataPath: 'C:\\Users\\Max\\AppData\\Roaming',
      programDataPath: 'C:\\ProgramData',
      platform: 'win32',
      isWritableDir: (dir) => dir === 'C:\\ProgramData\\SoftwareKatalog\\data',
    });
    assert.deepEqual(withProgramData, {
      dataDir: 'C:\\ProgramData\\SoftwareKatalog\\data',
      source: 'program-data',
    });

    const fallbackAppData = resolveDataDir({
      installKind: 'installed',
      isAllUsersInstall: true,
      appFolder: 'C:\\Program Files\\Software Katalog',
      appDataPath: 'C:\\Users\\Max\\AppData\\Roaming',
      programDataPath: 'C:\\ProgramData',
      platform: 'win32',
      isWritableDir: () => false,
    });
    assert.deepEqual(fallbackAppData, {
      dataDir: 'C:\\Users\\Max\\AppData\\Roaming\\SoftwareKatalog\\data',
      source: 'app-data',
    });
  });

  it('weicht bei schreibgeschuetzter Per-User-Installation auf AppData aus', () => {
    const readonlyUserDir = resolveDataDir({
      installKind: 'installed',
      isAllUsersInstall: false,
      appFolder: 'C:\\Users\\Max\\AppData\\Local\\Programs\\Software Katalog',
      appDataPath: 'C:\\Users\\Max\\AppData\\Roaming',
      platform: 'win32',
      isWritableDir: () => false,
    });
    assert.deepEqual(readonlyUserDir, {
      dataDir: 'C:\\Users\\Max\\AppData\\Roaming\\SoftwareKatalog\\data',
      source: 'app-data',
    });
  });

  it('nutzt AppFolder/data fuer portable-exe und portable-dir', () => {
    const portableExe = resolveDataDir({
      installKind: 'portable-exe',
      appFolder: 'Z:\\NAS\\SoftwareKatalog',
      appDataPath: 'C:\\Users\\Max\\AppData\\Roaming',
      platform: 'win32',
      isWritableDir: () => false,
    });
    assert.deepEqual(portableExe, { dataDir: 'Z:\\NAS\\SoftwareKatalog\\data', source: 'app-folder' });

    const portableDir = resolveDataDir({
      installKind: 'portable-dir',
      appFolder: 'Z:\\NAS\\SoftwareKatalogZip',
      appDataPath: 'C:\\Users\\Max\\AppData\\Roaming',
      platform: 'win32',
      isWritableDir: () => false,
    });
    assert.deepEqual(portableDir, { dataDir: 'Z:\\NAS\\SoftwareKatalogZip\\data', source: 'app-folder' });
  });
});

describe('app-update-logic: selectReleaseAsset nach installKind und arch', () => {
  it('waehlt fuer installed + x64 das x64-Setup-Asset', () => {
    const picked = selectReleaseAsset(SAMPLE_RELEASE_ASSETS, { installKind: 'installed', arch: 'x64' });
    assert.equal(picked?.name, 'SoftwareKatalog-Setup-x64.exe');
    assert.match(picked?.url || '', /SoftwareKatalog-Setup-x64\.exe$/);
  });

  it('waehlt fuer installed + ia32 das ia32-Setup-Asset', () => {
    const picked = selectReleaseAsset(SAMPLE_RELEASE_ASSETS, { installKind: 'installed', arch: 'ia32' });
    assert.equal(picked?.name, 'SoftwareKatalog-Setup-ia32.exe');
  });

  it('faellt fuer installed + x64 auf architekturneutrales Setup zurueck', () => {
    const neutralAssets = [
      { name: 'SoftwareKatalog-Setup.exe', browser_download_url: 'https://example.invalid/SoftwareKatalog-Setup.exe' },
      {
        name: 'SoftwareKatalog-Portable.exe',
        browser_download_url: 'https://example.invalid/SoftwareKatalog-Portable.exe',
      },
    ];
    const picked = selectReleaseAsset(neutralAssets, { installKind: 'installed', arch: 'x64' });
    assert.equal(picked?.name, 'SoftwareKatalog-Setup.exe');
  });

  it('installiert auf ia32 niemals versehentlich ein reines x64-Setup', () => {
    const x64OnlyAssets = [
      {
        name: 'SoftwareKatalog-Setup-x64.exe',
        browser_download_url: 'https://example.invalid/SoftwareKatalog-Setup-x64.exe',
      },
      {
        name: 'SoftwareKatalog-Portable.exe',
        browser_download_url: 'https://example.invalid/SoftwareKatalog-Portable.exe',
      },
    ];
    const picked = selectReleaseAsset(x64OnlyAssets, { installKind: 'installed', arch: 'ia32' });
    assert.equal(picked, null);
  });

  it('waehlt fuer portable-exe jeweils die Portable-EXE fuer x64 und ia32', () => {
    const pickedX64 = selectReleaseAsset(SAMPLE_RELEASE_ASSETS, { installKind: 'portable-exe', arch: 'x64' });
    const pickedIa32 = selectReleaseAsset(SAMPLE_RELEASE_ASSETS, { installKind: 'portable-exe', arch: 'ia32' });
    assert.equal(pickedX64?.name, 'SoftwareKatalog-Portable.exe');
    assert.equal(pickedIa32?.name, 'SoftwareKatalog-Portable.exe');

    const archSpecificPortable = [
      { name: 'SoftwareKatalog-Portable-x64.exe', browser_download_url: 'https://example.invalid/p-x64.exe' },
      { name: 'SoftwareKatalog-Portable-ia32.exe', browser_download_url: 'https://example.invalid/p-ia32.exe' },
    ];
    assert.equal(
      selectReleaseAsset(archSpecificPortable, { installKind: 'portable-exe', arch: 'ia32' })?.name,
      'SoftwareKatalog-Portable-ia32.exe'
    );
  });

  it('waehlt fuer portable-dir das Windows-ZIP und ignoriert mac/linux/blockmap', () => {
    const pickedX64 = selectReleaseAsset(SAMPLE_RELEASE_ASSETS, { installKind: 'portable-dir', arch: 'x64' });
    assert.equal(pickedX64?.name, 'Software.Katalog-1.27.0-win.zip');

    const archZips = [
      { name: 'SoftwareKatalog-1.27.0-win-x64.zip', browser_download_url: 'https://example.invalid/win-x64.zip' },
      { name: 'SoftwareKatalog-1.27.0-win-ia32.zip', browser_download_url: 'https://example.invalid/win-ia32.zip' },
      { name: 'SoftwareKatalog-1.27.0-mac.zip', browser_download_url: 'https://example.invalid/mac.zip' },
    ];
    assert.equal(
      selectReleaseAsset(archZips, { installKind: 'portable-dir', arch: 'x64' })?.name,
      'SoftwareKatalog-1.27.0-win-x64.zip'
    );
    assert.equal(
      selectReleaseAsset(archZips, { installKind: 'portable-dir', arch: 'ia32' })?.name,
      'SoftwareKatalog-1.27.0-win-ia32.zip'
    );
  });

  it('gibt null bei fehlenden oder leeren Assets zurueck', () => {
    assert.equal(selectReleaseAsset([], { installKind: 'installed', arch: 'x64' }), null);
    assert.equal(selectReleaseAsset(null, { installKind: 'portable-exe', arch: 'x64' }), null);
  });
});

describe('app-update-logic: formatInstallModeInfo, normalizeArch & PowerShell-Skript', () => {
  it('normalisiert Architekturen und formatiert Modus-Anzeige fuer die Einstellungen', () => {
    assert.equal(normalizeArch('x64'), 'x64');
    assert.equal(normalizeArch('x86'), 'ia32');
    assert.equal(normalizeArch('ia32'), 'ia32');
    assert.equal(normalizeArch('arm64'), 'arm64');

    assert.equal(formatInstallModeInfo('installed', 'x64').label, 'Installiert (64-Bit)');
    assert.equal(formatInstallModeInfo('installed', 'ia32').label, 'Installiert (32-Bit)');
    assert.equal(formatInstallModeInfo('portable-exe', 'x64').label, 'Portabel (64-Bit)');
    assert.equal(formatInstallModeInfo('portable-dir', 'x64').label, 'Portabel (Ordner, 64-Bit)');
  });

  it('erzeugt sichere PowerShell-Skripte fuer All-Users, Per-User, Portable-EXE und ZIP', () => {
    assert.equal(escapePsSingleQuoted("C:\\User's\\App"), "C:\\User''s\\App");

    const allUsersPs = buildUpdatePowerShellScript({
      installKind: 'installed',
      isAllUsersInstall: true,
      tempFilePath: 'C:\\Temp\\sk_update_setup.exe',
      execPath: 'C:\\Program Files\\Software Katalog\\Software Katalog.exe',
      appFolder: 'C:\\Program Files\\Software Katalog',
      pid: 4321,
    });
    assert.match(allUsersPs, /OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
    assert.match(allUsersPs, /Wait-Process -Id 4321/);
    assert.match(allUsersPs, /'\/allusers', '\/S'/);
    assert.match(allUsersPs, /-Verb RunAs/);

    const perUserPs = buildUpdatePowerShellScript({
      installKind: 'installed',
      isAllUsersInstall: false,
      tempFilePath: 'C:\\Temp\\sk_update_setup.exe',
      execPath: 'C:\\Users\\Max\\AppData\\Local\\Programs\\Software Katalog\\Software Katalog.exe',
      appFolder: 'C:\\Users\\Max\\AppData\\Local\\Programs\\Software Katalog',
      pid: 1234,
    });
    assert.match(perUserPs, /'\/currentuser', '\/S'/);
    assert.doesNotMatch(perUserPs, /-Verb RunAs/);

    const portablePs = buildUpdatePowerShellScript({
      installKind: 'portable-exe',
      tempFilePath: 'C:\\Temp\\sk_update_portable.exe',
      execPath: 'C:\\Temp\\mount\\Software Katalog.exe',
      portableExecutableFile: 'D:\\USB\\SoftwareKatalog-Portable.exe',
      appFolder: 'D:\\USB',
      pid: 99,
    });
    assert.match(portablePs, /D:\\USB\\SoftwareKatalog-Portable\.exe/);

    const zipPs = buildUpdatePowerShellScript({
      installKind: 'portable-dir',
      tempFilePath: 'C:\\Temp\\sk_update.zip',
      execPath: 'D:\\Apps\\SK\\Software Katalog.exe',
      appFolder: 'D:\\Apps\\SK',
      pid: 77,
    });
    assert.match(zipPs, /Expand-Archive/);
    assert.match(zipPs, /foreach \(\$item in @\('data', 'config\.json', 'catalog\.json'\)\)/);
  });
});
