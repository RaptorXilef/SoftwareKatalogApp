import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_PROVIDER_SETTINGS, normalizeProviderSettings } from '../src/shared/provider-lifecycle-logic.js';
import {
  isValidSourceName,
  isValidSourceUrl,
  isValidWingetSourceType,
  normalizeCustomSourcesList,
  PROVIDER_SOURCE_TEMPLATES,
  parseChocoSourceListOutput,
  parsePowerShellRepositoriesJson,
  parseScoopBucketListOutput,
  parseWingetSourceListOutput,
} from '../src/shared/provider-sources-parser.js';

describe('provider-sources-parser: winget source list', () => {
  it('parst deutsche und englische Tabellen-Ausgaben inkl. Explicit-Spalte und ANSI-Codes', () => {
    const stdout = [
      '\x1b[32mName        Argument                                      Explicit\x1b[0m',
      '--------------------------------------------------------------------',
      'msstore     https://storeedgefd.dsx.mp.microsoft.com/v9.0 false',
      'winget      https://cdn.winget.microsoft.com/cache        false',
      'winget-font https://cdn.winget.microsoft.com/fonts        true',
      '',
    ].join('\n');

    const parsed = parseWingetSourceListOutput(stdout);
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0], {
      name: 'msstore',
      url: 'https://storeedgefd.dsx.mp.microsoft.com/v9.0',
      type: '',
      explicit: false,
      enabled: true,
    });
    assert.equal(parsed[1].name, 'winget');
    assert.equal(parsed[2].name, 'winget-font');
    assert.equal(parsed[2].explicit, true);
  });

  it('parst zweispaltige winget source list Ausgaben ohne Explicit-Spalte', () => {
    const stdout = [
      'Name    Argument',
      '--------------------------------------------------',
      'winget  https://cdn.winget.microsoft.com/cache',
      'custom  https://packages.example.org/winget',
    ].join('\n');

    const parsed = parseWingetSourceListOutput(stdout);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[1].name, 'custom');
    assert.equal(parsed[1].url, 'https://packages.example.org/winget');
    assert.equal(parsed[1].explicit, false);
  });

  it('liefert ein leeres Array bei leerer oder ungueltiger Ausgabe', () => {
    assert.deepEqual(parseWingetSourceListOutput(''), []);
    assert.deepEqual(parseWingetSourceListOutput('Keine Quellen gefunden.'), []);
  });
});

describe('provider-sources-parser: scoop bucket list', () => {
  it('parst das aktuelle Scoop-Tabellenformat mit Manifests und Updated', () => {
    const stdout = [
      'Name       Source                                          Updated             Manifests',
      '----       ------                                          -------             ---------',
      'main       https://github.com/ScoopInstaller/Main          2026-11-20 10:12:00      1390',
      'extras     https://github.com/ScoopInstaller/Extras        2026-11-21 08:30:11      2145',
      'nerd-fonts https://github.com/matthewjberger/scoop-nerd-fonts 2026-11-19 19:05:00    342',
    ].join('\n');

    const parsed = parseScoopBucketListOutput(stdout);
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0], {
      name: 'main',
      url: 'https://github.com/ScoopInstaller/Main',
      updated: '2026-11-20 10:12:00',
      manifests: 1390,
      enabled: true,
    });
    assert.equal(parsed[1].name, 'extras');
    assert.equal(parsed[1].manifests, 2145);
    assert.equal(parsed[2].name, 'nerd-fonts');
    assert.equal(parsed[2].manifests, 342);
  });

  it('parst klassische einspaltige Scoop-Bucket-Listen und leere Ausgaben', () => {
    const legacy = ['main', 'extras', 'versions'].join('\n');
    const parsed = parseScoopBucketListOutput(legacy);
    assert.deepEqual(
      parsed.map((b) => b.name),
      ['main', 'extras', 'versions']
    );
    assert.deepEqual(parseScoopBucketListOutput(''), []);
  });
});

describe('provider-sources-parser: choco source list -r', () => {
  it('parst Pipe-Zeilen inkl. Disabled, Priority und AdminOnly', () => {
    const stdout = [
      'Chocolatey v2.4.0',
      'chocolatey|https://community.chocolatey.org/api/v2/|False||0|False|False|False',
      'internal|https://choco.company.local/nuget|True|build|10|False|False|True',
      'chocolatey.licensed|https://licensedpackages.chocolatey.org/api/v2/|False||5|False|True|False',
    ].join('\n');

    const parsed = parseChocoSourceListOutput(stdout);
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0], {
      name: 'chocolatey',
      url: 'https://community.chocolatey.org/api/v2/',
      enabled: true,
      priority: 0,
      adminOnly: false,
    });
    assert.deepEqual(parsed[1], {
      name: 'internal',
      url: 'https://choco.company.local/nuget',
      enabled: false,
      priority: 10,
      adminOnly: true,
    });
    assert.equal(parsed[2].priority, 5);
    assert.equal(parsed[2].enabled, true);
  });

  it('ignoriert ungueltige Zeilen ohne Pipe oder mit leerer URL', () => {
    const stdout = ['WARN: something', 'broken-line|', 'valid|https://example.org/api/v2/'].join('\n');
    const parsed = parseChocoSourceListOutput(stdout);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, 'valid');
  });
});

