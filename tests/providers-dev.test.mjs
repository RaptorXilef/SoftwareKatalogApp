import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-providers-dev-'));
const appDir = path.join(tempRoot, 'app');
const dataDir = path.join(appDir, 'data');
const userDataDir = path.join(tempRoot, 'userData');
const tempSubDir = path.join(tempRoot, 'temp');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(tempSubDir, { recursive: true });

const electronMockUrl = 'mock://electron-dev-providers';
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
  export const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  };
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

const {
  isValidPythonPackageName,
  normalizePythonPackageName,
  parsePipListJson,
  parsePipOutdatedJson,
  parsePipVersionOutput,
  parsePyPiPackageJson,
  parsePyPiSearchHtml,
  parsePyPiSimpleIndexHtml,
  parseUvToolListOutput,
  parseUvVersionOutput,
} = await import('../src/shared/python-parser.js');
const {
  isValidCargoCrateName,
  parseCargoInstallListOutput,
  parseCargoVersionOutput,
  parseCratesIoSearchJson,
  parseCratesIoShowJson,
} = await import('../src/shared/cargo-parser.js');
const {
  extractVcpkgBasePort,
  isSafeVcpkgUninstallDir,
  isValidVcpkgPortName,
  parseVcpkgListOutput,
  parseVcpkgManifestJson,
  parseVcpkgSearchOutput,
  parseVcpkgUpgradeOutput,
  parseVcpkgVersionOutput,
} = await import('../src/shared/vcpkg-parser.js');
const {
  isValidDotnetToolId,
  parseDotnetToolListOutput,
  parseDotnetVersionOutput,
  parseNugetSearchJson,
  parseNugetShowJson,
} = await import('../src/shared/dotnet-parser.js');
const {
  isValidPsModuleName,
  parsePowerShellVersionOutput,
  parsePsGalleryODataAtomXml,
  parsePsGalleryODataJson,
  parsePsGalleryShowEntry,
  parsePsInstalledModulesJson,
} = await import('../src/shared/psgallery-parser.js');
const { mergeInstalledSoftware } = await import('../src/shared/installed-merger.js');
const { buildUnifiedPackages, getPackageStatus, getProviderBadgeInfo } = await import(
  '../src/shared/unified-packages.js'
);
const { evaluateBundleStatus, planBundleExecution, sortBundleItems } = await import('../src/shared/bundles-logic.js');
const { getProvider, isProviderEnabled, listProvidersInfo } = await import('../src/main/providers/registry.js');

