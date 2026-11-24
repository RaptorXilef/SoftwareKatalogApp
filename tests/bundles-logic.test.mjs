import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildBundleDraftFromInstalled,
  buildExportAllBundlesPayload,
  buildExportBundlePayload,
  evaluateBundleItemStatus,
  evaluateBundleStatus,
  getBundleEditorArchiveCandidates,
  getBundleItemKey,
  getKnownProviderPackages,
  matchesSelectedItemId,
  mergeProviderEditorResults,
  moveBundleItem,
  normalizeBundle,
  planBundleExecution,
  resolveImportedBundleId,
  sortBundleItems,
  validateImportBundlePayload,
  validateImportBundlesPayload,
} from '../src/shared/bundles-logic.js';

describe('bundles-logic: Schema, Sortierung & Export/Import', () => {
  it('sortiert Bündel-Items nach order aufsteigend, dedupliziert und nummeriert 1..N sauber durch', () => {
    const sorted = sortBundleItems([
      { order: 20, source: 'winget', refId: '', packageId: 'VideoLAN.VLC', name: 'VLC' },
      { order: 5, source: 'archive', refId: 'runtime-vcpp', packageId: '', name: 'VC++ Redist' },
      { order: 30, source: 'winget', refId: '', packageId: 'videolan.vlc', name: 'VLC Duplikat' },
      { source: 'archive', refId: 'tool-7zip', packageId: '7zip.7zip', name: '7-Zip' },
    ]);

    assert.equal(sorted.length, 3);
    assert.deepEqual(
      sorted.map((i) => ({ order: i.order, name: i.name, source: i.source })),
      [
        { order: 1, name: 'VC++ Redist', source: 'archive' },
        { order: 2, name: 'VLC', source: 'winget' },
        { order: 3, name: '7-Zip', source: 'archive' },
      ]
    );
  });

  it('verschiebt Items per moveBundleItem (Pfeil-Buttons & Drag & Drop) und ignoriert ungültige Indizes', () => {
    const base = [
      { order: 1, source: 'archive', refId: 'a', name: 'Alpha' },
      { order: 2, source: 'archive', refId: 'b', name: 'Beta' },
      { order: 3, source: 'winget', packageId: 'Gamma.App', name: 'Gamma' },
    ];

    const movedDown = moveBundleItem(base, 0, 2);
    assert.deepEqual(
      movedDown.map((i) => ({ order: i.order, name: i.name })),
      [
        { order: 1, name: 'Beta' },
        { order: 2, name: 'Gamma' },
        { order: 3, name: 'Alpha' },
      ]
    );

    const movedUp = moveBundleItem(movedDown, 2, 0);
    assert.deepEqual(
      movedUp.map((i) => i.name),
      ['Alpha', 'Beta', 'Gamma']
    );

    const unchanged = moveBundleItem(base, 0, -1);
    assert.deepEqual(
      unchanged.map((i) => i.name),
      ['Alpha', 'Beta', 'Gamma']
    );
  });

  it('erzeugt und validiert Export-/Import-Payloads zuverlässig', () => {
    const bundle = normalizeBundle({
      id: 'b-1',
      name: 'Basis-Setup',
      description: 'Standardprogramme',
      icon: '🚀',
      items: [{ order: 1, source: 'winget', packageId: '7zip.7zip', name: '7-Zip' }],
    });

    const exported = buildExportBundlePayload(bundle);
    assert.equal(exported.format, 'software-katalog-bundle');
    assert.equal(exported.version, 1);

    const validWrapped = validateImportBundlePayload(exported);
    assert.equal(validWrapped.valid, true);
    assert.equal(validWrapped.bundle.name, 'Basis-Setup');
    assert.equal(validWrapped.bundle.items.length, 1);

    const validDirect = validateImportBundlePayload({
      name: 'Direkt',
      items: [{ source: 'archive', refId: 'vlc', name: 'VLC' }],
    });
    assert.equal(validDirect.valid, true);
    assert.equal(validDirect.bundle.items[0].order, 1);

    assert.equal(validateImportBundlePayload(null).valid, false);
    assert.equal(validateImportBundlePayload({ format: 'wrong', bundle: { name: 'X', items: [] } }).valid, false);
    assert.equal(validateImportBundlePayload({ name: '   ', items: [] }).valid, false);
    assert.equal(
      validateImportBundlePayload({ name: 'Kaputt', items: [{ source: 'winget', packageId: '' }] }).valid,
      false
    );
  });

  it('erkennt selektierte Items flexibel über Key, refId oder packageId', () => {
    const archItem = { order: 1, source: 'archive', refId: 'vlc-id', packageId: 'VideoLAN.VLC', name: 'VLC' };
    assert.equal(getBundleItemKey(archItem), 'archive:vlc-id');
    assert.equal(matchesSelectedItemId(archItem, new Set(['archive:vlc-id'])), true);
    assert.equal(matchesSelectedItemId(archItem, new Set(['vlc-id'])), true);
    assert.equal(matchesSelectedItemId(archItem, new Set(['videolan.vlc'])), true);
    assert.equal(matchesSelectedItemId(archItem, new Set(['other'])), false);
  });
});

