import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-providers-js-'));
const appDir = path.join(tempRoot, 'app');
const dataDir = path.join(appDir, 'data');
const userDataDir = path.join(tempRoot, 'userData');
const tempSubDir = path.join(tempRoot, 'temp');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(tempSubDir, { recursive: true });

const electronMockUrl = 'mock://electron-js-providers';
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

const {
  isValidNpmPackageName,
  normalizeRepositoryUrl,
  parseNpmListJson,
  parseNpmOutdatedJson,
  parseNpmSearchJson,
  parseNpmShowJson,
  parseBunGlobalPackageJson,
  parseBunPmLsOutput,
  mergeBunGlobalPackages,
  parsePnpmListJson,
} = await import('../src/shared/npm-parser.js');
const {
  computeNvmUpgrades,
  isValidNvmVersion,
  normalizeNodeVersion,
  parseNodeDistIndexJson,
  parseNvmListAvailableOutput,
  parseNvmListOutput,
} = await import('../src/shared/nvm-parser.js');
const {
  isValidComposerPackageName,
  parseComposerOutdatedJson,
  parseComposerShowJson,
  parsePackagistSearchJson,
  parsePackagistShowJson,
} = await import('../src/shared/composer-parser.js');
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

describe('npm-parser (npm, Bun, pnpm)', () => {
  it('validiert reguläre und Scoped-npm-Paketnamen sowie Repository-URLs', () => {
    assert.equal(isValidNpmPackageName('typescript'), true);
    assert.equal(isValidNpmPackageName('@biomejs/biome'), true);
    assert.equal(isValidNpmPackageName('eslint_d'), true);
    assert.equal(isValidNpmPackageName('bad pkg; rm -rf'), false);
    assert.equal(isValidNpmPackageName('../evil'), false);
    assert.equal(isValidNpmPackageName('-leading-dash'), false);

    assert.equal(
      normalizeRepositoryUrl('git+https://github.com/biomejs/biome.git'),
      'https://github.com/biomejs/biome'
    );
    assert.equal(normalizeRepositoryUrl({ url: 'git://github.com/vitejs/vite.git' }), 'https://github.com/vitejs/vite');
    assert.equal(normalizeRepositoryUrl('git@github.com:oven-sh/bun.git'), 'https://github.com/oven-sh/bun');
    assert.equal(normalizeRepositoryUrl('github:eslint/eslint'), 'https://github.com/eslint/eslint');
    assert.equal(normalizeRepositoryUrl('javascript:alert(1)'), '');
  });

  it('parst `npm list -g --depth=0 --json` und `npm outdated -g --json` inkl. BOM/ANSI', () => {
    const listRaw = `\uFEFF\u001b[32m{
      "name": "lib",
      "dependencies": {
        "typescript": { "version": "5.7.2" },
        "@biomejs/biome": { "version": "1.9.4" },
        "broken-dep": { "missing": true }
      }
    }\u001b[0m`;

    const installed = parseNpmListJson(listRaw);
    assert.equal(installed.length, 2);
    assert.deepEqual(installed[0], {
      packageManager: 'npm',
      packageId: 'typescript',
      id: 'typescript',
      name: 'typescript',
      version: '5.7.2',
      source: 'npm',
    });
    assert.equal(installed[1].packageId, '@biomejs/biome');
    assert.equal(installed[1].version, '1.9.4');

    const outdatedRaw = JSON.stringify({
      typescript: { current: '5.6.3', wanted: '5.6.3', latest: '5.7.2' },
      '@biomejs/biome': { current: '1.9.4', wanted: '1.9.4', latest: '1.9.4' },
      eslint: { current: '9.14.0', wanted: '9.15.0', latest: '9.16.0' },
    });

    const upgrades = parseNpmOutdatedJson(outdatedRaw);
    assert.equal(upgrades.length, 2);
    assert.deepEqual(upgrades[0], {
      packageManager: 'npm',
      packageId: 'typescript',
      id: 'typescript',
      name: 'typescript',
      installedVersion: '5.6.3',
      wantedVersion: '5.6.3',
      availableVersion: '5.7.2',
      source: 'npm',
    });
    assert.equal(upgrades[1].packageId, 'eslint');
    assert.equal(upgrades[1].availableVersion, '9.16.0');
    assert.deepEqual(parseNpmOutdatedJson('{}'), []);
  });

  it('parst Registry-Suche, CLI-Suche und `/latest` sowie Scoped-Packuments', () => {
    const registrySearchPayload = {
      objects: [
        {
          package: {
            name: 'prettier',
            version: '3.4.2',
            description: 'Prettier is an opinionated code formatter',
            keywords: ['formatter', 'javascript'],
            links: {
              npm: 'https://www.npmjs.com/package/prettier',
              homepage: 'https://prettier.io',
              repository: 'https://github.com/prettier/prettier',
            },
            publisher: { username: 'prettier-bot' },
          },
        },
      ],
    };
    const searchRes = parseNpmSearchJson(registrySearchPayload, 10);
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].packageId, 'prettier');
    assert.equal(searchRes[0].homepage, 'https://prettier.io');
    assert.equal(searchRes[0].repositoryUrl, 'https://github.com/prettier/prettier');
    assert.deepEqual(searchRes[0].tags, ['formatter', 'javascript']);

    const cliSearch = parseNpmSearchJson(
      JSON.stringify([{ name: 'tsx', version: '4.19.2', description: 'TypeScript Execute' }]),
      5
    );
    assert.equal(cliSearch.length, 1);
    assert.equal(cliSearch[0].name, 'tsx');

    const latestShow = parseNpmShowJson({
      name: 'vite',
      version: '6.0.3',
      description: 'Next generation frontend tooling.',
      homepage: 'https://vite.dev',
      license: 'MIT',
      author: { name: 'Evan You' },
      keywords: ['build', 'bundler'],
      repository: { type: 'git', url: 'git+https://github.com/vitejs/vite.git' },
    });
    assert.equal(latestShow.packageId, 'vite');
    assert.equal(latestShow.version, '6.0.3');
    assert.equal(latestShow.author, 'Evan You');
    assert.equal(latestShow.license, 'MIT');
    assert.equal(latestShow.repositoryUrl, 'https://github.com/vitejs/vite');

    const scopedPackument = parseNpmShowJson({
      name: '@biomejs/biome',
      'dist-tags': { latest: '1.9.4' },
      versions: {
        '1.9.4': {
          name: '@biomejs/biome',
          version: '1.9.4',
          description: 'Toolchain of the web',
          homepage: 'https://biomejs.dev',
          license: 'MIT OR Apache-2.0',
          repository: { url: 'git+https://github.com/biomejs/biome.git' },
          keywords: ['linter', 'formatter'],
        },
      },
    });
    assert.equal(scopedPackument.packageId, '@biomejs/biome');
    assert.equal(scopedPackument.version, '1.9.4');
    assert.equal(scopedPackument.repositoryUrl, 'https://github.com/biomejs/biome');
  });

  it('parst Bun Global `package.json`, `bun pm ls -g`, Merge und `pnpm list -g --depth=0 --json`', () => {
    const bunPkgJson = JSON.stringify({
      dependencies: {
        typescript: '^5.7.0',
        '@biomejs/biome': '^1.9.0',
        tsx: 'latest',
      },
    });
    const pkgJsonParsed = parseBunGlobalPackageJson(bunPkgJson);
    assert.equal(pkgJsonParsed.length, 3);
    assert.equal(pkgJsonParsed[0].version, '5.7.0');
    assert.equal(pkgJsonParsed[2].version, '');

    const bunPmOut = [
      'C:\\Users\\test\\.bun\\install\\global node_modules (3)',
      '├── @biomejs/biome@1.9.4',
      '├── tsx@4.19.2',
      '└── typescript@5.7.2',
    ].join('\n');
    const pmLsParsed = parseBunPmLsOutput(bunPmOut);
    assert.equal(pmLsParsed.length, 3);
    assert.equal(pmLsParsed[0].packageId, '@biomejs/biome');
    assert.equal(pmLsParsed[0].version, '1.9.4');

    const mergedBun = mergeBunGlobalPackages(pkgJsonParsed, pmLsParsed);
    assert.equal(mergedBun.length, 3);
    assert.equal(mergedBun.find((p) => p.packageId === 'typescript')?.version, '5.7.2');
    assert.equal(mergedBun.find((p) => p.packageId === 'tsx')?.version, '4.19.2');

    const pnpmRaw = JSON.stringify([
      {
        name: 'global',
        dependencies: {
          turbo: { version: '2.3.3' },
          '@antfu/ni': { version: '23.1.0' },
        },
      },
    ]);
    const pnpmParsed = parsePnpmListJson(pnpmRaw);
    assert.equal(pnpmParsed.length, 2);
    assert.equal(pnpmParsed[0].packageManager, 'pnpm');
    assert.equal(pnpmParsed[0].version, '2.3.3');
    assert.equal(pnpmParsed[1].packageId, '@antfu/ni');
  });
});

