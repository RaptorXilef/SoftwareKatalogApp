import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createDevActions } from '../src/main/dev-projects/dev-actions.js';
import { createDevProjectsService } from '../src/main/dev-projects/dev-projects-service.js';
import { createDevScanner } from '../src/main/dev-projects/dev-scanner.js';
import { evaluateAdminAccess, isProtectedAdminChannel } from '../src/shared/auth-logic.js';
import {
  buildDevInstallCommand,
  buildDevSyncCommand,
  buildDevToggleScopeSteps,
  buildDevUninstallCommand,
  buildDevUpdateCommand,
  detectProjectManagersFromFiles,
  isValidDevPackageName,
  parseBunLock,
  parseCargoLock,
  parseCargoTomlDirect,
  parseComposerJsonDirect,
  parseComposerLock,
  parseCsprojDirect,
  parseDotnetPackagesLockJson,
  parsePackageJsonDirect,
  parsePackageLockJson,
  parsePnpmLockYaml,
  parseProjectBunOutdatedOutput,
  parseProjectComposerOutdatedJson,
  parseProjectDotnetOutdatedJson,
  parseProjectNpmOutdatedJson,
  parseProjectPipOutdatedJson,
  parseProjectYarnOutdatedOutput,
  parsePyprojectTomlDirect,
  parseRequirementsTxt,
  parseUvLock,
  parseVcpkgProjectManifest,
  parseYarnLock,
} from '../src/shared/dev-projects-logic.js';

const tempDirs = [];

function makeTempDir(prefix = 'sk-dev-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFakeJobFactory() {
  const jobs = [];
  const createJobFn = ({ type, title, dedupeKey, cancelable }) => {
    const controller = new AbortController();
    const record = {
      type,
      title,
      dedupeKey,
      cancelable,
      updates: [],
      finished: null,
      controller,
    };
    jobs.push(record);
    return {
      id: `job-${jobs.length}`,
      signal: controller.signal,
      update(pct, detail) {
        record.updates.push({ pct, detail });
      },
      finish(status, detail) {
        record.finished = { status, detail };
      },
    };
  };
  return { jobs, createJobFn };
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignorieren
    }
  }
});

describe('dev-projects-service: Atomare Speicherung, CRUD & Pfad-Verfuegbarkeit', () => {
  it('speichert Projekte atomar in dev-projects.json und erkennt fehlende/abgesteckte Pfade', () => {
    const root = makeTempDir();
    const dataDir = path.join(root, 'data');
    const projectDir = path.join(root, 'my-app');
    const missingDir = path.join(root, 'unplugged-drive', 'repo');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    let clock = 1000;
    let idCounter = 0;
    const service = createDevProjectsService({
      getDataFolderFn: () => dataDir,
      nowFn: () => {
        clock += 100;
        return clock;
      },
      randomUUIDFn: () => `proj-${++idCounter}`,
    });

    const add1 = service.addDevProject({
      name: 'My App',
      path: `${projectDir}${path.sep}`,
      icon: 'code',
      notes: 'Hauptprojekt',
    });
    assert.equal(add1.success, true);
    assert.equal(add1.project.id, 'proj-1');
    assert.equal(add1.project.path, path.normalize(projectDir));
    assert.equal(add1.project.isAvailable, true);
    assert.equal(add1.project.lastScannedAt, null);

    // Duplikat-Pfad ablehnen
    const dupRes = service.addDevProject({ name: 'Dup', path: projectDir });
    assert.equal(dupRes.success, false);

    // Zweites Projekt mit fehlendem Pfad anlegen -> isAvailable: false statt Exception
    const add2 = service.addDevProject({ path: missingDir });
    assert.equal(add2.success, true);
    assert.equal(add2.project.name, 'repo');
    assert.equal(add2.project.isAvailable, false);

    const listed = service.listDevProjects();
    assert.equal(listed.success, true);
    assert.equal(listed.projects.length, 2);
    assert.equal(listed.projects[0].isAvailable, true);
    assert.equal(listed.projects[1].isAvailable, false);

    // Update & markScanned
    const upd = service.updateDevProject('proj-1', { notes: 'Aktualisiert', icon: 'rocket' });
    assert.equal(upd.success, true);
    assert.equal(upd.project.notes, 'Aktualisiert');
    assert.equal(upd.project.icon, 'rocket');

    const scanned = service.markDevProjectScanned('proj-1', 99999);
    assert.equal(scanned.success, true);
    assert.equal(scanned.project.lastScannedAt, 99999);

    // Ordner loeschen -> listDevProjects markiert Projekt sauber als nicht verfuegbar
    fs.rmSync(projectDir, { recursive: true, force: true });
    const afterDelete = service.listDevProjects();
    assert.equal(afterDelete.projects.find((p) => p.id === 'proj-1')?.isAvailable, false);

    // Entfernen
    const removed = service.removeDevProject('proj-2');
    assert.equal(removed.success, true);
    assert.equal(removed.projects.length, 1);

    const diskRaw = JSON.parse(fs.readFileSync(path.join(dataDir, 'dev-projects.json'), 'utf-8'));
    assert.equal(diskRaw.length, 1);
    assert.equal(diskRaw[0].id, 'proj-1');
  });

  it('lehnt leere Pfade und Pfade mit Steuerzeichen ab', () => {
    const root = makeTempDir();
    const service = createDevProjectsService({ getDataFolderFn: () => root });
    assert.equal(service.addDevProject({ path: '   ' }).success, false);
    assert.equal(service.addDevProject({ path: 'C:\\repo\nbad' }).success, false);
  });
});

