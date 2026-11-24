import { normalizeProviderVersion } from './provider-lifecycle-logic.js';
import { cleanCliLines } from './winget-parser.js';

const CARGO_CRATE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function stripBomAndAnsi(text) {
  if (!text || typeof text !== 'string') return '';
  return cleanCliLines(text.replace(/^\uFEFF/, ''))
    .join('\n')
    .trim();
}

function parseJsonSafe(raw) {
  if (raw && typeof raw === 'object') return raw;
  const clean = stripBomAndAnsi(String(raw || ''));
  if (!clean) return null;
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function normalizeHttpUrl(rawUrl) {
  const clean = String(rawUrl || '').trim();
  if (!clean) return '';
  try {
    const parsed = new URL(clean);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href.replace(/\/+$/, '');
    }
  } catch {
    return '';
  }
  return '';
}

/**
 * Validiert Cargo-Crate-Namen (Buchstabe am Anfang, Buchstaben/Ziffern/`_`/`-`, max. 64 Zeichen).
 * @param {unknown} crateName
 * @returns {boolean}
 */
export function isValidCargoCrateName(crateName) {
  const clean = String(crateName || '').trim();
  if (!clean || clean.length > 64 || /\s/.test(clean)) return false;
  return CARGO_CRATE_NAME_RE.test(clean);
}

/**
 * Extrahiert die Cargo-Version aus `cargo --version`.
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseCargoVersionOutput(stdout) {
  const clean = stripBomAndAnsi(stdout);
  if (!clean) return null;
  const match = clean.match(/\bcargo\s+v?(\d+\.\d+\.\d+(?:[-+._a-z0-9]*)?)/i);
  if (match) return normalizeProviderVersion(match[1]);
  const fallback = clean.match(/\bv?(\d+\.\d+(?:\.\d+)*)/);
  return fallback ? normalizeProviderVersion(fallback[1]) : null;
}

/**
 * Parst die Ausgabe von `cargo install --list`.
 * Beispiel:
 *   ripgrep v14.1.1:
 *       rg.exe
 *   bat v0.24.0 (C:\src\bat):
 *       bat.exe
 * @param {string} rawText
 */
export function parseCargoInstallListOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = cleanCliLines(rawText.replace(/^\uFEFF/, ''));
  const results = [];
  const seen = new Set();
  /** @type {{ packageManager: string, packageId: string, id: string, name: string, version: string, binaries: string[], source: string } | null} */
  let current = null;

  for (const rawLine of lines) {
    if (!rawLine?.trim()) continue;
    const isIndented = /^\s+/.test(rawLine);
    const trimmed = rawLine.trim();

    if (isIndented && current) {
      const binName = trimmed.replace(/:$/, '').trim();
      if (binName && !current.binaries.includes(binName)) {
        current.binaries.push(binName);
      }
      continue;
    }

    const crateMatch = trimmed.match(
      /^([A-Za-z][A-Za-z0-9_-]*)\s+v?(\d+\.\d+\.\d+(?:[-+._A-Za-z0-9]*)?)(?:\s+\([^)]+\))?:\s*$/
    );
    if (!crateMatch) {
      current = null;
      continue;
    }

    const name = crateMatch[1].trim();
    const key = name.toLowerCase();
    if (seen.has(key)) {
      current = null;
      continue;
    }
    seen.add(key);

    const version = normalizeProviderVersion(crateMatch[2]) || '';
    current = {
      packageManager: 'cargo',
      packageId: name,
      id: name,
      name,
      version,
      binaries: [],
      source: 'cargo',
    };
    results.push(current);
  }

  return results;
}

/**
 * Parst Suchergebnisse von `https://crates.io/api/v1/crates?q=<query>&per_page=20`.
 * @param {unknown} rawJsonOrObj
 * @param {number} [limit]
 */
export function parseCratesIoSearchJson(rawJsonOrObj, limit = 20) {
  const parsed = parseJsonSafe(rawJsonOrObj);
  if (!parsed || typeof parsed !== 'object') return [];

  const crates = Array.isArray(parsed.crates) ? parsed.crates : [];
  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const results = [];
  const seen = new Set();

  for (const entry of crates) {
    if (results.length >= maxResults) break;
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.id || entry.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const version =
      normalizeProviderVersion(entry.max_stable_version || entry.max_version || entry.newest_version) || '';
    const desc = String(entry.description || '').trim();
    const homepage = normalizeHttpUrl(entry.homepage) || `https://crates.io/crates/${encodeURIComponent(name)}`;
    const repositoryUrl = normalizeHttpUrl(entry.repository);

    results.push({
      packageManager: 'cargo',
      packageId: name,
      id: name,
      name,
      version,
      shortDescription: desc,
      description: desc,
      homepage,
      repositoryUrl,
      source: 'cargo',
    });
  }

  return results;
}

/**
 * Parst Details von `https://crates.io/api/v1/crates/<name>`.
 * @param {unknown} rawJsonOrObj
 * @param {string} [fallbackCrateName]
 */
export function parseCratesIoShowJson(rawJsonOrObj, fallbackCrateName = '') {
  const parsed = parseJsonSafe(rawJsonOrObj);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const crate = parsed.crate && typeof parsed.crate === 'object' ? parsed.crate : parsed;
  const name = String(crate.id || crate.name || fallbackCrateName || '').trim();
  if (!name) return null;

  const versions = Array.isArray(parsed.versions) ? parsed.versions : [];
  const activeVersions = versions.filter((v) => v && typeof v === 'object' && !v.yanked);
  const targetVer =
    normalizeProviderVersion(crate.max_stable_version || crate.max_version || crate.newest_version) || '';
  const matchedVer =
    activeVersions.find((v) => normalizeProviderVersion(v.num) === targetVer) ||
    activeVersions[0] ||
    versions[0] ||
    null;

  const version = normalizeProviderVersion(matchedVer?.num) || targetVer;
  const description = String(crate.description || '').trim();
  const shortDescription = description.length <= 200 ? description : `${description.slice(0, 197).trim()}...`;
  const license = String(matchedVer?.license || '').trim();
  const cratesUrl = `https://crates.io/crates/${encodeURIComponent(name)}`;
  const repositoryUrl = normalizeHttpUrl(crate.repository);
  const homepage =
    normalizeHttpUrl(crate.homepage) || normalizeHttpUrl(crate.documentation) || repositoryUrl || cratesUrl;

  const keywordsRaw = Array.isArray(parsed.keywords)
    ? parsed.keywords.map((k) => String(k?.keyword || k?.id || k || '').trim())
    : Array.isArray(crate.keywords)
      ? crate.keywords.map((k) => String(k || '').trim())
      : [];
  const tags = [...new Set(keywordsRaw.filter(Boolean))].slice(0, 15);

  const publisher = String(matchedVer?.published_by?.name || matchedVer?.published_by?.login || '').trim();

  return {
    name,
    packageManager: 'cargo',
    packageId: name,
    version,
    publisher,
    author: publisher,
    shortDescription,
    description,
    homepage,
    repositoryUrl,
    license,
    licenseUrl: '',
    tags,
    cratesUrl,
  };
}
