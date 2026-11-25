import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  buildPersistentIconIndexKeys,
  createIconCacheIndex,
  ICON_CACHE_NEGATIVE_TTL_MS,
  ICON_CACHE_POSITIVE_TTL_MS,
} from '../src/shared/icon-cache-store.js';

const tempDirs = [];

function makeTempCacheDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-icon-cache-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors on locked files
    }
  }
});

describe('buildPersistentIconIndexKeys', () => {
  it('builds deterministic package, archive, and url origin keys without generic hosts', () => {
    const keys = buildPersistentIconIndexKeys({
      id: 'vlc-media-player',
      packageManager: 'winget',
      packageId: 'VideoLAN.VLC',
      homepage: 'https://www.videolan.org/vlc/',
      repositoryUrl: 'https://github.com/videolan/vlc',
      links: ['https://aka.ms/something'],
    });

    assert.equal(keys.includes('winget:VideoLAN.VLC'), true);
    assert.equal(keys.includes('winget:videolan.vlc'), true);
    assert.equal(keys.includes('archive:vlc-media-player'), true);
    assert.equal(keys.includes('url:https://www.videolan.org'), true);
    assert.equal(keys.includes('url:https://github.com/videolan/vlc'), true);
    assert.equal(
      keys.some((k) => k.includes('aka.ms')),
      false
    );
  });
});

describe('createIconCacheIndex', () => {
  it('persists cache hits, respects offline permanence after TTL, and caches negative hits for 24h', () => {
    const cacheDir = makeTempCacheDir();
    const iconFile = path.join(cacheDir, 'vlc.png');
    fs.writeFileSync(iconFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

    let fakeNow = 1_700_000_000_000;
    let fakeOnline = true;
    const indexA = createIconCacheIndex({
      cacheDir,
      now: () => fakeNow,
      isOnline: () => fakeOnline,
    });

    const keys = buildPersistentIconIndexKeys({
      id: 'vlc',
      packageManager: 'winget',
      packageId: 'VideoLAN.VLC',
    });
    indexA.recordHit(keys, iconFile, 'online-favicon');

    // Fresh instance simulates app restart
    const indexB = createIconCacheIndex({
      cacheDir,
      now: () => fakeNow,
      isOnline: () => fakeOnline,
    });
    const hit = indexB.lookup(keys);
    assert.equal(hit.status, 'hit');
    assert.equal(hit.filePath, iconFile);

    // Beyond 30d TTL while offline -> still permanently valid
    fakeNow += ICON_CACHE_POSITIVE_TTL_MS + 1000;
    fakeOnline = false;
    const offlineHit = indexB.lookup(keys);
    assert.equal(offlineHit.status, 'hit');
    assert.equal(offlineHit.offlineRetained, true);

    // Beyond 30d TTL while online -> marked stale so refresh can be attempted
    fakeOnline = true;
    const staleHit = indexB.lookup(keys);
    assert.equal(staleHit.status, 'stale');

    // Negative miss caching (24h TTL)
    const missingKeys = ['winget:missing.pkg'];
    indexB.recordMiss(missingKeys);
    assert.equal(indexB.lookup(missingKeys).status, 'miss');
    fakeNow += ICON_CACHE_NEGATIVE_TTL_MS + 1000;
    assert.equal(indexB.lookup(missingKeys).status, 'none');

    // Stats and clear
    assert.ok(indexB.getStats().fileCount >= 1);
    const clearRes = indexB.clear();
    assert.equal(clearRes.success, true);
    assert.equal(indexB.lookup(keys).status, 'none');
    assert.equal(indexB.getStats().fileCount, 0);
  });
});
