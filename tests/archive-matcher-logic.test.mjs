import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildStage2Entry,
  buildWingetSearchQuery,
  getUnmatchedArchiveItems,
  matchArchiveWithInstalledWinget,
  rankSearchCandidates,
} from '../src/shared/archive-matcher-logic.js';

describe('archive-matcher-logic: Stufe 1 (installierte Winget-Pakete)', () => {
  it('filtert Archiv-Ordner ohne packageId/wingetId und ordnet sichere PC-Treffer vorab zu', () => {
    const catalogItems = [
      { id: 'already', name: '7-Zip', path: 'C:\\Archiv\\7-Zip', packageId: '7zip.7zip' },
      { id: 'legacy', name: 'Git', path: 'C:\\Archiv\\Git', wingetId: 'Git.Git' },
      {
        id: 'vlc-by-path',
        name: 'Mein Video Player',
        path: 'C:\\Archiv\\VideoPlayer',
        autoPaths: ['C:\\Program Files\\VideoLAN\\VLC\\vlc.exe'],
      },
      {
        id: 'npp-by-name',
        name: 'Notepad++ (x64)',
        path: 'C:\\Archiv\\NotepadPlusPlus',
        searchNames: ['Notepad++'],
      },
      {
        id: 'unmatched-tool',
        name: 'Obsidian v1.8.0 Portable',
        path: 'C:\\Archiv\\Obsidian',
      },
    ];

    const unmatched = getUnmatchedArchiveItems(catalogItems);
    assert.deepEqual(
      unmatched.map((i) => i.id),
      ['vlc-by-path', 'npp-by-name', 'unmatched-tool']
    );

    const installedWingetApps = [
      {
        packageId: 'VideoLAN.VLC',
        name: 'VLC media player',
        installedVersion: '3.0.21',
        installLocation: 'C:\\Program Files\\VideoLAN\\VLC',
      },
      {
        packageId: 'Notepad++.Notepad++',
        name: 'Notepad++ (64-bit x64)',
        installedVersion: '8.7.5',
      },
      {
        packageId: 'Mozilla.Firefox',
        name: 'Mozilla Firefox',
        installLocation: 'C:\\Program Files', // Generischer Ordner -> darf keinen False-Positive auslösen
      },
    ];

    const { matched, remaining } = matchArchiveWithInstalledWinget(unmatched, installedWingetApps);

    assert.equal(matched.length, 2);
    assert.equal(matched[0].itemId, 'vlc-by-path');
    assert.equal(matched[0].selectedPackageId, 'VideoLAN.VLC');
    assert.equal(matched[0].preselected, true);
    assert.equal(matched[0].stage, 'installed');

    assert.equal(matched[1].itemId, 'npp-by-name');
    assert.equal(matched[1].selectedPackageId, 'Notepad++.Notepad++');
    assert.equal(matched[1].preselected, true);

    assert.deepEqual(
      remaining.map((i) => i.id),
      ['unmatched-tool']
    );
  });
});

describe('archive-matcher-logic: Stufe 2 (Suche & Ranking)', () => {
  it('bereinigt Suchanfragen von Versionsnummern und Rauschwörtern', () => {
    assert.equal(
      buildWingetSearchQuery({ name: 'Obsidian v1.8.0 (x64) Portable', path: 'C:\\Archiv\\Obsidian' }),
      'Obsidian'
    );
    assert.equal(buildWingetSearchQuery({ name: 'v2.0.0', path: 'C:\\Archiv\\Audacity_Setup' }), 'Audacity');
  });

  it('bewertet exakte Suchtreffer am höchsten und markiert Stufe-2-Vorschläge nie vorab', () => {
    const item = { id: 'obs', name: 'Obsidian', path: 'C:\\Archiv\\Obsidian' };
    const searchResults = [
      { packageId: 'Some.ObsidianPlugin', name: 'Obsidian Plugin Helper', version: '1.0.0' },
      { packageId: 'Obsidian.Obsidian', name: 'Obsidian', version: '1.8.4' },
      { packageId: 'Obsidian.Obsidian', name: 'Obsidian Duplikat', version: '1.8.4' },
    ];

    const ranked = rankSearchCandidates(item, searchResults);
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].packageId, 'Obsidian.Obsidian');

    const entry = buildStage2Entry(item, searchResults, { query: 'Obsidian' });
    assert.equal(entry.stage, 'search');
    assert.equal(entry.preselected, false);
    assert.equal(entry.selectedPackageId, 'Obsidian.Obsidian');

    const emptyEntry = buildStage2Entry(item, [], { query: 'Obsidian' });
    assert.equal(emptyEntry.stage, 'none');
    assert.equal(emptyEntry.preselected, false);
    assert.equal(emptyEntry.selectedPackageId, '');
  });
});
