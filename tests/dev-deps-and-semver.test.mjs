import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDevUpdateCommand,
  classifySemverUpdates,
  parseBunLock,
  parseCargoLock,
  parseComposerLock,
  parseDotnetPackagesLockJson,
  parsePackageLockJson,
  parsePnpmLockYaml,
  parseUvLock,
  parseYarnLock,
} from '../src/shared/dev-projects-logic.js';
import { buildDevDependencyGraph, buildDevDependencyTree, filterDevDependencies } from '../src/shared/dev-ui-logic.js';

describe('classifySemverUpdates', () => {
  it('separates highest stable patch, minor, and major targets and skips pre-releases for stable current', () => {
    const res = classifySemverUpdates('1.2.0', [
      '1.2.1',
      '1.2.5',
      '1.2.9-beta.1',
      '1.3.0',
      '1.6.0',
      '1.6.2-rc.1',
      '2.0.0',
      '2.1.0',
      '3.0.0-alpha.1',
    ]);
    assert.deepEqual(res, {
      patch: '1.2.5',
      minor: '1.6.0',
      major: '2.1.0',
    });
  });

  it('allows pre-release upgrades when current version is already a pre-release', () => {
    const res = classifySemverUpdates('1.2.0-beta.1', [
      '1.2.0-beta.2',
      '1.2.0',
      '1.2.3-rc.1',
      '1.3.0',
      '2.0.0-alpha.1',
    ]);
    assert.equal(res.minor, '1.3.0');
    assert.equal(res.major, '2.0.0-alpha.1');
  });

  it('handles missing tiers cleanly', () => {
    assert.deepEqual(classifySemverUpdates('2.0.0', ['1.9.9', '2.0.0', '2.0.3']), {
      patch: '2.0.3',
      minor: '',
      major: '',
    });
    assert.deepEqual(classifySemverUpdates('invalid', ['1.0.0']), {
      patch: '',
      minor: '',
      major: '',
    });
  });
});

describe('buildDevUpdateCommand exactTarget', () => {
  it('targets exact chosen version across ecosystems when exactTarget is true', () => {
    const npmCmd = buildDevUpdateCommand({
      manager: 'npm',
      packageName: 'vite',
      targetVersion: '5.4.10',
      allowMajor: false,
      exactTarget: true,
      isDev: true,
    });
    assert.deepEqual(npmCmd.args, ['install', '-D', 'vite@5.4.10']);

    const pipCmd = buildDevUpdateCommand({
      manager: 'pip',
      packageName: 'ruff',
      targetVersion: '0.7.1',
      exactTarget: true,
    });
    assert.deepEqual(pipCmd.args, ['install', '--upgrade', 'ruff==0.7.1']);

    const cargoCmd = buildDevUpdateCommand({
      manager: 'cargo',
      packageName: 'serde',
      targetVersion: '1.0.215',
      exactTarget: true,
    });
    assert.deepEqual(cargoCmd.args, ['add', 'serde@=1.0.215']);
  });
});

