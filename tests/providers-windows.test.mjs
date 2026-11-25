import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-providers-win-'));
const appDir = path.join(tempRoot, 'app');
const dataDir = path.join(appDir, 'data');
const userDataDir = path.join(tempRoot, 'userData');
const tempSubDir = path.join(tempRoot, 'temp');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(tempSubDir, { recursive: true });

const electronMockUrl = 'mock://electron-win-providers';
const electronMockSource = `
  const appDir = ${JSON.stringify(appDir)};
  const userDataDir = ${JSON.stringify(userDataDir)};
  const tempDir = ${JSON.stringify(tempSubDir)};

  export const app = {
    isPackaged: false,
    getAppPath: () => appDir,
    getPath: (name) => {
      if (name === 'userData') return userDataDir;
      if (name === 'temp') return tempDir;
      return appDir;
    },
  };
  export const BrowserWindow = { getAllWindows: () => [] };
  export const dialog = {};
  export const ipcMain = { handle: () => {}, on: () => {} };
  export const net = {};
  export const protocol = {};
  export const session = { fromPartition: () => ({ on: () => {}, off: () => {} }) };
  export const shell = {};
`;

const electronHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: electronMockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === electronMockUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: electronMockSource,
      };
    }
    return nextLoad(url, context);
  },
});

const { parseScoopExportJson, parseScoopStatusOutput, parseScoopSearchOutput, parseScoopInfoOutput } = await import(
  '../src/shared/scoop-parser.js'
);
const {
  isValidChocoPackageId,
  parseChocoListOutput,
  parseChocoSearchOutput,
  parseChocoOutdatedOutput,
  parseChocoInfoOutput,
} = await import('../src/shared/choco-parser.js');
const {
  normalizeMsiProductCode,
  isMsiProductCode,
  extractMsiProductCodeFromEntry,
  parseMsiRegistryEntries,
  buildMsiUninstallArgs,
  buildMsiInstallArgs,
} = await import('../src/shared/msi-parser.js');
const { parseWingetSearchOutput, parseWingetUpgradeOutput, parseWingetShowOutput } = await import(
  '../src/shared/winget-parser.js'
);
const { mergeInstalledSoftware } = await import('../src/shared/installed-merger.js');
const { buildUnifiedPackages, getPackageStatus, getProviderBadgeInfo, matchesProviderFilter } = await import(
  '../src/shared/unified-packages.js'
);
const { buildBundleDraftFromInstalled, evaluateBundleStatus, planBundleExecution, sortBundleItems } = await import(
  '../src/shared/bundles-logic.js'
);
const { getProvider, isProviderEnabled, listProvidersInfo } = await import('../src/main/providers/registry.js');

