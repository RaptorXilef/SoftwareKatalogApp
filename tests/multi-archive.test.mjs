import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { inspectArchiveTargetCollision } from '../src/main/archive-linker-core.js';
import {
  formatMultiRootFileLabel,
  getArchiveRootLabel,
  mergeMultiRootCatalogEntries,
  normalizeArchivePaths,
  resolveBestArchivePath,
} from '../src/shared/multi-archive-logic.js';

describe('multi-archive (Konfiguration, Priorität, Merging & Offline-Resilienz)', () => {
  let tmpBase;
  let root1;
  let root2;

  beforeEach(async () => {
    tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sk-multi-archive-'));
    root1 = path.join(tmpBase, 'NAS_Archive');
    root2 = path.join(tmpBase, 'Local_Archive');
    await fs.promises.mkdir(root1, { recursive: true });
    await fs.promises.mkdir(root2, { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpBase, { recursive: true, force: true });
  });

  it('migriert legacy targetPath zu archivePaths und dedupliziert priorisiert', () => {
    assert.deepEqual(normalizeArchivePaths({ targetPath: '\\\\NAS\\Software' }), ['\\\\NAS\\Software']);
    assert.deepEqual(normalizeArchivePaths({}), ['../software']);

    const deduped = normalizeArchivePaths(
      {
        archivePaths: ['  D:\\Archiv\\  ', 'd:/archiv', 'E:\\Backup', '', 'e:\\backup\\'],
      },
      { platform: 'win32' }
    );
    assert.deepEqual(deduped, ['D:\\Archiv\\', 'E:\\Backup']);

    assert.equal(getArchiveRootLabel('\\\\NAS\\Software\\Tools', 0), 'NAS/Software');
    assert.equal(getArchiveRootLabel('D:\\SoftwareArchiv', 1), 'D:\\SoftwareArchiv');
  });

  it('führt Duplikate über packageId und normalisierten Namen in Prioritätsreihenfolge zusammen', () => {
    const roots = [
      { index: 0, rawPath: '\\\\NAS\\Software', absPath: root1, label: 'NAS/Software' },
      { index: 1, rawPath: 'D:\\LocalArchiv', absPath: root2, label: 'D:\\LocalArchiv' },
    ];

    const scannedByRoot = new Map([
      [
        0,
        [
          {
            id: 'nas-vlc',
            name: 'VLC Media Player',
            path: path.join(root1, 'VideoLAN.VLC'),
            primaryPath: path.join(root1, 'VideoLAN.VLC'),
            packageManager: 'winget',
            packageId: 'VideoLAN.VLC',
            wingetId: 'VideoLAN.VLC',
            description: 'Primäre NAS-Beschreibung',
            icon: null,
            screenshots: [path.join(root1, 'VideoLAN.VLC', '_metadata', 'shot1.png')],
            links: [{ label: 'Homepage', url: 'https://www.videolan.org' }],
            lastFiles: [path.join(root1, 'VideoLAN.VLC', 'vlc-3.0.21-win64.exe')],
            subCategories: ['Media'],
          },
          {
            id: 'nas-7zip',
            name: '7-Zip',
            path: path.join(root1, '7Zip'),
            primaryPath: path.join(root1, '7Zip'),
            description: '',
            screenshots: [],
            links: [],
            lastFiles: [path.join(root1, '7Zip', '7z2408-x64.exe')],
          },
        ],
      ],
      [
        1,
        [
          {
            id: 'loc-vlc',
            name: 'VLC Player (Lokal)',
            path: path.join(root2, 'VLC_Local'),
            primaryPath: path.join(root2, 'VLC_Local'),
            packageManager: 'winget',
            packageId: 'videolan.vlc', // Case-insensitiver Match über packageId
            description: 'Lokale Beschreibung darf Primär nicht überschreiben',
            icon: path.join(root2, 'VLC_Local', '_metadata', 'icon.png'),
            screenshots: [path.join(root2, 'VLC_Local', '_metadata', 'shot2.png')],
            links: [
              { label: 'Homepage', url: 'https://www.videolan.org' }, // Duplikat -> deduplizieren
              { label: 'Forum', url: 'https://forum.videolan.org' },
            ],
            lastFiles: [path.join(root2, 'VLC_Local', 'vlc-3.0.20-win64.exe')],
            subCategories: ['Video', 'media'],
          },
          {
            id: 'loc-7zip',
            name: '7 Zip!',
            path: path.join(root2, '7-Zip'),
            primaryPath: path.join(root2, '7-Zip'),
            description: 'Ergänzte Beschreibung aus zweitem Archiv',
            icon: path.join(root2, '7-Zip', '_metadata', 'icon.png'),
            screenshots: [path.join(root2, '7-Zip', '_metadata', 'shot.png')],
            links: [{ label: '7-Zip', url: 'https://7-zip.org' }],
            lastFiles: [path.join(root2, '7-Zip', '7z2301-x64.msi')],
          },
        ],
      ],
    ]);

    const merged = mergeMultiRootCatalogEntries(scannedByRoot, { roots });
    assert.equal(merged.length, 2);

    const vlc = merged.find((e) => e.packageId === 'VideoLAN.VLC');
    assert.ok(vlc);
    assert.equal(vlc.archiveRootIndex, 0);
    assert.equal(vlc.primaryPath, path.join(root1, 'VideoLAN.VLC'));
    assert.equal(vlc.description, 'Primäre NAS-Beschreibung');
    assert.equal(vlc.icon, path.join(root2, 'VLC_Local', '_metadata', 'icon.png'));
    assert.equal(vlc.hasMultipleArchiveRoots, true);
    assert.equal(vlc.alternatePaths.length, 1);
    assert.equal(vlc.alternatePaths[0].rootIndex, 1);
    assert.equal(vlc.lastFiles.length, 2);
    assert.equal(vlc.screenshots.length, 2);
    assert.equal(vlc.links.length, 2);
    assert.deepEqual(vlc.subCategories, ['Media', 'Video']);

    assert.equal(
      formatMultiRootFileLabel(vlc.lastFiles[0], vlc.lastFileSources, vlc.hasMultipleArchiveRoots),
      '[#1 NAS/Software] vlc-3.0.21-win64.exe'
    );
    assert.equal(
      formatMultiRootFileLabel(vlc.lastFiles[1], vlc.lastFileSources, vlc.hasMultipleArchiveRoots),
      '[#2 D:\\LocalArchiv] vlc-3.0.20-win64.exe'
    );

    // 7-Zip wurde ohne packageId über den normalisierten Namen gemerged
    const sevenZip = merged.find((e) => e.name === '7-Zip');
    assert.ok(sevenZip);
    assert.equal(sevenZip.archiveRootIndex, 0);
    assert.equal(sevenZip.description, 'Ergänzte Beschreibung aus zweitem Archiv');
    assert.equal(sevenZip.lastFiles.length, 2);
  });

  it('überspringt offline Archiv-Pfade sauber, erhält gecachte Einträge und wählt erreichbaren Download-Pfad', () => {
    const roots = [
      { index: 0, rawPath: '\\\\NAS\\Offline', absPath: 'Z:\\OfflineNAS', label: 'NAS/Offline' },
      { index: 1, rawPath: root2, absPath: root2, label: 'Local' },
    ];

    const vlcNasFile = 'Z:\\OfflineNAS\\VLC\\vlc-3.0.21.exe';
    const onlyNasFile = 'Z:\\OfflineNAS\\OnlyNas\\tool.exe';
    const vlcLocalFile = path.join(root2, 'VLC', 'vlc-3.0.20.exe');

    const existingEntries = [
      {
        id: 'only-nas',
        name: 'NAS Only Tool',
        path: 'Z:\\OfflineNAS\\OnlyNas',
        primaryPath: 'Z:\\OfflineNAS\\OnlyNas',
        archiveRootIndex: 0,
        archiveRootLabel: 'NAS/Offline',
        lastFiles: [onlyNasFile],
        lastFileSources: {
          [onlyNasFile]: { rootIndex: 0, rootLabel: 'NAS/Offline', offline: false },
        },
      },
      {
        id: 'vlc-nas',
        name: 'VLC Media Player',
        path: 'Z:\\OfflineNAS\\VLC',
        primaryPath: 'Z:\\OfflineNAS\\VLC',
        archiveRootIndex: 0,
        archiveRootLabel: 'NAS/Offline',
        packageId: 'VideoLAN.VLC',
        alternatePaths: [{ path: path.join(root2, 'VLC'), rootIndex: 1, rootLabel: 'Local' }],
        lastFiles: [vlcNasFile, vlcLocalFile],
        lastFileSources: {
          [vlcNasFile]: { rootIndex: 0, rootLabel: 'NAS/Offline', offline: false },
          [vlcLocalFile]: { rootIndex: 1, rootLabel: 'Local', offline: false },
        },
      },
    ];

    // Root 0 ist offline, Root 1 wurde live gescannt
    const scannedByRoot = new Map([
      [
        1,
        [
          {
            id: 'vlc-local',
            name: 'VLC Media Player',
            path: path.join(root2, 'VLC'),
            primaryPath: path.join(root2, 'VLC'),
            archiveRootIndex: 1,
            archiveRootLabel: 'Local',
            packageId: 'VideoLAN.VLC',
            lastFiles: [vlcLocalFile],
            lastFileSources: {
              [vlcLocalFile]: { rootIndex: 1, rootLabel: 'Local', offline: false },
            },
          },
        ],
      ],
    ]);

    const merged = mergeMultiRootCatalogEntries(scannedByRoot, {
      existingEntries,
      offlineRootIndices: [0],
      roots,
    });

    const nasOnly = merged.find((e) => e.name === 'NAS Only Tool');
    assert.ok(nasOnly);
    assert.equal(nasOnly.archiveOffline, true);
    assert.equal(nasOnly.lastFileSources[onlyNasFile].offline, true);

    const vlc = merged.find((e) => e.packageId === 'VideoLAN.VLC');
    assert.ok(vlc);
    // Mindestens Root 1 ist online -> insgesamt nutzbar, lokale Datei steht an Index 0
    assert.equal(vlc.archiveOffline, false);
    assert.equal(vlc.lastFiles[0], vlcLocalFile);
    assert.equal(vlc.lastFileSources[vlcNasFile].offline, true);
    assert.equal(vlc.lastFileSources[vlcLocalFile].offline, false);

    // Download-Ziel löst auf erreichbaren Root #2 auf, da Root #1 offline ist
    const bestTarget = resolveBestArchivePath(vlc, {
      archiveRoots: ['Z:\\OfflineNAS', root2],
      pathExists: (p) => p.startsWith(root2),
    });
    assert.equal(bestTarget, path.join(root2, 'VLC'));

    // Wenn gar nichts erreichbar ist -> null
    assert.equal(
      resolveBestArchivePath(nasOnly, {
        archiveRoots: ['Z:\\OfflineNAS', root2],
        pathExists: (p) => p.startsWith(root2),
      }),
      null
    );
  });

  it('erlaubt bei inspectArchiveTargetCollision Unterordner aus allen konfigurierten Archiv-Pfaden', async () => {
    const dirInRoot1 = path.join(root1, 'AppOne');
    const dirInRoot2 = path.join(root2, 'AppTwo');
    await fs.promises.mkdir(dirInRoot1, { recursive: true });
    await fs.promises.mkdir(dirInRoot2, { recursive: true });

    const check1 = inspectArchiveTargetCollision(dirInRoot1, [root1, root2]);
    const check2 = inspectArchiveTargetCollision(dirInRoot2, [root1, root2]);
    const checkOutside = inspectArchiveTargetCollision(tmpBase, [root1, root2]);
    const checkRootItself = inspectArchiveTargetCollision(root2, [root1, root2]);

    assert.equal(check1.valid, true);
    assert.equal(check2.valid, true);
    assert.equal(checkOutside.valid, false);
    assert.equal(checkRootItself.valid, false);
  });
});