describe('nvm-parser', () => {
  it('parst `nvm list` und erkennt die aktive `*`-Version', () => {
    assert.equal(normalizeNodeVersion('v22.11.0'), '22.11.0');
    assert.equal(isValidNvmVersion('22.11.0'), true);
    assert.equal(isValidNvmVersion('lts', { allowAliases: true }), true);
    assert.equal(isValidNvmVersion('22.11.0 && calc'), false);

    const nvmListOut = [
      '',
      '  * 22.11.0 (Currently using 64-bit executable)',
      '    20.18.1',
      '    18.20.4 (32-bit)',
    ].join('\n');

    const installed = parseNvmListOutput(nvmListOut);
    assert.equal(installed.length, 3);
    assert.deepEqual(installed[0], {
      packageManager: 'nvm',
      packageId: '22.11.0',
      id: '22.11.0',
      name: 'Node.js v22.11.0',
      version: '22.11.0',
      isActive: true,
      arch: '64-bit',
      source: 'nvm',
    });
    assert.equal(installed[1].isActive, false);
    assert.equal(installed[2].arch, '32-bit');
    assert.deepEqual(parseNvmListOutput('No installations recognized.'), []);
  });

  it('parst `nvm list available` und filtert nach LTS, Current oder Versionsnummer', () => {
    const availTable = [
      '|   CURRENT    |     LTS      |  OLD STABLE  | OLD UNSTABLE |',
      '|--------------|--------------|--------------|--------------|',
      '|    23.3.0    |   22.11.0    |   0.12.18    |   0.11.16    |',
      '|    23.2.0    |   20.18.1    |   0.10.48    |   0.11.15    |',
      '|    23.1.0    |   18.20.5    |   0.10.47    |   0.11.14    |',
    ].join('\n');

    const allRes = parseNvmListAvailableOutput(availTable, { limit: 20 });
    assert.equal(allRes.length, 12);
    assert.equal(allRes[0].channel, 'LTS');
    assert.equal(allRes[0].packageId, '22.11.0');
    assert.equal(allRes[0].name, 'Node.js v22.11.0 (LTS)');

    const ltsOnly = parseNvmListAvailableOutput(availTable, { query: 'lts' });
    assert.equal(ltsOnly.length, 3);
    assert.ok(ltsOnly.every((r) => r.channel === 'LTS'));

    const v20Only = parseNvmListAvailableOutput(availTable, { query: '20.18' });
    assert.equal(v20Only.length, 1);
    assert.equal(v20Only[0].packageId, '20.18.1');
  });

  it('parst nodejs.org dist/index.json und erkennt NVM-Upgrades je Major-Reihe (z. B. 26.12.1 -> 26.13.1) sowie optional LTS/Current', () => {
    const distJson = JSON.stringify([
      { version: 'v27.1.0', lts: false, date: '2026-11-20' },
      { version: 'v26.13.1', lts: 'Zeta', date: '2026-11-18' },
      { version: 'v26.12.1', lts: 'Zeta', date: '2026-10-01' },
      { version: 'v22.14.0', lts: 'Jod', date: '2026-09-10' },
      { version: 'v22.11.0', lts: 'Jod', date: '2025-10-29' },
      { version: 'v20.19.0', lts: 'Iron', date: '2026-08-01' },
      { version: 'v18.20.8', lts: 'Hydrogen', date: '2025-04-01' },
    ]);

    const distEntries = parseNodeDistIndexJson(distJson);
    assert.equal(distEntries.length, 7);
    assert.equal(distEntries[0].version, '27.1.0');
    assert.equal(distEntries[0].channel, 'Current');
    assert.equal(distEntries[1].version, '26.13.1');
    assert.equal(distEntries[1].channel, 'LTS');

    // Fall 1: 26.12.1 -> 26.13.1 und 20.18.1 -> 20.19.0 (22.14.0 bereits installiert -> kein Update fuer 22.11.0 auf 22.14.0)
    const installed = [
      { packageId: '26.12.1', name: 'Node.js v26.12.1', version: '26.12.1', isActive: true, arch: '64-bit' },
      { packageId: '22.14.0', name: 'Node.js v22.14.0', version: '22.14.0', isActive: false, arch: '64-bit' },
      { packageId: '20.18.1', name: 'Node.js v20.18.1', version: '20.18.1', isActive: false, arch: '64-bit' },
    ];
    const upgrades = computeNvmUpgrades(installed, distEntries);
    assert.equal(upgrades.length, 2);
    assert.equal(upgrades[0].packageId, '26.12.1');
    assert.equal(upgrades[0].installedVersion, '26.12.1');
    assert.equal(upgrades[0].availableVersion, '26.13.1');
    assert.equal(upgrades[0].isActive, true);
    assert.equal(upgrades[1].packageId, '20.18.1');
    assert.equal(upgrades[1].availableVersion, '20.19.0');

    // Fall 2: Bereits neuestes 18.x installiert -> optionales LTS-Upgrade auf 26.13.1, kein Fehlalarm wenn 26.13.1 schon drauf ist
    const ltsFallback = computeNvmUpgrades([{ version: '18.20.8' }], distEntries, { includeLatestLts: true });
    assert.equal(ltsFallback.length, 1);
    assert.equal(ltsFallback[0].availableVersion, '26.13.1');

    const alreadyHasLatestLts = computeNvmUpgrades([{ version: '18.20.8' }, { version: '26.13.1' }], distEntries, {
      includeLatestLts: true,
    });
    assert.equal(alreadyHasLatestLts.length, 0);

    // Fall 3: includeLatestCurrent schlaegt 27.1.0 vor, wenn 26.13.1 bereits aktuell ist
    const currentOpt = computeNvmUpgrades([{ version: '26.13.1' }], distEntries, {
      includeLatestLts: true,
      includeLatestCurrent: true,
    });
    assert.equal(currentOpt.length, 1);
    assert.equal(currentOpt[0].availableVersion, '27.1.0');
  });
});

