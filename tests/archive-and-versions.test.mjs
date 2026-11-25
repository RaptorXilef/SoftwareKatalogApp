import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeMultiRootCatalogEntries, sortArchiveSetupFiles } from '../src/shared/multi-archive-logic.js';
import { parseWingetVersionsOutput } from '../src/shared/winget-parser.js';

describe('sortArchiveSetupFiles & mergeMultiRootCatalogEntries', () => {
  it('sorts setup files descending by highest version regardless of extension order', () => {
    const files = [
      'C:\\Archive\\App\\App_v1.9.5.exe',
      'C:\\Archive\\App\\App_v2.0.0.msi',
      'C:\\Archive\\App\\App_v1.10.2.zip',
    ];
    const sorted = sortArchiveSetupFiles(files);
    assert.deepEqual(sorted, [
      'C:\\Archive\\App\\App_v2.0.0.msi',
      'C:\\Archive\\App\\App_v1.10.2.zip',
      'C:\\Archive\\App\\App_v1.9.5.exe',
    ]);
  });

  it('prioritizes online archive files ahead of offline files in multi-root catalogs', () => {
    const existingOffline = [
      {
        id: 'vlc-offline',
        name: 'VLC',
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        path: 'Z:\\Archive\\VLC',
        lastFiles: ['Z:\\Archive\\VLC\\vlc-3.0.21.exe'],
        lastFileSources: {
          'Z:\\Archive\\VLC\\vlc-3.0.21.exe': { rootIndex: 0, rootLabel: 'NAS', offline: true },
        },
        archiveSources: [{ rootIndex: 0, rootLabel: 'NAS', path: 'Z:\\Archive\\VLC', offline: true }],
      },
    ];
    const onlineItems = [
      {
        id: 'vlc-local',
        name: 'VLC',
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        path: 'D:\\LocalArchive\\VLC',
        lastFiles: ['D:\\LocalArchive\\VLC\\vlc-3.0.18.exe', 'D:\\LocalArchive\\VLC\\vlc-3.0.20.msi'],
      },
    ];

    const merged = mergeMultiRootCatalogEntries([[], onlineItems], {
      existingEntries: existingOffline,
      offlineRootIndices: [0],
      roots: [
        { index: 0, rawPath: 'Z:\\Archive', absPath: 'Z:\\Archive', label: 'NAS' },
        { index: 1, rawPath: 'D:\\LocalArchive', absPath: 'D:\\LocalArchive', label: 'Local' },
      ],
    });

    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].lastFiles, [
      'D:\\LocalArchive\\VLC\\vlc-3.0.20.msi',
      'D:\\LocalArchive\\VLC\\vlc-3.0.18.exe',
      'Z:\\Archive\\VLC\\vlc-3.0.21.exe',
    ]);
  });
});

describe('parseWingetVersionsOutput', () => {
  it('parses and sorts winget --versions output descending by SemVer', () => {
    const stdout = [
      '- \\ | /',
      'Gefunden Microsoft PowerToys [Microsoft.PowerToys]',
      'Version',
      '-------',
      '0.84.0',
      '0.85.2',
      '0.86.0',
      '0.85.10',
      '0.86.0',
    ].join('\r\n');

    assert.deepEqual(parseWingetVersionsOutput(stdout), ['0.86.0', '0.85.10', '0.85.2', '0.84.0']);
  });

  it('returns empty list when separator or versions are missing', () => {
    assert.deepEqual(parseWingetVersionsOutput('No package found matching input criteria.'), []);
  });
});
