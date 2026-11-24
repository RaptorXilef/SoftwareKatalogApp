import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createProviderCache, DEFAULT_CACHE_TTL_MS } from '../src/shared/provider-cache.js';
import {
  cleanCliLines,
  mergeWingetExportWithList,
  mergeWingetShowResults,
  parseWingetExportJson,
  parseWingetListOutput,
  parseWingetSearchOutput,
  parseWingetShowOutput,
  parseWingetUpgradeOutput,
} from '../src/shared/winget-parser.js';

describe('cleanCliLines', () => {
  it('bereinigt ANSI-Sequenzen und Spinner-Fragmente mit Wagenrücklauf', () => {
    const raw = '\u001b[32m-\r\\\r|\r/\rGefunden 7-Zip [7zip.7zip]\u001b[0m\r\nVersion: 26.06\r\n';
    const lines = cleanCliLines(raw);
    assert.deepEqual(lines, ['Gefunden 7-Zip [7zip.7zip]', 'Version: 26.06', '']);
  });
});

describe('parseWingetShowOutput', () => {
  it('parst deutsche winget show Ausgabe inkl. eingerücktem Installationsprogramm-Block und einzeiligen Markierungen', () => {
    const sampleDe = [
      'Gefunden 7-Zip [7zip.7zip]',
      'Version: 26.06',
      'Herausgeber: Igor Pavlov',
      'Herausgeber-URL: https://7-zip.org/',
      'Autor: Igor Pavlov',
      'Moniker: 7zip',
      'Beschreibung:',
      '  Ein Dateiarchivierer mit hoher Kompressionsrate.',
      '',
      '  Unterstützt viele Formate.',
      'Startseite: https://7-zip.org/download.html',
      'Lizenz: LGPL-2.1',
      'Lizenz-URL: https://7-zip.org/license.txt',
      'Versionshinweise:',
      '  - Improved split support.',
      '  - Bugfixes.',
      'URL der Versionshinweise: https://github.com/ip7z/7zip/releases/tag/26.06',
      'Markierungen: archiver, compression, archiver',
      'Installationsprogramm:',
      '  Installertyp: wix',
      '  Installer-URL: https://github.com/ip7z/7zip/releases/download/26.06/7z2606-x64.msi',
      '  Sha256-Installer: 6DC822569E777D9A3ECD5FFCBC22B55600AF87E6C5D9810A64E8566CF5A4AF9F',
      '  Freigabedatum: 2026-11-07',
    ].join('\n');

    const parsed = parseWingetShowOutput(sampleDe);
    assert.equal(parsed.name, '7-Zip');
    assert.equal(parsed.packageManager, 'winget');
    assert.equal(parsed.packageId, '7zip.7zip');
    assert.equal(parsed.version, '26.06');
    assert.equal(parsed.publisher, 'Igor Pavlov');
    assert.equal(parsed.publisherUrl, 'https://7-zip.org/');
    assert.equal(parsed.author, 'Igor Pavlov');
    assert.equal(parsed.moniker, '7zip');
    assert.equal(parsed.shortDescription, 'Ein Dateiarchivierer mit hoher Kompressionsrate.');
    assert.equal(parsed.description, 'Ein Dateiarchivierer mit hoher Kompressionsrate.\n\nUnterstützt viele Formate.');
    assert.equal(parsed.homepage, 'https://7-zip.org/download.html');
    assert.equal(parsed.license, 'LGPL-2.1');
    assert.equal(parsed.licenseUrl, 'https://7-zip.org/license.txt');
    assert.equal(parsed.releaseNotes, '- Improved split support.\n- Bugfixes.');
    assert.equal(parsed.releaseNotesUrl, 'https://github.com/ip7z/7zip/releases/tag/26.06');
    assert.deepEqual(parsed.tags, ['archiver', 'compression']);
    assert.equal(parsed.installerType, 'wix');
    assert.equal(parsed.downloadUrl, 'https://github.com/ip7z/7zip/releases/download/26.06/7z2606-x64.msi');
    assert.equal(parsed.sha256, '6dc822569e777d9a3ecd5ffcbc22b55600af87e6c5d9810a64e8566cf5a4af9f');
    assert.equal(parsed.releaseDate, '2026-11-07');
  });

  it('parst englische winget show Ausgabe inkl. Short Description und mehrzeiliger Tags', () => {
    const sampleEn = [
      'Found VLC media player [VideoLAN.VLC]',
      'Version: 3.0.24',
      'Publisher: VideoLAN',
      'Author: VideoLAN Team',
      'Short Description: Free and open source media player.',
      'Description: Plays most multimedia files as well as DVDs.',
      'Homepage: https://www.videolan.org/vlc/',
      'License: GPL-2.0',
      'License Url: https://code.videolan.org/videolan/vlc/-/blob/HEAD/COPYING',
      'Release Notes Url: https://www.videolan.org/developers/vlc-branch/NEWS',
      'Tags:',
      '  media-player',
      '  video',
      'Installer:',
      '  Installer Type: nullsoft',
      '  Installer Url: https://get.videolan.org/vlc/3.0.24/win64/vlc-3.0.24-win64.exe',
      '  Installer SHA256: AAAA1111BBBB2222',
    ].join('\n');

    const parsed = parseWingetShowOutput(sampleEn);
    assert.equal(parsed.name, 'VLC media player');
    assert.equal(parsed.packageId, 'VideoLAN.VLC');
    assert.equal(parsed.shortDescription, 'Free and open source media player.');
    assert.equal(parsed.description, 'Plays most multimedia files as well as DVDs.');
    assert.deepEqual(parsed.tags, ['media-player', 'video']);
    assert.equal(parsed.installerType, 'nullsoft');
    assert.equal(parsed.downloadUrl, 'https://get.videolan.org/vlc/3.0.24/win64/vlc-3.0.24-win64.exe');
    assert.equal(parsed.sha256, 'aaaa1111bbbb2222');
  });

  it('behandelt fehlende optionale Felder, mehrzeilige Release-Notes und unterschiedliche Versionsformate stabil', () => {
    const minimalDe = [
      'Gefunden Minimal Tool [Vendor.MinimalTool]',
      'Version: 4.0.2.263060742',
      'Herausgeber: Vendor Corp',
      'Versionshinweise:',
      '  Erste Zeile der Hinweise.',
      '  Zweite Zeile mit Details.',
    ].join('\n');

    const parsedMinimal = parseWingetShowOutput(minimalDe);
    assert.equal(parsedMinimal.name, 'Minimal Tool');
    assert.equal(parsedMinimal.packageId, 'Vendor.MinimalTool');
    assert.equal(parsedMinimal.version, '4.0.2.263060742');
    assert.equal(parsedMinimal.releaseNotes, 'Erste Zeile der Hinweise.\nZweite Zeile mit Details.');
    assert.deepEqual(parsedMinimal.tags, []);
    assert.equal(parsedMinimal.homepage, '');
    assert.equal(parsedMinimal.license, '');
    assert.equal(parsedMinimal.downloadUrl, '');
    assert.equal(parsedMinimal.installerType, '');

    const betaEn = [
      'Found Beta App [Acme.BetaApp]',
      'Version: 1.5.0-beta.2',
      'Publisher: Acme',
      'Description:',
      '  Line one of description.',
      '  Line two of description.',
      'Release Notes:',
      '  - Added beta feature',
      '  - Fixed crash on startup',
    ].join('\n');

    const parsedBeta = parseWingetShowOutput(betaEn);
    assert.equal(parsedBeta.version, '1.5.0');
    assert.equal(parsedBeta.description, 'Line one of description.\nLine two of description.');
    assert.equal(parsedBeta.releaseNotes, '- Added beta feature\n- Fixed crash on startup');

    const dateVer = parseWingetShowOutput(['Found CalVer [Acme.CalVer]', 'Version: 2026.11.01'].join('\n'));
    assert.equal(dateVer.version, '2026.11.01');
  });
});

