import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildRemotePackageItem,
  buildUnifiedPackages,
  canDownloadOnline,
  computeTabCounts,
  DEFAULT_START_TAB,
  getPackageStatus,
  getProviderBadgeInfo,
  normalizeStartTab,
} from '../src/shared/unified-packages.js';

describe('buildUnifiedPackages', () => {
  it('verknüpft Archiv- und PC-Einträge über archiveItemId, packageId/wingetId, Installationspfad und searchNames', () => {
    const catalogItems = [
      {
        id: 'arch-vlc',
        name: 'VLC Media Player',
        wingetId: 'VideoLAN.VLC',
        lastFiles: ['C:\\Archiv\\VLC\\vlc-3.0.21-win64.exe'],
        webVersion: '3.0.21',
      },
      {
        id: 'arch-custom',
        name: 'Mein Spezialtool',
        autoPaths: ['C:\\Program Files\\SpezialTool\\tool.exe'],
        lastFiles: ['C:\\Archiv\\Spezial\\tool_v2.0.0.exe'],
      },
      {
        id: 'arch-alias',
        name: 'Notepad++',
        searchNames: ['Notepad++ (64-bit x64)'],
        lastFiles: ['C:\\Archiv\\Npp\\npp.8.7.0.exe'],
      },
      {
        id: 'arch-only',
        name: 'Nur Im Archiv Tool',
        lastFiles: ['C:\\Archiv\\Only\\only_v1.0.0.exe'],
      },
    ];

    const installedApps = [
      {
        id: 'winget:videolan.vlc',
        name: 'VLC media player',
        publisher: 'VideoLAN',
        installedVersion: '3.0.20',
        availableVersion: '3.0.22',
        hasUpdate: true,
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        canUninstall: true,
      },
      {
        id: 'registry:spezial',
        name: 'Ganz Anderer Registry Name',
        publisher: 'ACME',
        installedVersion: '1.5.0',
        installLocation: 'C:\\Program Files\\SpezialTool',
        displayIcon: 'C:\\Program Files\\SpezialTool\\tool.exe,0',
        source: 'registry',
        canUninstall: true,
      },
      {
        id: 'registry:npp',
        name: 'Notepad++ (64-bit x64)',
        installedVersion: '8.7.5',
        source: 'registry',
        canUninstall: true,
      },
      {
        id: 'winget:git.git',
        name: 'Git',
        publisher: 'The Git Development Community',
        installedVersion: '2.47.0',
        availableVersion: '2.48.1',
        hasUpdate: true,
        packageManager: 'winget',
        packageId: 'Git.Git',
        canUninstall: true,
      },
    ];

    const pcIconCache = new Map([['winget:git.git', 'C:\\cache\\git.png']]);
    const unified = buildUnifiedPackages({ catalogItems, installedApps, pcIconCache });

    assert.equal(unified.length, 5);

    const vlc = unified.find((p) => p.id === 'arch-vlc');
    assert.equal(vlc.origin, 'both');
    assert.equal(vlc.installedVersion, '3.0.20');
    assert.equal(vlc.webVersion, '3.0.22');
    assert.equal(vlc.canUninstall, true);

    const custom = unified.find((p) => p.id === 'arch-custom');
    assert.equal(custom.origin, 'both');
    assert.equal(custom.installedVersion, '1.5.0');

    const npp = unified.find((p) => p.id === 'arch-alias');
    assert.equal(npp.origin, 'both');
    assert.equal(npp.installedVersion, '8.7.5');

    const archOnly = unified.find((p) => p.id === 'arch-only');
    assert.equal(archOnly.origin, 'archive');
    assert.equal(archOnly.isInstalled, false);

    const git = unified.find((p) => p.id === 'winget:git.git');
    assert.equal(git.origin, 'pc');
    assert.equal(git.inArchive, false);
    assert.equal(git.icon, 'C:\\cache\\git.png');
    assert.equal(git.webVersion, '2.48.1');
  });

  it('verhindert False-Positive-Pfadmatches über generische Windows-Systemordner', () => {
    const catalogItems = [
      {
        id: 'arch-a',
        name: 'Alpha App',
        autoPaths: ['C:\\Program Files\\Alpha\\alpha.exe'],
      },
    ];
    const installedApps = [
      {
        id: 'registry:beta',
        name: 'Beta App',
        installLocation: 'C:\\Program Files',
        installedVersion: '1.0.0',
      },
    ];

    const unified = buildUnifiedPackages({ catalogItems, installedApps });
    assert.equal(unified.length, 2);
    assert.equal(unified[0].origin, 'archive');
    assert.equal(unified[1].origin, 'pc');
  });
});

