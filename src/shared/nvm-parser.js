import { compareVersions } from './version.js';
import { cleanCliLines } from './winget-parser.js';

const NVM_VERSION_RE = /^v?(\d+(?:\.\d+){0,2})$/i;
const NVM_ALIASES = new Set(['lts', 'latest', 'newest', 'current']);

/**
 * Normalisiert eine Node.js-Versionsnummer (entfernt führendes "v").
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeNodeVersion(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return trimmed.replace(/^v(?=\d)/i, '').trim();
}

/**
 * Validiert sichere Node.js-Versionsangaben für `nvm install/uninstall/use`.
 * @param {unknown} version
 * @param {{ allowAliases?: boolean }} [options]
 * @returns {boolean}
 */
export function isValidNvmVersion(version, { allowAliases = false } = {}) {
  const clean = String(version || '').trim();
  if (!clean || /\s/.test(clean)) return false;
  if (allowAliases && NVM_ALIASES.has(clean.toLowerCase())) return true;
  return NVM_VERSION_RE.test(clean);
}

/**
 * Parst die Ausgabe von `nvm list` (inkl. `*`-Markierung für die aktive Version).
 * @param {string} stdout
 */
export function parseNvmListOutput(stdout) {
  const lines = cleanCliLines(String(stdout || '').replace(/^\uFEFF/, ''));
  const results = [];
  const seen = new Set();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || /no installations recognized/i.test(trimmed)) continue;

    const match = trimmed.match(/^(\*)?\s*v?(\d+\.\d+\.\d+)(?:\s*\(([^)]+)\))?/i);
    if (!match) continue;

    const isActive = Boolean(match[1]);
    const version = normalizeNodeVersion(match[2]);
    const note = String(match[3] || '').trim();
    const archMatch = note.match(/\b(64-bit|32-bit)\b/i);
    const arch = archMatch ? archMatch[1].toLowerCase() : '';

    if (!version || seen.has(version)) continue;
    seen.add(version);

    results.push({
      packageManager: 'nvm',
      packageId: version,
      id: version,
      name: `Node.js v${version}`,
      version,
      isActive,
      arch,
      source: 'nvm',
    });
  }

  return results;
}

const CHANNEL_PRIORITY = new Map([
  ['LTS', 1],
  ['Current', 2],
  ['Old Stable', 3],
  ['Old Unstable', 4],
]);

function normalizeChannelName(rawHeader, fallbackIndex) {
  const h = String(rawHeader || '')
    .trim()
    .toLowerCase();
  if (h.includes('lts')) return 'LTS';
  if (h.includes('current')) return 'Current';
  if (h.includes('unstable')) return 'Old Unstable';
  if (h.includes('stable') || h.includes('old')) return 'Old Stable';
  if (fallbackIndex === 0) return 'Current';
  if (fallbackIndex === 1) return 'LTS';
  if (fallbackIndex === 2) return 'Old Stable';
  return 'Old Unstable';
}

/**
 * Parst die 4-spaltige ASCII-Tabelle von `nvm list available` und filtert nach Channel oder Version.
 * @param {string} stdout
 * @param {{ query?: string, limit?: number }} [options]
 */
