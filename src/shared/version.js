/**
 * Extrahiert die erste gültige Versionsnummer (z. B. 1.0 oder 3.0.21.0) aus einem String.
 */
export function extractVersion(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/,\s*/g, '.');
  const match = cleaned.match(/(\d+(?:\.\d+)+)/);
  return match ? match[1] : null;
}

/**
 * Vergleicht zwei Versionsnummern bis zur konfigurierten Stellentiefe.
 * Rückgabe: 1 (v1 > v2), -1 (v1 < v2), 0 (gleich).
 */
export function compareVersions(v1, v2, maxDepth = 3) {
  if (!v1 || !v2) return 0;
  const p1 = String(v1).split('.').map(Number);
  const p2 = String(v2).split('.').map(Number);
  const depth = maxDepth > 0 ? maxDepth : Math.max(p1.length, p2.length);

  for (let i = 0; i < depth; i++) {
    const n1 = p1[i] || 0;
    const n2 = p2[i] || 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

/**
 * Bereinigt einen Namen für Windows/NAS-Dateisysteme.
 */
export function sanitizeFileName(name) {
  return String(name || 'Software')
    .replace(/[<>:"/\\|?*]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Erzeugt einen sauberen Archiv-Dateinamen mit garantierter Versionsnummer.
 * Beispiel: buildArchiveFilename({ softwareName: 'VLC Media Player', version: '3.0.21', originalFilename: 'setup-x64.exe' })
 * -> 'VLC_Media_Player_v3.0.21_x64.exe'
 */
export function buildArchiveFilename({
  softwareName,
  version,
  originalFilename = 'setup.exe',
  pattern = '{Name}_v{Version}{Arch}{Ext}',
  keepIfVersionPresent = true,
}) {
  const safeOriginal = originalFilename.split(/[\\/]/).pop() || 'setup.exe';
  const extMatch = safeOriginal.match(/(\.(?:tar\.gz|tar\.xz|[a-z0-9]{2,5}))$/i);
  const ext = extMatch ? extMatch[1].toLowerCase() : '.exe';

  // Wenn die erkannte Version bereits sauber im Originalnamen steckt, optional übernehmen
  if (keepIfVersionPresent && version && safeOriginal.includes(version)) {
    return safeOriginal.replace(/[<>:"/\\|?*]+/g, '_');
  }

  // Architektur-Hinweis aus Originalnamen retten (x64, arm64, win64, x86)
  const archMatch = safeOriginal.match(/(?:^|[._\-(\s])(x64|amd64|win64|arm64|x86|win32)(?:$|[._\-)\s])/i);
  const arch = archMatch ? `_${archMatch[1].toLowerCase()}` : '';

  if (!version) {
    return `${sanitizeFileName(softwareName)}${arch}${ext}`;
  }

  const cleanName = sanitizeFileName(softwareName);
  return pattern
    .replace('{Name}', cleanName)
    .replace('{Version}', version)
    .replace('{Arch}', arch)
    .replace('{Ext}', ext);
}
