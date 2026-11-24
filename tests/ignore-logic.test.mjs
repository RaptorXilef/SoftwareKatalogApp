import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildExportIgnoredUpdatesPayload,
  buildIgnoreEntryFromPackage,
  filterIgnoredEntries,
  findMatchingIgnoreRule,
  getIgnorePackageKey,
  IGNORE_EXPORT_FORMAT,
  isUpdateIgnored,
  mergeIgnoredUpdates,
  removeIgnoredUpdateEntry,
  upsertIgnoredUpdate,
  validateImportIgnoredUpdatesPayload,
} from '../src/shared/ignore-logic.js';
import { computeTabCounts, getPackageStatus } from '../src/shared/unified-packages.js';

describe('ignore-logic: mode "version" & "all"', () => {
  it('unterdrueckt bei mode "version" nur die exakte Zielversion und laesst neuere Versionen wieder erscheinen', () => {
    const vlcItem = {
      id: 'arch-vlc',
      name: 'VLC Media Player',
      inArchive: true,
      isInstalled: true,
      packageManager: 'winget',
      packageId: 'VideoLAN.VLC',
    };

    const rule = {
      id: 'rule-1',
      packageKey: 'winget:videolan.vlc',
      name: 'VLC Media Player',
      packageManager: 'winget',
      packageId: 'VideoLAN.VLC',
      mode: 'version',
      ignoredVersion: '3.0.21',
      createdAt: 1700000000000,
    };

    assert.equal(isUpdateIgnored(vlcItem, '3.0.21', [rule]), true);
    assert.equal(isUpdateIgnored(vlcItem, 'v3.0.21', [rule]), true);
    // Neuere Version muss automatisch wieder auftauchen
    assert.equal(isUpdateIgnored(vlcItem, '3.0.22', [rule]), false);
    assert.equal(isUpdateIgnored(vlcItem, '3.1.0', [rule]), false);
  });

  it('normalisiert rein numerische Versionen sauber (2.0 == 2.0.0), aber verhindert False-Matches bei Pre-Releases', () => {
    const item = {
      id: 'winget:test.app',
      name: 'Test App',
      packageManager: 'winget',
      packageId: 'Test.App',
    };

    const numericRule = {
      id: 'r-num',
      packageKey: 'winget:test.app',
      name: 'Test App',
      packageManager: 'winget',
      packageId: 'Test.App',
      mode: 'version',
      ignoredVersion: '2.0.0',
      createdAt: 1700000000000,
    };
    assert.equal(isUpdateIgnored(item, '2.0', [numericRule]), true);
    assert.equal(isUpdateIgnored(item, '2.0.1', [numericRule]), false);

    const preReleaseRule = {
      id: 'r-pre',
      packageKey: 'winget:test.app',
      name: 'Test App',
      packageManager: 'winget',
      packageId: 'Test.App',
      mode: 'version',
      ignoredVersion: '2.0.0-beta.1',
      createdAt: 1700000000000,
    };
    assert.equal(isUpdateIgnored(item, '2.0.0-beta.1', [preReleaseRule]), true);
    assert.equal(isUpdateIgnored(item, '2.0.0-beta.2', [preReleaseRule]), false);
  });

  it('unterdrueckt bei mode "all" alle aktuellen und kuenftigen Versionen', () => {
    const gitItem = {
      id: 'winget:git.git',
      name: 'Git',
      packageManager: 'winget',
      packageId: 'Git.Git',
    };

    const rule = {
      id: 'rule-all',
      packageKey: 'winget:git.git',
      name: 'Git',
      packageManager: 'winget',
      packageId: 'Git.Git',
      mode: 'all',
      ignoredVersion: '2.48.0',
      createdAt: 1700000000000,
    };

    assert.equal(isUpdateIgnored(gitItem, '2.48.0', [rule]), true);
    assert.equal(isUpdateIgnored(gitItem, '2.49.1', [rule]), true);
    assert.equal(isUpdateIgnored(gitItem, '99.0.0', [rule]), true);
  });

  it('erkennt Archiv-Programme ohne packageId ueber archive:<id>', () => {
    const archiveOnly = {
      id: 'custom-tool',
      name: 'Mein Tool',
      inArchive: true,
      archiveItemId: 'custom-tool',
      isInstalled: true,
    };
    const entry = buildIgnoreEntryFromPackage(archiveOnly, {
      mode: 'version',
      ignoredVersion: '1.2.0',
      now: 1700000000000,
    });

    assert.equal(getIgnorePackageKey(archiveOnly), 'archive:custom-tool');
    assert.equal(entry.packageKey, 'archive:custom-tool');
    assert.equal(entry.packageManager, 'archive');
    assert.ok(findMatchingIgnoreRule(archiveOnly, '1.2.0', [entry]));
    assert.equal(findMatchingIgnoreRule(archiveOnly, '1.3.0', [entry]), null);
  });
});