describe('composer-parser', () => {
  it('parst `composer global show/outdated --format=json` inkl. Windows-Vorlaufzeile', () => {
    assert.equal(isValidComposerPackageName('laravel/installer'), true);
    assert.equal(isValidComposerPackageName('phpstan/phpstan'), true);
    assert.equal(isValidComposerPackageName('invalid-pkg'), false);

    const showRaw = `Changed current directory to C:\\Users\\test\\AppData\\Roaming\\Composer
{
  "installed": [
    { "name": "laravel/installer", "version": "v5.10.1", "description": "Laravel application installer." },
    { "name": "phpunit/phpunit", "version": "11.4.3", "description": "The PHP Unit Testing framework." }
  ]
}`;

    const installed = parseComposerShowJson(showRaw);
    assert.equal(installed.length, 2);
    assert.equal(installed[0].packageManager, 'composer');
    assert.equal(installed[0].packageId, 'laravel/installer');
    assert.equal(installed[0].version, '5.10.1');

    const outdatedRaw = `Changed current directory to C:\\Users\\test\\AppData\\Roaming\\Composer
{
  "installed": [
    { "name": "laravel/installer", "version": "5.10.1", "latest": "5.11.0", "latest-status": "semver-safe-update", "description": "Laravel installer" },
    { "name": "phpunit/phpunit", "version": "11.4.3", "latest": "11.4.3", "latest-status": "up-to-date" }
  ]
}`;
    const upgrades = parseComposerOutdatedJson(outdatedRaw);
    assert.equal(upgrades.length, 1);
    assert.equal(upgrades[0].packageId, 'laravel/installer');
    assert.equal(upgrades[0].installedVersion, '5.10.1');
    assert.equal(upgrades[0].availableVersion, '5.11.0');
  });

  it('parst Packagist Search & Show JSON', () => {
    const searchRes = parsePackagistSearchJson({
      results: [
        {
          name: 'laravel/installer',
          description: 'Laravel application installer.',
          url: 'https://packagist.org/packages/laravel/installer',
          repository: 'https://github.com/laravel/installer',
        },
      ],
    });
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].packageId, 'laravel/installer');
    assert.equal(searchRes[0].repositoryUrl, 'https://github.com/laravel/installer');

    const showRes = parsePackagistShowJson({
      package: {
        name: 'laravel/installer',
        description: 'Laravel application installer.',
        repository: 'https://github.com/laravel/installer',
        versions: {
          'dev-master': { version: 'dev-master' },
          'v5.10.0': { version: 'v5.10.0', license: ['MIT'] },
          'v5.11.0': {
            version: 'v5.11.0',
            description: 'Laravel application installer.',
            license: ['MIT'],
            authors: [{ name: 'Taylor Otwell' }],
            keywords: ['laravel', 'cli'],
            homepage: 'https://laravel.com',
          },
        },
      },
    });
    assert.equal(showRes.version, '5.11.0');
    assert.equal(showRes.author, 'Taylor Otwell');
    assert.equal(showRes.license, 'MIT');
    assert.equal(showRes.homepage, 'https://laravel.com');
    assert.deepEqual(showRes.tags, ['laravel', 'cli']);
  });
});

