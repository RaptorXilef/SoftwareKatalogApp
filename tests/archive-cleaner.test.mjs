import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { collectCleanupPlanFromFolders, executeArchiveSubdirMove } from '../src/main/archive-cleaner-core.js';

describe('archive-cleaner (Dateisystem-Integration)', () => {
  let tempRoot;

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sk-cleaner-fs-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  async function writeDummySetup(dirPath, fileName, content = 'setup-binary') {
    await fs.promises.mkdir(dirPath, { recursive: true });
    await fs.promises.writeFile(path.join(dirPath, fileName), content, 'utf-8');
  }

  async function writeMeta(dirPath, metaObj) {
    const metaDir = path.join(dirPath, '_metadata');
    await fs.promises.mkdir(metaDir, { recursive: true });
    await fs.promises.writeFile(path.join(metaDir, 'meta.json'), JSON.stringify(metaObj, null, 2), 'utf-8');
    await fs.promises.writeFile(path.join(metaDir, 'icon.png'), 'png-bytes', 'utf-8');
  }

  it('wählt bei keepCount = 2 nur ältere Setup-Dateien aus, verschiebt nach _archive und lässt _metadata unberührt', async () => {
    const normalDir = path.join(tempRoot, 'VLC');
    await writeMeta(normalDir, { name: 'VLC Media Player', keepAllVersions: false });
    await writeDummySetup(normalDir, 'vlc_v3.0.18.exe', 'old-1');
    await writeDummySetup(normalDir, 'vlc_v3.0.19.exe', 'old-2');
    await writeDummySetup(normalDir, 'vlc_v3.0.20.exe', 'keep-1');
    await writeDummySetup(normalDir, 'vlc_v3.0.21.exe', 'keep-2');

    const plan = await collectCleanupPlanFromFolders([{ id: 'vlc', name: 'VLC Media Player', path: normalDir }], {
      keepVersions: 2,
    });

    assert.equal(plan.candidates.length, 1);
    assert.deepEqual(
      plan.candidates[0].keptFiles.map((f) => f.name),
      ['vlc_v3.0.21.exe', 'vlc_v3.0.20.exe']
    );
    assert.deepEqual(
      plan.candidates[0].filesToRemove.map((f) => f.name),
      ['vlc_v3.0.19.exe', 'vlc_v3.0.18.exe']
    );

    const moveRes = await executeArchiveSubdirMove(plan);
    assert.equal(moveRes.processedFiles, 2);
    assert.deepEqual(moveRes.errors, []);

    // Neueste 2 Setups bleiben im Programm-Ordner
    assert.equal(fs.existsSync(path.join(normalDir, 'vlc_v3.0.21.exe')), true);
    assert.equal(fs.existsSync(path.join(normalDir, 'vlc_v3.0.20.exe')), true);

    // Ältere 2 Setups liegen jetzt in _archive/
    assert.equal(fs.existsSync(path.join(normalDir, 'vlc_v3.0.19.exe')), false);
    assert.equal(fs.existsSync(path.join(normalDir, 'vlc_v3.0.18.exe')), false);
    assert.equal(fs.existsSync(path.join(normalDir, '_archive', 'vlc_v3.0.19.exe')), true);
    assert.equal(fs.existsSync(path.join(normalDir, '_archive', 'vlc_v3.0.18.exe')), true);

    // _metadata/ wurde niemals angerührt
    assert.equal(fs.existsSync(path.join(normalDir, '_metadata', 'meta.json')), true);
    assert.equal(fs.existsSync(path.join(normalDir, '_metadata', 'icon.png')), true);
  });

  it('ignoriert Ordner mit _last und Programme mit keepAllVersions: true komplett', async () => {
    const lastDir = path.join(tempRoot, 'PinnedTool');
    await writeMeta(lastDir, { name: 'Pinned Tool', keepAllVersions: false });
    await writeDummySetup(lastDir, 'pinned_v1.0.exe');
    await writeDummySetup(lastDir, 'pinned_v2.0.exe');
    await writeDummySetup(lastDir, 'pinned_v3.0.exe');
    await writeDummySetup(path.join(lastDir, '_last'), 'pinned_v4.0.exe');

    const keepAllDir = path.join(tempRoot, 'KeepAllTool');
    await writeMeta(keepAllDir, { name: 'Keep All Tool', keepAllVersions: true });
    await writeDummySetup(keepAllDir, 'keep_v1.0.exe');
    await writeDummySetup(keepAllDir, 'keep_v2.0.exe');
    await writeDummySetup(keepAllDir, 'keep_v3.0.exe');
    await writeDummySetup(keepAllDir, 'keep_v4.0.exe');

    const plan = await collectCleanupPlanFromFolders(
      [
        { id: 'pinned', name: 'Pinned Tool', path: lastDir },
        { id: 'keep', name: 'Keep All Tool', path: keepAllDir },
      ],
      { keepVersions: 2 }
    );

    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.totalFilesToRemove, 0);
    assert.equal(plan.protectedItems.length, 2);

    const moveRes = await executeArchiveSubdirMove(plan);
    assert.equal(moveRes.processedFiles, 0);

    // Alle Dateien + _metadata + _last existieren unverändert am Ursprungsort
    assert.equal(fs.existsSync(path.join(lastDir, 'pinned_v1.0.exe')), true);
    assert.equal(fs.existsSync(path.join(lastDir, '_last', 'pinned_v4.0.exe')), true);
    assert.equal(fs.existsSync(path.join(keepAllDir, 'keep_v1.0.exe')), true);
    assert.equal(fs.existsSync(path.join(keepAllDir, '_metadata', 'meta.json')), true);
    assert.equal(fs.existsSync(path.join(lastDir, '_archive')), false);
    assert.equal(fs.existsSync(path.join(keepAllDir, '_archive')), false);
  });
});