describe('dev-projects-logic: Oekosystem- & Lockfile-Erkennung', () => {
  it('erkennt mehrere Paketmanager gleichzeitig und beachtet JS-Lockfile-Prioritaet', () => {
    const combo = detectProjectManagersFromFiles([
      'package.json',
      'package-lock.json',
      'composer.json',
      'composer.lock',
      'Cargo.toml',
      'Cargo.lock',
      'MyService.csproj',
      'vcpkg.json',
    ]);
    assert.deepEqual(combo.managers, ['npm', 'composer', 'cargo', 'dotnet', 'vcpkg']);

    assert.deepEqual(detectProjectManagersFromFiles(['package.json', 'pnpm-lock.yaml', 'package-lock.json']).managers, [
      'pnpm',
    ]);
    assert.deepEqual(detectProjectManagersFromFiles(['package.json', 'bun.lock']).managers, ['bun']);
    assert.deepEqual(detectProjectManagersFromFiles(['package.json', 'bun.lockb']).managers, ['bun']);
    assert.deepEqual(detectProjectManagersFromFiles(['package.json', 'yarn.lock']).managers, ['yarn']);
    assert.deepEqual(detectProjectManagersFromFiles(['package.json']).managers, ['npm']);
    assert.deepEqual(detectProjectManagersFromFiles(['pyproject.toml', 'uv.lock']).managers, ['uv']);
    assert.deepEqual(detectProjectManagersFromFiles(['requirements.txt']).managers, ['pip']);
    assert.deepEqual(detectProjectManagersFromFiles(['pyproject.toml'], { hasUvToolConfig: true }).managers, ['uv']);
  });
});

