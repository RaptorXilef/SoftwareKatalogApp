import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCleanupPlan,
  clampKeepVersions,
  formatBytes,
  isCleanupCandidateFile,
  selectFilesForCleanup,
} from '../src/shared/archive-cleaner-logic.js';

describe('archive-cleaner-logic: Hilfsfunktionen', () => {
  it('begrenzt keepVersions sauber auf mindestens 1 und maximal 50', () => {
    assert.equal(clampKeepVersions(2), 2);
    assert.equal(clampKeepVersions(0), 1);
    assert.equal(clampKeepVersions(-5), 1);
    assert.equal(clampKeepVersions('abc'), 2);
    assert.equal(clampKeepVersions(120), 50);
  });

  it('filtert Setup-Kandidaten anhand autoExtensions und ignoriert .part-Dateien', () => {
    assert.equal(isCleanupCandidateFile('VLC_v3.0.21.exe', ['.exe', '.msi', '.zip']), true);
    assert.equal(isCleanupCandidateFile('setup.MSI', ['exe', 'msi']), true);
    assert.equal(isCleanupCandidateFile('download.exe.part', ['.exe']), false);
    assert.equal(isCleanupCandidateFile('meta.json', ['.exe', '.msi', '.zip']), false);
    assert.equal(isCleanupCandidateFile('liesmich.txt', ['.exe', '.msi', '.zip']), false);
  });

  it('formatiert Dateigrößen sauber in B, KB, MB und GB', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(1536), '1,5 KB');
    assert.equal(formatBytes(15 * 1024 * 1024), '15,0 MB');
    assert.equal(formatBytes(2.5 * 1024 * 1024 * 1024), '2,50 GB');
  });
});

describe('archive-cleaner-logic: Versionsauswahl', () => {
  it('behält die N neuesten Versionen und wählt ältere (inkl. zweistelliger SemVer) zum Entfernen', () => {
    const files = [
      { name: 'Tool_v1.2.0.exe', size: 1000, mtimeMs: 100 },
      { name: 'Tool_v1.10.0.exe', size: 3000, mtimeMs: 300 },
      { name: 'Tool_v1.9.0.exe', size: 2000, mtimeMs: 200 },
      { name: 'Tool_v1.1.0.exe', size: 500, mtimeMs: 50 },
    ];

    const res = selectFilesForCleanup(files, { keepVersions: 2 });
    assert.deepEqual(
      res.keptFiles.map((f) => f.name),
      ['Tool_v1.10.0.exe', 'Tool_v1.9.0.exe']
    );
    assert.deepEqual(
      res.filesToRemove.map((f) => f.name),
      ['Tool_v1.2.0.exe', 'Tool_v1.1.0.exe']
    );
    assert.equal(res.reclaimBytes, 1500);
  });

  it('gruppiert verschiedene Architekturen derselben Version in einem Versions-Slot', () => {
    const files = [
      { name: 'App_v3.0.0_x64.exe', size: 4000, mtimeMs: 300 },
      { name: 'App_v3.0.0_x86.exe', size: 3500, mtimeMs: 300 },
      { name: 'App_v2.5.0_x64.exe', size: 3000, mtimeMs: 200 },
      { name: 'App_v2.0.0_x64.exe', size: 2500, mtimeMs: 100 },
    ];

    const res = selectFilesForCleanup(files, { keepVersions: 2 });
    assert.deepEqual(
      res.keptFiles.map((f) => f.name),
      ['App_v3.0.0_x86.exe', 'App_v3.0.0_x64.exe', 'App_v2.5.0_x64.exe']
    );
    assert.deepEqual(
      res.filesToRemove.map((f) => f.name),
      ['App_v2.0.0_x64.exe']
    );
    assert.equal(res.reclaimBytes, 2500);
  });

  it('sortiert Dateien ohne Versionsnummer nach mtimeMs absteigend', () => {
    const files = [
      { name: 'setup_old.exe', size: 1000, mtimeMs: 100 },
      { name: 'setup_mid.exe', size: 2000, mtimeMs: 200 },
      { name: 'setup_new.exe', size: 3000, mtimeMs: 300 },
    ];

    const res = selectFilesForCleanup(files, { keepVersions: 1 });
    assert.deepEqual(
      res.keptFiles.map((f) => f.name),
      ['setup_new.exe']
    );
    assert.deepEqual(
      res.filesToRemove.map((f) => f.name),
      ['setup_mid.exe', 'setup_old.exe']
    );
    assert.equal(res.reclaimBytes, 3000);
  });
});

