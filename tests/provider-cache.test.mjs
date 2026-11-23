import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createProviderCache, DEFAULT_CACHE_TTL_MS } from '../src/shared/provider-cache.js';

describe('createProviderCache', () => {
  let tempDir;
  let cacheFile;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-provider-cache-'));
    cacheFile = path.join(tempDir, 'provider-cache.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('speichert Einträge persistent über mehrere Instanzen und nutzt gültigen 7-Tage-Cache ohne Fetcher', async () => {
    let clock = 1_700_000_000_000;
    const cacheA = createProviderCache({ filePath: cacheFile, now: () => clock });

    let fetchCount = 0;
    const first = await cacheA.getOrFetch('winget:show:7zip.7zip', async () => {
      fetchCount++;
      return { name: '7-Zip', version: '26.06' };
    });

    assert.equal(first.fromCache, false);
    assert.equal(first.isStale, false);
    assert.equal(first.data.version, '26.06');
    assert.equal(fetchCount, 1);

    // 3 Tage später in neuer Cache-Instanz -> Cache-Hit ohne Online-Abruf
    clock += 3 * 24 * 60 * 60 * 1000;
    const cacheB = createProviderCache({ filePath: cacheFile, now: () => clock });
    const second = await cacheB.getOrFetch('winget:show:7zip.7zip', async () => {
      fetchCount++;
      return { name: '7-Zip', version: '27.00' };
    });

    assert.equal(second.fromCache, true);
    assert.equal(second.isStale, false);
    assert.equal(second.data.version, '26.06');
    assert.equal(fetchCount, 1);
  });

  it('aktualisiert abgelaufene Einträge (> 7 Tage) bei erfolgreicher Online-Abfrage', async () => {
    let clock = 1_700_000_000_000;
    const cache = createProviderCache({ filePath: cacheFile, now: () => clock });

    await cache.getOrFetch('winget:show:videolan.vlc', async () => ({ version: '3.0.21' }));

    clock += DEFAULT_CACHE_TTL_MS + 1000;
    const refreshed = await cache.getOrFetch('winget:show:videolan.vlc', async () => ({ version: '3.0.24' }));

    assert.equal(refreshed.fromCache, false);
    assert.equal(refreshed.isStale, false);
    assert.equal(refreshed.data.version, '3.0.24');
    assert.equal(refreshed.updatedAt, clock);
  });

  it('behält bestehenden Cache dauerhaft gültig mit isStale: true, wenn Online-Abruf nach Ablauf fehlschlägt', async () => {
    let clock = 1_700_000_000_000;
    const initialTs = clock;
    const cache = createProviderCache({ filePath: cacheFile, now: () => clock });

    await cache.getOrFetch('winget:show:git.git', async () => ({ name: 'Git', version: '2.55.0' }));

    // 10 Tage später, Gerät ist offline
    clock += 10 * 24 * 60 * 60 * 1000;
    const staleRes = await cache.getOrFetch('winget:show:git.git', async () => {
      throw new Error('Offline / Timeout');
    });

    assert.equal(staleRes.fromCache, true);
    assert.equal(staleRes.isStale, true);
    assert.equal(staleRes.updatedAt, initialTs);
    assert.equal(staleRes.data.version, '2.55.0');
    assert.match(staleRes.error, /Offline/);

    // Nochmals später bleibt der Cache weiterhin erhalten
    clock += 30 * 24 * 60 * 60 * 1000;
    const stillThere = cache.get('winget:show:git.git');
    assert.ok(stillThere);
    assert.equal(stillThere.data.version, '2.55.0');
  });

  it('erholt sich sauber von einer beschädigten Cache-Datei', async () => {
    fs.writeFileSync(cacheFile, '{broken-json', 'utf-8');
    const cache = createProviderCache({ filePath: cacheFile });

    const res = await cache.getOrFetch('winget:show:test.app', async () => ({ version: '1.0.0' }));
    assert.equal(res.fromCache, false);
    assert.equal(res.data.version, '1.0.0');
  });
});