after(() => {
  electronHook.deregister();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('python-parser (pip & uv tool)', () => {
  it('validiert Paketnamen, PEP-503-Normalisierung und Versionen', () => {
    assert.equal(isValidPythonPackageName('requests'), true);
    assert.equal(isValidPythonPackageName('python-dotenv'), true);
    assert.equal(isValidPythonPackageName('ruamel.yaml'), true);
    assert.equal(isValidPythonPackageName('bad pkg; calc'), false);
    assert.equal(isValidPythonPackageName('-bad'), false);
    assert.equal(normalizePythonPackageName('Python_DotEnv.Extra'), 'python-dotenv-extra');

    assert.equal(
      parsePipVersionOutput('pip 24.3.1 from C:\\Python313\\Lib\\site-packages\\pip (python 3.13)'),
      '24.3.1'
    );
    assert.equal(parseUvVersionOutput('uv 0.5.11 (c45a289c2 2024-12-19)'), '0.5.11');
  });

  it('parst `pip list --format=json` und `pip list --outdated --format=json` inkl. BOM/ANSI', () => {
    const listRaw = `\uFEFF\u001b[32m[
      {"name": "requests", "version": "2.32.3"},
      {"name": "Requests", "version": "2.32.3"},
      {"name": "rich", "version": "13.9.4"}
    ]\u001b[0m`;

    const installed = parsePipListJson(listRaw);
    assert.equal(installed.length, 2);
    assert.deepEqual(installed[0], {
      packageManager: 'pip',
      packageId: 'requests',
      id: 'requests',
      name: 'requests',
      version: '2.32.3',
      source: 'pip',
    });
    assert.equal(installed[1].packageId, 'rich');

    const outdatedRaw = JSON.stringify([
      { name: 'requests', version: '2.31.0', latest_version: '2.32.3', latest_filetype: 'wheel' },
      { name: 'rich', version: '13.9.4', latest_version: '13.9.4', latest_filetype: 'wheel' },
      { name: 'ruff', version: '0.8.1', latest_version: '0.8.4', latest_filetype: 'wheel' },
    ]);
    const upgrades = parsePipOutdatedJson(outdatedRaw);
    assert.equal(upgrades.length, 2);
    assert.deepEqual(upgrades[0], {
      packageManager: 'pip',
      packageId: 'requests',
      id: 'requests',
      name: 'requests',
      installedVersion: '2.31.0',
      availableVersion: '2.32.3',
      source: 'pip',
    });
    assert.equal(upgrades[1].packageId, 'ruff');
    assert.deepEqual(parsePipOutdatedJson('[]'), []);
  });

  it('parst `uv tool list` inkl. Executables, Annotationen und Leerzustand', () => {
    assert.deepEqual(parseUvToolListOutput('No tools installed\n'), []);

    const uvOut = [
      '\uFEFFruff v0.8.4',
      '- ruff.exe',
      'black v24.10.0 [extras: jupyter]',
      '- black.exe',
      '- blackd.exe',
      'httpie v3.2.4',
      '- http.exe',
      '- https.exe',
    ].join('\n');

    const tools = parseUvToolListOutput(uvOut);
    assert.equal(tools.length, 3);
    assert.deepEqual(tools[0], {
      packageManager: 'uv',
      packageId: 'ruff',
      id: 'ruff',
      name: 'ruff',
      version: '0.8.4',
      executables: ['ruff.exe'],
      source: 'uv',
    });
    assert.equal(tools[1].version, '24.10.0');
    assert.deepEqual(tools[1].executables, ['black.exe', 'blackd.exe']);
    assert.deepEqual(tools[2].executables, ['http.exe', 'https.exe']);
  });

  it('parst PyPI JSON API, PyPI-Such-HTML und PEP-503-Simple-Index', () => {
    const pypiShow = parsePyPiPackageJson(
      {
        info: {
          name: 'ruff',
          version: '0.8.4',
          summary: 'An extremely fast Python linter and code formatter, written in Rust.',
          description: 'Full Ruff README description.',
          author: 'Charlie Marsh',
          license_expression: 'MIT',
          keywords: 'linter, formatter, python',
          project_urls: {
            Homepage: 'https://docs.astral.sh/ruff/',
            Repository: 'https://github.com/astral-sh/ruff',
          },
          project_url: 'https://pypi.org/project/ruff/',
        },
      },
      'ruff',
      { packageManager: 'uv' }
    );
    assert.equal(pypiShow.packageManager, 'uv');
    assert.equal(pypiShow.version, '0.8.4');
    assert.equal(pypiShow.license, 'MIT');
    assert.equal(pypiShow.repositoryUrl, 'https://github.com/astral-sh/ruff');
    assert.equal(pypiShow.homepage, 'https://docs.astral.sh/ruff');
    assert.deepEqual(pypiShow.tags, ['linter', 'formatter', 'python']);

    const searchHtml = `
      <ul class="unstyled">
        <li>
          <a class="package-snippet" href="/project/ruff/">
            <h3 class="package-snippet__title">
              <span class="package-snippet__name">ruff</span>
              <span class="package-snippet__version">0.8.4</span>
            </h3>
            <p class="package-snippet__description">Fast Python linter &amp; formatter</p>
          </a>
        </li>
      </ul>
    `;
    const searchRes = parsePyPiSearchHtml(searchHtml, 10, { packageManager: 'pip' });
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].packageId, 'ruff');
    assert.equal(searchRes[0].shortDescription, 'Fast Python linter & formatter');

    const simpleHtml =
      '<a href="/simple/ruff/">ruff</a><a href="/simple/ruff-lsp/">ruff-lsp</a><a href="/simple/other/">other</a>';
    const simpleRes = parsePyPiSimpleIndexHtml(simpleHtml, 'ruff', 10, { packageManager: 'pip' });
    assert.deepEqual(
      simpleRes.map((r) => r.packageId),
      ['ruff', 'ruff-lsp']
    );
  });
});