describe('dev-projects-logic: Manifest- & Lockfile-Parser (Direct vs Transitive)', () => {
  it('parst package.json + package-lock.json v3 inkl. Scoped-Packages, Dev-Scope & requiredBy', () => {
    const pkgJson = JSON.stringify({
      name: 'demo-app',
      dependencies: { express: '^4.18.0' },
      devDependencies: { '@types/node': '^22.0.0' },
      optionalDependencies: { fsevents: '^2.3.3' },
    });
    const lockJson = JSON.stringify({
      name: 'demo-app',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'demo-app',
          dependencies: { express: '^4.18.0' },
          devDependencies: { '@types/node': '^22.0.0' },
          optionalDependencies: { fsevents: '^2.3.3' },
        },
        'node_modules/express': {
          version: '4.19.2',
          license: 'MIT',
          dependencies: { debug: '4.3.4' },
        },
        'node_modules/debug': {
          version: '4.3.4',
          license: 'MIT',
          dependencies: { ms: '2.1.2' },
        },
        'node_modules/ms': {
          version: '2.1.2',
          license: 'MIT',
        },
        'node_modules/@types/node': {
          version: '22.5.4',
          dev: true,
          license: 'MIT',
        },
        'node_modules/fsevents': {
          version: '2.3.3',
          optional: true,
        },
      },
    });

    const direct = parsePackageJsonDirect(pkgJson, 'npm');
    assert.equal(direct.length, 3);
    assert.equal(direct.find((p) => p.name === 'express')?.scope, 'prod');
    assert.equal(direct.find((p) => p.name === '@types/node')?.scope, 'dev');
    assert.equal(direct.find((p) => p.name === 'fsevents')?.scope, 'optional');

    const lock = parsePackageLockJson(lockJson, direct, 'npm');
    assert.equal(lock.dependencies.length, 5);
    const express = lock.dependencies.find((d) => d.name === 'express');
    const debug = lock.dependencies.find((d) => d.name === 'debug');
    const ms = lock.dependencies.find((d) => d.name === 'ms');
    const typesNode = lock.dependencies.find((d) => d.name === '@types/node');

    assert.equal(express?.direct, true);
    assert.equal(express?.version, '4.19.2');
    assert.deepEqual(express?.requiredBy, []);

    assert.equal(debug?.direct, false);
    assert.deepEqual(debug?.requiredBy, ['express']);

    assert.equal(ms?.direct, false);
    assert.deepEqual(ms?.requiredBy, ['debug']);

    assert.equal(typesNode?.direct, true);
    assert.equal(typesNode?.scope, 'dev');
  });

  it('parst composer.json + composer.lock und filtert Plattform-Constraints', () => {
    const composerJson = JSON.stringify({
      require: {
        php: '^8.2',
        'ext-json': '*',
        'monolog/monolog': '^3.5',
      },
      'require-dev': {
        'phpunit/phpunit': '^11.0',
      },
    });
    const composerLock = JSON.stringify({
      packages: [
        {
          name: 'monolog/monolog',
          version: 'v3.7.0',
          description: 'Logs your app',
          license: ['MIT'],
          homepage: 'https://seldaek.github.io/monolog/',
          require: {
            php: '>=8.1',
            'psr/log': '^3.0',
          },
        },
        {
          name: 'psr/log',
          version: '3.0.2',
          description: 'PSR-3 logger interface',
          license: ['MIT'],
        },
      ],
      'packages-dev': [
        {
          name: 'phpunit/phpunit',
          version: '11.3.1',
          description: 'The PHP Unit Testing framework.',
          license: ['BSD-3-Clause'],
        },
      ],
    });

    const direct = parseComposerJsonDirect(composerJson);
    assert.equal(direct.length, 2);
    assert.equal(
      direct.some((d) => d.name === 'php' || d.name === 'ext-json'),
      false
    );

    const lock = parseComposerLock(composerLock, direct);
    assert.equal(lock.dependencies.length, 3);
    const psrLog = lock.dependencies.find((d) => d.name === 'psr/log');
    const phpunit = lock.dependencies.find((d) => d.name === 'phpunit/phpunit');
    assert.equal(psrLog?.direct, false);
    assert.deepEqual(psrLog?.requiredBy, ['monolog/monolog']);
    assert.equal(phpunit?.direct, true);
    assert.equal(phpunit?.scope, 'dev');
    assert.equal(lock.versionByName['monolog/monolog'], '3.7.0');
  });

  it('parst pnpm-lock.yaml, yarn.lock, bun.lock, Cargo, Python/uv, .csproj/packages.lock.json und vcpkg.json', () => {
    const pnpmLock = `
lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      zod:
        specifier: ^3.23.0
        version: 3.23.8
    devDependencies:
      vitest:
        specifier: ^2.0.0
        version: 2.1.1
snapshots:
  zod@3.23.8: {}
  vitest@2.1.1:
    dependencies:
      tinybench: 2.9.0
  tinybench@2.9.0: {}
`;
    const pnpmParsed = parsePnpmLockYaml(pnpmLock, [
      { name: 'zod', scope: 'prod' },
      { name: 'vitest', scope: 'dev' },
    ]);
    assert.equal(pnpmParsed.dependencies.find((d) => d.name === 'zod')?.direct, true);
    assert.equal(pnpmParsed.dependencies.find((d) => d.name === 'tinybench')?.direct, false);
    assert.deepEqual(pnpmParsed.dependencies.find((d) => d.name === 'tinybench')?.requiredBy, ['vitest']);

    const yarnLock = `
chalk@^5.3.0:
  version "5.3.0"
  dependencies:
    ansi-styles "^6.0.0"

ansi-styles@^6.0.0:
  version "6.2.1"
`;
    const yarnParsed = parseYarnLock(yarnLock, [{ name: 'chalk', scope: 'prod' }]);
    assert.equal(yarnParsed.dependencies.find((d) => d.name === 'ansi-styles')?.version, '6.2.1');
    assert.deepEqual(yarnParsed.dependencies.find((d) => d.name === 'ansi-styles')?.requiredBy, ['chalk']);

    const bunLock = `{
      // Bun Lockfile
      "lockfileVersion": 0,
      "packages": {
        "hono": ["hono@4.6.3", "", {}, "sha512-abc"],
      },
    }`;
    const bunParsed = parseBunLock(bunLock, [{ name: 'hono', scope: 'prod' }]);
    assert.equal(bunParsed.dependencies[0]?.version, '4.6.3');

    const cargoToml = `
[package]
name = "my-cli"
version = "0.1.0"

[dependencies]
serde = { version = "1.0", features = ["derive"] }

[dev-dependencies]
tokio = "1.40"
`;
    const cargoDirect = parseCargoTomlDirect(cargoToml);
    assert.equal(cargoDirect.rootPackageName, 'my-cli');
    assert.equal(cargoDirect.packages.length, 2);

    const cargoLock = `
[[package]]
name = "my-cli"
version = "0.1.0"
dependencies = [
  "serde",
]

[[package]]
name = "serde"
version = "1.0.210"
source = "registry+https://github.com/rust-lang/crates.io-index"
dependencies = [
  "serde_derive",
]

[[package]]
name = "serde_derive"
version = "1.0.210"
source = "registry+https://github.com/rust-lang/crates.io-index"
`;
    const cargoParsed = parseCargoLock(cargoLock, cargoDirect.packages, cargoDirect.rootPackageName);
    assert.equal(
      cargoParsed.dependencies.some((d) => d.name === 'my-cli'),
      false
    );
    assert.deepEqual(cargoParsed.dependencies.find((d) => d.name === 'serde_derive')?.requiredBy, ['serde']);

    const pyproject = `
[project]
name = "demo"
dependencies = [
  "fastapi>=0.115.0",
]

[dependency-groups]
dev = ["pytest>=8.0"]

[tool.uv]
managed = true
`;
    const pyDirect = parsePyprojectTomlDirect(pyproject, 'uv');
    assert.equal(pyDirect.hasUvToolConfig, true);
    assert.equal(pyDirect.packages.length, 2);
    assert.equal(parseRequirementsTxt('# comment\nrequests>=2.32\n-r base.txt\n', 'pip').length, 1);

    const uvLock = `
[[package]]
name = "fastapi"
version = "0.115.4"
dependencies = [
  { name = "starlette" },
]

[[package]]
name = "starlette"
version = "0.41.2"
`;
    const uvParsed = parseUvLock(uvLock, pyDirect.packages);
    assert.equal(uvParsed.dependencies.find((d) => d.name === 'starlette')?.direct, false);
    assert.deepEqual(uvParsed.dependencies.find((d) => d.name === 'starlette')?.requiredBy, ['fastapi']);

    const csproj = `
<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="xunit" Version="2.9.0" PrivateAssets="all" />
  </ItemGroup>
</Project>`;
    const csDirect = parseCsprojDirect(csproj);
    assert.equal(csDirect.length, 2);
    assert.equal(csDirect.find((p) => p.name === 'xunit')?.scope, 'dev');

    const nugetLock = JSON.stringify({
      version: 1,
      dependencies: {
        'net8.0': {
          'Newtonsoft.Json': { type: 'Direct', resolved: '13.0.3' },
        },
      },
    });
    const nugetParsed = parseDotnetPackagesLockJson(nugetLock, csDirect);
    assert.equal(nugetParsed.dependencies[0]?.version, '13.0.3');

    const vcpkgManifest = parseVcpkgProjectManifest(
      JSON.stringify({
        dependencies: ['fmt', { name: 'zlib', 'version>=': '1.3.1' }],
        overrides: [{ name: 'fmt', version: '11.0.2' }],
      })
    );
    assert.equal(vcpkgManifest.find((p) => p.name === 'fmt')?.installedVersion, '11.0.2');
  });
});