after(() => {
  electronHook.deregister();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('scoop-parser', () => {
  it('parst `scoop export` JSON mit BOM, ANSI-Codes und Duplikaten', () => {
    const raw = `\uFEFF\u001b[32m{
      "buckets": [{ "Name": "main" }],
      "apps": [
        { "Name": "git", "Version": "2.47.1", "Source": "main", "Updated": "2026-01-10T10:00:00", "Info": "" },
        { "Name": "GIT", "Version": "2.47.0", "Source": "main" },
        { "name": "ripgrep", "version": "14.1.1", "source": "main", "info": "Held package" }
      ]
    }\u001b[0m`;

    const parsed = parseScoopExportJson(raw);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], {
      packageManager: 'scoop',
      packageId: 'git',
      id: 'git',
      name: 'git',
      version: '2.47.1',
      bucket: 'main',
      source: 'main',
      updated: '2026-01-10T10:00:00',
      info: '',
    });
    assert.equal(parsed[1].name, 'ripgrep');
    assert.equal(parsed[1].info, 'Held package');

    assert.deepEqual(parseScoopExportJson(''), []);
    assert.deepEqual(parseScoopExportJson('kein json'), []);
  });

  it('parst `scoop status` Tabellen und ignoriert Held packages standardmäßig', () => {
    const stdout = [
      'Scoop is up to date.',
      '',
      'Name    Installed Version Latest Version Missing Dependencies Info',
      '----    ----------------- -------------- -------------------- ----',
      'git     2.47.0            2.47.1',
      'nodejs  22.10.0           22.11.0        7zip                 Held package',
      'jq      1.7.1             1.7.1',
      'ripgrep 14.1.0            14.1.1',
    ].join('\n');

    const updates = parseScoopStatusOutput(stdout);
    assert.equal(updates.length, 2);
    assert.equal(updates[0].packageId, 'git');
    assert.equal(updates[0].installedVersion, '2.47.0');
    assert.equal(updates[0].availableVersion, '2.47.1');
    assert.equal(updates[1].packageId, 'ripgrep');

    const withHeld = parseScoopStatusOutput(stdout, { includeHeld: true });
    assert.equal(withHeld.length, 3);
    assert.equal(withHeld[1].name, 'nodejs');
    assert.equal(withHeld[1].missingDependencies, '7zip');
  });

  it('parst `scoop search` im modernen Tabellen- und klassischen Bucket-Format', () => {
    const tableOut = [
      'Results from local buckets...',
      '',
      'Name      Version  Source Binaries',
      '----      -------  ------ --------',
      'git       2.47.1   main   git.exe',
      'git-lfs   3.6.0    main',
      'lazygit   0.44.1   extras',
    ].join('\n');

    const tableRes = parseScoopSearchOutput(tableOut, 2);
    assert.equal(tableRes.length, 2);
    assert.deepEqual(tableRes[0], {
      packageManager: 'scoop',
      packageId: 'git',
      id: 'git',
      name: 'git',
      version: '2.47.1',
      bucket: 'main',
      source: 'main',
      binaries: 'git.exe',
    });

    const legacyOut = [
      "'main' bucket:",
      '  7zip (24.08)',
      "  ripgrep (14.1.1) --> includes 'rg.exe'",
      '',
      "'extras' bucket:",
      '  vscode (1.96.0)',
    ].join('\n');

    const legacyRes = parseScoopSearchOutput(legacyOut, 10);
    assert.equal(legacyRes.length, 3);
    assert.equal(legacyRes[1].bucket, 'main');
    assert.equal(legacyRes[1].binaries, 'rg.exe');
    assert.equal(legacyRes[2].bucket, 'extras');
  });

  it('parst `scoop info` inklusive Website, Lizenz-URL, Bucket und mehrzeiliger Beschreibung', () => {
    const infoOut = [
      'Name        : ripgrep',
      'Description : Line-oriented search tool that recursively searches',
      '              the current directory for a regex pattern',
      'Version     : 14.1.1',
      'Bucket      : main',
      'Website     : https://github.com/BurntSushi/ripgrep',
      'License     : MIT (https://opensource.org/licenses/MIT)',
      'Installed   : C:\\Users\\test\\scoop\\apps\\ripgrep\\current',
      'Notes       : Configure RIPGREP_CONFIG_PATH if needed.',
    ].join('\n');

    const info = parseScoopInfoOutput(infoOut, 'ripgrep');
    assert.equal(info.packageManager, 'scoop');
    assert.equal(info.name, 'ripgrep');
    assert.equal(info.version, '14.1.1');
    assert.equal(info.bucket, 'main');
    assert.equal(info.homepage, 'https://github.com/BurntSushi/ripgrep');
    assert.equal(info.license, 'MIT');
    assert.equal(info.licenseUrl, 'https://opensource.org/licenses/MIT');
    assert.match(info.description, /Line-oriented search tool/);
    assert.match(info.description, /regex pattern/);
    assert.deepEqual(info.tags, ['main']);
  });
});

