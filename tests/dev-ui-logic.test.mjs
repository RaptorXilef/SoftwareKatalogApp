import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDevUpdateKey,
  DEV_SEARCH_MANAGERS,
  filterDevDependencies,
  filterDevInstalled,
  filterDevProjects,
  filterDevUpdates,
  getCompatibleDevUpdates,
  getDevManagerMeta,
  getOrderedSearchManagers,
  getProjectFolderBaseName,
  isCompatibleDevUpdate,
  shortenProjectPath,
  summarizeDevProjectScan,
} from '../src/shared/dev-ui-logic.js';

describe('dev-ui-logic: path helpers and manager metadata', () => {
  it('extracts folder basenames and shortens long paths cleanly', () => {
    assert.equal(getProjectFolderBaseName('C:\\xampp\\htdocs\\SoftwareKatalogApp\\'), 'SoftwareKatalogApp');
    assert.equal(getProjectFolderBaseName('/home/dev/projects/my-app/'), 'my-app');
    assert.equal(getProjectFolderBaseName('C:\\'), 'C:');
    assert.equal(getProjectFolderBaseName(''), '');

    const shortPath = 'C:\\dev\\app';
    assert.equal(shortenProjectPath(shortPath, 40), shortPath);

    const longWinPath = 'C:\\Users\\developer\\Documents\\Repositories\\ClientA\\SoftwareKatalogApp';
    const shortened = shortenProjectPath(longWinPath, 42);
    assert.ok(shortened.length <= 42);
    assert.ok(shortened.startsWith('C:\\...\\'));
    assert.ok(shortened.endsWith('SoftwareKatalogApp'));
  });

  it('returns accurate capability metadata and orders detected managers first', () => {
    assert.equal(getDevManagerMeta('npm').supportsToggleScope, true);
    assert.equal(getDevManagerMeta('composer').supportsDevScope, true);
    assert.equal(getDevManagerMeta('pip').supportsToggleScope, false);
    assert.equal(getDevManagerMeta('dotnet').label, 'NuGet (.NET)');
    assert.equal(getDevManagerMeta('vcpkg').supportsUninstall, false);
    assert.equal(getDevManagerMeta('yarn').badgeClass, 'is-yarn');

    const ordered = getOrderedSearchManagers(['composer', 'npm']);
    assert.equal(ordered.length, DEV_SEARCH_MANAGERS.length);
    assert.equal(ordered[0].id, 'composer');
    assert.equal(ordered[0].detected, true);
    assert.equal(ordered[1].id, 'npm');
    assert.equal(ordered[1].detected, true);
    assert.equal(ordered[2].detected, false);
  });
});

describe('dev-ui-logic: updates, scan summary, and filters', () => {
  const sampleUpdates = [
    {
      manager: 'npm',
      name: 'vite',
      current: '8.1.0',
      wanted: '8.3.8',
      latest: '8.3.8',
      scope: 'dev',
      isMajor: false,
      hasWantedUpdate: true,
    },
    {
      manager: 'npm',
      name: 'electron',
      current: '44.0.0',
      wanted: '44.0.0',
      latest: '45.2.3',
      scope: 'dev',
      isMajor: true,
      hasWantedUpdate: false,
    },
    {
      manager: 'composer',
      name: 'monolog/monolog',
      current: '3.7.0',
      wanted: '3.8.1',
      latest: '4.0.0',
      scope: 'prod',
      isMajor: true,
      hasWantedUpdate: true,
    },
  ];

  it('identifies compatible updates and summarizes scan payloads', () => {
    assert.equal(buildDevUpdateKey(sampleUpdates[0]), 'npm:vite');
    assert.equal(isCompatibleDevUpdate(sampleUpdates[0]), true);
    assert.equal(isCompatibleDevUpdate(sampleUpdates[1]), false);
    assert.equal(isCompatibleDevUpdate(sampleUpdates[2]), true);

    const compatible = getCompatibleDevUpdates(sampleUpdates);
    assert.deepEqual(
      compatible.map((u) => u.name),
      ['vite', 'monolog/monolog']
    );

    const summary = summarizeDevProjectScan({
      success: true,
      hasCheckedUpdates: true,
      managers: ['npm', 'composer'],
      installed: [{ name: 'vite' }, { name: 'monolog/monolog' }],
      dependencies: [{ name: 'vite' }, { name: 'rollup' }, { name: 'monolog/monolog' }],
      updates: sampleUpdates,
    });
    assert.deepEqual(summary, {
      hasScan: true,
      hasCheckedUpdates: true,
      managers: ['npm', 'composer'],
      directCount: 2,
      depsCount: 3,
      updatesCount: 3,
      compatibleUpdatesCount: 2,
      majorUpdatesCount: 2,
      unavailable: false,
      error: '',
    });
  });

  it('filters projects, updates, direct packages, and lockfile dependencies accurately', () => {
    const projects = [
      { id: 'p1', name: 'SoftwareKatalogApp', path: 'C:\\xampp\\htdocs\\SoftwareKatalogApp', notes: 'Electron' },
      { id: 'p2', name: 'RustTool', path: 'D:\\code\\rust-tool', notes: 'CLI' },
    ];
    const scans = {
      p1: { managers: ['npm'] },
      p2: { managers: ['cargo'] },
    };
    assert.equal(filterDevProjects(projects, 'cargo', scans).length, 1);
    assert.equal(filterDevProjects(projects, 'electron katalog', scans)[0].id, 'p1');

    assert.equal(filterDevUpdates(sampleUpdates, { managerFilter: 'composer', query: '' }).length, 1);
    assert.equal(filterDevUpdates(sampleUpdates, { managerFilter: 'all', query: 'electron' }).length, 1);

    const installed = [
      { manager: 'npm', name: 'dompurify', scope: 'prod', declaredRange: '^3.4.0', installedVersion: '3.4.0' },
      { manager: 'npm', name: 'vite', scope: 'dev', declaredRange: '^8.3.8', installedVersion: '8.3.8' },
      {
        manager: 'composer',
        name: 'guzzlehttp/guzzle',
        scope: 'prod',
        declaredRange: '^7.9',
        installedVersion: '7.9.2',
      },
    ];
    assert.equal(filterDevInstalled(installed, { managerFilter: 'all', scopeFilter: 'dev' }).length, 1);
    assert.equal(filterDevInstalled(installed, { managerFilter: 'npm', scopeFilter: 'prod' }).length, 1);

    const deps = [
      { manager: 'npm', name: 'vite', version: '8.3.8', direct: true, license: 'MIT', requiredBy: [] },
      { manager: 'npm', name: 'rollup', version: '4.30.0', direct: false, license: 'MIT', requiredBy: ['vite'] },
      {
        manager: 'composer',
        name: 'psr/log',
        version: '3.0.2',
        direct: false,
        license: 'MIT',
        requiredBy: ['monolog/monolog'],
      },
    ];
    assert.equal(filterDevDependencies(deps, { directFilter: 'direct' }).length, 1);
    assert.equal(filterDevDependencies(deps, { directFilter: 'transitive', query: 'monolog' }).length, 1);
    assert.equal(filterDevDependencies(deps, { managerFilter: 'npm', query: 'MIT' }).length, 2);
  });
});