describe('dev-projects-logic: Outdated JSON Parser', () => {
  it('parst npm outdated --json und pnpm outdated --format json inkl. Major-Erkennung', () => {
    const npmOut = JSON.stringify({
      express: { current: '4.18.2', wanted: '4.21.1', latest: '5.0.1', dependent: 'app' },
      lodash: { current: '4.17.20', wanted: '4.17.21', latest: '4.17.21', dependent: 'app' },
    });
    const parsedNpm = parseProjectNpmOutdatedJson(npmOut, {
      manager: 'npm',
      directScopeMap: new Map([['express', 'prod']]),
    });
    assert.equal(parsedNpm.length, 2);
    assert.equal(parsedNpm[0].current, '4.18.2');
    assert.equal(parsedNpm[0].wanted, '4.21.1');
    assert.equal(parsedNpm[0].latest, '5.0.1');
    assert.equal(parsedNpm[0].isMajor, true);
    assert.equal(parsedNpm[0].hasWantedUpdate, true);
    assert.equal(parsedNpm[1].isMajor, false);

    const pnpmOut = JSON.stringify([
      {
        name: 'vitest',
        current: '1.6.0',
        wanted: '1.6.1',
        latest: '2.1.4',
        dependencyType: 'devDependencies',
      },
    ]);
    const parsedPnpm = parseProjectNpmOutdatedJson(pnpmOut, { manager: 'pnpm' });
    assert.equal(parsedPnpm[0].scope, 'dev');
    assert.equal(parsedPnpm[0].isMajor, true);
  });

  it('parst composer outdated --format=json inkl. Windows-Vorlauf und semver-safe vs update-possible', () => {
    const raw = `Changed current directory to C:\\Projects\\web
{
  "installed": [
    {
      "name": "monolog/monolog",
      "version": "v2.9.0",
      "latest": "v3.7.0",
      "latest-status": "update-possible",
      "description": "Logger"
    },
    {
      "name": "symfony/console",
      "version": "v7.1.0",
      "latest": "7.1.5",
      "latest-status": "semver-safe-update",
      "description": "Console"
    },
    {
      "name": "psr/log",
      "version": "3.0.2",
      "latest": "3.0.2",
      "latest-status": "up-to-date"
    }
  ]
}`;
    const parsed = parseProjectComposerOutdatedJson(raw, {
      directScopeMap: new Map([['monolog/monolog', 'prod']]),
    });
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].current, '2.9.0');
    assert.equal(parsed[0].wanted, '2.9.0');
    assert.equal(parsed[0].latest, '3.7.0');
    assert.equal(parsed[0].isMajor, true);
    assert.equal(parsed[0].hasWantedUpdate, false);
    assert.equal(parsed[1].wanted, '7.1.5');
    assert.equal(parsed[1].isMajor, false);
    assert.equal(parsed[1].hasWantedUpdate, true);
  });

  it('parst dotnet, pip, bun und yarn outdated Ausgaben', () => {
    const dotnetJson = JSON.stringify({
      projects: [
        {
          frameworks: [
            {
              topLevelPackages: [
                {
                  id: 'Newtonsoft.Json',
                  requestedVersion: '13.0.1',
                  resolvedVersion: '13.0.1',
                  latestVersion: '13.0.3',
                },
              ],
            },
          ],
        },
      ],
    });
    const dotnetUpd = parseProjectDotnetOutdatedJson(dotnetJson);
    assert.equal(dotnetUpd.length, 1);
    assert.equal(dotnetUpd[0].wanted, '13.0.3');

    const pipJson = JSON.stringify([
      { name: 'fastapi', version: '0.110.0', latest_version: '0.115.4' },
      { name: 'unrelated-global', version: '1.0.0', latest_version: '2.0.0' },
    ]);
    const pipUpd = parseProjectPipOutdatedJson(pipJson, {
      manager: 'pip',
      allowedNamesSet: new Set(['fastapi']),
    });
    assert.equal(pipUpd.length, 1);
    assert.equal(pipUpd[0].name, 'fastapi');

    const bunTable = `
| Package | Current | Update | Latest |
|---------|---------|--------|--------|
| hono    | 4.5.0   | 4.6.3  | 4.6.3  |
`;
    const bunUpd = parseProjectBunOutdatedOutput(bunTable);
    assert.equal(bunUpd.length, 1);
    assert.equal(bunUpd[0].latest, '4.6.3');

    const yarnNdjson = JSON.stringify({
      type: 'table',
      data: { body: [['chalk', '4.1.2', '4.1.2', '5.3.0', 'dependencies']] },
    });
    const yarnUpd = parseProjectYarnOutdatedOutput(yarnNdjson);
    assert.equal(yarnUpd.length, 1);
    assert.equal(yarnUpd[0].isMajor, true);
  });
});