describe('mergeWingetShowResults', () => {
  it('behält deutsche Lokalisierung und ergänzt fehlende Installer-Daten aus dem Standard-Fallback', () => {
    const deLocalized = parseWingetShowOutput(
      [
        'Gefunden Mozilla Firefox [Mozilla.Firefox]',
        'Version: 160.0.1',
        'Herausgeber: Mozilla',
        'Beschreibung: Freier Webbrowser.',
        'Installationsprogramm:',
        '  Es wurde kein anwendbarer Installer gefunden.',
      ].join('\n')
    );

    const defaultFallback = parseWingetShowOutput(
      [
        'Found Mozilla Firefox [Mozilla.Firefox]',
        'Version: 160.0.1',
        'Publisher: Mozilla',
        'Description: Free web browser.',
        'Installer:',
        '  Installer Type: exe',
        '  Installer Url: https://download.mozilla.org/firefox-160.0.1.exe',
        '  Installer SHA256: ABCD1234',
        '  Release Date: 2026-11-17',
      ].join('\n')
    );

    const merged = mergeWingetShowResults(deLocalized, defaultFallback);
    assert.equal(merged.description, 'Freier Webbrowser.');
    assert.equal(merged.installerType, 'exe');
    assert.equal(merged.downloadUrl, 'https://download.mozilla.org/firefox-160.0.1.exe');
    assert.equal(merged.sha256, 'abcd1234');
    assert.equal(merged.releaseDate, '2026-11-17');
  });
});

