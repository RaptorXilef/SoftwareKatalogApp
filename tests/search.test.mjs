import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scoreCatalogItem } from '../src/shared/search.js';

const vlc = {
  name: 'VLC Mediaplayer',
  mainCategory: 'Video',
  subCategories: ['Player', 'Mediaplayer', 'Open Source', 'Audio', 'Streaming'],
  formats: ['.mp4', '.mkv'],
  description: 'Vielseitiger Open-Source Video- und Audioplayer.',
};

const lav = {
  name: 'LAV Filters',
  mainCategory: 'Video',
  subCategories: ['Codec', 'DirectShow', 'Open Source', 'FFmpeg', 'Splitter', 'Decoder', 'Filter'],
  formats: ['.mkv', '.mp4'],
  description: 'Ermöglicht jedem DirectShow Video Player das Abspielen moderner Formate.',
};

describe('scoreCatalogItem', () => {
  it('rankt VLC Mediaplayer bei "Video Player" deutlich vor LAV Filters und markiert nur VLC als Kerntreffer', () => {
    const vlcRes = scoreCatalogItem(vlc, 'Video Player');
    const lavRes = scoreCatalogItem(lav, 'Video Player');

    assert.equal(vlcRes.matched, true);
    assert.equal(vlcRes.isCoreMatch, true);

    assert.equal(lavRes.matched, true);
    assert.equal(lavRes.isCoreMatch, false);
    assert.ok(vlcRes.score > lavRes.score * 2);
  });

  it('wendet kein Fuzzy-Matching auf Beschreibungen an', () => {
    const res = scoreCatalogItem(lav, 'Vedeo Plaxer');
    assert.equal(res.matched, false);
  });

  it('toleriert leichte Tippfehler im Programmnamen und in Tags', () => {
    const res = scoreCatalogItem(vlc, 'Mediaplayr');
    assert.equal(res.matched, true);
    assert.equal(res.isCoreMatch, true);
  });

  it('findet Dateiformate mit und ohne führenden Punkt', () => {
    const withDot = scoreCatalogItem(vlc, '.mkv');
    const withoutDot = scoreCatalogItem(vlc, 'mkv');
    assert.equal(withDot.matched, true);
    assert.equal(withoutDot.matched, true);
    assert.equal(withDot.isCoreMatch, true);
  });

  it('findet Programme auch über packageId, wingetId und publisher', () => {
    const pkg = {
      name: 'Git',
      packageId: 'Git.Git',
      publisher: 'The Git Development Community',
      tags: ['The Git Development Community'],
    };
    const byId = scoreCatalogItem(pkg, 'Git.Git');
    const byPub = scoreCatalogItem(pkg, 'Development');
    assert.equal(byId.matched, true);
    assert.equal(byId.isCoreMatch, true);
    assert.equal(byPub.matched, true);
    assert.equal(byPub.isCoreMatch, true);
  });
});
