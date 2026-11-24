import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createScanProgressState,
  formatScanProgressBanner,
  formatSourceNameList,
  markScanFinished,
  markScanPhaseMerging,
  markScanSourceDone,
} from '../src/shared/scan-progress-logic.js';

describe('scan-progress-logic', () => {
  it('erstellt Initialzustand, dedupliziert Quellen und aktualisiert Fortschritt immutable', () => {
    const initial = createScanProgressState(
      [
        { id: 'registry', label: 'Windows-Registry', kind: 'system' },
        { id: 'winget', label: 'Winget', kind: 'provider' },
        { id: 'winget', label: 'Winget Duplikat', kind: 'provider' },
        { id: 'msstore', label: 'MS Store', kind: 'provider' },
        { id: 'scoop', label: 'Scoop', kind: 'provider' },
      ],
      { startedAt: 1000 }
    );

    assert.equal(initial.active, true);
    assert.equal(initial.phase, 'scanning');
    assert.equal(initial.total, 4);
    assert.equal(initial.completed, 0);
    assert.equal(initial.percent, 8);
    assert.equal(initial.startedAt, 1000);

    const afterReg = markScanSourceDone(initial, 'registry', { ok: true });
    assert.equal(initial.completed, 0);
    assert.equal(afterReg.completed, 1);
    assert.equal(afterReg.percent, 30);
    assert.equal(afterReg.sources.find((s) => s.id === 'registry')?.status, 'done');

    const afterScoopErr = markScanSourceDone(afterReg, 'scoop', { ok: false, error: 'Timeout' });
    assert.equal(afterScoopErr.completed, 2);
    assert.equal(afterScoopErr.percent, 50);
    assert.equal(afterScoopErr.sources.find((s) => s.id === 'scoop')?.status, 'error');
    assert.equal(afterScoopErr.sources.find((s) => s.id === 'scoop')?.error, 'Timeout');

    const merging = markScanPhaseMerging(afterScoopErr);
    assert.equal(merging.active, true);
    assert.equal(merging.phase, 'merging');
    assert.equal(merging.percent, 94);

    const finished = markScanFinished(merging);
    assert.equal(finished.active, false);
    assert.equal(finished.phase, 'done');
    assert.equal(finished.percent, 100);
  });

  it('formatiert Aufzaehlungen von Quellnamen fuer 0, 1, 2, 3 und >3 Eintraege', () => {
    assert.equal(formatSourceNameList([]), '');
    assert.equal(formatSourceNameList(['Winget']), 'Winget');
    assert.equal(formatSourceNameList(['Winget', 'MS Store']), 'Winget und MS Store');
    assert.equal(formatSourceNameList(['Winget', 'MS Store', 'Scoop']), 'Winget, MS Store und Scoop');
    assert.equal(
      formatSourceNameList(['Winget', 'MS Store', 'Scoop', 'npm', 'pip']),
      'Winget, MS Store und 3 weitere Quellen'
    );
  });

  it('baut Banner-Modelle fuer Provider-Check, laufende Quellen, Merge-Phase und Inaktivitaet', () => {
    const checkingBanner = formatScanProgressBanner(null, { tab: 'updates', isCheckingProviders: true });
    assert.equal(checkingBanner.visible, true);
    assert.equal(checkingBanner.indeterminate, true);
    assert.equal(checkingBanner.headline, 'Prüfe aktive Paketmanager...');
    assert.equal(checkingBanner.chips.length, 0);

    const inactiveBanner = formatScanProgressBanner(null, { tab: 'updates', isCheckingProviders: false });
    assert.equal(inactiveBanner.visible, false);

    let state = createScanProgressState([
      { id: 'registry', label: 'Windows-Registry', kind: 'system' },
      { id: 'winget', label: 'Winget', kind: 'provider' },
      { id: 'msstore', label: 'MS Store', kind: 'provider' },
    ]);

    const multiBanner = formatScanProgressBanner(state, { tab: 'updates' });
    assert.equal(multiBanner.visible, true);
    assert.equal(multiBanner.indeterminate, false);
    assert.equal(multiBanner.headline, 'Winget und MS Store werden auf Updates geprüft...');
    assert.equal(multiBanner.subtext, '0 von 3 Quellen abgeschlossen');
    // Provider-Chips werden zuerst sortiert vor System-Chips
    assert.deepEqual(
      multiBanner.chips.map((c) => c.id),
      ['winget', 'msstore', 'registry']
    );

    state = markScanSourceDone(state, 'msstore', { ok: true });
    const singleBannerUpdates = formatScanProgressBanner(state, { tab: 'updates' });
    assert.equal(singleBannerUpdates.headline, 'Winget wird auf Updates geprüft...');
    assert.equal(singleBannerUpdates.subtext, '1 von 3 Quellen abgeschlossen');

    const singleBannerInstalled = formatScanProgressBanner(state, { tab: 'installed' });
    assert.equal(singleBannerInstalled.headline, 'Winget wird eingelesen...');

    const merged = markScanPhaseMerging(markScanSourceDone(markScanSourceDone(state, 'winget'), 'registry'));
    const mergeUpdatesBanner = formatScanProgressBanner(merged, { tab: 'updates' });
    assert.equal(mergeUpdatesBanner.headline, 'Vergleiche gefundene Updates mit dem Archiv...');
    assert.equal(mergeUpdatesBanner.percent, 94);

    const mergeInstalledBanner = formatScanProgressBanner(merged, { tab: 'installed' });
    assert.equal(mergeInstalledBanner.headline, 'Verknüpfe installierte Programme mit dem Archiv...');

    const finishedBanner = formatScanProgressBanner(markScanFinished(merged), { tab: 'updates' });
    assert.equal(finishedBanner.visible, false);
  });
});
