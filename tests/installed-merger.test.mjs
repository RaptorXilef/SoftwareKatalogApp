import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeInstalledSoftware } from '../src/shared/installed-merger.js';

describe('mergeInstalledSoftware', () => {
  it('löst abgeschnittene Upgrade-IDs über winget export auf und verknüpft Registry + Archiv-Katalog', () => {
    const wingetExports = [
      { packageManager: 'winget', packageId: '7zip.7zip', version: '26.04', source: 'winget' },
      {
        packageManager: 'winget',
        packageId: 'SatisfactoryModding.SatisfactoryModManager',
        version: '3.1.0',
        source: 'winget',
      },
    ];

    const wingetUpgrades = [
      {
        packageManager: 'winget',
        packageId: 'SatisfactoryModding.SatisfactoryMo…',
        name: 'Satisfactory Mod Manager',
        installedVersion: '3.1.0',
        availableVersion: '3.2.0',
        source: 'winget',
        idTruncated: true,
      },
    ];

    const registryEntries = [
      {
        displayName: '7-Zip 26.04 (x64)',
        displayVersion: '26.04',
        publisher: 'Igor Pavlov',
        uninstallString: '"C:\\Program Files\\7-Zip\\Uninstall.exe"',
        quietUninstallString: '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S',
        displayIcon: 'C:\\Program Files\\7-Zip\\7zFM.exe,0',
        installLocation: 'C:\\Program Files\\7-Zip',
        registryKey: '7-Zip',
      },
      // Duplikat ohne QuietUninstallString -> soll hinter dem reicheren Eintrag zurückstehen
      {
        displayName: '7-Zip 26.04 (x64)',
        displayVersion: '26.04',
        publisher: 'Igor Pavlov',
        uninstallString: '"C:\\Program Files\\7-Zip\\Uninstall.exe"',
      },
      // Systemkomponente -> standardmäßig gefiltert
      {
        displayName: 'Hidden Helper Component',
        displayVersion: '1.0.0',
        systemComponent: 1,
      },
      // Reines Registry-Programm ohne Winget
      {
        displayName: 'Custom Legacy Tool',
        displayVersion: '1.5.2',
        publisher: 'ACME',
        uninstallString: 'MsiExec.exe /I{12345678-1234-1234-1234-1234567890AB}',
      },
    ];

    const catalogItems = [
      {
        id: 'arch-7zip',
        name: '7-Zip',
        wingetId: '7zip.7zip', // Legacy-Fallback-Feld
        path: 'software/7zip',
        icon: 'software/7zip/_metadata/icon.png',
      },
    ];

    const merged = mergeInstalledSoftware({
      wingetExports,
      wingetUpgrades,
      registryEntries,
      catalogItems,
    });

    assert.equal(merged.length, 3);

    const sevenZip = merged.find((p) => p.packageId === '7zip.7zip');
    assert.ok(sevenZip);
    assert.equal(sevenZip.inArchive, true);
    assert.equal(sevenZip.archiveItemId, 'arch-7zip');
    assert.equal(sevenZip.quietUninstallString, '"C:\\Program Files\\7-Zip\\Uninstall.exe" /S');
    assert.equal(sevenZip.hasUpdate, false);

    const smm = merged.find((p) => p.packageId === 'SatisfactoryModding.SatisfactoryModManager');
    assert.ok(smm);
    assert.equal(smm.hasUpdate, true);
    assert.equal(smm.availableVersion, '3.2.0');

    const legacy = merged.find((p) => p.name === 'Custom Legacy Tool');
    assert.ok(legacy);
    assert.equal(legacy.source, 'registry');
    assert.equal(legacy.canUninstall, true);
  });
});