describe('provider-sources-parser: PowerShell Repositories', () => {
  it('parst Get-PSResourceRepository JSON (Array und Uri.AbsoluteUri Objekt)', () => {
    const stdout = JSON.stringify([
      {
        Name: 'PSGallery',
        Uri: { AbsoluteUri: 'https://www.powershellgallery.com/api/v2' },
        Trusted: true,
        Priority: 50,
      },
      {
        Name: 'PrivateFeed',
        Uri: 'https://pkgs.example.org/ps/v3/index.json',
        Trusted: false,
        Priority: 20,
      },
    ]);

    const parsed = parsePowerShellRepositoriesJson(stdout);
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0], {
      name: 'PSGallery',
      url: 'https://www.powershellgallery.com/api/v2',
      trusted: true,
      priority: 50,
      enabled: true,
    });
    assert.equal(parsed[1].trusted, false);
    assert.equal(parsed[1].priority, 20);
  });

  it('parst Get-PSRepository Einzelobjekt (PowerShell 5.1) mit InstallationPolicy', () => {
    const stdout = JSON.stringify({
      Name: 'PSGallery',
      SourceLocation: 'https://www.powershellgallery.com/api/v2',
      InstallationPolicy: 'Untrusted',
    });

    const parsed = parsePowerShellRepositoriesJson(stdout);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], {
      name: 'PSGallery',
      url: 'https://www.powershellgallery.com/api/v2',
      trusted: false,
      priority: null,
      enabled: true,
    });

    assert.deepEqual(parsePowerShellRepositoriesJson(''), []);
    assert.deepEqual(parsePowerShellRepositoriesJson('not-json'), []);
  });
});

describe('provider-sources-parser: Validatoren, Vorlagen & providerSettings', () => {
  it('validiert Namen, URLs, Winget-Typen und normalisiert customSources', () => {
    assert.equal(isValidSourceName('winget-custom_1.0'), true);
    assert.equal(isValidSourceName('bad name with spaces'), false);
    assert.equal(isValidSourceName('bad;inject'), false);

    assert.equal(isValidSourceUrl('https://registry.npmjs.org'), true);
    assert.equal(isValidSourceUrl('http://localhost:4873'), true);
    assert.equal(isValidSourceUrl('ftp://invalid.example.org'), false);
    assert.equal(isValidSourceUrl('not-a-url'), false);

    assert.equal(isValidWingetSourceType(''), true);
    assert.equal(isValidWingetSourceType('Microsoft.PreIndexed.Package'), true);
    assert.equal(isValidWingetSourceType('bad type'), false);

    const normalized = normalizeCustomSourcesList([
      { name: 'company', url: 'https://npm.company.local/' },
      { name: 'COMPANY', url: 'https://duplicate.local' },
      { name: 'invalid name', url: 'https://valid.local' },
      { name: 'badurl', url: 'javascript:alert(1)' },
    ]);
    assert.deepEqual(normalized, [{ name: 'company', url: 'https://npm.company.local' }]);

    assert.ok(PROVIDER_SOURCE_TEMPLATES.winget.some((t) => t.name === 'msstore'));
    assert.ok(PROVIDER_SOURCE_TEMPLATES.scoop.some((t) => t.name === 'extras'));
    assert.ok(PROVIDER_SOURCE_TEMPLATES.pwsh7.some((t) => t.name === 'PSGallery'));
  });

  it('normalisiert providerSettings.customSources ohne DEFAULT_PROVIDER_SETTINGS zu veraendern', () => {
    assert.deepEqual(normalizeProviderSettings(undefined), DEFAULT_PROVIDER_SETTINGS);

    const withSources = normalizeProviderSettings({
      vcpkgRoot: ' C:\\vcpkg ',
      npm: { customSources: [{ name: 'mirror', url: 'https://registry.npmmirror.com/' }] },
      pip: { customSources: [{ name: 'invalid', url: 'not-a-url' }] },
    });

    assert.equal(withSources.vcpkgRoot, 'C:\\vcpkg');
    assert.deepEqual(withSources.npm.customSources, [{ name: 'mirror', url: 'https://registry.npmmirror.com' }]);
    assert.equal(withSources.pip, undefined);
  });
});
