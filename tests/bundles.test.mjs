import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateBundleItemStatus,
  evaluateBundleStatus,
  moveBundleItem,
  normalizeBundle,
  planBundleExecution,
  sortBundleItems,
} from '../src/shared/bundles-logic.js';

describe('bundles: Sortierung, PC-Abgleich & Silent-vor-Interaktiv-Planung', () => {
  it('sortiert Bündel-Einträge nach order, nummeriert 1..N und unterstützt moveBundleItem', () => {
    const sorted = sortBundleItems([
      { order: 30, source: 'winget', packageId: 'Mozilla.Firefox', name: 'Firefox' },
      { order: 10, source: 'archive', refId: 'vcpp-runtime', name: 'VC++ Runtime' },
      { order: 20, source: 'archive', refId: 'arch-7zip', name: '7-Zip' },
    ]);

    assert.deepEqual(
      sorted.map((i) => ({ order: i.order, name: i.name })),
      [
        { order: 1, name: 'VC++ Runtime' },
        { order: 2, name: '7-Zip' },
        { order: 3, name: 'Firefox' },
      ]
    );

    const moved = moveBundleItem(sorted, 2, 1);
    assert.deepEqual(
      moved.map((i) => ({ order: i.order, name: i.name })),
      [
        { order: 1, name: 'VC++ Runtime' },
        { order: 2, name: 'Firefox' },
        { order: 3, name: '7-Zip' },
      ]
    );
  });

  it('gleicht gegen installierte PC-Programme ab (skip / update / install)', () => {
    const packages = [
      {
        id: 'arch-7zip',
        archiveItemId: 'arch-7zip',
        name: '7-Zip',
        inArchive: true,
        isInstalled: true,
        installedVersion: '26.06',
        lastFiles: ['C:\\Archiv\\7zip\\7z2606-x64.msi'],
        installMode: 'silent',
        silentArgs: '/qn /norestart',
      },
      {
        id: 'arch-vlc',
        archiveItemId: 'arch-vlc',
        name: 'VLC Media Player',
        inArchive: true,
        isInstalled: true,
        installedVersion: '3.0.20',
        lastFiles: ['C:\\Archiv\\VLC\\vlc-3.0.24-win64.exe'],
        installMode: 'silent',
        silentArgs: '/S',
      },
      {
        id: 'winget:git.git',
        name: 'Git',
        inArchive: false,
        isInstalled: true,
        installedVersion: '2.54.0',
        webVersion: '2.55.0',
        hasWingetUpgrade: true,
        packageManager: 'winget',
        packageId: 'Git.Git',
      },
      {
        id: 'arch-gimp',
        archiveItemId: 'arch-gimp',
        name: 'GIMP',
        inArchive: true,
        isInstalled: false,
        lastFiles: ['C:\\Archiv\\GIMP\\gimp-2.10.38-setup.exe'],
        installMode: 'interactive',
      },
    ];

    const upToDate = evaluateBundleItemStatus(
      { order: 1, source: 'archive', refId: 'arch-7zip', name: '7-Zip' },
      packages
    );
    assert.equal(upToDate.status, 'up-to-date');
    assert.equal(upToDate.action, 'skip');
    assert.equal(upToDate.defaultSelected, false);

    const outdatedArchive = evaluateBundleItemStatus(
      { order: 2, source: 'archive', refId: 'arch-vlc', name: 'VLC' },
      packages
    );
    assert.equal(outdatedArchive.status, 'outdated');
    assert.equal(outdatedArchive.action, 'update');
    assert.equal(outdatedArchive.defaultSelected, true);

    const outdatedWinget = evaluateBundleItemStatus(
      { order: 3, source: 'winget', packageId: 'Git.Git', name: 'Git' },
      packages
    );
    assert.equal(outdatedWinget.status, 'outdated');
    assert.equal(outdatedWinget.action, 'update');
    assert.equal(outdatedWinget.defaultSelected, true);

    const missing = evaluateBundleItemStatus(
      { order: 4, source: 'archive', refId: 'arch-gimp', name: 'GIMP' },
      packages
    );
    assert.equal(missing.status, 'missing');
    assert.equal(missing.action, 'install');
    assert.equal(missing.defaultSelected, true);

    const bundle = normalizeBundle({
      id: 'b-main',
      name: 'Standard-PC',
      items: [
        { order: 1, source: 'archive', refId: 'arch-7zip', name: '7-Zip' },
        { order: 2, source: 'archive', refId: 'arch-vlc', name: 'VLC' },
        { order: 3, source: 'winget', packageId: 'Git.Git', name: 'Git' },
        { order: 4, source: 'archive', refId: 'arch-gimp', name: 'GIMP' },
      ],
    });
    const summaryEval = evaluateBundleStatus(bundle, { packages });
    assert.equal(summaryEval.summary.statusText, '3 von 4 bereits installiert');
    assert.equal(summaryEval.summary.upToDateCount, 1);
    assert.equal(summaryEval.summary.outdatedCount, 2);
    assert.equal(summaryEval.summary.missingCount, 1);
  });

  it('plant stille Pakete vor interaktiven & interactive-required Paketen', () => {
    const packages = [
      {
        id: 'arch-iobit',
        archiveItemId: 'arch-iobit',
        name: 'IObit Uninstaller',
        inArchive: true,
        isInstalled: false,
        installMode: 'interactive-required',
        silentArgs: '/VERYSILENT',
      },
      {
        id: 'arch-runtime',
        archiveItemId: 'arch-runtime',
        name: 'VC++ Runtime',
        inArchive: true,
        isInstalled: false,
        installMode: 'silent',
        silentArgs: '/quiet /norestart',
      },
      {
        id: 'arch-gimp',
        archiveItemId: 'arch-gimp',
        name: 'GIMP',
        inArchive: true,
        isInstalled: false,
        installMode: 'interactive',
      },
      {
        id: 'arch-7zip',
        archiveItemId: 'arch-7zip',
        name: '7-Zip',
        inArchive: true,
        isInstalled: false,
        installMode: 'silent',
        silentArgs: '/qn /norestart',
      },
    ];

    const bundle = normalizeBundle({
      id: 'b-exec',
      name: 'Neuinstallation',
      items: [
        { order: 1, source: 'archive', refId: 'arch-iobit', name: 'IObit Uninstaller' },
        { order: 2, source: 'archive', refId: 'arch-runtime', name: 'VC++ Runtime' },
        { order: 3, source: 'archive', refId: 'arch-gimp', name: 'GIMP' },
        { order: 4, source: 'archive', refId: 'arch-7zip', name: '7-Zip' },
        { order: 5, source: 'winget', packageId: 'Mozilla.Firefox', name: 'Firefox' },
      ],
    });

    const evalRes = evaluateBundleStatus(bundle, { packages });
    const plan = planBundleExecution(evalRes.items, { allowSilent: true, silentWinget: false });

    assert.deepEqual(
      plan.orderedQueue.map((i) => ({ name: i.name, phase: i.executionPhase, silent: i.willRunSilent })),
      [
        { name: 'VC++ Runtime', phase: 'silent', silent: true },
        { name: '7-Zip', phase: 'silent', silent: true },
        { name: 'IObit Uninstaller', phase: 'interactive', silent: false },
        { name: 'GIMP', phase: 'interactive', silent: false },
        { name: 'Firefox', phase: 'interactive', silent: false },
      ]
    );
  });
});