describe('dev-scanner: Kompletter Projekt-Scan mit Temp-Ordner & gemockter CLI', () => {
  it('liefert getrennte Listen installed, dependencies und updates fuer kombiniertes Node+PHP Projekt', async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, 'data');
    const projectDir = path.join(root, 'fullstack');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({
        name: 'fullstack',
        dependencies: { express: '^4.18.0' },
        devDependencies: { eslint: '^8.57.0' },
      })
    );
    fs.writeFileSync(
      path.join(projectDir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { express: '^4.18.0' }, devDependencies: { eslint: '^8.57.0' } },
          'node_modules/express': { version: '4.19.2', license: 'MIT', dependencies: { accepts: '1.3.8' } },
          'node_modules/accepts': { version: '1.3.8', license: 'MIT' },
          'node_modules/eslint': { version: '8.57.1', dev: true, license: 'MIT' },
        },
      })
    );
    fs.writeFileSync(
      path.join(projectDir, 'composer.json'),
      JSON.stringify({
        require: { php: '^8.3', 'monolog/monolog': '^3.0' },
      })
    );
    fs.writeFileSync(
      path.join(projectDir, 'composer.lock'),
      JSON.stringify({
        packages: [
          {
            name: 'monolog/monolog',
            version: '3.6.0',
            description: 'Logging library',
            license: ['MIT'],
            require: { 'psr/log': '^3.0' },
          },
          { name: 'psr/log', version: '3.0.1', description: 'PSR log', license: ['MIT'] },
        ],
      })
    );

    const svc = createDevProjectsService({ getDataFolderFn: () => dataDir });
    const added = svc.addDevProject({ name: 'Fullstack', path: projectDir });
    assert.equal(added.success, true);

    const cliCalls = [];
    const { jobs, createJobFn } = makeFakeJobFactory();
    const scanner = createDevScanner({
      getProjectFn: svc.getDevProject,
      markScannedFn: svc.markDevProjectScanned,
      createJobFn,
      runManagerCliFn: async (manager, args, opts) => {
        cliCalls.push({ manager, args, cwd: opts.projectPath });
        if (manager === 'npm') {
          return {
            code: 1,
            stdout: JSON.stringify({
              express: { current: '4.19.2', wanted: '4.21.1', latest: '5.0.0' },
            }),
            stderr: '',
          };
        }
        if (manager === 'composer') {
          return {
            code: 0,
            stdout: JSON.stringify({
              installed: [
                {
                  name: 'monolog/monolog',
                  version: '3.6.0',
                  latest: '3.7.0',
                  'latest-status': 'semver-safe-update',
                },
              ],
            }),
            stderr: '',
          };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    const scanRes = await scanner.scanDevProject(added.project.id);
    assert.equal(scanRes.success, true);
    assert.deepEqual(scanRes.managers, ['npm', 'composer']);

    // 1. installed (nur direkte Manifest-Pakete)
    assert.equal(scanRes.installed.length, 3);
    assert.equal(scanRes.installed.find((p) => p.name === 'express')?.installedVersion, '4.19.2');
    assert.equal(scanRes.installed.find((p) => p.name === 'monolog/monolog')?.description, 'Logging library');

    // 2. dependencies (direkte + transitive)
    assert.equal(scanRes.dependencies.length, 5);
    assert.equal(scanRes.dependencies.filter((d) => !d.direct).length, 2);
    assert.deepEqual(scanRes.dependencies.find((d) => d.name === 'accepts')?.requiredBy, ['express']);
    assert.deepEqual(scanRes.dependencies.find((d) => d.name === 'psr/log')?.requiredBy, ['monolog/monolog']);

    // 3. updates (inkl. npm Exit-Code 1)
    assert.equal(scanRes.updates.length, 2);
    assert.equal(scanRes.updates.find((u) => u.name === 'express')?.isMajor, true);
    assert.equal(scanRes.updates.find((u) => u.name === 'monolog/monolog')?.wanted, '3.7.0');

    // Pruefe cwd & Job-Status
    assert.equal(
      cliCalls.every((c) => c.cwd === path.normalize(projectDir)),
      true
    );
    assert.equal(jobs[0].finished?.status, 'done');
  });

  it('behandelt fehlende CLIs mit Graceful Fallback ohne Scan-Abbruch', async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, 'data');
    const projectDir = path.join(root, 'node-only');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), JSON.stringify({ dependencies: { zod: '^3.22.0' } }));

    const svc = createDevProjectsService({ getDataFolderFn: () => dataDir });
    const added = svc.addDevProject({ path: projectDir });

    const scanner = createDevScanner({
      getProjectFn: svc.getDevProject,
      markScannedFn: svc.markDevProjectScanned,
      runManagerCliFn: async () => ({
        code: -1,
        stdout: '',
        stderr: '',
        notFound: true,
        error: 'npm not found',
      }),
    });

    const scanRes = await scanner.scanDevProject(added.project.id);
    assert.equal(scanRes.success, true);
    assert.equal(scanRes.installed.length, 1);
    assert.equal(scanRes.updates.length, 0);
    assert.equal(scanRes.warnings.length, 1);
  });

  it('liefert sauberen unavailable-Status bei nicht erreichbarem Projektordner', async () => {
    const root = makeTempDir();
    const svc = createDevProjectsService({ getDataFolderFn: () => root });
    const added = svc.addDevProject({ path: path.join(root, 'gone') });

    const scanner = createDevScanner({
      getProjectFn: svc.getDevProject,
      markScannedFn: svc.markDevProjectScanned,
    });
    const res = await scanner.scanDevProject(added.project.id);
    assert.equal(res.success, false);
    assert.equal(res.unavailable, true);
  });
});