describe('getPackageStatus & computeTabCounts', () => {
  it('hält die Status-Farbpriorität ein: webupdate > update > newer > installed > none', () => {
    // Web-Update schlägt Archiv-Update
    const webAndArchive = getPackageStatus({
      origin: 'both',
      isInstalled: true,
      installedVersion: '1.0.0',
      lastFiles: ['app_v2.0.0.exe'],
      webVersion: '3.0.0',
    });
    assert.equal(webAndArchive.status, 'webupdate');
    assert.equal(webAndArchive.hasWebUpdate, true);
    assert.equal(webAndArchive.hasArchiveUpdate, true);

    // Archiv-Update
    const archiveUpd = getPackageStatus({
      origin: 'both',
      isInstalled: true,
      installedVersion: '1.0.0',
      lastFiles: ['app_v2.0.0.exe'],
      webVersion: '2.0.0',
    });
    assert.equal(archiveUpd.status, 'update');

    // PC neuer als Archiv
    const pcNewer = getPackageStatus({
      origin: 'both',
      isInstalled: true,
      installedVersion: '2.5.0',
      lastFiles: ['app_v2.0.0.exe'],
      webVersion: '2.0.0',
    });
    assert.equal(pcNewer.status, 'newer');

    // Aktuell installiert
    const current = getPackageStatus({
      origin: 'both',
      isInstalled: true,
      installedVersion: '2.0.0',
      lastFiles: ['app_v2.0.0.exe'],
      webVersion: '2.0.0',
    });
    assert.equal(current.status, 'installed');

    // Reines PC-Programm mit Winget-Update
    const pcUpdate = getPackageStatus({
      origin: 'pc',
      isInstalled: true,
      installedVersion: '2.47.0',
      webVersion: '2.48.1',
      hasWingetUpgrade: true,
    });
    assert.equal(pcUpdate.status, 'webupdate');
    assert.equal(pcUpdate.hasWebUpdate, true);
  });

  it('berechnet Live-Zähler unter Berücksichtigung versteckter Kategorien', () => {
    const packages = [
      { id: '1', inArchive: true, isInstalled: true, origin: 'both', installedVersion: '1.0', webVersion: '2.0' },
      { id: '2', inArchive: true, isInstalled: false, origin: 'archive', lastFiles: ['x_v1.0.exe'] },
      {
        id: '3',
        inArchive: false,
        isInstalled: true,
        origin: 'pc',
        installedVersion: '1.0',
        webVersion: '1.2',
        hasWingetUpgrade: true,
      },
      {
        id: '4',
        inArchive: true,
        isInstalled: true,
        origin: 'both',
        hiddenCategory: 'Secret',
        installedVersion: '1.0',
        webVersion: '2.0',
      },
    ];

    const countsDefault = computeTabCounts(packages, { visibleHiddenCats: [], bundlesCount: 2 });
    assert.deepEqual(countsDefault, { updates: 2, installed: 2, archive: 2, bundles: 2 });

    const countsWithHidden = computeTabCounts(packages, { visibleHiddenCats: ['Secret'], bundlesCount: 0 });
    assert.deepEqual(countsWithHidden, { updates: 3, installed: 3, archive: 3, bundles: 0 });
  });
});

describe('buildRemotePackageItem & remote status', () => {
  it('markiert nicht installierte Remote-Pakete nicht fälschlich als Web-Update', () => {
    const remoteItem = buildRemotePackageItem({
      providerId: 'winget',
      packageId: 'Mozilla.Firefox',
      providerName: 'Winget',
      summary: {
        name: 'Mozilla Firefox',
        version: '135.0.1',
        shortDescription: 'Schneller Open-Source-Browser',
      },
      existingPackages: [],
    });

    assert.equal(remoteItem.id, 'remote:winget:Mozilla.Firefox');
    assert.equal(remoteItem.origin, 'remote');
    assert.equal(remoteItem.inArchive, false);
    assert.equal(remoteItem.isInstalled, false);
    assert.equal(remoteItem.webVersion, '135.0.1');

    const st = getPackageStatus(remoteItem);
    assert.equal(st.status, 'none');
    assert.equal(st.hasWebUpdate, false);
    assert.equal(st.webVersion, '135.0.1');
  });

  it('verknüpft Remote-Pakete mit vorhandenen Archiv- und PC-Einträgen und erkennt Updates', () => {
    const existingPackages = [
      {
        id: 'arch-vlc',
        name: 'VLC Media Player',
        origin: 'both',
        inArchive: true,
        isInstalled: true,
        installedVersion: '3.0.20',
        lastFiles: ['C:\\Archiv\\VLC\\vlc-3.0.20-win64.exe'],
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        wingetId: 'VideoLAN.VLC',
        canUninstall: true,
        validInstallPath: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
      },
    ];

    const remoteVlc = buildRemotePackageItem({
      providerId: 'winget',
      packageId: 'VideoLAN.VLC',
      providerName: 'Winget',
      summary: { name: 'VLC', version: '3.0.21' },
      existingPackages,
    });

    assert.equal(remoteVlc.isInstalled, true);
    assert.equal(remoteVlc.installedVersion, '3.0.20');
    assert.equal(remoteVlc.archiveItemId, 'arch-vlc');
    assert.equal(remoteVlc.matchedArchiveItem?.id, 'arch-vlc');
    assert.equal(remoteVlc.canUninstall, true);
    assert.equal(remoteVlc.lastFiles.length, 1);

    const st = getPackageStatus(remoteVlc);
    assert.equal(st.status, 'webupdate');
    assert.equal(st.hasWebUpdate, true);
    assert.equal(st.archiveVersion, '3.0.20');
  });

  it('erkennt direkte Online-Downloadquellen zuverlässig über canDownloadOnline', () => {
    assert.equal(canDownloadOnline({ inArchive: true, webSourceType: 'winget', packageId: 'VideoLAN.VLC' }), true);
    assert.equal(canDownloadOnline({ inArchive: true, packageManager: 'winget', packageId: 'Git.Git' }), true);
    assert.equal(
      canDownloadOnline({ inArchive: true, webSourceType: 'github', webVersionUrl: 'https://github.com/a/b' }),
      true
    );
    assert.equal(canDownloadOnline({ inArchive: true, downloadUrl: 'https://example.com/setup.exe' }), true);
    assert.equal(canDownloadOnline({ inArchive: true, webSourceType: 'none' }), false);
  });
});