describe('choco-parser', () => {
  it('validiert Paket-IDs und parst `choco list -r` sowie `choco search -r`', () => {
    assert.equal(isValidChocoPackageId('git.install'), true);
    assert.equal(isValidChocoPackageId('7zip'), true);
    assert.equal(isValidChocoPackageId('bad pkg; calc'), false);

    const listOut = ['Chocolatey v2.3.0', '7zip|24.8.0', 'git.install|2.47.1', '2 packages installed.'].join('\n');

    const installed = parseChocoListOutput(listOut);
    assert.equal(installed.length, 2);
    assert.deepEqual(installed[0], {
      packageManager: 'chocolatey',
      packageId: '7zip',
      id: '7zip',
      name: '7zip',
      version: '24.8.0',
      source: 'chocolatey',
    });

    const searched = parseChocoSearchOutput('vlc|3.0.21\nffmpeg|7.1\ncurl|8.11.0', 2);
    assert.equal(searched.length, 2);
    assert.equal(searched[1].packageId, 'ffmpeg');
  });

  it('parst `choco outdated -r` inklusive pinned-Filterung', () => {
    const outdatedOut = [
      'Chocolatey v2.3.0',
      'Output is package name | current version | available version | pinned?',
      '7zip|24.7.0|24.8.0|false',
      'nodejs|20.11.0|22.11.0|true',
      'git|2.47.1|2.47.1|false',
      'vlc|3.0.20|3.0.21|false',
    ].join('\n');

    const upgrades = parseChocoOutdatedOutput(outdatedOut);
    assert.equal(upgrades.length, 2);
    assert.equal(upgrades[0].packageId, '7zip');
    assert.equal(upgrades[0].installedVersion, '24.7.0');
    assert.equal(upgrades[0].availableVersion, '24.8.0');
    assert.equal(upgrades[1].packageId, 'vlc');

    const withPinned = parseChocoOutdatedOutput(outdatedOut, { includePinned: true });
    assert.equal(withPinned.length, 3);
    assert.equal(withPinned[1].pinned, true);
  });

  it('parst `choco info` Metadaten', () => {
    const infoOut = [
      'Chocolatey v2.3.0',
      'git.install 2.47.1 [Approved]',
      ' Title: Git (Install) | Published: 2024-11-26',
      ' Number of Downloads: 123456',
      ' Software Site: https://git-scm.com/',
      ' Software License: https://opensource.org/licenses/GPL-2.0',
      ' Software Authors: Johannes Schindelin, Junio C Hamano',
      ' Summary: Fast, scalable, distributed revision control system',
      ' Description: Git is a free and open source distributed version control system.',
      '  Designed to handle everything quickly.',
      ' Tags: git vcs scm admin',
      ' Release Notes: https://github.com/git-for-windows/git/releases',
    ].join('\n');

    const info = parseChocoInfoOutput(infoOut, 'git.install');
    assert.equal(info.packageManager, 'chocolatey');
    assert.equal(info.packageId, 'git.install');
    assert.equal(info.name, 'Git (Install)');
    assert.equal(info.version, '2.47.1');
    assert.equal(info.homepage, 'https://git-scm.com/');
    assert.equal(info.licenseUrl, 'https://opensource.org/licenses/GPL-2.0');
    assert.equal(info.author, 'Johannes Schindelin, Junio C Hamano');
    assert.deepEqual(info.tags, ['git', 'vcs', 'scm', 'admin']);
  });
});

describe('msi-parser', () => {
  it('normalisiert ProductCodes und baut sichere msiexec-Argumente', () => {
    assert.equal(
      normalizeMsiProductCode('12345678-1234-abcd-ef00-1234567890ab'),
      '{12345678-1234-ABCD-EF00-1234567890AB}'
    );
    assert.equal(
      normalizeMsiProductCode('MsiExec.exe /I{aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee}'),
      '{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}'
    );
    assert.equal(isMsiProductCode('not-a-guid'), false);

    assert.deepEqual(buildMsiUninstallArgs('12345678-1234-1234-1234-1234567890ab', { silent: false }), [
      '/x',
      '{12345678-1234-1234-1234-1234567890AB}',
    ]);
    assert.deepEqual(buildMsiUninstallArgs('{12345678-1234-1234-1234-1234567890ab}', { silent: true }), [
      '/x',
      '{12345678-1234-1234-1234-1234567890AB}',
      '/qn',
      '/norestart',
    ]);
    assert.equal(buildMsiUninstallArgs('invalid'), null);

    assert.deepEqual(buildMsiInstallArgs('C:\\Temp\\setup.msi', { silent: true }), [
      '/i',
      'C:\\Temp\\setup.msi',
      '/qn',
      '/norestart',
    ]);
    assert.equal(buildMsiInstallArgs('C:\\Temp\\setup.exe'), null);
  });

  it('filtert und dedupliziert Registry-Einträge mit WindowsInstaller == 1', () => {
    const rawEntries = [
      {
        displayName: '7-Zip 24.08 (x64 edition)',
        displayVersion: '24.08.00.0',
        publisher: 'Igor Pavlov',
        uninstallString: 'MsiExec.exe /I{23170F69-40C1-2702-2408-000001000000}',
        registryKey: '{23170F69-40C1-2702-2408-000001000000}',
        windowsInstaller: 1,
      },
      // Nicht-MSI
      {
        displayName: 'NSIS App',
        displayVersion: '1.0.0',
        uninstallString: 'C:\\App\\uninstall.exe',
        windowsInstaller: 0,
      },
      // Systemkomponente
      {
        displayName: 'Hidden MSI Module',
        displayVersion: '1.0.0',
        registryKey: '{99999999-9999-9999-9999-999999999999}',
        windowsInstaller: 1,
        systemComponent: 1,
      },
    ];

    const msiApps = parseMsiRegistryEntries(rawEntries);
    assert.equal(msiApps.length, 1);
    assert.equal(msiApps[0].packageManager, 'msi');
    assert.equal(msiApps[0].productCode, '{23170F69-40C1-2702-2408-000001000000}');
    assert.equal(extractMsiProductCodeFromEntry(rawEntries[0]), '{23170F69-40C1-2702-2408-000001000000}');

    const withSys = parseMsiRegistryEntries(rawEntries, { includeSystemComponents: true });
    assert.equal(withSys.length, 2);
  });
});

