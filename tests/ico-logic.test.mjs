import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { extractPngFromIcoBuffer } from '../src/shared/ico-logic.js';

describe('ico-logic: extractPngFromIcoBuffer', () => {
  it('extrahiert den eingebetteten 256x256 PNG-Frame aus build/icon.ico', () => {
    const icoPath = path.join(process.cwd(), 'build', 'icon.ico');
    const raw = fs.readFileSync(icoPath);
    const png = extractPngFromIcoBuffer(raw);

    assert.ok(Buffer.isBuffer(png));
    assert.ok(png.length > 1000);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  });

  it('liefert null bei leeren, beschaedigten oder nicht-ICO Puffern', () => {
    assert.equal(extractPngFromIcoBuffer(null), null);
    assert.equal(extractPngFromIcoBuffer(Buffer.alloc(10)), null);
    assert.equal(extractPngFromIcoBuffer(Buffer.from('not an ico file')), null);
  });
});