export function parseNvmListAvailableOutput(stdout, { query = '', limit = 30 } = {}) {
  const lines = cleanCliLines(String(stdout || '').replace(/^\uFEFF/, ''));
  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;

  let columnChannels = ['Current', 'LTS', 'Old Stable', 'Old Unstable'];
  const byVersion = new Map();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed?.includes('|')) continue;
    if (/^[\s|+-]+$/.test(trimmed)) continue;

    const cells = trimmed
      .split('|')
      .map((c) => c.trim())
      .filter((_, idx, arr) => {
        if (idx === 0 && trimmed.startsWith('|')) return false;
        if (idx === arr.length - 1 && trimmed.endsWith('|')) return false;
        return true;
      });

    if (cells.length === 0) continue;

    const hasHeaderWords = cells.some((c) => /\b(current|lts|old stable|old unstable)\b/i.test(c));
    if (hasHeaderWords) {
      columnChannels = cells.map((cell, idx) => normalizeChannelName(cell, idx));
      continue;
    }

    for (let colIdx = 0; colIdx < cells.length; colIdx++) {
      const verMatch = cells[colIdx].match(/^v?(\d+\.\d+\.\d+)$/i);
      if (!verMatch) continue;
      const version = normalizeNodeVersion(verMatch[1]);
      const channel = columnChannels[colIdx] || 'Current';

      const existing = byVersion.get(version);
      if (!existing || (CHANNEL_PRIORITY.get(channel) ?? 99) < (CHANNEL_PRIORITY.get(existing.channel) ?? 99)) {
        byVersion.set(version, { version, channel });
      }
    }
  }

  const queryWords = String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const filtered = [...byVersion.values()].filter(({ version, channel }) => {
    if (queryWords.length === 0) return true;
    const channelLower = channel.toLowerCase();
    const hay = `node nodejs v${version} ${version} ${channelLower}`;
    return queryWords.every((word) => {
      const cleanWord = word.replace(/^v(?=\d)/i, '');
      return hay.includes(word) || (cleanWord && version.includes(cleanWord));
    });
  });

  filtered.sort((a, b) => {
    const prioA = CHANNEL_PRIORITY.get(a.channel) ?? 99;
    const prioB = CHANNEL_PRIORITY.get(b.channel) ?? 99;
    if (prioA !== prioB) return prioA - prioB;
    return compareVersions(b.version, a.version, 3);
  });

  return filtered.slice(0, maxResults).map(({ version, channel }) => ({
    packageManager: 'nvm',
    packageId: version,
    id: version,
    name: channel === 'LTS' ? `Node.js v${version} (LTS)` : `Node.js v${version}`,
    version,
    channel,
    shortDescription: `Node.js ${channel} Release (${version})`,
    tags: [channel.toLowerCase()],
    source: 'nvm',
  }));
}

function getMajorVersion(version) {
  const clean = normalizeNodeVersion(version);
  if (!clean) return Number.NaN;
  const first = clean.split('.')[0];
  const parsed = Number.parseInt(first, 10);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Parst die offizielle Node.js-Release-Liste (`https://nodejs.org/dist/index.json`)
 * in einheitliche NVM-Release-Eintraege.
 * @param {string | Array<Record<string, any>>} raw
 * @param {{ limit?: number }} [options]
 */
export function parseNodeDistIndexJson(raw, { limit = 0 } = {}) {
  let entries = [];
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/^\uFEFF/, '').trim();
    if (!cleaned) return [];
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      return [];
    }
  } else if (Array.isArray(raw)) {
    entries = raw;
  }

  if (entries.length === 0) return [];

  const byVersion = new Map();
  let highestNonLtsMajor = -1;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const version = normalizeNodeVersion(entry.version);
    if (!isValidNvmVersion(version) || !/^\d+\.\d+\.\d+$/.test(version)) continue;
    if (byVersion.has(version)) continue;

    const major = getMajorVersion(version);
    if (!Number.isFinite(major)) continue;

    const lts = entry.lts && typeof entry.lts === 'string' ? entry.lts.trim() : Boolean(entry.lts);
    if (!lts && major > highestNonLtsMajor) {
      highestNonLtsMajor = major;
    }

    byVersion.set(version, {
      version,
      major,
      lts,
      date: typeof entry.date === 'string' ? entry.date.trim() : '',
    });
  }

  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const list = [...byVersion.values()].map((item) => {
    const channel = item.lts ? 'LTS' : item.major === highestNonLtsMajor ? 'Current' : 'Old Stable';
    return {
      packageManager: 'nvm',
      packageId: item.version,
      id: item.version,
      name: channel === 'LTS' ? `Node.js v${item.version} (LTS)` : `Node.js v${item.version}`,
      version: item.version,
      major: item.major,
      lts: item.lts,
      channel,
      date: item.date,
      source: 'nvm',
    };
  });

  list.sort((a, b) => compareVersions(b.version, a.version, 3));
  return list.slice(0, maxResults);
}

/**
 * Vergleicht ueber `nvm list` installierte Node.js-Versionen mit verfuegbaren Releases
 * (primaer innerhalb derselben Major-Reihe, z. B. 26.12.1 -> 26.13.1, sowie optional neuester LTS/Current).
 * @param {Array<Record<string, any>>} [installedPackages]
 * @param {Array<Record<string, any>>} [availableVersions]
 * @param {{ includeLatestLts?: boolean, includeLatestCurrent?: boolean }} [options]
 */