describe('lockfile requires extraction', () => {
  it('extracts both requires and requiredBy in package-lock.json', () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { express: '^4.18.0' } },
        'node_modules/express': {
          version: '4.19.2',
          dependencies: { debug: '2.6.9', qs: '6.11.0' },
        },
        'node_modules/debug': {
          version: '2.6.9',
          dependencies: { ms: '2.0.0' },
        },
        'node_modules/qs': { version: '6.11.0' },
        'node_modules/ms': { version: '2.0.0' },
      },
    });
    const parsed = parsePackageLockJson(lock);
    const express = parsed.dependencies.find((d) => d.name === 'express');
    const ms = parsed.dependencies.find((d) => d.name === 'ms');
    assert.deepEqual(express?.requires, ['debug', 'qs']);
    assert.deepEqual(ms?.requiredBy, ['debug']);
    assert.deepEqual(ms?.requires, []);
  });

  it('extracts requires across pnpm, yarn, bun, composer, uv, cargo, and dotnet lockfiles', () => {
    const pnpm = parsePnpmLockYaml(
      [
        'importers:',
        '  .:',
        '    dependencies:',
        '      foo:',
        '        version: 1.0.0',
        'packages:',
        '  /foo@1.0.0:',
        '    dependencies:',
        '      bar: 2.0.0',
        '  /bar@2.0.0: {}',
      ].join('\n')
    );
    assert.deepEqual(pnpm.dependencies.find((d) => d.name === 'foo')?.requires, ['bar']);

    const yarn = parseYarnLock(
      [
        'foo@^1.0.0:',
        '  version "1.0.0"',
        '  dependencies:',
        '    bar "^2.0.0"',
        '',
        'bar@^2.0.0:',
        '  version "2.0.0"',
      ].join('\n')
    );
    assert.deepEqual(yarn.dependencies.find((d) => d.name === 'foo')?.requires, ['bar']);

    const bun = parseBunLock(
      JSON.stringify({
        packages: {
          foo: ['foo@1.0.0', '', { dependencies: { bar: '^2.0.0' } }],
          bar: ['bar@2.0.0', '', {}],
        },
      })
    );
    assert.deepEqual(bun.dependencies.find((d) => d.name === 'foo')?.requires, ['bar']);

    const composer = parseComposerLock(
      JSON.stringify({
        packages: [
          { name: 'vendor/foo', version: '1.0.0', require: { php: '^8.2', 'vendor/bar': '^2.0' } },
          { name: 'vendor/bar', version: '2.0.0' },
        ],
      })
    );
    assert.deepEqual(composer.dependencies.find((d) => d.name === 'vendor/foo')?.requires, ['vendor/bar']);

    const uv = parseUvLock(
      [
        '[[package]]',
        'name = "httpx"',
        'version = "0.27.0"',
        'dependencies = [',
        '  { name = "anyio" },',
        ']',
        '',
        '[[package]]',
        'name = "anyio"',
        'version = "4.4.0"',
      ].join('\n'),
      [{ name: 'httpx', scope: 'prod' }]
    );
    assert.deepEqual(uv.dependencies.find((d) => d.name === 'httpx')?.requires, ['anyio']);

    const cargo = parseCargoLock(
      [
        '[[package]]',
        'name = "tokio"',
        'version = "1.40.0"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        'dependencies = [',
        '  "mio",',
        ']',
        '',
        '[[package]]',
        'name = "mio"',
        'version = "1.0.2"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
      ].join('\n'),
      [{ name: 'tokio', scope: 'prod' }]
    );
    assert.deepEqual(cargo.dependencies.find((d) => d.name === 'tokio')?.requires, ['mio']);

    const dotnet = parseDotnetPackagesLockJson(
      JSON.stringify({
        dependencies: {
          net8: {
            'Serilog.Sinks.Console': {
              type: 'Direct',
              resolved: '5.0.1',
              dependencies: { Serilog: '3.1.1' },
            },
            Serilog: { type: 'Transitive', resolved: '3.1.1' },
          },
        },
      })
    );
    assert.deepEqual(dotnet.dependencies.find((d) => d.name === 'Serilog.Sinks.Console')?.requires, ['Serilog']);
  });
});

describe('DEV dependency tree, graph & cycle protection', () => {
  const cyclicDeps = [
    {
      manager: 'npm',
      name: 'pkg-a',
      version: '1.0.0',
      direct: true,
      scope: 'prod',
      requires: ['pkg-b'],
      requiredBy: [],
    },
    {
      manager: 'npm',
      name: 'pkg-b',
      version: '1.0.0',
      direct: false,
      scope: 'prod',
      requires: ['pkg-a'],
      requiredBy: ['pkg-a'],
    },
  ];

  it('guards circular dependencies in tree view and marks cyclic re-entry', () => {
    const tree = buildDevDependencyTree(cyclicDeps);
    assert.equal(tree.roots.length, 1);
    assert.equal(tree.roots[0].name, 'pkg-a');
    assert.equal(tree.roots[0].children.length, 1);
    assert.equal(tree.roots[0].children[0].name, 'pkg-b');
    assert.equal(tree.roots[0].children[0].children.length, 1);
    assert.equal(tree.roots[0].children[0].children[0].name, 'pkg-a');
    assert.equal(tree.roots[0].children[0].children[0].cyclic, true);
  });

  it('builds graph with cycle marker and enforces >80 node limit & focus mode', () => {
    const cyclicGraph = buildDevDependencyGraph(cyclicDeps, { projectName: 'CyclicApp' });
    assert.equal(
      cyclicGraph.edges.some((e) => e.from === 'npm:pkg-b' && e.to === 'npm:pkg-a' && e.cyclic),
      true
    );

    const largeDeps = Array.from({ length: 120 }, (_, i) => ({
      manager: 'npm',
      name: `pkg-${String(i).padStart(3, '0')}`,
      version: '1.0.0',
      direct: i < 5,
      scope: 'prod',
      requires: i === 0 ? ['pkg-010'] : [],
      requiredBy: i === 10 ? ['pkg-000'] : [],
    }));

    const truncatedGraph = buildDevDependencyGraph(largeDeps, { projectName: 'BigApp', maxNodes: 80 });
    assert.equal(truncatedGraph.exceedsLimit, true);
    assert.equal(truncatedGraph.truncated, true);
    assert.ok(truncatedGraph.nodes.length <= 81);

    const focusedGraph = buildDevDependencyGraph(largeDeps, {
      projectName: 'BigApp',
      focusNodeKey: 'npm:pkg-000',
      maxNodes: 80,
    });
    assert.equal(focusedGraph.truncated, false);
    assert.equal(
      focusedGraph.nodes.some((n) => n.id === 'npm:pkg-000'),
      true
    );
    assert.equal(
      focusedGraph.nodes.some((n) => n.id === 'npm:pkg-010'),
      true
    );
  });

  it('filters dependencies by outgoing requires terms', () => {
    const hits = filterDevDependencies(cyclicDeps, { query: 'pkg-b' });
    assert.equal(hits.length, 2);
  });
});