describe('dev-actions & Command-Builder: Projekt-lokale Paket-Operationen', () => {
  it('baut sichere projekt-lokale Kommandos und validiert Paketnamen', () => {
    assert.deepEqual(buildDevInstallCommand({ manager: 'npm', packageName: 'vitest', isDev: true }).args, [
      'install',
      '-D',
      'vitest',
    ]);
    assert.deepEqual(
      buildDevInstallCommand({ manager: 'composer', packageName: 'phpunit/phpunit', isDev: true }).args,
      ['require', '--dev', 'phpunit/phpunit']
    );
    assert.deepEqual(buildDevInstallCommand({ manager: 'bun', packageName: 'zod', isDev: true }).args, [
      'add',
      '-d',
      'zod',
    ]);
    assert.deepEqual(buildDevInstallCommand({ manager: 'pnpm', packageName: 'eslint', isDev: true }).args, [
      'add',
      '-D',
      'eslint',
    ]);
    assert.deepEqual(buildDevInstallCommand({ manager: 'cargo', packageName: 'serde', version: '1.0.210' }).args, [
      'add',
      'serde@1.0.210',
    ]);
    assert.deepEqual(buildDevInstallCommand({ manager: 'uv', packageName: 'pytest', isDev: true }).args, [
      'add',
      '--dev',
      'pytest',
    ]);
    assert.deepEqual(buildDevInstallCommand({ manager: 'dotnet', packageName: 'Serilog', version: '4.1.0' }).args, [
      'add',
      'package',
      'Serilog',
      '--version',
      '4.1.0',
    ]);

    // wanted vs major update
    assert.deepEqual(buildDevUpdateCommand({ manager: 'npm', packageName: 'express', allowMajor: false }).args, [
      'update',
      'express',
    ]);
    assert.deepEqual(
      buildDevUpdateCommand({
        manager: 'npm',
        packageName: 'vitest',
        targetVersion: '2.1.0',
        allowMajor: true,
        isDev: true,
      }).args,
      ['install', '-D', 'vitest@2.1.0']
    );
    assert.deepEqual(
      buildDevUninstallCommand({ manager: 'composer', packageName: 'phpunit/phpunit', isDev: true }).args,
      ['remove', '--dev', 'phpunit/phpunit']
    );
    assert.deepEqual(buildDevSyncCommand('composer').args, ['install']);

    const toggle = buildDevToggleScopeSteps({
      manager: 'composer',
      packageName: 'monolog/monolog',
      currentRange: '^3.0',
      targetScope: 'dev',
    });
    assert.equal(toggle.supported, true);
    if (toggle.supported) {
      assert.deepEqual(toggle.steps, [
        ['remove', 'monolog/monolog'],
        ['require', '--dev', 'monolog/monolog:^3.0'],
      ]);
    }

    assert.equal(isValidDevPackageName('npm', 'chalk && calc.exe'), false);
    assert.equal(isValidDevPackageName('composer', 'vendor/pkg;rm -rf'), false);
  });

  it('fuehrt devInstallPackage, devUpdatePackage (wanted vs major), devToggleScope & devSyncProject mit Re-Scan aus', async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, 'data');
    const projectDir = path.join(root, 'app');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({
        dependencies: { express: '^4.18.0' },
        devDependencies: { eslint: '^8.57.0' },
      })
    );

    const svc = createDevProjectsService({ getDataFolderFn: () => dataDir });
    const added = svc.addDevProject({ name: 'App', path: projectDir });

    const executed = [];
    let scanCount = 0;
    const { jobs, createJobFn } = makeFakeJobFactory();

    const actions = createDevActions({
      getProjectFn: svc.getDevProject,
      createJobFn,
      runManagerCliFn: async (manager, args, opts) => {
        executed.push({ manager, args, cwd: opts.projectPath });
        return { code: 0, stdout: 'ok', stderr: '' };
      },
      scanProjectFn: async (projectId) => {
        scanCount++;
        return { success: true, projectId, scanCount };
      },
      fetchJsonFn: async (url) => {
        assert.equal(url.includes('packageType=DotnetTool'), false);
        return { data: [{ id: 'Serilog', version: '4.1.0', description: 'Logging' }] };
      },
    });

    const instRes = await actions.devInstallPackage(added.project.id, {
      manager: 'npm',
      packageName: 'zod',
      version: '3.23.8',
      isDev: false,
    });
    assert.equal(instRes.success, true);
    assert.equal(scanCount, 1);
    assert.deepEqual(executed[0].args, ['install', 'zod@3.23.8']);

    // Major-Update auf ein dev-Paket muss -D automatisch aus package.json uebernehmen
    const majorUpd = await actions.devUpdatePackage(added.project.id, {
      manager: 'npm',
      packageName: 'eslint',
      targetVersion: '9.12.0',
      allowMajor: true,
    });
    assert.equal(majorUpd.success, true);
    assert.deepEqual(executed[1].args, ['install', '-D', 'eslint@9.12.0']);

    const toggleRes = await actions.devToggleScope(added.project.id, {
      manager: 'npm',
      packageName: 'express',
      targetScope: 'dev',
    });
    assert.equal(toggleRes.success, true);
    assert.deepEqual(executed[2].args, ['install', '--save-dev', 'express@^4.18.0']);

    const syncRes = await actions.devSyncProject(added.project.id, 'npm');
    assert.equal(syncRes.success, true);
    assert.deepEqual(executed[3].args, ['install']);
    assert.equal(jobs.length, 4);

    // NuGet-Bibliothekssuche ohne DotnetTool-Filter
    const nugetSearch = await actions.devSearchPackages('dotnet', 'Serilog');
    assert.equal(nugetSearch.success, true);
    assert.equal(nugetSearch.results[0].packageId, 'Serilog');
  });

  it('bricht laufende Aktion sauber ueber Job-AbortSignal ab', async () => {
    const root = makeTempDir();
    const projectDir = path.join(root, 'app');
    fs.mkdirSync(projectDir, { recursive: true });
    const svc = createDevProjectsService({ getDataFolderFn: () => root });
    const added = svc.addDevProject({ path: projectDir });
    const { jobs, createJobFn } = makeFakeJobFactory();

    const actions = createDevActions({
      getProjectFn: svc.getDevProject,
      createJobFn,
      runManagerCliFn: async (_manager, _args, { signal }) => {
        jobs[0].controller.abort();
        return { code: -1, aborted: Boolean(signal.aborted), stdout: '', stderr: '' };
      },
      scanProjectFn: async () => {
        throw new Error('Darf nach Abbruch nicht scannen');
      },
    });

    const res = await actions.devSyncProject(added.project.id, 'npm');
    assert.equal(res.success, false);
    assert.equal(res.canceled, true);
  });
});

describe('dev-projects Auth-Schutz', () => {
  it('schuetzt mutierende dev-projects Kanaele bei aktivem Admin-Schutz', () => {
    const protectedChannels = [
      'dev-projects-add',
      'dev-projects-update',
      'dev-projects-remove',
      'dev-projects-install-package',
      'dev-projects-update-package',
      'dev-projects-uninstall-package',
      'dev-projects-toggle-scope',
      'dev-projects-sync',
    ];
    for (const ch of protectedChannels) {
      assert.equal(isProtectedAdminChannel(ch), true);
      assert.equal(evaluateAdminAccess({ channel: ch, authEnabled: true, isAuthenticated: false }).allowed, false);
      assert.equal(
        evaluateAdminAccess({ channel: ch, authEnabled: true, isAuthenticated: true, sessionTimeoutMinutes: 0 })
          .allowed,
        true
      );
    }

    for (const publicCh of ['dev-projects-list', 'dev-projects-scan', 'dev-projects-search-packages']) {
      assert.equal(evaluateAdminAccess({ channel: publicCh, authEnabled: true, isAuthenticated: false }).allowed, true);
    }
  });
});