describe('msstore winget-parser & multi-provider merger/unified/bundles', () => {
  it('parst MS-Store-IDs ohne Punkt bei `requireDotInId: false`', () => {
    const storeOut = [
      'Name                  Id           Version   Quelle',
      '---------------------------------------------------',
      'WhatsApp              9NKSQGP7F2NH Unbekannt msstore',
      'Windows Terminal      9N0DX20HK701 Unbekannt msstore',
    ].join('\n');

    const defaultRes = parseWingetSearchOutput(storeOut, 25);
    assert.equal(defaultRes.length, 0);

    const storeRes = parseWingetSearchOutput(storeOut, 25, {
      packageManager: 'msstore',
      defaultSource: 'msstore',
      requireDotInId: false,
    });
    assert.equal(storeRes.length, 2);
    assert.equal(storeRes[0].packageManager, 'msstore');
    assert.equal(storeRes[0].packageId, '9NKSQGP7F2NH');
    assert.equal(storeRes[0].source, 'msstore');

    const upgOut = [
      'Name     Id           Version Verfügbar Quelle',
      '----------------------------------------------',
      'WhatsApp 9NKSQGP7F2NH 2.24.1  2.24.2    msstore',
    ].join('\n');
    const upgRes = parseWingetUpgradeOutput(upgOut, { packageManager: 'msstore', defaultSource: 'msstore' });
    assert.equal(upgRes.length, 1);
    assert.equal(upgRes[0].packageManager, 'msstore');

    const showRes = parseWingetShowOutput('Gefunden WhatsApp [9NKSQGP7F2NH]\nVersion: 2.24.2\n', '9NKSQGP7F2NH', {
      packageManager: 'msstore',
    });
    assert.equal(showRes.packageManager, 'msstore');
  });

  it('führt Scoop, Chocolatey, MS Store und MSI sauber im installed-merger zusammen', () => {
    const merged = mergeInstalledSoftware({
      wingetExports: [
        { packageManager: 'winget', packageId: '7zip.7zip', version: '24.08', source: 'winget' },
        { packageManager: 'winget', packageId: '9NKSQGP7F2NH', version: '2.24.1', source: 'msstore' },
      ],
      wingetUpgrades: [],
      providerInstalled: [
        {
          packageManager: 'msstore',
          packageId: '9NKSQGP7F2NH',
          name: 'WhatsApp',
          version: '2.24.1',
          source: 'msstore',
        },
        {
          packageManager: 'scoop',
          packageId: 'ripgrep',
          name: 'ripgrep',
          version: '14.1.0',
          bucket: 'main',
          source: 'main',
        },
        { packageManager: 'chocolatey', packageId: 'ffmpeg', name: 'ffmpeg', version: '7.0.0', source: 'chocolatey' },
      ],
      providerUpgrades: [
        {
          packageManager: 'msstore',
          packageId: '9NKSQGP7F2NH',
          name: 'WhatsApp',
          installedVersion: '2.24.1',
          availableVersion: '2.24.2',
          source: 'msstore',
        },
        {
          packageManager: 'scoop',
          packageId: 'ripgrep',
          name: 'ripgrep',
          installedVersion: '14.1.0',
          availableVersion: '14.1.1',
          source: 'scoop',
        },
      ],
      registryEntries: [
        {
          displayName: 'Local Enterprise MSI',
          displayVersion: '3.2.1',
          publisher: 'Corp GmbH',
          registryKey: '{ABCDEF12-3456-7890-ABCD-EF1234567890}',
          windowsInstaller: 1,
        },
      ],
      msiEnabled: true,
    });

    // MS Store wurde nicht doppelt als winget + msstore gezählt
    const msstoreApps = merged.filter((p) => p.packageId === '9NKSQGP7F2NH');
    assert.equal(msstoreApps.length, 1);
    assert.equal(msstoreApps[0].packageManager, 'msstore');
    assert.equal(msstoreApps[0].hasUpdate, true);

    const scoopApp = merged.find((p) => p.id === 'scoop:ripgrep');
    assert.ok(scoopApp);
    assert.equal(scoopApp.hasUpdate, true);
    assert.equal(scoopApp.availableVersion, '14.1.1');

    const chocoApp = merged.find((p) => p.id === 'chocolatey:ffmpeg');
    assert.ok(chocoApp);
    assert.equal(chocoApp.hasUpdate, false);

    const msiApp = merged.find((p) => p.packageManager === 'msi');
    assert.ok(msiApp);
    assert.equal(msiApp.packageId, '{ABCDEF12-3456-7890-ABCD-EF1234567890}');
    assert.equal(msiApp.canUninstall, true);

    const unified = buildUnifiedPackages({ catalogItems: [], installedApps: merged });
    const scoopUnified = unified.find((p) => p.packageManager === 'scoop');
    assert.equal(getPackageStatus(scoopUnified).status, 'webupdate');
    assert.equal(matchesProviderFilter(scoopUnified, 'scoop'), true);
    assert.equal(matchesProviderFilter(scoopUnified, 'chocolatey'), false);
    assert.deepEqual(getProviderBadgeInfo('msstore'), {
      id: 'msstore',
      label: 'MS Store',
      badgeClass: 'is-msstore',
    });

    // Bündel-Unterstützung für Scoop, Chocolatey und MS Store
    const snapshot = buildBundleDraftFromInstalled(unified);
    assert.equal(snapshot.providerCounts.scoop, 1);
    assert.equal(snapshot.providerCounts.chocolatey, 1);
    assert.equal(snapshot.providerCounts.msstore, 1);
    assert.equal(snapshot.excludedCount, 1); // Lokales MSI wird aus Portabilitätsgründen nicht automatisch in Bündel aufgenommen

    const items = sortBundleItems([
      { source: 'scoop', packageId: 'ripgrep', name: 'ripgrep' },
      { source: 'chocolatey', packageId: 'ffmpeg', name: 'ffmpeg' },
      { source: 'msstore', packageId: '9NKSQGP7F2NH', name: 'WhatsApp' },
    ]);
    assert.equal(items.length, 3);

    const evaluation = evaluateBundleStatus({ items }, { packages: unified });
    assert.equal(evaluation.summary.outdatedCount, 2);
    assert.equal(evaluation.summary.upToDateCount, 1);

    const plan = planBundleExecution(evaluation.items, { silentWinget: true });
    assert.equal(plan.stats.silentCount, 3);
  });
});

