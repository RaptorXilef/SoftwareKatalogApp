import { cleanCliLines } from './winget-parser.js';

const VALID_CHOCO_ID_RE = /^[A-Za-z0-9._+-]+$/;

/**
 * Prüft, ob eine Chocolatey-Paket-ID gültig und sicher für CLI/PowerShell-Aufrufe ist.
 * @param {unknown} packageId
 * @returns {boolean}
 */
export function isValidChocoPackageId(packageId) {
  if (typeof packageId !== 'string') return false;
  const clean = packageId.trim();
  if (!clean || /\s/.test(clean)) return false;
  return VALID_CHOCO_ID_RE.test(clean);
}

function parsePipePackages(stdout, limit = Number.POSITIVE_INFINITY) {
  const lines = cleanCliLines(stdout);
  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const results = [];
  const seen = new Set();

  for (const rawLine of lines) {
    if (results.length >= maxResults) break;
    const trimmed = rawLine.trim();
    if (!trimmed.includes('|')) continue;

    const parts = trimmed.split('|');
    if (parts.length < 2) continue;

    const id = parts[0].trim();
    const version = parts[1].trim();
    if (!isValidChocoPackageId(id)) continue;

    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      packageManager: 'chocolatey',
      packageId: id,
      id,
      name: id,
      version,
      source: 'chocolatey',
    });
  }

  return results;
}

/**
 * Parst `choco list -r` (Format `name|version`).
 * @param {string} stdout
 */
export function parseChocoListOutput(stdout) {
  return parsePipePackages(stdout);
}

/**
 * Parst `choco search <query> -r` (Format `name|version`).
 * @param {string} stdout
 * @param {number} [limit]
 */
export function parseChocoSearchOutput(stdout, limit = 25) {
  return parsePipePackages(stdout, limit);
}

/**
 * Parst `choco outdated -r` (Format `id|currentVersion|availableVersion|pinned`).
 * @param {string} stdout
 * @param {{ includePinned?: boolean }} [options]
 */
export function parseChocoOutdatedOutput(stdout, { includePinned = false } = {}) {
  const lines = cleanCliLines(stdout);
  const results = [];
  const seen = new Set();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.includes('|')) continue;

    const parts = trimmed.split('|');
    if (parts.length < 3) continue;

    const id = parts[0].trim();
    const installedVersion = parts[1].trim();
    const availableVersion = parts[2].trim();
    const pinnedRaw = (parts[3] || '').trim().toLowerCase();
    const pinned = pinnedRaw === 'true' || pinnedRaw === '1' || pinnedRaw === 'yes';

    if (!isValidChocoPackageId(id) || !installedVersion || !availableVersion) continue;
    if (installedVersion === availableVersion) continue;
    if (!includePinned && pinned) continue;

    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      packageManager: 'chocolatey',
      packageId: id,
      id,
      name: id,
      installedVersion,
      availableVersion,
      pinned,
      source: 'chocolatey',
    });
  }

  return results;
}

/**
 * Parst die Ausgabe von `choco info <pkg>`.
 * @param {string} stdout
 * @param {string} [fallbackPackageId]
 */
export function parseChocoInfoOutput(stdout, fallbackPackageId = '') {
  const lines = cleanCliLines(stdout);
  const result = {
    name: '',
    packageManager: 'chocolatey',
    packageId: fallbackPackageId ? String(fallbackPackageId).trim() : '',
    version: '',
    publisher: '',
    author: '',
    shortDescription: '',
    description: '',
    homepage: '',
    license: '',
    licenseUrl: '',
    releaseNotesUrl: '',
    tags: [],
  };

  let activeField = null;
  const descriptionLines = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (activeField === 'description' && descriptionLines.length > 0) {
        descriptionLines.push('');
      }
      continue;
    }

    // Header-Zeile: z. B. "git 2.47.1 [Approved]"
    if (!result.version && !trimmed.includes(':')) {
      const headerMatch = trimmed.match(/^([A-Za-z0-9._+-]+)\s+(\S+)(?:\s+\[.*\])?$/);
      if (headerMatch && isValidChocoPackageId(headerMatch[1]) && /^\d/.test(headerMatch[2])) {
        result.packageId = result.packageId || headerMatch[1].trim();
        result.version = headerMatch[2].trim();
        continue;
      }
    }

    const kvMatch = trimmed.match(/^([^:]+):(.*)$/);
    const isIndented = /^\s{2,}\S/.test(rawLine);

    if (kvMatch && (!isIndented || activeField !== 'description')) {
      const key = kvMatch[1].trim().toLowerCase();
      const val = kvMatch[2].trim();
      activeField = null;

      if (key === 'title') {
        const pipeIdx = val.indexOf('|');
        const titlePart = pipeIdx !== -1 ? val.slice(0, pipeIdx).trim() : val;
        if (titlePart) result.name = titlePart;
      } else if (key === 'summary') {
        result.shortDescription = val;
      } else if (key === 'description') {
        activeField = 'description';
        if (val) descriptionLines.push(val);
      } else if (key === 'tags') {
        if (val) {
          result.tags = [
            ...new Set(
              val
                .split(/[\s,]+/)
                .map((t) => t.trim())
                .filter(Boolean)
            ),
          ];
        }
      } else if (key === 'software site' || key === 'project site') {
        result.homepage = val;
      } else if (key === 'software license' || key === 'license') {
        if (/^https?:\/\//i.test(val)) {
          result.licenseUrl = val;
        } else {
          result.license = val;
        }
      } else if (key === 'software authors' || key === 'author' || key === 'authors') {
        result.author = val;
        if (!result.publisher) result.publisher = val;
      } else if (key === 'release notes') {
        if (/^https?:\/\//i.test(val)) {
          result.releaseNotesUrl = val;
        }
      }
      continue;
    }

    if (activeField === 'description') {
      descriptionLines.push(trimmed);
    }
  }

  result.description = descriptionLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!result.shortDescription && result.description) {
    const firstPara = result.description
      .split(/\n{2,}/)[0]
      .replace(/\s+/g, ' ')
      .trim();
    result.shortDescription = firstPara.length <= 200 ? firstPara : `${firstPara.slice(0, 197).trim()}...`;
  } else if (!result.description && result.shortDescription) {
    result.description = result.shortDescription;
  }

  if (!result.name) {
    result.name = result.packageId;
  }

  return result;
}