describe('bundles-logic: PC-Status-Abgleich', () => {
  const packages = [
    {
      id: 'arch-7zip',
      archiveItemId: 'arch-7zip',
      name: '7-Zip',
      origin: 'both',
      inArchive: true,
      isInstalled: true,
      installedVersion: '24.09',
      lastFiles: ['C:\\Archiv\\7zip\\7z2409-x64.msi'],
      packageManager: 'winget',
      packageId: '7zip.7zip',
      installMode: 'silent',
      silentArgs: '/qn /norestart',
    },
    {
      id: 'arch-vlc',
      archiveItemId: 'arch-vlc',
      name: 'VLC Media Player',
      origin: 'both',
      inArchive: true,
      isInstalled: true,
      installedVersion: '3.0.20',
      lastFiles: ['C:\\Archiv\\VLC\\vlc-3.0.21-win64.exe'],
      packageManager: 'winget',
      packageId: 'VideoLAN.VLC',
      installMode: 'silent',
      silentArgs: '/S',
    },
    {
      id: 'arch-gimp',
      archiveItemId: 'arch-gimp',
      name: 'GIMP',
      origin: 'archive',
      inArchive: true,
      isInstalled: false,
      lastFiles: ['C:\\Archiv\\GIMP\\gimp-2.10.38-setup.exe'],
      installMode: 'interactive',
    },
    {
      id: 'winget:git.git',
      name: 'Git',
      origin: 'pc',
      inArchive: false,
      isInstalled: true,
      installedVersion: '2.47.0',
      webVersion: '2.48.1',
      hasWingetUpgrade: true,
      packageManager: 'winget',
      packageId: 'Git.Git',
    },
    {
      id: 'arch-newer',
      archiveItemId: 'arch-newer',
      name: 'Firefox',
      origin: 'both',
      inArchive: true,
      isInstalled: true,
      installedVersion: '136.0.0',
      lastFiles: ['C:\\Archiv\\Firefox\\firefox_135.0.0.exe'],
      webVersion: '135.0.0',
    },
  ];

  it('klassifiziert aktuell, veraltet (Archiv & Winget), PC-neuer und fehlend korrekt', () => {
    const upToDate = evaluateBundleItemStatus(
      { order: 1, source: 'archive', refId: 'arch-7zip', name: '7-Zip' },
      packages
    );
    assert.equal(upToDate.status, 'up-to-date');
    assert.equal(upToDate.statusLabel, '✅ Bereits aktuell - überspringen');
    assert.equal(upToDate.defaultSelected, false);
    assert.equal(upToDate.canRunArchiveSilent, true);

    const pcNewer = evaluateBundleItemStatus(
      { order: 2, source: 'archive', refId: 'arch-newer', name: 'Firefox' },
      packages
    );
    assert.equal(pcNewer.status, 'up-to-date');
    assert.equal(pcNewer.defaultSelected, false);

    const outdatedArch = evaluateBundleItemStatus(
      { order: 3, source: 'archive', refId: 'arch-vlc', name: 'VLC' },
      packages
    );
    assert.equal(outdatedArch.status, 'outdated');
    assert.equal(outdatedArch.statusLabel, '⬆️ Veraltet - aktualisieren');
    assert.equal(outdatedArch.defaultSelected, true);

    const outdatedWg = evaluateBundleItemStatus(
      { order: 4, source: 'winget', packageId: 'Git.Git', name: 'Git' },
      packages
    );
    assert.equal(outdatedWg.status, 'outdated');
    assert.equal(outdatedWg.defaultSelected, true);

    const missingArch = evaluateBundleItemStatus(
      { order: 5, source: 'archive', refId: 'arch-gimp', name: 'GIMP' },
      packages
    );
    assert.equal(missingArch.status, 'missing');
    assert.equal(missingArch.statusLabel, '⬇️ Fehlt - installieren');
    assert.equal(missingArch.defaultSelected, true);

    const missingWg = evaluateBundleItemStatus(
      { order: 6, source: 'winget', packageId: 'Notepad++.Notepad++', name: 'Notepad++' },
      packages
    );
    assert.equal(missingWg.status, 'missing');
    assert.equal(missingWg.defaultSelected, true);
  });

  it('erkennt fehlenden Archiv-Eintrag und setzt defaultSelected auf false', () => {
    const brokenArch = evaluateBundleItemStatus(
      { order: 1, source: 'archive', refId: 'nicht-vorhanden', name: 'Gelöscht' },
      packages
    );
    assert.equal(brokenArch.archiveMissing, true);
    assert.equal(brokenArch.defaultSelected, false);
  });

  it('berechnet Live-Bündel-Zusammenfassung für die Übersichtskarten', () => {
    const bundle = normalizeBundle({
      id: 'test-b',
      name: 'Test',
      items: [
        { order: 1, source: 'archive', refId: 'arch-7zip', name: '7-Zip' },
        { order: 2, source: 'archive', refId: 'arch-vlc', name: 'VLC' },
        { order: 3, source: 'archive', refId: 'arch-gimp', name: 'GIMP' },
        { order: 4, source: 'winget', packageId: 'Git.Git', name: 'Git' },
      ],
    });

    const evalRes = evaluateBundleStatus(bundle, { packages });
    assert.equal(evalRes.summary.total, 4);
    assert.equal(evalRes.summary.installedCount, 3);
    assert.equal(evalRes.summary.upToDateCount, 1);
    assert.equal(evalRes.summary.outdatedCount, 2);
    assert.equal(evalRes.summary.missingCount, 1);
    assert.equal(evalRes.summary.statusText, '3 von 4 bereits installiert');
  });
});

