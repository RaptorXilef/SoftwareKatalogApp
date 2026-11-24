import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  buildAutoIdFolderName,
  inspectArchiveTargetCollision,
  writeLinkedMetaToTarget,
} from '../src/main/archive-linker-core.js';

describe('archive-linker (Kollision, Link-Modus & auto-id)', () => {
  let archiveRoot;

  beforeEach(async () => {
    archiveRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sk-linker-fs-'));
  });

  afterEach(async () => {
    await fs.promises.rm(archiveRoot, { recursive: true, force: true });
  });

  it('erkennt Kollisionen zwischen leerem Ordner, vorhandenem _metadata und ungültigen Pfaden', async () => {
    const emptyFolder = path.join(archiveRoot, 'EmptyApp');
    await fs.promises.mkdir(emptyFolder, { recursive: true });

    const emptyCheck = inspectArchiveTargetCollision(emptyFolder, archiveRoot);
    assert.equal(emptyCheck.valid, true);
    assert.equal(emptyCheck.dirExists, true);
    assert.equal(emptyCheck.hasMetadata, false);

    const existingFolder = path.join(archiveRoot, 'ExistingApp');
    await fs.promises.mkdir(path.join(existingFolder, '_metadata'), { recursive: true });
    await fs.promises.writeFile(
      path.join(existingFolder, '_metadata', 'meta.json'),
      JSON.stringify({ name: 'Bestehende App', keepAllVersions: true }),
      'utf-8'
    );

    const existingCheck = inspectArchiveTargetCollision(existingFolder, archiveRoot);
    assert.equal(existingCheck.valid, true);
    assert.equal(existingCheck.hasMetadata, true);
    assert.equal(existingCheck.existingMeta.name, 'Bestehende App');
    assert.equal(existingCheck.existingMeta.keepAllVersions, true);

    // Im Modus 'create' liefert bestehendes _metadata eine Kollision und überschreibt nichts
    const blockedCreate = writeLinkedMetaToTarget({
      archiveRootDir: archiveRoot,
      targetDir: existingFolder,
      collisionMode: 'create',
      packageManager: 'winget',
      packageId: 'Vendor.ExistingApp',
      softwareName: 'Überschriebener Name',
    });
    assert.equal(blockedCreate.success, false);
    assert.equal(blockedCreate.collision, true);

    // Pfad außerhalb des Archivs & Archiv-Root selbst werden abgewiesen
    const outsideCheck = inspectArchiveTargetCollision(os.tmpdir(), archiveRoot);
    assert.equal(outsideCheck.valid, false);
    const rootCheck = inspectArchiveTargetCollision(archiveRoot, archiveRoot);
    assert.equal(rootCheck.valid, false);
  });

  it('erhält im link-Modus bestehende Beschreibung, Tags & Flags und ergänzt packageManager/packageId', async () => {
    const appDir = path.join(archiveRoot, 'VLC_Custom');
    const metaDir = path.join(appDir, '_metadata');
    await fs.promises.mkdir(metaDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(metaDir, 'meta.json'),
      JSON.stringify(
        {
          name: 'Mein VLC Player',
          category: 'Multimedia',
          tags: ['Video', 'Audio', 'Favorit'],
          description: 'Handgepflegte Beschreibung mit wichtigen Hinweisen.',
          keepAllVersions: true,
          links: { Handbuch: 'https://example.org/docs' },
        },
        null,
        2
      ),
      'utf-8'
    );

    const res = writeLinkedMetaToTarget({
      archiveRootDir: archiveRoot,
      targetDir: appDir,
      saveMode: 'ask',
      collisionMode: 'link',
      packageManager: 'winget',
      packageId: 'VideoLAN.VLC',
      softwareName: 'VLC media player',
      fetchedPkg: { version: '3.0.24', description: 'Winget-Text darf nicht überschreiben' },
    });

    assert.equal(res.success, true);
    assert.equal(res.mode, 'link');

    const saved = JSON.parse(await fs.promises.readFile(path.join(metaDir, 'meta.json'), 'utf-8'));
    assert.equal(saved.name, 'Mein VLC Player');
    assert.equal(saved.category, 'Multimedia');
    assert.deepEqual(saved.tags, ['Video', 'Audio', 'Favorit']);
    assert.equal(saved.description, 'Handgepflegte Beschreibung mit wichtigen Hinweisen.');
    assert.equal(saved.keepAllVersions, true);
    assert.deepEqual(saved.links, { Handbuch: 'https://example.org/docs' });
    assert.equal(saved.packageManager, 'winget');
    assert.equal(saved.packageId, 'VideoLAN.VLC');
    assert.equal(saved.wingetId, 'VideoLAN.VLC');
    assert.equal(saved.webSourceType, 'winget');
    assert.equal(saved.webVersion, '3.0.24');
  });

  it('verwendet im auto-id-Modus die Paket-ID als Ordnernamen und den echten Anzeigenamen in meta.json', async () => {
    assert.equal(buildAutoIdFolderName('VideoLAN.VLC'), 'VideoLAN.VLC');
    assert.equal(buildAutoIdFolderName('Vendor/Unsafe:Name?'), 'Vendor_Unsafe_Name');

    const res = writeLinkedMetaToTarget({
      archiveRootDir: archiveRoot,
      saveMode: 'auto-id',
      collisionMode: 'create',
      packageManager: 'winget',
      packageId: 'VideoLAN.VLC',
      softwareName: 'VLC Media Player',
      fetchedPkg: {
        name: 'VLC media player',
        version: '3.0.24',
        description: 'Freier Mediaplayer',
        tags: ['media', 'player'],
        homepage: 'https://www.videolan.org/',
      },
    });

    assert.equal(res.success, true);
    assert.equal(path.basename(res.targetDir), 'VideoLAN.VLC');
    assert.equal(fs.existsSync(path.join(archiveRoot, 'VideoLAN.VLC', '_metadata', 'meta.json')), true);

    const saved = JSON.parse(
      await fs.promises.readFile(path.join(archiveRoot, 'VideoLAN.VLC', '_metadata', 'meta.json'), 'utf-8')
    );
    assert.equal(saved.name, 'VLC Media Player');
    assert.equal(saved.packageManager, 'winget');
    assert.equal(saved.packageId, 'VideoLAN.VLC');
    assert.equal(saved.wingetId, 'VideoLAN.VLC');
    assert.equal(saved.webVersion, '3.0.24');
  });

  it('unterstuetzt generische Nicht-Winget-Provider mit webSourceType="provider" ohne wingetId', async () => {
    const res = writeLinkedMetaToTarget({
      archiveRootDir: archiveRoot,
      saveMode: 'auto-id',
      collisionMode: 'create',
      packageManager: 'scoop',
      packageId: 'extras/neovim',
      softwareName: 'Neovim',
      fetchedPkg: {
        name: 'Neovim',
        version: '0.10.2',
        description: 'Vim-fork focused on extensibility and usability',
        homepage: 'https://neovim.io/',
        repositoryUrl: 'https://github.com/neovim/neovim',
      },
    });

    assert.equal(res.success, true);
    assert.equal(path.basename(res.targetDir), 'extras_neovim');
    const saved = JSON.parse(await fs.promises.readFile(path.join(res.targetDir, '_metadata', 'meta.json'), 'utf-8'));
    assert.equal(saved.name, 'Neovim');
    assert.equal(saved.packageManager, 'scoop');
    assert.equal(saved.packageId, 'extras/neovim');
    assert.equal(saved.wingetId, '');
    assert.equal(saved.webSourceType, 'provider');
    assert.equal(saved.webVersion, '0.10.2');
    assert.deepEqual(saved.links, {
      Homepage: 'https://neovim.io/',
      Repository: 'https://github.com/neovim/neovim',
    });
  });
});