describe('cargo-parser (Rust Cargo & crates.io)', () => {
  it('validiert Crate-Namen und parst `cargo --version` sowie `cargo install --list`', () => {
    assert.equal(isValidCargoCrateName('ripgrep'), true);
    assert.equal(isValidCargoCrateName('fd-find'), true);
    assert.equal(isValidCargoCrateName('123bad'), false);
    assert.equal(isValidCargoCrateName('bad crate'), false);

    assert.equal(parseCargoVersionOutput('cargo 1.83.0 (5ffbef321 2024-10-29)'), '1.83.0');

    const cargoListOut = [
      'ripgrep v14.1.1:',
      '    rg.exe',
      'bat v0.24.0 (C:\\src\\bat):',
      '    bat.exe',
      'cargo-update v16.0.0:',
      '    cargo-install-update-config.exe',
      '    cargo-install-update.exe',
    ].join('\n');

    const installed = parseCargoInstallListOutput(cargoListOut);
    assert.equal(installed.length, 3);
    assert.deepEqual(installed[0], {
      packageManager: 'cargo',
      packageId: 'ripgrep',
      id: 'ripgrep',
      name: 'ripgrep',
      version: '14.1.1',
      binaries: ['rg.exe'],
      source: 'cargo',
    });
    assert.equal(installed[1].packageId, 'bat');
    assert.equal(installed[1].version, '0.24.0');
    assert.deepEqual(installed[2].binaries, ['cargo-install-update-config.exe', 'cargo-install-update.exe']);
  });

  it('parst crates.io Search und Show JSON inkl. yanked-Filterung', () => {
    const searchPayload = {
      crates: [
        {
          id: 'ripgrep',
          name: 'ripgrep',
          max_stable_version: '14.1.1',
          max_version: '14.1.1',
          description: 'Line-oriented search tool',
          homepage: 'https://github.com/BurntSushi/ripgrep',
          repository: 'https://github.com/BurntSushi/ripgrep',
        },
      ],
    };
    const searchRes = parseCratesIoSearchJson(searchPayload, 20);
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].packageManager, 'cargo');
    assert.equal(searchRes[0].version, '14.1.1');

    const showPayload = {
      crate: {
        id: 'ripgrep',
        name: 'ripgrep',
        max_stable_version: '14.1.1',
        description: 'ripgrep recursively searches directories for a regex pattern.',
        homepage: 'https://github.com/BurntSushi/ripgrep',
        repository: 'https://github.com/BurntSushi/ripgrep',
      },
      versions: [
        { num: '14.2.0', yanked: true, license: 'MIT' },
        { num: '14.1.1', yanked: false, license: 'Unlicense OR MIT', published_by: { name: 'Andrew Gallant' } },
      ],
      keywords: [
        { id: 'cli', keyword: 'cli' },
        { id: 'search', keyword: 'search' },
      ],
    };
    const showRes = parseCratesIoShowJson(showPayload, 'ripgrep');
    assert.equal(showRes.version, '14.1.1');
    assert.equal(showRes.license, 'Unlicense OR MIT');
    assert.equal(showRes.author, 'Andrew Gallant');
    assert.deepEqual(showRes.tags, ['cli', 'search']);
    assert.equal(showRes.cratesUrl, 'https://crates.io/crates/ripgrep');
  });
});

