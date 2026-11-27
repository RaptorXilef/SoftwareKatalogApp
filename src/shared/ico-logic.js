const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Extrahiert den groessten eingebetteten PNG-Frame (z. B. 256x256) aus einer Windows-.ico-Datei.
 * @param {Buffer | Uint8Array | null | undefined} rawBuffer
 * @returns {Buffer | null}
 */
export function extractPngFromIcoBuffer(rawBuffer) {
  if (!rawBuffer || rawBuffer.byteLength < 22) return null;
  const buf = Buffer.isBuffer(rawBuffer)
    ? rawBuffer
    : Buffer.from(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);

  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1 || count < 1) return null;

  const dirEnd = 6 + count * 16;
  if (dirEnd > buf.length) return null;

  /** @type {{ width: number, height: number, size: number, offset: number } | null} */
  let best = null;

  for (let i = 0; i < count; i++) {
    const entryOffset = 6 + i * 16;
    const width = buf[entryOffset] || 256;
    const height = buf[entryOffset + 1] || 256;
    const size = buf.readUInt32LE(entryOffset + 8);
    const offset = buf.readUInt32LE(entryOffset + 12);

    if (size < PNG_SIGNATURE.length || offset < dirEnd || offset + size > buf.length) {
      continue;
    }

    if (!buf.subarray(offset, offset + PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      continue;
    }

    const area = width * height;
    const bestArea = best ? best.width * best.height : -1;
    if (!best || area > bestArea || (area === bestArea && size > best.size)) {
      best = { width, height, size, offset };
    }
  }

  if (!best) return null;
  return Buffer.from(buf.subarray(best.offset, best.offset + best.size));
}