describe('bundles-logic: Silent-vor-Interaktiv-Planung & Adware-Schutz', () => {
  const packages = [
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
      id: 'arch-protected',
      archiveItemId: 'arch-protected',
      name: 'Spezial-Wrapper',
      inArchive: true,
      isInstalled: false,
      installMode: 'interactive-required',
      silentArgs: '/S',
    },
    {
      id: 'arch-interactive',
      archiveItemId: 'arch-interactive',
      name: 'GIMP',
      inArchive: true,
      isInstalled: false,
      installMode: 'interactive',
      silentArgs: '/VERYSILENT',
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

  it('plant stille Pakete vor interaktiven Paketen unter Erhalt der Reihenfolge pro Phase', () => {
    const bundle = normalizeBundle({
      id: 'b-plan',
      name: 'Planung',
      items: [
        { order: 1, source: 'archive', refId: 'arch-runtime', name: 'VC++ Runtime' },
        { order: 2, source: 'archive', refId: 'arch-protected', name: 'Spezial-Wrapper' },
        { order: 3, source: 'archive', refId: 'arch-interactive', name: 'GIMP' },
        { order: 4, source: 'archive', refId: 'arch-7zip', name: '7-Zip' },
        { order: 5, source: 'winget', packageId: 'Mozilla.Firefox', name: 'Firefox' },
      ],
    });

    const evalRes = evaluateBundleStatus(bundle, { packages });
    const plan = planBundleExecution(evalRes.items, { allowSilent: true, silentWinget: false });

    assert.deepEqual(
      plan.silentItems.map((i) => i.name),
      ['VC++ Runtime', '7-Zip']
    );
    assert.deepEqual(
      plan.interactiveItems.map((i) => i.name),
      ['Spezial-Wrapper', 'GIMP', 'Firefox']
    );
    assert.deepEqual(
      plan.orderedQueue.map((i) => i.name),
      ['VC++ Runtime', '7-Zip', 'Spezial-Wrapper', 'GIMP', 'Firefox']
    );
    assert.equal(plan.stats.silentCount, 2);
    assert.equal(plan.stats.interactiveCount, 3);
    assert.equal(plan.stats.adwareProtectedCount, 1);
    assert.match(plan.interactiveNotice, /🛡️ Adware-Schutz/);
  });

  it('zwingt interactive-required und Adware-Kandidaten auch bei silentWinget=true in die interaktive Phase', () => {
    const items = [
      evaluateBundleItemStatus({ order: 1, source: 'winget', packageId: 'Piriform.CCleaner', name: 'CCleaner' }, []),
      evaluateBundleItemStatus({ order: 2, source: 'winget', packageId: 'VideoLAN.VLC', name: 'VLC' }, []),
      evaluateBundleItemStatus(
        { order: 3, source: 'archive', refId: 'arch-protected', name: 'Spezial-Wrapper' },
        packages
      ),
    ];

    const plan = planBundleExecution(items, { allowSilent: true, silentWinget: true });
    assert.deepEqual(
      plan.silentItems.map((i) => i.name),
      ['VLC']
    );
    assert.deepEqual(
      plan.interactiveItems.map((i) => i.name),
      ['CCleaner', 'Spezial-Wrapper']
    );
    assert.equal(plan.interactiveItems[0].willRunSilent, false);
    assert.equal(plan.interactiveItems[0].adwareProtected, true);
    assert.equal(plan.interactiveItems[1].willRunSilent, false);
    assert.equal(plan.interactiveItems[1].adwareProtected, true);
  });
});

describe('bundles-logic: 1-Klick-PC-Snapshot', () => {
  it('generiert Bündel-Entwurf aus Archiv- & Winget-Programmen, dedupliziert und schließt reine Registry-Apps aus', () => {
    const packages = [
      {
        id: 'arch-vlc',
        archiveItemId: 'arch-vlc',
        name: 'VLC Media Player',
        inArchive: true,
        isInstalled: true,
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
      },
      {
        id: 'winget:videolan.vlc',
        name: 'VLC Duplikat',
        inArchive: false,
        isInstalled: true,
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
      },
      {
        id: 'winget:git.git',
        name: 'Git',
        inArchive: false,
        isInstalled: true,
        packageManager: 'winget',
        packageId: 'Git.Git',
      },
      {
        id: 'registry:legacy',
        name: 'Altes Treiberpaket',
        inArchive: false,
        isInstalled: true,
        packageManager: null,
        packageId: null,
      },
      {
        id: 'arch-not-installed',
        archiveItemId: 'arch-not-installed',
        name: 'Nicht installiert',
        inArchive: true,
        isInstalled: false,
      },
    ];

    const res = buildBundleDraftFromInstalled(packages, { name: 'Mein PC' });
    assert.equal(res.includedCount, 2);
    assert.equal(res.archiveCount, 1);
    assert.equal(res.wingetCount, 1);
    assert.equal(res.excludedCount, 1);
    assert.equal(res.draft.name, 'Mein PC');
    assert.deepEqual(
      res.draft.items.map((i) => ({ order: i.order, source: i.source, name: i.name })),
      [
        { order: 1, source: 'winget', name: 'Git' },
        { order: 2, source: 'archive', name: 'VLC Media Player' },
      ]
    );
  });
});

describe('bundles-logic: Bündel-Editor-Kandidaten (Archiv & Winget)', () => {
  it('liefert ALLE sichtbaren Archiv-Programme ohne 20er-Limit und respektiert versteckte Kategorien', () => {
    const catalog = Array.from({ length: 35 }, (_, idx) => ({
      id: `app-${idx + 1}`,
      name: `Programm ${String(idx + 1).padStart(2, '0')}`,
      mainCategory: idx % 2 === 0 ? 'Tools' : 'Multimedia',
      subCategories: [],
      hiddenCategory: idx === 34 ? 'Privat' : '',
      lastFiles: [`C:\\Archiv\\App${idx + 1}\\setup-1.0.${idx}.exe`],
    }));

    const allVisible = getBundleEditorArchiveCandidates(catalog);
    assert.equal(allVisible.length, 34);
    assert.equal(allVisible[0].providerId, 'archive');
    assert.equal(allVisible[0].editorItem.source, 'archive');

    const withHidden = getBundleEditorArchiveCandidates(catalog, { visibleHiddenCats: ['Privat'] });
    assert.equal(withHidden.length, 35);

    const filtered = getBundleEditorArchiveCandidates(catalog, { query: 'Programm 25' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].packageId, 'app-25');
  });

  it('ermittelt bekannte/installierte Winget-Pakete, dedupliziert und führt Remote-Treffer sauber zusammen', () => {
    const packages = [
      {
        id: 'arch-vlc',
        archiveItemId: 'arch-vlc',
        name: 'VLC Media Player (Archiv)',
        inArchive: true,
        isInstalled: false,
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        webVersion: '3.0.21',
      },
      {
        id: 'winget:videolan.vlc',
        name: 'VLC media player',
        inArchive: false,
        isInstalled: true,
        installedVersion: '3.0.20',
        packageManager: 'winget',
        packageId: 'VideoLAN.VLC',
        publisher: 'VideoLAN',
      },
      {
        id: 'winget:git.git',
        name: 'Git',
        inArchive: false,
        isInstalled: true,
        installedVersion: '2.48.0',
        packageManager: 'winget',
        packageId: 'Git.Git',
        publisher: 'The Git Development Community',
      },
      {
        id: 'registry:legacy',
        name: 'Legacy Tool',
        inArchive: false,
        isInstalled: true,
        packageManager: null,
        packageId: null,
      },
    ];

    const known = getKnownProviderPackages(packages, { providerId: 'winget' });
    assert.equal(known.length, 2);
    assert.equal(known[0].packageId, 'Git.Git');
    assert.equal(known[1].packageId, 'VideoLAN.VLC');
    assert.equal(known[1].isInstalled, true);
    assert.equal(known[1].inArchive, true);

    const knownFiltered = getKnownProviderPackages(packages, { providerId: 'winget', query: 'videolan' });
    assert.equal(knownFiltered.length, 1);
    assert.equal(knownFiltered[0].packageId, 'VideoLAN.VLC');

    const merged = mergeProviderEditorResults({
      knownPackages: knownFiltered,
      remoteResults: [
        { packageId: 'VideoLAN.VLC', name: 'VLC media player', version: '3.0.24' },
        { packageId: 'VideoLAN.VLC.Nightly', name: 'VLC Nightly', version: '4.0.0' },
      ],
      providerId: 'winget',
    });
    assert.equal(merged.length, 2);
    assert.equal(merged[0].isInstalled, true);
    assert.equal(merged[0].version, '3.0.24');
    assert.equal(merged[1].packageId, 'VideoLAN.VLC.Nightly');
    assert.equal(merged[1].isInstalled, false);
  });

  it('validiert Einzel- und Mehrfach-Exporte und löst ID-Kollisionen beim Import auf', () => {
    const b1 = normalizeBundle({
      id: 'b-1',
      name: 'Basis',
      items: [{ source: 'winget', packageId: '7zip.7zip', name: '7-Zip' }],
    });
    const b2 = normalizeBundle({
      id: 'b-2',
      name: 'Medien',
      items: [{ source: 'archive', refId: 'vlc', name: 'VLC' }],
    });

    const multiExport = buildExportAllBundlesPayload([b1, b2]);
    assert.equal(multiExport.format, 'software-katalog-bundles');
    assert.equal(multiExport.bundles.length, 2);

    const parsedMulti = validateImportBundlesPayload(multiExport);
    assert.equal(parsedMulti.valid, true);
    assert.equal(parsedMulti.bundles.length, 2);

    const parsedRawArr = validateImportBundlesPayload([
      { name: 'Direkt', items: [{ source: 'winget', packageId: 'Git.Git', name: 'Git' }] },
    ]);
    assert.equal(parsedRawArr.valid, true);
    assert.equal(parsedRawArr.bundles.length, 1);

    const parsedSingle = validateImportBundlesPayload(buildExportBundlePayload(b1));
    assert.equal(parsedSingle.valid, true);
    assert.equal(parsedSingle.bundles.length, 1);

    assert.equal(validateImportBundlesPayload([]).valid, false);
    assert.equal(validateImportBundlesPayload({ format: 'software-katalog-bundles', bundles: [] }).valid, false);

    let seq = 0;
    const existing = new Set(['b-1', 'new-1']);
    assert.equal(
      resolveImportedBundleId('b-free', existing, () => `new-${++seq}`),
      'b-free'
    );
    assert.equal(
      resolveImportedBundleId('b-1', existing, () => `new-${++seq}`),
      'new-2'
    );
    assert.equal(
      resolveImportedBundleId('', existing, () => `new-${++seq}`),
      'new-3'
    );
  });
});