describe('vcpkg-parser (C/C++ vcpkg)', () => {
  it('validiert Port-Specs, Version und Sicherheitspruefung fuer Loeschpfade', () => {
    assert.equal(isValidVcpkgPortName('zlib'), true);
    assert.equal(isValidVcpkgPortName('zlib:x64-windows'), true);
    assert.equal(isValidVcpkgPortName('curl[ssl,http2]:x64-windows'), true);
    assert.equal(isValidVcpkgPortName('bad port'), false);
    assert.equal(extractVcpkgBasePort('curl[ssl]:x64-windows'), 'curl');

    assert.equal(
      parseVcpkgVersionOutput(
        'vcpkg package management program version 2024-12-09-1005b78fa1bf1dde1a20c2734cba4ea61ca94d9a'
      ),
      '2024-12-09'
    );

    assert.equal(isSafeVcpkgUninstallDir('C:\\'), false);
    assert.equal(isSafeVcpkgUninstallDir('C:\\Windows'), false);
    assert.equal(isSafeVcpkgUninstallDir('C:\\Users\\test'), false);
    assert.equal(isSafeVcpkgUninstallDir('C:\\Users\\test\\AppData\\Local'), false);
    assert.equal(isSafeVcpkgUninstallDir('C:\\tools\\vcpkg'), true);
    assert.equal(isSafeVcpkgUninstallDir('D:\\dev\\vcpkg'), true);
  });

  it('parst `vcpkg list`, `vcpkg search`, `vcpkg upgrade` und `vcpkg.json`', () => {
    assert.deepEqual(parseVcpkgListOutput('No packages are installed.\n'), []);

    const listOut = [
      'curl:x64-windows              8.11.0#1        A library for transferring data with URLs',
      'curl[non-http]:x64-windows                    Enables protocols beyond HTTP/HTTPS/FTP',
      'curl[schannel]:x64-windows                    SSL support (Secure Channel)',
      'zlib:x64-windows              1.3.1           A compression library',
    ].join('\n');
    const installed = parseVcpkgListOutput(listOut);
    assert.equal(installed.length, 2);
    assert.deepEqual(installed[0], {
      packageManager: 'vcpkg',
      packageId: 'curl:x64-windows',
      id: 'curl:x64-windows',
      name: 'curl (x64-windows)',
      port: 'curl',
      triplet: 'x64-windows',
      version: '8.11.0',
      shortDescription: 'A library for transferring data with URLs',
      source: 'vcpkg',
    });
    assert.equal(installed[1].packageId, 'zlib:x64-windows');

    const searchOut = [
      'zlib                 1.3.1            A compression library',
      'zlib-ng              2.2.2            zlib data compression library for the next generation systems',
      'The result may be outdated. Run `git pull` to get the latest results.',
      'If your port is not listed, please open an issue at:',
    ].join('\n');
    const searchRes = parseVcpkgSearchOutput(searchOut, 25);
    assert.equal(searchRes.length, 2);
    assert.equal(searchRes[0].packageId, 'zlib');
    assert.equal(searchRes[1].packageId, 'zlib-ng');

    const upgradeOut = [
      'The following packages will be rebuilt:',
      '  * zlib:x64-windows 1.3.0 -> 1.3.1',
      '    curl:x64-windows 8.10.1#2 -> 8.11.0',
    ].join('\n');
    const upgrades = parseVcpkgUpgradeOutput(upgradeOut);
    assert.equal(upgrades.length, 2);
    assert.equal(upgrades[0].installedVersion, '1.3.0');
    assert.equal(upgrades[0].availableVersion, '1.3.1');

    const manifest = parseVcpkgManifestJson(
      {
        name: 'zlib',
        version: '1.3.1',
        description: ['A Massively Spiffy Yet Delicately Unobtrusive Compression Library'],
        homepage: 'https://zlib.net/',
        license: 'Zlib',
      },
      'zlib:x64-windows'
    );
    assert.equal(manifest.name, 'zlib');
    assert.equal(manifest.version, '1.3.1');
    assert.equal(manifest.license, 'Zlib');
    assert.equal(manifest.homepage, 'https://zlib.net/');
  });
});

