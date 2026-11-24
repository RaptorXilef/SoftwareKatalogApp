import { compareVersions } from './version.js';
import { cleanCliLines } from './winget-parser.js';

const COMPOSER_PACKAGE_RE = /^[a-z0-9](?:[_.-]?[a-z0-9]+)*\/[a-z0-9](?:(?:[_.]|-{1,2})?[a-z0-9]+)*$/i;

function cleanComposerVersion(raw) {
  if (raw === null || raw === undefined) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  return trimmed.replace(/^v(?=\d)/i, '').trim();
}

/**
 * Validiert Composer-Paketnamen im Format `vendor/package`.
 * @param {unknown} pkgName
 * @returns {boolean}
 */
export function isValidComposerPackageName(pkgName) {
  const clean = String(pkgName || '').trim();
  if (!clean || clean.length > 200 || /\s/.test(clean)) return false;
  return COMPOSER_PACKAGE_RE.test(clean);
}

/**
 * Bereinigt BOM/ANSI und Windows-Vorlaufzeilen (z. B. `Changed current directory to ...`) vor Composer-JSON.
 * @param {string} rawText
 * @returns {any}
 */
export function extractComposerJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = cleanCliLines(rawText.replace(/^\uFEFF/, ''))
    .join('\n')
    .trim();
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

/**
 * Parst `composer global show --format=json`.
 * @param {string} rawText
 */
export function parseComposerShowJson(rawText) {
  const parsed = extractComposerJson(rawText);
  if (!parsed || typeof parsed !== 'object') return [];

  const installed = Array.isArray(parsed.installed) ? parsed.installed : [];
  const results = [];
  const seen = new Set();

  for (const entry of installed) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      packageManager: 'composer',
      packageId: name,
      id: name,
      name,
      version: cleanComposerVersion(entry.version),
      shortDescription: String(entry.description || '').trim(),
      source: 'composer',
    });
  }

  return results;
}

/**
 * Parst `composer global outdated --format=json`.
 * @param {string} rawText
 */
export function parseComposerOutdatedJson(rawText) {
  const parsed = extractComposerJson(rawText);
  if (!parsed || typeof parsed !== 'object') return [];

  const installed = Array.isArray(parsed.installed) ? parsed.installed : [];
  const upgrades = [];
  const seen = new Set();

  for (const entry of installed) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;

    const current = cleanComposerVersion(entry.version);
    const latest = cleanComposerVersion(entry.latest);
    const latestStatus = String(entry['latest-status'] || '')
      .trim()
      .toLowerCase();
    if (!latest || latestStatus === 'up-to-date' || (current && current === latest)) continue;

    seen.add(key);
    upgrades.push({
      packageManager: 'composer',
      packageId: name,
      id: name,
      name,
      installedVersion: current,
      availableVersion: latest,
      latestStatus,
      description: String(entry.description || '').trim(),
      source: 'composer',
    });
  }

  return upgrades;
}

/**
 * Parst Suchergebnisse von `https://packagist.org/search.json?q=<query>`.
 * @param {unknown} rawJsonOrObj
 * @param {number} [limit]
 */
export function parsePackagistSearchJson(rawJsonOrObj, limit = 25) {
  const parsed = typeof rawJsonOrObj === 'string' ? extractComposerJson(rawJsonOrObj) : rawJsonOrObj;
  if (!parsed || typeof parsed !== 'object') return [];

  const rawResults = Array.isArray(parsed.results) ? parsed.results : [];
  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const results = [];
  const seen = new Set();

  for (const entry of rawResults) {
    if (results.length >= maxResults) break;
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const desc = String(entry.description || '').trim();
    results.push({
      packageManager: 'composer',
      packageId: name,
      id: name,
      name,
      version: '',
      shortDescription: desc,
      description: desc,
      homepage: String(entry.url || '').trim(),
      repositoryUrl: String(entry.repository || '').trim(),
      source: 'composer',
    });
  }

  return results;
}

function selectLatestStablePackagistVersion(versionsObj) {
  if (!versionsObj || typeof versionsObj !== 'object') return null;

  const candidates = [];
  for (const [verKey, meta] of Object.entries(versionsObj)) {
    if (!meta || typeof meta !== 'object') continue;
    const cleanVer = cleanComposerVersion(meta.version || verKey);
    if (!cleanVer) continue;
    if (/^(?:dev-|.*-dev$)/i.test(cleanVer) || /-(?:alpha|beta|rc)\d*$/i.test(cleanVer)) continue;
    if (!/^\d+(?:\.\d+)+/.test(cleanVer)) continue;
    candidates.push({ version: cleanVer, meta });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersions(b.version, a.version, 4));
  return candidates[0];
}

/**
 * Parst Details von `https://packagist.org/packages/<vendor>/<pkg>.json`.
 * @param {unknown} rawJsonOrObj
 * @param {string} [fallbackPackageId]
 */
export function parsePackagistShowJson(rawJsonOrObj, fallbackPackageId = '') {
  const parsed = typeof rawJsonOrObj === 'string' ? extractComposerJson(rawJsonOrObj) : rawJsonOrObj;
  if (!parsed || typeof parsed !== 'object') return null;

  const pkg = parsed.package && typeof parsed.package === 'object' ? parsed.package : parsed;
  const name = String(pkg.name || fallbackPackageId || '').trim();
  if (!name) return null;

  const selected = selectLatestStablePackagistVersion(pkg.versions);
  const meta = selected?.meta || {};
  const version = selected?.version || '';
  const description = String(meta.description || pkg.description || '').trim();
  const shortDescription = description.length <= 200 ? description : `${description.slice(0, 197).trim()}...`;

  const authors = Array.isArray(meta.authors)
    ? meta.authors
        .map((a) => String(a?.name || '').trim())
        .filter(Boolean)
        .join(', ')
    : '';
  const license = Array.isArray(meta.license)
    ? meta.license.filter(Boolean).join(', ')
    : String(meta.license || '').trim();
  const keywords = Array.isArray(meta.keywords)
    ? [...new Set(meta.keywords.map((k) => String(k || '').trim()).filter(Boolean))].slice(0, 15)
    : [];

  const repositoryUrl = String(pkg.repository || meta.source?.url || '').trim();
  const homepage = String(meta.homepage || '').trim() || repositoryUrl || `https://packagist.org/packages/${name}`;
  const vendor = name.includes('/') ? name.split('/')[0] : '';

  return {
    name,
    packageManager: 'composer',
    packageId: name,
    version,
    publisher: vendor || authors,
    author: authors,
    shortDescription,
    description,
    homepage,
    repositoryUrl,
    license,
    licenseUrl: '',
    tags: keywords,
  };
}
