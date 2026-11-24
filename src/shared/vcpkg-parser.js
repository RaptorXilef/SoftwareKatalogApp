import path from 'node:path';
import { normalizeProviderVersion } from './provider-lifecycle-logic.js';
import { cleanCliLines } from './winget-parser.js';

const VCPKG_PORT_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?(?::[A-Za-z0-9._-]+)?$/;

/**
 * Validiert vcpkg-Port-Namen (optional mit `[features]` und `:triplet`, z. B. `zlib:x64-windows` oder `curl[ssl]:x64-windows`).
 * @param {unknown} portName
 * @returns {boolean}
 */
export function isValidVcpkgPortName(portName) {
  const clean = String(portName || '').trim();
  if (!clean || clean.length > 200 || /\s/.test(clean)) return false;
  return VCPKG_PORT_SPEC_RE.test(clean);
}

/**
 * Extrahiert den reinen Port-Namen ohne `[features]` und `:triplet`.
 * @param {unknown} packageId
 * @returns {string}
 */
export function extractVcpkgBasePort(packageId) {
  const clean = String(packageId || '').trim();
  if (!clean) return '';
  return clean.split(':')[0].split('[')[0].trim();
}

/**
 * Extrahiert das vcpkg-Datum/Version aus `vcpkg --version`.
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseVcpkgVersionOutput(stdout) {
  const clean = cleanCliLines(String(stdout || '').replace(/^\uFEFF/, '')).join(' ');
  if (!clean) return null;
  const dateMatch = clean.match(/version\s+(\d{4}-\d{2}-\d{2})/i);
  if (dateMatch) return normalizeProviderVersion(dateMatch[1]);
  const semverMatch = clean.match(/\bv?(\d+\.\d+(?:\.\d+)*)/);
  return semverMatch ? normalizeProviderVersion(semverMatch[1]) : null;
}

/**
 * Parst `vcpkg list` Ausgabe (`<port>:<triplet>  <version>  <description>`).
 * Feature-Unterzeilen (`port[feature]:triplet`) werden uebersprungen.
 * @param {string} rawText
 */
export function parseVcpkgListOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = cleanCliLines(rawText.replace(/^\uFEFF/, ''));
  const results = [];
  const seen = new Set();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^no packages are installed\.?$/i.test(trimmed)) return [];
    if (/^(?:warning|error|note):/i.test(trimmed)) continue;

    const match = trimmed.match(/^([^\s]+)\s{2,}([^\s]+)(?:\s{2,}(.*))?$/);
    if (!match) continue;

    const spec = match[1].trim();
    if (spec.includes('[')) continue; // Feature-Zeile nicht als eigenes Paket doppelt zaehlen

    const colonIdx = spec.indexOf(':');
    const port = colonIdx > 0 ? spec.slice(0, colonIdx).trim() : spec;
    const triplet = colonIdx > 0 ? spec.slice(colonIdx + 1).trim() : '';
    if (!port || !isValidVcpkgPortName(spec)) continue;

    const key = spec.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const rawVer = match[2].trim();
    const version = rawVer.replace(/#\d+$/, '').trim();
    const shortDescription = String(match[3] || '').trim();

    results.push({
      packageManager: 'vcpkg',
      packageId: spec,
      id: spec,
      name: triplet ? `${port} (${triplet})` : port,
      port,
      triplet,
      version,
      shortDescription,
      source: 'vcpkg',
    });
  }

  return results;
}

/**
 * Parst `vcpkg search <query>` Ausgabe (`<port>  <version>  <description>`).
 * @param {string} rawText
 * @param {number} [limit]
 */
export function parseVcpkgSearchOutput(rawText, limit = 25) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = cleanCliLines(rawText.replace(/^\uFEFF/, ''));
  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const results = [];
  const seen = new Set();

  for (const rawLine of lines) {
    if (results.length >= maxResults) break;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (
      /^(?:the result may be outdated|if your port is not listed|no packages matching|warning:|error:|note:)/i.test(
        trimmed
      )
    ) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s{2,}([^\s]+)(?:\s{2,}(.*))?$/);
    if (!match) continue;

    const port = match[1].trim();
    const rawVer = match[2].trim();
    if (!/\d/.test(rawVer)) continue;

    const key = port.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const version = rawVer.replace(/#\d+$/, '').trim();
    const desc = String(match[3] || '').trim();

    results.push({
      packageManager: 'vcpkg',
      packageId: port,
      id: port,
      name: port,
      version,
      shortDescription: desc,
      description: desc,
      homepage: `https://vcpkg.io/en/package/${encodeURIComponent(port)}`,
      source: 'vcpkg',
    });
  }

  return results;
}