describe('archive-cleaner-logic: Zwingender Schutz für _last und keepAllVersions', () => {
  it('überspringt Programme mit _last-Ordner und keepAllVersions: true und listet sie unter protectedItems', () => {
    const entries = [
      {
        id: 'prog-normal',
        name: 'Normal Tool',
        path: 'C:\\Archiv\\Normal',
        hasLastDir: false,
        keepAllVersions: false,
        files: [
          { name: 'normal_v3.0.0.exe', size: 3000, mtimeMs: 300 },
          { name: 'normal_v2.0.0.exe', size: 2000, mtimeMs: 200 },
          { name: 'normal_v1.0.0.exe', size: 1000, mtimeMs: 100 },
        ],
      },
      {
        id: 'prog-last',
        name: 'Pinned Last Tool',
        path: 'C:\\Archiv\\Pinned',
        hasLastDir: true,
        keepAllVersions: false,
        files: [
          { name: 'pinned_v3.0.0.exe', size: 5000, mtimeMs: 300 },
          { name: 'pinned_v2.0.0.exe', size: 4000, mtimeMs: 200 },
          { name: 'pinned_v1.0.0.exe', size: 3000, mtimeMs: 100 },
        ],
      },
      {
        id: 'prog-keep',
        name: 'Keep All Tool',
        path: 'C:\\Archiv\\KeepAll',
        hasLastDir: false,
        keepAllVersions: true,
        files: [
          { name: 'keep_v4.0.0.exe', size: 6000, mtimeMs: 400 },
          { name: 'keep_v3.0.0.exe', size: 5000, mtimeMs: 300 },
          { name: 'keep_v2.0.0.exe', size: 4000, mtimeMs: 200 },
          { name: 'keep_v1.0.0.exe', size: 3000, mtimeMs: 100 },
        ],
      },
      {
        id: 'prog-both',
        name: 'Both Protected Tool',
        path: 'C:\\Archiv\\Both',
        hasLastDir: true,
        keepAllVersions: true,
        files: [
          { name: 'both_v3.0.0.exe', size: 2000, mtimeMs: 300 },
          { name: 'both_v2.0.0.exe', size: 2000, mtimeMs: 200 },
          { name: 'both_v1.0.0.exe', size: 2000, mtimeMs: 100 },
        ],
      },
      {
        id: 'prog-clean',
        name: 'Clean Tool',
        path: 'C:\\Archiv\\Clean',
        hasLastDir: false,
        keepAllVersions: false,
        files: [
          { name: 'clean_v2.0.0.exe', size: 1000, mtimeMs: 200 },
          { name: 'clean_v1.0.0.exe', size: 1000, mtimeMs: 100 },
        ],
      },
    ];

    const plan = buildCleanupPlan(entries, { keepVersions: 2 });

    assert.equal(plan.keepVersions, 2);
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0].id, 'prog-normal');
    assert.deepEqual(
      plan.candidates[0].filesToRemove.map((f) => f.name),
      ['normal_v1.0.0.exe']
    );
    assert.equal(plan.totalFilesToRemove, 1);
    assert.equal(plan.totalReclaimBytes, 1000);
    assert.equal(plan.unaffectedCount, 1);

    assert.equal(plan.protectedItems.length, 3);
    const byId = new Map(plan.protectedItems.map((p) => [p.id, p]));
    assert.deepEqual(byId.get('prog-last').reasons, ['pinnedLast']);
    assert.deepEqual(byId.get('prog-keep').reasons, ['keepAllVersions']);
    assert.deepEqual(byId.get('prog-both').reasons, ['pinnedLast', 'keepAllVersions']);
  });
});