describe('ignore-logic: Integration in getPackageStatus & computeTabCounts', () => {
  it('filtert ignorierte Updates aus hasVisibleUpdate und dem Updates-Tab-Zaehler heraus', () => {
    const packages = [
      {
        id: 'arch-vlc',
        name: 'VLC Media Player',
        origin: 'both',
        inArchive: true,
        isInstalled: true,
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        installedVersion: '3.0.20',
        lastFiles: ['vlc-3.0.20.exe'],
        webVersion: '3.0.21',
      },
      {
        id: 'winget:git.git',
        name: 'Git',
        origin: 'pc',
        inArchive: false,
        isInstalled: true,
        packageManager: 'winget',
        packageId: 'Git.Git',
        installedVersion: '2.47.0',
        webVersion: '2.48.0',
        hasWingetUpgrade: true,
      },
    ];

    const ignoredUpdates = [
      {
        id: 'ign-1',
        packageKey: 'winget:videolan.vlc',
        name: 'VLC Media Player',
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        mode: 'version',
        ignoredVersion: '3.0.21',
        createdAt: 1700000000000,
      },
    ];

    const vlcStatus = getPackageStatus(packages[0], { ignoredUpdates });
    assert.equal(vlcStatus.hasWebUpdate, true);
    assert.equal(vlcStatus.isIgnoredUpdate, true);
    assert.equal(vlcStatus.hasVisibleUpdate, false);

    const counts = computeTabCounts(packages, { ignoredUpdates, bundlesCount: 1 });
    assert.deepEqual(counts, { updates: 1, installed: 2, archive: 1, bundles: 1 });

    // Sobald eine neuere Version (3.0.22) erscheint, taucht das Update wieder auf
    const packagesWithNewer = [{ ...packages[0], webVersion: '3.0.22' }, packages[1]];
    const vlcNewStatus = getPackageStatus(packagesWithNewer[0], { ignoredUpdates });
    assert.equal(vlcNewStatus.isIgnoredUpdate, false);
    assert.equal(vlcNewStatus.hasVisibleUpdate, true);

    const countsAfterBump = computeTabCounts(packagesWithNewer, { ignoredUpdates, bundlesCount: 1 });
    assert.deepEqual(countsAfterBump, { updates: 2, installed: 2, archive: 1, bundles: 1 });
  });
});

describe('ignore-logic: Upsert, Entfernen & Suchfilter', () => {
  it('aktualisiert bestehende Regeln pro Paket ohne Duplikate und entfernt sie sauber', () => {
    let seq = 0;
    const gen = () => `id-${++seq}`;

    const first = upsertIgnoredUpdate(
      [],
      {
        packageKey: 'winget:videolan.vlc',
        name: 'VLC Media Player',
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        mode: 'version',
        ignoredVersion: '3.0.21',
      },
      { now: 1000, generateId: gen }
    );
    assert.equal(first.success, true);
    assert.equal(first.entries.length, 1);
    assert.equal(first.entry.id, 'id-1');

    // Upgrade auf mode: 'all' behaelt bestehende ID und ueberschreibt Regel
    const second = upsertIgnoredUpdate(
      first.entries,
      {
        packageKey: 'winget:videolan.vlc',
        name: 'VLC Media Player',
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        mode: 'all',
        ignoredVersion: '3.0.21',
      },
      { now: 2000, generateId: gen }
    );
    assert.equal(second.success, true);
    assert.equal(second.entries.length, 1);
    assert.equal(second.entry.id, 'id-1');
    assert.equal(second.entry.mode, 'all');

    const filtered = filterIgnoredEntries(second.entries, 'alle updates');
    assert.equal(filtered.length, 1);

    const removed = removeIgnoredUpdateEntry(second.entries, 'id-1');
    assert.equal(removed.removed, true);
    assert.equal(removed.entries.length, 0);
  });
});