describe('parseWingetSearchOutput', () => {
  it('parst Suchergebnisse trotz Spinner-Prefixen sauber', () => {
    const out = [
      '-\r\\\r|\rName                                ID                     Version Quelle',
      '-------------------------------------------------------------------------',
      'VLC media player                    VideoLAN.VLC           3.0.24  winget',
      '7-Zip                               7zip.7zip              26.06   winget',
    ].join('\n');

    const results = parseWingetSearchOutput(out);
    assert.equal(results.length, 2);
    assert.deepEqual(results[0], {
      packageManager: 'winget',
      packageId: 'VideoLAN.VLC',
      id: 'VideoLAN.VLC',
      name: 'VLC media player',
      version: '3.0.24',
      source: 'winget',
    });
  });

  it('liefert bei limit = 0 alle gefundenen Treffer ohne Begrenzung auf 25', () => {
    const rows = Array.from(
      { length: 32 },
      (_, idx) => `App ${idx + 1}                             Vendor.App${idx + 1}         1.0.${idx}  winget`
    );
    const out = [
      'Name                                ID                     Version Quelle',
      '-------------------------------------------------------------------------',
      ...rows,
    ].join('\n');

    assert.equal(parseWingetSearchOutput(out).length, 25);
    assert.equal(parseWingetSearchOutput(out, 0).length, 32);
  });
});