describe('registry defaults for new Windows providers', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ enabledProviders: ['winget', 'archive'] }, null, 2),
      'utf-8'
    );
  });

  it('registriert scoop, chocolatey, msstore und msi standardmäßig deaktiviert mit korrekten Capabilities', () => {
    const scoop = getProvider('scoop');
    const choco = getProvider('chocolatey');
    const msstore = getProvider('msstore');
    const msi = getProvider('msi');

    assert.ok(scoop);
    assert.ok(choco);
    assert.ok(msstore);
    assert.ok(msi);

    assert.equal(isProviderEnabled('scoop'), false);
    assert.equal(isProviderEnabled('chocolatey'), false);
    assert.equal(isProviderEnabled('msstore'), false);
    assert.equal(isProviderEnabled('msi'), false);

    assert.equal(scoop.canInstallManager, true);
    assert.equal(scoop.canUninstallManager, true);
    assert.equal(scoop.requiresAdminForBootstrap, false);
    assert.equal(scoop.capabilities.supportsArchiveDownload, false);
    assert.match(scoop.uninstallWarning, /Scoop/i);

    assert.equal(choco.canInstallManager, true);
    assert.equal(choco.canUninstallManager, true);
    assert.equal(choco.requiresAdminForBootstrap, true);
    assert.equal(choco.capabilities.supportsArchiveDownload, false);
    assert.match(choco.uninstallWarning, /ChocolateyInstall/i);

    assert.equal(msstore.canInstallManager, false);
    assert.equal(msstore.canUninstallManager, false);
    assert.equal(msstore.capabilities.search, true);
    assert.equal(msstore.capabilities.listUpgrades, true);

    assert.equal(msi.canInstallManager, false);
    assert.equal(msi.canUninstallManager, false);
    assert.equal(msi.isSystemComponent, true);
    assert.deepEqual(msi.capabilities, {
      search: false,
      listInstalled: true,
      listUpgrades: false,
      listVersions: false,
      show: false,
      install: true,
      uninstall: true,
      supportsArchiveDownload: true,
      manageSources: false,
    });

    const info = listProvidersInfo();
    assert.ok(info.providers.some((p) => p.id === 'scoop' && p.uninstallWarning));
  });
});