export function computeNvmUpgrades(
  installedPackages = [],
  availableVersions = [],
  { includeLatestLts = true, includeLatestCurrent = false } = {}
) {
  if (!Array.isArray(installedPackages) || installedPackages.length === 0) return [];
  if (!Array.isArray(availableVersions) || availableVersions.length === 0) return [];

  const highestByMajor = new Map();
  let latestLts = null;
  let latestCurrent = null;
  let overallHighest = null;

  for (const raw of availableVersions) {
    const rawVer = typeof raw === 'string' ? raw : raw?.version || raw?.packageId || raw?.id;
    const version = normalizeNodeVersion(rawVer);
    if (!isValidNvmVersion(version) || !/^\d+\.\d+\.\d+$/.test(version)) continue;

    const major = Number.isFinite(Number(raw?.major)) ? Number(raw.major) : getMajorVersion(version);
    if (!Number.isFinite(major)) continue;

    const channel = typeof raw === 'object' && raw?.channel ? String(raw.channel).trim() : '';
    const isLts = channel.toLowerCase() === 'lts' || Boolean(typeof raw === 'object' && raw?.lts);
    const isCurrent = channel.toLowerCase() === 'current';
    const entry = { version, major, channel: channel || (isLts ? 'LTS' : ''), isLts, isCurrent };

    const prevMajor = highestByMajor.get(major);
    if (!prevMajor || compareVersions(entry.version, prevMajor.version, 3) > 0) {
      highestByMajor.set(major, entry);
    }

    if (isLts && (!latestLts || compareVersions(entry.version, latestLts.version, 3) > 0)) {
      latestLts = entry;
    }
    if (isCurrent && (!latestCurrent || compareVersions(entry.version, latestCurrent.version, 3) > 0)) {
      latestCurrent = entry;
    }
    if (!overallHighest || compareVersions(entry.version, overallHighest.version, 3) > 0) {
      overallHighest = entry;
    }
  }

  if (!latestCurrent) {
    latestCurrent = overallHighest;
  }

  const normalizedInstalled = [];
  const installedSet = new Set();
  let highestInstalledMajor = -1;

  for (const inst of installedPackages) {
    const version = normalizeNodeVersion(inst?.version || inst?.packageId || inst?.id);
    if (!isValidNvmVersion(version) || !/^\d+\.\d+\.\d+$/.test(version)) continue;
    const major = getMajorVersion(version);
    if (!Number.isFinite(major)) continue;

    installedSet.add(version);
    if (major > highestInstalledMajor) {
      highestInstalledMajor = major;
    }
    normalizedInstalled.push({
      version,
      major,
      name: String(inst?.name || `Node.js v${version}`).trim(),
      isActive: Boolean(inst?.isActive),
      arch: String(inst?.arch || '').trim(),
    });
  }

  const upgrades = [];
  const seenInstalled = new Set();

  for (const inst of normalizedInstalled) {
    if (seenInstalled.has(inst.version)) continue;
    seenInstalled.add(inst.version);

    let target = null;
    const bestSameMajor = highestByMajor.get(inst.major);
    if (
      bestSameMajor &&
      compareVersions(bestSameMajor.version, inst.version, 3) > 0 &&
      !installedSet.has(bestSameMajor.version)
    ) {
      target = bestSameMajor;
    } else if (inst.major === highestInstalledMajor) {
      if (
        includeLatestLts &&
        latestLts &&
        latestLts.major > highestInstalledMajor &&
        compareVersions(latestLts.version, inst.version, 3) > 0 &&
        !installedSet.has(latestLts.version)
      ) {
        target = latestLts;
      } else if (
        includeLatestCurrent &&
        latestCurrent &&
        latestCurrent.major > highestInstalledMajor &&
        compareVersions(latestCurrent.version, inst.version, 3) > 0 &&
        !installedSet.has(latestCurrent.version)
      ) {
        target = latestCurrent;
      }
    }

    if (!target) continue;

    upgrades.push({
      packageManager: 'nvm',
      packageId: inst.version,
      id: inst.version,
      name: inst.name || `Node.js v${inst.version}`,
      installedVersion: inst.version,
      availableVersion: target.version,
      isActive: inst.isActive,
      arch: inst.arch,
      channel: target.channel || '',
      source: 'nvm',
    });
  }

  return upgrades;
}