describe('buildUnifiedPackages: Icon-Priorität im Tab Archiv (Bug 3)', () => {
  it('bevorzugt _metadata/icon.*, fällt sonst auf PC-/Cache-Icon zurück und liefert sonst null', () => {
    const catalogItems = [
      {
        id: 'arch-with-meta',
        name: 'VLC Media Player',
        wingetId: 'VideoLAN.VLC',
        icon: 'Z:\\software\\VLC\\_metadata\\icon.png',
      },
      {
        id: 'arch-no-meta-pc',
        name: 'Audacity',
        wingetId: 'Audacity.Audacity',
        icon: null,
      },
      {
        id: 'arch-no-meta-cache',
        name: 'GIMP',
        wingetId: 'GIMP.GIMP',
        icon: null,
      },
      {
        id: 'arch-empty',
        name: 'Ohne Icon Tool',
        icon: null,
      },
    ];

    const installedApps = [
      {
        id: 'winget:videolan.vlc',
        name: 'VLC media player',
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
      },
      {
        id: 'winget:audacity.audacity',
        name: 'Audacity 4.0',
        packageManager: 'winget',
        packageId: 'Audacity.Audacity',
      },
    ];

    const pcIconCache = new Map([
      ['winget:videolan.vlc', 'C:\\cache\\pc-vlc.png'],
      ['winget:audacity.audacity', 'C:\\cache\\pc-audacity.png'],
      ['arch-no-meta-cache', 'C:\\cache\\web-gimp.png'],
    ]);

    const unified = buildUnifiedPackages({ catalogItems, installedApps, pcIconCache });

    const withMeta = unified.find((p) => p.id === 'arch-with-meta');
    assert.equal(withMeta.icon, 'Z:\\software\\VLC\\_metadata\\icon.png');
    assert.equal(withMeta.iconSource, 'archive');

    const withPcFallback = unified.find((p) => p.id === 'arch-no-meta-pc');
    assert.equal(withPcFallback.icon, 'C:\\cache\\pc-audacity.png');
    assert.equal(withPcFallback.iconSource, 'pc');

    const withCacheFallback = unified.find((p) => p.id === 'arch-no-meta-cache');
    assert.equal(withCacheFallback.icon, 'C:\\cache\\web-gimp.png');
    assert.equal(withCacheFallback.iconSource, 'cache');

    const empty = unified.find((p) => p.id === 'arch-empty');
    assert.equal(empty.icon, null);
    assert.equal(empty.iconSource, 'placeholder');
  });
});

describe('normalizeStartTab', () => {
  it('akzeptiert alle gültigen Start-Tabs und fällt sonst auf updates zurück', () => {
    assert.equal(DEFAULT_START_TAB, 'updates');
    assert.equal(normalizeStartTab('updates'), 'updates');
    assert.equal(normalizeStartTab('INSTALLED'), 'installed');
    assert.equal(normalizeStartTab(' archive '), 'archive');
    assert.equal(normalizeStartTab('bundles'), 'bundles');
    assert.equal(normalizeStartTab('discover'), 'discover');
    assert.equal(normalizeStartTab('dev'), 'dev');
    assert.equal(normalizeStartTab('DEV', { showDevTab: true }), 'dev');
    assert.equal(normalizeStartTab('dev', { showDevTab: false }), 'updates');
    assert.equal(normalizeStartTab(''), 'updates');
    assert.equal(normalizeStartTab('unknown-tab'), 'updates');
    assert.equal(normalizeStartTab(null), 'updates');
    assert.deepEqual(getProviderBadgeInfo('yarn'), { id: 'yarn', label: 'Yarn', badgeClass: 'is-yarn' });
  });
});
