const ARCH_OR_NOISE_RE =
  /(?:^|[\s._(\-[/])(?:x64|x86|amd64|arm64|win64|win32|win10|win11|ia32|64-?bit|32-?bit|sha256|sha512|md5|utf-?8|mp3|mp4|7z)(?=$|[\s._)\-[/])/gi;

/**
 * Extrahiert die erste gültige Versionsnummer mit 1, 2, 3 oder 4+ Stellen
 * (z. B. 1, 1.3, 1.3.5, 1.3.4.21) aus einem String.
 */
export function extractVersion(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace(/,\s*/g, '.').trim();
  if (!cleaned) return null;

  // 1. Mehrteilige Versionsnummern (2, 3, 4+ Stellen: 1.3, 1.3.5, 1.3.4.21)
  const multiMatch = cleaned.match(/(\d+(?:\.\d+)+)/);
  if (multiMatch) return multiMatch[1];

  // 2. Reiner einstelliger Versions-String (z. B. "1", "v2")
  const exactSingle = cleaned.match(/^v?(\d+)$/i);
  if (exactSingle) return exactSingle[1];

  // 3. Einstellige Version mit explizitem Marker (z. B. "App_v1.exe", "Version 2", "Release 3 (64-bit)")
  const strippedNoise = cleaned.replace(ARCH_OR_NOISE_RE, ' ');
  const markedSingle = strippedNoise.match(
    /(?:^|[\s._(\-[/])(?:v(?:er(?:sion)?)?|release|rev)[\s._:-]*(\d+)(?=$|[\s._)\-[/])/i
  );
  if (markedSingle) return markedSingle[1];

  // 4. Freistehende Zahl nach Trennzeichen (z. B. "App_2.exe", "Tool - 3 (x64)")
  const withoutExt = strippedNoise.replace(/\.(?:tar\.gz|tar\.xz|exe|msi|msix|zip|7z|rar|gz)$/i, '');
  const delimitedSingle = withoutExt.match(/(?:[\s._(\-[/])(\d+)(?=$|[\s._)\-[/])/);
  if (delimitedSingle) return delimitedSingle[1];

  return null;
}

function parseVersionParts(version) {
  return String(version)
    .trim()
    .replace(/^v(?=\d)/i, '')
    .replace(/,\s*/g, '.')
    .split('.')
    .map((seg) => {
      const m = seg.trim().match(/^(\d+)/);
      return m ? Number(m[1]) : 0;
    });
}

/**
 * Vergleicht zwei Versionsnummern bis zur konfigurierten Stellentiefe.
 * Rückgabe: 1 (v1 > v2), -1 (v1 < v2), 0 (gleich).
 */
export function compareVersions(v1, v2, maxDepth = 3) {
  if (!v1 || !v2) return 0;
  const p1 = parseVersionParts(v1);
  const p2 = parseVersionParts(v2);
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