describe('dotnet-parser (.NET Global Tools & NuGet)', () => {
  it('parst `dotnet --version` und `dotnet tool list -g` (EN & DE)', () => {
    assert.equal(isValidDotnetToolId('dotnet-ef'), true);
    assert.equal(isValidDotnetToolId('Microsoft.dotnet-httprepl'), true);
    assert.equal(isValidDotnetToolId('bad tool'), false);

    assert.equal(parseDotnetVersionOutput('10.0.100\n'), '10.0.100');

    const listEn = [
      'Package Id               Version      Commands',
      '---------------------------------------------------',
      'dotnet-ef                9.0.0        dotnet-ef',
      'dotnetsay                2.1.7        dotnetsay',
    ].join('\n');
    const parsedEn = parseDotnetToolListOutput(listEn);
    assert.equal(parsedEn.length, 2);
    assert.deepEqual(parsedEn[0], {
      packageManager: 'dotnet',
      packageId: 'dotnet-ef',
      id: 'dotnet-ef',
      name: 'dotnet-ef',
      version: '9.0.0',
      commands: ['dotnet-ef'],
      source: 'dotnet',
    });

    const listDe = [
      'Paket-ID                 Version      Befehle',
      '---------------------------------------------------',
      'dotnet-script            1.5.0        dotnet-script',
    ].join('\n');
    const parsedDe = parseDotnetToolListOutput(listDe);
    assert.equal(parsedDe.length, 1);
    assert.equal(parsedDe[0].packageId, 'dotnet-script');
  });

  it('parst NuGet Search & Show JSON', () => {
    const nugetPayload = {
      totalHits: 1,
      data: [
        {
          id: 'dotnet-ef',
          version: '9.0.0',
          title: 'dotnet-ef',
          description: 'Entity Framework Core Command Line Tools',
          authors: ['Microsoft'],
          projectUrl: 'https://docs.microsoft.com/ef/core/',
          licenseUrl: 'https://licenses.nuget.org/MIT',
          tags: ['EntityFramework', 'CLI'],
        },
      ],
    };

    const searchRes = parseNugetSearchJson(nugetPayload, 25);
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].packageManager, 'dotnet');
    assert.equal(searchRes[0].version, '9.0.0');

    const showRes = parseNugetShowJson(nugetPayload, 'dotnet-ef');
    assert.equal(showRes.packageId, 'dotnet-ef');
    assert.equal(showRes.author, 'Microsoft');
    assert.equal(showRes.licenseUrl, 'https://licenses.nuget.org/MIT');
    assert.equal(showRes.nugetUrl, 'https://www.nuget.org/packages/dotnet-ef');
  });
});