describe('parseWingetUpgradeOutput', () => {
  it('parst Einzel-Leerzeichen-Grenzen, <-Präfixe, abgeschnittene IDs und ignoriert Footer', () => {
    const out = [
      'Name                                                         ID                                         Version         Verfügbar       Quelle',
      '----------------------------------------------------------------------------------------------------------------------------------------------',
      'Audacity 4.0 beta.2                                          Audacity.Audacity                          4.0.0.261621301 4.0.2.263060742 winget',
      'Satisfactory Mod Manager                                     SatisfactoryModding.SatisfactoryModManager 3.1.0           3.2.0           winget',
      'Speccy                                                       Piriform.Speccy                            < 1.34.84       1.34.84         winget',
      'Very Long Package Name                                       SomeVendor.VeryLongPackageIdentifierName…  1.0.0           1.1.0           winget',
      '4 Aktualisierungen verfügbar.',
      'Mindestens 2 Paket verfügt über Versionsnummern, die nicht ermittelt werden können.',
    ].join('\n');

    const upgrades = parseWingetUpgradeOutput(out);
    assert.equal(upgrades.length, 4);

    assert.equal(upgrades[0].packageId, 'Audacity.Audacity');
    assert.equal(upgrades[0].installedVersion, '4.0.0.261621301');
    assert.equal(upgrades[0].availableVersion, '4.0.2.263060742');

    assert.equal(upgrades[1].packageId, 'SatisfactoryModding.SatisfactoryModManager');
    assert.equal(upgrades[1].installedVersion, '3.1.0');
    assert.equal(upgrades[1].availableVersion, '3.2.0');

    assert.equal(upgrades[2].packageId, 'Piriform.Speccy');
    assert.equal(upgrades[2].installedVersion, '1.34.84');
    assert.equal(upgrades[2].rawInstalledVersion, '< 1.34.84');
    assert.equal(upgrades[2].installedVersionIsLowerBound, true);

    assert.equal(upgrades[3].idTruncated, true);
  });

  it('parst mehrteilige winget upgrade Tabellen und ignoriert wiederholte Headerzeilen', () => {
    const multiOut = [
      'Name       Id            Version Verfügbar Quelle',
      '-------------------------------------------------',
      'HP Smart   9N9PHDT62W94  150.1.0 159.1.0   msstore',
      '1 Aktualisierungen verfügbar.',
      'Die folgenden Pakete erfordern explizites Targeting:',
      'Name       Id            Version Verfügbar Quelle',
      '-------------------------------------------------',
      'WhatsApp   9NKSQGP7F2NH  < 2.24  2.25.1    msstore',
    ].join('\n');

    const upgrades = parseWingetUpgradeOutput(multiOut, { packageManager: 'msstore', defaultSource: 'msstore' });
    assert.equal(upgrades.length, 2);
    assert.equal(upgrades[0].packageId, '9N9PHDT62W94');
    assert.equal(upgrades[0].name, 'HP Smart');
    assert.equal(upgrades[1].packageId, '9NKSQGP7F2NH');
    assert.equal(upgrades[1].installedVersionIsLowerBound, true);
  });
});

describe('parseWingetListOutput & mergeWingetExportWithList', () => {
  it('parst winget list (3, 4 und 5 Spalten inkl. MS-Store-IDs und Verfuegbar-Spalte)', () => {
    const listOut = [
      'Name                 ID           Version     Verfügbar   Quelle',
      '-----------------------------------------------------------------',
      'HP Smart             9N9PHDT62W94 Unbekannt   159.1.1160  msstore',
      'Windows Terminal     9N0DX20HK701 < 1.21.0                msstore',
      'Spotify              9NCBCSZSJRSB 1.2.50.335              msstore',
    ].join('\n');

    const parsed = parseWingetListOutput(listOut, {
      packageManager: 'msstore',
      defaultSource: 'msstore',
      requireDotInId: false,
    });
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].name, 'HP Smart');
    assert.equal(parsed[0].packageId, '9N9PHDT62W94');
    assert.equal(parsed[0].availableVersion, '159.1.1160');
    assert.equal(parsed[1].name, 'Windows Terminal');
    assert.equal(parsed[1].version, '1.21.0');
    assert.equal(parsed[1].installedVersionIsLowerBound, true);
    assert.equal(parsed[2].name, 'Spotify');
    assert.equal(parsed[2].availableVersion, '');
  });

  it('fuehrt winget export und winget list (inkl. abgeschnittener ...-IDs) zusammen', () => {
    const exported = [
      { packageManager: 'winget', packageId: '7zip.7zip', version: '26.04', source: 'winget' },
      {
        packageManager: 'winget',
        packageId: 'SatisfactoryModding.SatisfactoryModManager',
        version: '3.1.0',
        source: 'winget',
      },
    ];
    const listed = [
      {
        packageManager: 'winget',
        packageId: '7zip.7zip',
        name: '7-Zip',
        version: '26.04',
        availableVersion: '',
        source: 'winget',
        idTruncated: false,
      },
      {
        packageManager: 'winget',
        packageId: 'SatisfactoryModding.SatisfactoryMo…',
        name: 'Satisfactory Mod Manager',
        version: '3.1.0',
        availableVersion: '3.2.0',
        source: 'winget',
        idTruncated: true,
      },
    ];

    const merged = mergeWingetExportWithList(exported, listed);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].name, '7-Zip');
    assert.equal(merged[1].packageId, 'SatisfactoryModding.SatisfactoryModManager');
    assert.equal(merged[1].name, 'Satisfactory Mod Manager');
    assert.equal(merged[1].availableVersion, '3.2.0');
  });
});