/**
 * Parst die Dry-Run-Ausgabe von `vcpkg upgrade`.
 * Beispiel: `* zlib:x64-windows  1.3.0 -> 1.3.1`
 * @param {string} rawText
 */
export function parseVcpkgUpgradeOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = cleanCliLines(rawText.replace(/^\uFEFF/, ''));
  const upgrades = [];
  const seen = new Set();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^all installed packages are up-to-date/i.test(trimmed)) return [];

    const match = trimmed.match(/^\*?\s*([^\s]+)\s+([^\s]+)\s*->\s*([^\s]+)/);
    if (!match) continue;

    const spec = match[1].trim();
    if (!isValidVcpkgPortName(spec) || spec.includes('[')) continue;

    const key = spec.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const port = extractVcpkgBasePort(spec);
    const installedVersion = match[2].trim().replace(/#\d+$/, '');
    const availableVersion = match[3].trim().replace(/#\d+$/, '');
    if (!availableVersion || installedVersion === availableVersion) continue;

    upgrades.push({
      packageManager: 'vcpkg',
      packageId: spec,
      id: spec,
      name: spec.includes(':') ? `${port} (${spec.split(':')[1]})` : port,
      installedVersion,
      availableVersion,
      source: 'vcpkg',
    });
  }

  return upgrades;
}

/**
 * Parst eine lokale `ports/<port>/vcpkg.json` Manifest-Datei fuer `show()`.
 * @param {unknown} rawJsonOrObj
 * @param {string} [fallbackPort]
 */
export function parseVcpkgManifestJson(rawJsonOrObj, fallbackPort = '') {
  let parsed = rawJsonOrObj;
  if (typeof rawJsonOrObj === 'string') {
    try {
      parsed = JSON.parse(rawJsonOrObj.replace(/^\uFEFF/, ''));
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  /** @type {Record<string, any>} */
  const manifest = parsed;
  const name = String(manifest.name || extractVcpkgBasePort(fallbackPort) || '').trim();
  if (!name) return null;

  const rawVersion =
    manifest.version ?? manifest['version-semver'] ?? manifest['version-date'] ?? manifest['version-string'];
  const version = String(rawVersion || '').trim();

  const rawDesc = manifest.description;
  const description = Array.isArray(rawDesc)
    ? rawDesc
        .map((d) => String(d || '').trim())
        .filter(Boolean)
        .join('\n')
    : String(rawDesc || '').trim();
  const shortDescription = description.length <= 200 ? description : `${description.slice(0, 197).trim()}...`;

  const homepage = String(manifest.homepage || '').trim() || `https://vcpkg.io/en/package/${encodeURIComponent(name)}`;
  const license = String(manifest.license || '').trim();

  return {
    name,
    packageManager: 'vcpkg',
    packageId: fallbackPort || name,
    version,
    publisher: 'Microsoft vcpkg',
    author: '',
    shortDescription,
    description,
    homepage,
    repositoryUrl: 'https://github.com/microsoft/vcpkg',
    license,
    licenseUrl: '',
    tags: [],
  };
}

/**
 * Prueft vor dem Loeschen eines vcpkg-Ordners, ob kein kritisches System- oder Wurzelverzeichnis getroffen wird.
 * @param {unknown} dirPath
 * @returns {boolean}
 */
export function isSafeVcpkgUninstallDir(dirPath) {
  if (typeof dirPath !== 'string') return false;
  const trimmed = dirPath.trim();
  if (!trimmed) return false;

  const normalized = path.win32.normalize(trimmed).replace(/[\\/]+$/, '');
  const lower = normalized.toLowerCase();

  // Laufwerkswurzeln, Windows-, Programme-, Benutzer- und AppData-Wurzeln strikt sperren
  if (/^[a-z]:$/i.test(lower) || lower === '\\' || lower === '/') return false;
  const parts = lower.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return false;

  const forbidden = new Set([
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\programdata',
    'c:\\users',
  ]);
  if (forbidden.has(lower)) return false;
  if (/^[a-z]:\\users\\[^\\]+$/.test(lower)) return false;
  if (/^[a-z]:\\users\\[^\\]+\\appdata(?:\\(?:local|roaming))?$/.test(lower)) return false;

  return true;
}