describe('psgallery-parser (PowerShell 7 & 5.1)', () => {
  it('validiert Modulnamen, Versionen und parst Get-InstalledModule JSON (Array, Einzelobjekt, Version-Objekt)', () => {
    assert.equal(isValidPsModuleName('PSReadLine'), true);
    assert.equal(isValidPsModuleName('Az.Accounts'), true);
    assert.equal(isValidPsModuleName('bad module'), false);

    assert.equal(parsePowerShellVersionOutput('7.4.6\n'), '7.4.6');
    assert.equal(parsePowerShellVersionOutput('5.1.22621.4391\n'), '5.1.22621.4391');

    // PowerShell 5.1 liefert bei genau 1 Ergebnis ein einzelnes JSON-Objekt statt eines Arrays
    const singlePs5Json = `\uFEFF{
      "Name": "Pester",
      "Version": { "Major": 5, "Minor": 6, "Build": 1, "Revision": -1 },
      "Author": "Pester Team",
      "Description": "BDD testing framework for PowerShell",
      "ProjectUri": { "AbsoluteUri": "https://pester.dev/" },
      "LicenseUri": "https://github.com/pester/Pester/blob/main/LICENSE"
    }`;
    const ps5Parsed = parsePsInstalledModulesJson(singlePs5Json, { packageManager: 'pwsh5' });
    assert.equal(ps5Parsed.length, 1);
    assert.deepEqual(ps5Parsed[0], {
      packageManager: 'pwsh5',
      packageId: 'Pester',
      id: 'Pester',
      name: 'Pester',
      version: '5.6.1',
      author: 'Pester Team',
      shortDescription: 'BDD testing framework for PowerShell',
      homepage: 'https://pester.dev',
      licenseUrl: 'https://github.com/pester/Pester/blob/main/LICENSE',
      source: 'pwsh5',
    });

    const multiPwsh7Json = JSON.stringify([
      { Name: 'Terminal-Icons', Version: '0.11.0', Author: 'devblackops', Description: 'Folder icons' },
      { Name: 'PSReadLine', Version: '2.3.6', Author: 'Microsoft', Description: 'Command line editing' },
    ]);
    const pwsh7Parsed = parsePsInstalledModulesJson(multiPwsh7Json, { packageManager: 'pwsh7' });
    assert.equal(pwsh7Parsed.length, 2);
    assert.equal(pwsh7Parsed[0].packageManager, 'pwsh7');
    assert.equal(pwsh7Parsed[1].version, '2.3.6');
  });

  it('parst PowerShell Gallery OData Atom XML, OData JSON und Show-Details', () => {
    const atomXml = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata">
        <entry>
          <title type="text">Terminal-Icons</title>
          <m:properties>
            <d:Id>Terminal-Icons</d:Id>
            <d:Version>0.11.0</d:Version>
            <d:NormalizedVersion>0.11.0</d:NormalizedVersion>
            <d:Authors>devblackops</d:Authors>
            <d:Description>A PowerShell module to add file &amp; folder icons</d:Description>
            <d:ProjectUrl>https://github.com/devblackops/Terminal-Icons</d:ProjectUrl>
            <d:LicenseUrl>https://github.com/devblackops/Terminal-Icons/blob/main/LICENSE</d:LicenseUrl>
            <d:Tags>PSModule Icons Terminal</d:Tags>
            <d:IsLatestVersion m:type="Edm.Boolean">true</d:IsLatestVersion>
          </m:properties>
        </entry>
      </feed>`;

    const xmlParsed = parsePsGalleryODataAtomXml(atomXml, 25, { packageManager: 'pwsh7' });
    assert.equal(xmlParsed.length, 1);
    assert.equal(xmlParsed[0].packageId, 'Terminal-Icons');
    assert.equal(xmlParsed[0].shortDescription, 'A PowerShell module to add file & folder icons');
    assert.equal(xmlParsed[0].isLatestVersion, true);
    assert.deepEqual(xmlParsed[0].tags, ['PSModule', 'Icons', 'Terminal']);

    const showObj = parsePsGalleryShowEntry(xmlParsed[0], 'Terminal-Icons', { packageManager: 'pwsh7' });
    assert.equal(showObj.packageManager, 'pwsh7');
    assert.equal(showObj.version, '0.11.0');
    assert.equal(showObj.galleryUrl, 'https://www.powershellgallery.com/packages/Terminal-Icons');

    const jsonParsed = parsePsGalleryODataJson(
      {
        d: {
          results: [{ Id: 'posh-git', NormalizedVersion: '1.1.0', Authors: 'Keith Dahlby', Description: 'Git prompt' }],
        },
      },
      10,
      { packageManager: 'pwsh5' }
    );
    assert.equal(jsonParsed.length, 1);
    assert.equal(jsonParsed[0].packageManager, 'pwsh5');
    assert.equal(jsonParsed[0].packageId, 'posh-git');
  });
});

describe('registry defaults & cross-provider integration for Developer/PowerShell', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ enabledProviders: ['winget', 'archive'] }, null, 2),
      'utf-8'
    );
  });

  it('registriert alle 7 neuen Provider standardmaessig deaktiviert mit korrekten Lifecycle-Flags', () => {
    for (const id of ['pip', 'uv', 'cargo', 'vcpkg', 'dotnet', 'pwsh7', 'pwsh5']) {
      const prov = getProvider(id);
      assert.ok(prov, `Provider ${id} muss registriert sein`);
      assert.equal(isProviderEnabled(id), false);
      assert.equal(prov.capabilities.search, true);
      assert.equal(prov.capabilities.listInstalled, true);
      assert.equal(prov.capabilities.listUpgrades, true);
      assert.equal(prov.capabilities.show, true);
      assert.equal(prov.capabilities.install, true);
      assert.equal(prov.capabilities.uninstall, true);
      assert.equal(prov.capabilities.supportsArchiveDownload, false);
    }

    assert.equal(getProvider('vcpkg').uninstallWarning, '');

    const pwsh5 = getProvider('pwsh5');
    assert.equal(pwsh5.category, 'system');
    assert.equal(pwsh5.isSystemComponent, true);
    assert.equal(pwsh5.canInstallManager, false);
    assert.equal(pwsh5.canUninstallManager, false);

    const pwsh7 = getProvider('pwsh7');
    assert.equal(pwsh7.category, 'system');
    assert.equal(pwsh7.isSystemComponent, false);
    assert.equal(pwsh7.canInstallManager, true);
    assert.equal(pwsh7.canUninstallManager, true);

    const info = listProvidersInfo();
    assert.ok(info.providers.some((p) => p.id === 'uv' && p.category === 'developer'));
  });

  it('fuehrt alle 7 Provider sauber durch Merger, Unified-Model und Buendel ohne Registry-Kollision', () => {
    const merged = mergeInstalledSoftware({
      providerInstalled: [
        { packageManager: 'pip', packageId: 'requests', name: 'requests', version: '2.31.0', source: 'pip' },
        { packageManager: 'uv', packageId: 'ruff', name: 'ruff', version: '0.8.4', source: 'uv' },
        { packageManager: 'cargo', packageId: 'ripgrep', name: 'ripgrep', version: '14.1.1', source: 'cargo' },
        {
          packageManager: 'vcpkg',
          packageId: 'zlib:x64-windows',
          name: 'zlib (x64-windows)',
          version: '1.3.0',
          source: 'vcpkg',
        },
        { packageManager: 'dotnet', packageId: 'dotnet-ef', name: 'dotnet-ef', version: '9.0.0', source: 'dotnet' },
        {
          packageManager: 'pwsh7',
          packageId: 'Terminal-Icons',
          name: 'Terminal-Icons',
          version: '0.11.0',
          source: 'pwsh7',
        },
        { packageManager: 'pwsh5', packageId: 'Pester', name: 'Pester', version: '5.6.1', source: 'pwsh5' },
      ],
      providerUpgrades: [
        {
          packageManager: 'pip',
          packageId: 'requests',
          name: 'requests',
          installedVersion: '2.31.0',
          availableVersion: '2.32.3',
          source: 'pip',
        },
        {
          packageManager: 'vcpkg',
          packageId: 'zlib:x64-windows',
          name: 'zlib (x64-windows)',
          installedVersion: '1.3.0',
          availableVersion: '1.3.1',
          source: 'vcpkg',
        },
      ],
      registryEntries: [
        {
          displayName: 'Python 3.13.1 (64-bit)',
          displayVersion: '3.13.1',
          publisher: 'Python Software Foundation',
          uninstallString: 'C:\\setup.exe',
        },
      ],
    });

    const pipApp = merged.find((p) => p.id === 'pip:requests');
    assert.ok(pipApp);
    assert.equal(pipApp.hasUpdate, true);
    assert.equal(pipApp.availableVersion, '2.32.3');

    const pwsh7App = merged.find((p) => p.id === 'pwsh7:terminal-icons');
    assert.ok(pwsh7App);
    assert.equal(pwsh7App.packageManager, 'pwsh7');

    const unified = buildUnifiedPackages({ catalogItems: [], installedApps: merged });
    const pipUnified = unified.find((p) => p.packageManager === 'pip');
    assert.equal(getPackageStatus(pipUnified).status, 'webupdate');

    assert.deepEqual(getProviderBadgeInfo('pwsh7'), {
      id: 'pwsh7',
      label: 'PowerShell 7',
      badgeClass: 'is-pwsh7',
    });
    assert.deepEqual(getProviderBadgeInfo('vcpkg'), {
      id: 'vcpkg',
      label: 'vcpkg',
      badgeClass: 'is-vcpkg',
    });

    const items = sortBundleItems([
      { source: 'pip', packageId: 'requests', name: 'requests' },
      { source: 'uv', packageId: 'ruff', name: 'ruff' },
      { source: 'cargo', packageId: 'ripgrep', name: 'ripgrep' },
      { source: 'vcpkg', packageId: 'zlib:x64-windows', name: 'zlib (x64-windows)' },
      { source: 'dotnet', packageId: 'dotnet-ef', name: 'dotnet-ef' },
      { source: 'pwsh7', packageId: 'Terminal-Icons', name: 'Terminal-Icons' },
      { source: 'pwsh5', packageId: 'Pester', name: 'Pester' },
    ]);
    assert.equal(items.length, 7);

    const evaluation = evaluateBundleStatus({ items }, { packages: unified });
    assert.equal(evaluation.summary.outdatedCount, 2);
    assert.equal(evaluation.summary.upToDateCount, 5);

    const plan = planBundleExecution(evaluation.items, { silentWinget: true });
    assert.equal(plan.stats.silentCount, 7);
  });
});
