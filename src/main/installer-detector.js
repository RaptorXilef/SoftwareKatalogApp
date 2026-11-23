import fs from 'node:fs';
import path from 'node:path';
import { detectAdwareSignals, detectInstallerFromBuffer } from '../shared/installer-logic.js';

const DEFAULT_HEAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_TAIL_BYTES = 1024 * 1024;

/**
 * Liest sicher den Anfang und das Ende einer Binärdatei ohne Ausführung,
 * um PE-Strings und Overlay-Metadaten (Inno, NSIS, WiX, InstallShield) auszulesen.
 */
async function readSafeBinarySample(filePath, headBytes = DEFAULT_HEAD_BYTES, tailBytes = DEFAULT_TAIL_BYTES) {
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const size = stat.size;
    if (size === 0) return Buffer.alloc(0);

    if (size <= headBytes + tailBytes) {
      const fullBuf = Buffer.allocUnsafe(size);
      const { bytesRead } = await fh.read(fullBuf, 0, size, 0);
      return fullBuf.subarray(0, bytesRead);
    }

    const headBuf = Buffer.allocUnsafe(headBytes);
    const tailBuf = Buffer.allocUnsafe(tailBytes);
    const headRes = await fh.read(headBuf, 0, headBytes, 0);
    const tailRes = await fh.read(tailBuf, 0, tailBytes, size - tailBytes);

    return Buffer.concat([
      headBuf.subarray(0, headRes.bytesRead),
      Buffer.from('\n'),
      tailBuf.subarray(0, tailRes.bytesRead),
    ]);
  } finally {
    await fh.close();
  }
}

/**
 * Analysiert eine lokale .exe/.msi-Setup-Datei ohne Ausführung auf Installer-Typ und Adware-Warnsignale.
 */
export async function detectInstallerFile(filePath, { name = '', packageId = '', publisher = '' } = {}) {
  const cleanPath = String(filePath || '').trim();
  if (!cleanPath) {
    return { success: false, error: 'Keine Setup-Datei angegeben.' };
  }

  try {
    const stat = await fs.promises.stat(cleanPath);
    if (!stat.isFile()) {
      return { success: false, error: 'Der angegebene Pfad ist keine gültige Datei.' };
    }

    const fileName = path.basename(cleanPath);
    const ext = path.extname(fileName).toLowerCase();

    let sample = null;
    if (ext === '.exe') {
      sample = await readSafeBinarySample(cleanPath);
    }

    const detection = detectInstallerFromBuffer(fileName, sample);
    const adwareWarning = detectAdwareSignals({
      name,
      fileName,
      packageId,
      publisher,
      buffer: sample,
    });

    return {
      success: true,
      filePath: cleanPath,
      fileName,
      type: detection.type,
      label: detection.label,
      suggestedArgs: detection.suggestedArgs,
      supportsInf: detection.supportsInf,
      hint: detection.hint,
      matchedSignature: detection.matchedSignature,
      adwareWarning,
    };
  } catch (err) {
    return {
      success: false,
      error: err?.message || 'Setup-Datei konnte nicht analysiert werden.',
    };
  }
}
