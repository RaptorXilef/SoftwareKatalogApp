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