describe('registry defaults & cross-provider integration for JS/Runtime/PHP', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ enabledProviders: ['winget', 'archive'] }, null, 2),
      'utf-8'
    );
  });

  it('registriert npm, bun, nvm, pnpm und composer standardmäßig deaktiviert mit erwarteten Capabilities', () => {
    for (const id of ['npm', 'bun', 'nvm', 'pnpm', 'composer']) {
      const prov = getProvider(id);
      assert.ok(prov, `Provider ${id} muss registriert sein`);
      assert.equal(isProviderEnabled(id), false);
      assert.equal(prov.canInstallManager, true);
      assert.equal(prov.canUninstallManager, true);
      assert.equal(prov.capabilities.supportsArchiveDownload, false);
    }

    const npm = getProvider('npm');
    assert.equal(npm.category, 'runtime');
    assert.equal(npm.capabilities.listUpgrades, true);

    const nvm = getProvider('nvm');
    assert.equal(nvm.category, 'runtime');
    assert.equal(nvm.capabilities.listUpgrades, true);
    assert.equal(typeof nvm.useVersion, 'function');

    const composer = getProvider('composer');
    assert.equal(composer.category, 'developer');
    assert.equal(composer.capabilities.listUpgrades, true);

    const info = listProvidersInfo();
    assert.ok(info.providers.some((p) => p.id === 'pnpm' && p.capabilities.search));
  });

  it('führt npm, bun, nvm, pnpm und composer sauber durch Merger, Unified-Model und Bündel ohne Registry-Kollision', () => {
    const merged = mergeInstalledSoftware({
      providerInstalled: [
        { packageManager: 'npm', packageId: 'typescript', name: 'typescript', version: '5.6.3', source: 'npm' },
        { packageManager: 'bun', packageId: 'tsx', name: 'tsx', version: '4.19.2', source: 'bun' },
        {
          packageManager: 'nvm',
          packageId: '22.11.0',
          name: 'Node.js v22.11.0',
          version: '22.11.0',
          isActive: true,
          arch: '64-bit',
          source: 'nvm',
        },
        { packageManager: 'pnpm', packageId: 'turbo', name: 'turbo', version: '2.3.3', source: 'pnpm' },
        {
          packageManager: 'composer',
          packageId: 'laravel/installer',
          name: 'laravel/installer',
          version: '5.10.1',
          source: 'composer',
        },
      ],
      providerUpgrades: [
        {
          packageManager: 'npm',
          packageId: 'typescript',
          name: 'typescript',
          installedVersion: '5.6.3',
          availableVersion: '5.7.2',
          source: 'npm',
        },
        {
          packageManager: 'composer',
          packageId: 'laravel/installer',
          name: 'laravel/installer',
          installedVersion: '5.10.1',
          availableVersion: '5.11.0',
          source: 'composer',
        },
      ],
      registryEntries: [
        {
          displayName: 'TypeScript SDK for Visual Studio',
          displayVersion: '5.0.0',
          publisher: 'Microsoft',
          uninstallString: 'C:\\setup.exe',
        },
      ],
    });

    // npm-Paket 'typescript' darf den Windows-Registry-Eintrag nicht vereinnahmen
    assert.equal(
      merged.some((p) => p.source === 'registry' && /TypeScript SDK/.test(p.name)),
      true
    );

    const npmApp = merged.find((p) => p.id === 'npm:typescript');
    assert.ok(npmApp);
    assert.equal(npmApp.hasUpdate, true);
    assert.equal(npmApp.availableVersion, '5.7.2');

    const nvmApp = merged.find((p) => p.id === 'nvm:22.11.0');
    assert.ok(nvmApp);
    assert.equal(nvmApp.isActive, true);

    const unified = buildUnifiedPackages({ catalogItems: [], installedApps: merged });
    const npmUnified = unified.find((p) => p.packageManager === 'npm');
    assert.equal(getPackageStatus(npmUnified).status, 'webupdate');
    assert.deepEqual(getProviderBadgeInfo('composer'), {
      id: 'composer',
      label: 'Composer',
      badgeClass: 'is-composer',
    });

    const items = sortBundleItems([
      { source: 'nvm', packageId: '22.11.0', name: 'Node.js v22.11.0' },
      { source: 'npm', packageId: 'typescript', name: 'typescript' },
      { source: 'composer', packageId: 'laravel/installer', name: 'laravel/installer' },
    ]);
    assert.equal(items.length, 3);

    const evaluation = evaluateBundleStatus({ items }, { packages: unified });
    assert.equal(evaluation.summary.outdatedCount, 2);
    assert.equal(evaluation.summary.upToDateCount, 1);

    const plan = planBundleExecution(evaluation.items, { silentWinget: true });
    assert.equal(plan.stats.silentCount, 3);
  });
});