describe('ignore-logic: Export / Import-Validierung & Merge', () => {
  it('exportiert und validiert JSON-Payloads inkl. direkter Arrays', () => {
    const entries = [
      {
        id: 'id-1',
        packageKey: 'winget:videolan.vlc',
        name: 'VLC Media Player',
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        mode: 'version',
        ignoredVersion: '3.0.21',
        createdAt: 1700000000000,
      },
      {
        id: 'id-2',
        packageKey: 'winget:git.git',
        name: 'Git',
        packageManager: 'winget',
        packageId: 'Git.Git',
        mode: 'all',
        ignoredVersion: '',
        createdAt: 1700000001000,
      },
    ];

    const payload = buildExportIgnoredUpdatesPayload(entries);
    assert.equal(payload.format, IGNORE_EXPORT_FORMAT);
    assert.equal(payload.entries.length, 2);

    const checkPayload = validateImportIgnoredUpdatesPayload(payload);
    assert.equal(checkPayload.valid, true);
    assert.equal(checkPayload.entries.length, 2);

    const checkDirectArray = validateImportIgnoredUpdatesPayload(entries);
    assert.equal(checkDirectArray.valid, true);
    assert.equal(checkDirectArray.entries.length, 2);
  });

  it('lehnt ungueltige Exportformate und fehlerhafte Eintraege ab', () => {
    assert.equal(validateImportIgnoredUpdatesPayload(null).valid, false);
    assert.equal(validateImportIgnoredUpdatesPayload([]).valid, false);
    assert.equal(validateImportIgnoredUpdatesPayload({ format: 'wrong-format', entries: [] }).valid, false);
    assert.equal(
      validateImportIgnoredUpdatesPayload({
        format: IGNORE_EXPORT_FORMAT,
        entries: [{ packageKey: 'winget:a.b', mode: 'invalid' }],
      }).valid,
      false
    );
    assert.equal(
      validateImportIgnoredUpdatesPayload({
        format: IGNORE_EXPORT_FORMAT,
        entries: [{ packageKey: 'winget:a.b', mode: 'version', ignoredVersion: '' }],
      }).valid,
      false
    );
  });

  it('fuehrt Eintraege beim Import sauber zusammen (merge) oder ersetzt sie (replace)', () => {
    const existing = [
      {
        id: 'existing-1',
        packageKey: 'winget:videolan.vlc',
        name: 'VLC Media Player',
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        mode: 'version',
        ignoredVersion: '3.0.21',
        createdAt: 1000,
      },
      {
        id: 'existing-2',
        packageKey: 'winget:7zip.7zip',
        name: '7-Zip',
        packageManager: 'winget',
        packageId: '7zip.7zip',
        mode: 'all',
        ignoredVersion: '',
        createdAt: 1000,
      },
    ];

    const imported = [
      // Unveraendert -> skipped
      {
        id: 'imp-1',
        packageKey: 'winget:7zip.7zip',
        name: '7-Zip',
        packageManager: 'winget',
        packageId: '7zip.7zip',
        mode: 'all',
        ignoredVersion: '',
        createdAt: 1000,
      },
      // Geaendert -> updated (behaelt existing-1)
      {
        id: 'imp-2',
        packageKey: 'winget:videolan.vlc',
        name: 'VLC Media Player',
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        mode: 'all',
        ignoredVersion: '',
        createdAt: 2000,
      },
      // Neu -> added
      {
        id: 'imp-3',
        packageKey: 'winget:git.git',
        name: 'Git',
        packageManager: 'winget',
        packageId: 'Git.Git',
        mode: 'version',
        ignoredVersion: '2.48.0',
        createdAt: 2000,
      },
    ];

    const merged = mergeIgnoredUpdates(existing, imported, { mode: 'merge', generateId: () => 'gen-id' });
    assert.equal(merged.added, 1);
    assert.equal(merged.updated, 1);
    assert.equal(merged.skipped, 1);
    assert.equal(merged.total, 3);
    assert.equal(merged.entries.find((e) => e.packageKey === 'winget:videolan.vlc')?.id, 'existing-1');
    assert.equal(merged.entries.find((e) => e.packageKey === 'winget:videolan.vlc')?.mode, 'all');

    const replaced = mergeIgnoredUpdates(existing, imported, { mode: 'replace', generateId: () => 'gen-id' });
    assert.equal(replaced.added, 3);
    assert.equal(replaced.total, 3);
  });
});