describe('parseWingetExportJson', () => {
  it('parst Export-JSON mit BOM und dedupliziert nach PackageIdentifier', () => {
    const raw = `\uFEFF${JSON.stringify({
      Sources: [
        {
          SourceDetails: { Name: 'winget' },
          Packages: [
            { PackageIdentifier: '7zip.7zip', Version: '26.04' },
            { PackageIdentifier: '7zip.7zip', Version: '26.04' },
            { PackageIdentifier: 'Git.Git', Version: '2.55.0.5' },
          ],
        },
      ],
    })}`;

    const exported = parseWingetExportJson(raw);
    assert.equal(exported.length, 2);
    assert.deepEqual(exported[0], {
      packageManager: 'winget',
      packageId: '7zip.7zip',
      version: '26.04',
      source: 'winget',
    });
  });
});

describe('createProviderCache (Winget-Cache-Logik)', () => {
  let tempDir;
  let cacheFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-winget-cache-'));
    cacheFile = path.join(tempDir, 'provider-cache.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('liefert frischen Cache (< 7 Tage) direkt ohne erneuten Abruf', async () => {
    let clock = 1_700_000_000_000;
    const cache = createProviderCache({ filePath: cacheFile, now: () => clock });
    let calls = 0;

    const initial = await cache.getOrFetch('winget:show:7zip.7zip', async () => {
      calls++;
      return { name: '7-Zip', version: '26.06' };
    });
    assert.equal(initial.fromCache, false);
    assert.equal(initial.isStale, false);

    clock += 2 * 24 * 60 * 60 * 1000;
    const freshHit = await cache.getOrFetch('winget:show:7zip.7zip', async () => {
      calls++;
      return { name: '7-Zip', version: '27.00' };
    });
    assert.equal(calls, 1);
    assert.equal(freshHit.fromCache, true);
    assert.equal(freshHit.isStale, false);
    assert.equal(freshHit.data.version, '26.06');
  });

  it('aktualisiert abgelaufenen Cache (> 7 Tage) bei erfolgreicher Online-Abfrage', async () => {
    let clock = 1_700_000_000_000;
    const cache = createProviderCache({ filePath: cacheFile, now: () => clock });

    await cache.getOrFetch('winget:show:videolan.vlc', async () => ({ name: 'VLC', version: '3.0.21' }));

    clock += DEFAULT_CACHE_TTL_MS + 5000;
    const updated = await cache.getOrFetch('winget:show:videolan.vlc', async () => ({
      name: 'VLC',
      version: '3.0.24',
    }));
    assert.equal(updated.fromCache, false);
    assert.equal(updated.isStale, false);
    assert.equal(updated.data.version, '3.0.24');
  });

  it('erhält abgelaufenen Cache im Offline-Modus und liefert isStale: true', async () => {
    let clock = 1_700_000_000_000;
    const cache = createProviderCache({ filePath: cacheFile, now: () => clock });

    await cache.getOrFetch('winget:show:git.git', async () => ({ name: 'Git', version: '2.55.0' }));

    clock += DEFAULT_CACHE_TTL_MS + 86_400_000;
    const offline = await cache.getOrFetch('winget:show:git.git', async () => {
      throw new Error('Netzwerk nicht erreichbar');
    });

    assert.equal(offline.fromCache, true);
    assert.equal(offline.isStale, true);
    assert.equal(offline.data.version, '2.55.0');
    assert.match(offline.error, /Netzwerk/);
  });
});
