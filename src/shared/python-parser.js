import { normalizeProviderVersion } from './provider-lifecycle-logic.js';
import { cleanCliLines } from './winget-parser.js';

const PYTHON_PACKAGE_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function stripBomAndAnsi(text) {
  if (!text || typeof text !== 'string') return '';
  return cleanCliLines(text.replace(/^\uFEFF/, ''))
    .join('\n')
    .trim();
}

function extractJsonArrayOrObject(rawText) {
  const cleaned = stripBomAndAnsi(rawText);
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstArr = cleaned.indexOf('[');
    const firstObj = cleaned.indexOf('{');
    let start = -1;
    let end = -1;
    if (firstArr !== -1 && (firstObj === -1 || firstArr < firstObj)) {
      start = firstArr;
      end = cleaned.lastIndexOf(']');
    } else if (firstObj !== -1) {
      start = firstObj;
      end = cleaned.lastIndexOf('}');
    }
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, ' ')
    .trim();
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

function normalizeKeywords(rawKeywords) {
  if (!rawKeywords) return [];
  const parts = Array.isArray(rawKeywords) ? rawKeywords : String(rawKeywords).split(/[,\s]+/);
  const seen = new Set();
  const tags = [];
  for (const part of parts) {
    const clean = String(part || '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(clean);
  }
  return tags.slice(0, 15);
}

/**
 * Validiert PEP 508 Python-Paketnamen (z. B. `requests`, `python-dotenv`, `ruamel.yaml`).
 * @param {unknown} pkgName
 * @returns {boolean}
 */
export function isValidPythonPackageName(pkgName) {
  const clean = String(pkgName || '').trim();
  if (!clean || clean.length > 200 || /\s/.test(clean)) return false;
  return PYTHON_PACKAGE_NAME_RE.test(clean);
}

/**
 * Normalisiert Python-Paketnamen nach PEP 503 (`[-_.]+` -> `-`, Kleinschreibung).
 * @param {unknown} name
 * @returns {string}
 */
export function normalizePythonPackageName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, '-');
}

/**
 * Extrahiert die pip-Version aus `python -m pip --version`.
 * @param {string} stdout
 * @returns {string | null}
 */
export function parsePipVersionOutput(stdout) {
  const clean = stripBomAndAnsi(stdout);
  if (!clean) return null;
  const match = clean.match(/\bpip\s+v?(\d+\.\d+(?:\.\d+)*(?:[a-z0-9._-]*)?)/i);
  if (match) return normalizeProviderVersion(match[1]);
  const fallback = clean.match(/\bv?(\d+\.\d+(?:\.\d+)*)/);
  return fallback ? normalizeProviderVersion(fallback[1]) : null;
}

/**
 * Parst `python -m pip list --format=json`.
 * @param {string} rawText
 */
export function parsePipListJson(rawText) {
  const parsed = extractJsonArrayOrObject(rawText);
  if (!Array.isArray(parsed)) return [];

  const results = [];
  const seen = new Set();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    const key = normalizePythonPackageName(name);
    if (seen.has(key)) continue;
    seen.add(key);

    const version = normalizeProviderVersion(entry.version) || '';
    results.push({
      packageManager: 'pip',
      packageId: name,
      id: name,
      name,
      version,
      source: 'pip',
    });
  }
  return results;
}

/**
 * Parst `python -m pip list --outdated --format=json`.
 * @param {string} rawText
 */
export function parsePipOutdatedJson(rawText) {
  const parsed = extractJsonArrayOrObject(rawText);
  if (!Array.isArray(parsed)) return [];

  const upgrades = [];
  const seen = new Set();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    const key = normalizePythonPackageName(name);
    if (seen.has(key)) continue;

    const installedVersion = normalizeProviderVersion(entry.version) || '';
    const availableVersion = normalizeProviderVersion(entry.latest_version ?? entry.latest) || '';
    if (!availableVersion || (installedVersion && installedVersion === availableVersion)) continue;

    seen.add(key);
    upgrades.push({
      packageManager: 'pip',
      packageId: name,
      id: name,
      name,
      installedVersion,
      availableVersion,
      source: 'pip',
    });
  }
  return upgrades;
}

/**
 * Extrahiert die uv-Version aus `uv --version`.
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseUvVersionOutput(stdout) {
  const clean = stripBomAndAnsi(stdout);
  if (!clean) return null;
  const match = clean.match(/\buv\s+v?(\d+\.\d+\.\d+(?:[-+._a-z0-9]*)?)/i);
  if (match) return normalizeProviderVersion(match[1]);
  const fallback = clean.match(/\bv?(\d+\.\d+(?:\.\d+)*)/);
  return fallback ? normalizeProviderVersion(fallback[1]) : null;
}

/**
 * Parst die Textausgabe von `uv tool list`.
 * Beispiel:
 *   ruff v0.8.4
 *   - ruff.exe
 *   black v24.10.0 [extras: jupyter]
 *   - black.exe
 * @param {string} rawText
 */
export function parseUvToolListOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = cleanCliLines(rawText.replace(/^\uFEFF/, ''));
  const results = [];
  const seen = new Set();
  /** @type {{ packageManager: string, packageId: string, id: string, name: string, version: string, executables: string[], source: string } | null} */
  let current = null;

  for (const rawLine of lines) {
    if (!rawLine?.trim()) continue;
    const trimmed = rawLine.trim();
    if (/^no tools installed\.?$/i.test(trimmed)) {
      return [];
    }

    // Eingerueckte Executable-Zeile (`- ruff.exe`) oder nicht-eingerueckte Tool-Zeile
    if (/^-\s+/.test(trimmed)) {
      if (current) {
        const exeName = trimmed.replace(/^-\s+/, '').trim();
        if (exeName && !current.executables.includes(exeName)) {
          current.executables.push(exeName);
        }
      }
      continue;
    }

    const toolMatch = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s+v?(\d+(?:\.\d+)+(?:[A-Za-z0-9._+-]*)?)(?:\s|$)/i);
    if (!toolMatch) continue;

    const name = toolMatch[1].trim();
    const key = normalizePythonPackageName(name);
    if (seen.has(key)) {
      current = null;
      continue;
    }
    seen.add(key);

    const version = normalizeProviderVersion(toolMatch[2]) || '';
    current = {
      packageManager: 'uv',
      packageId: name,
      id: name,
      name,
      version,
      executables: [],
      source: 'uv',
    };
    results.push(current);
  }

  return results;
}

function pickProjectUrl(projectUrls, candidates) {
  if (!projectUrls || typeof projectUrls !== 'object') return '';
  const entries = Object.entries(projectUrls);
  for (const target of candidates) {
    const targetLower = target.toLowerCase();
    for (const [key, val] of entries) {
      if (key.trim().toLowerCase() === targetLower) {
        const url = normalizeHttpUrl(val);
        if (url) return url;
      }
    }
  }
  return '';
}

/**
 * Parst Details von `https://pypi.org/pypi/<pkg>/json`.
 * @param {unknown} rawJsonOrObj
 * @param {string} [fallbackPackageId]
 * @param {{ packageManager?: string }} [options]
 */
export function parsePyPiPackageJson(rawJsonOrObj, fallbackPackageId = '', { packageManager = 'pip' } = {}) {
  const parsed = typeof rawJsonOrObj === 'string' ? extractJsonArrayOrObject(rawJsonOrObj) : rawJsonOrObj;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const info = parsed.info && typeof parsed.info === 'object' ? parsed.info : parsed;
  const name = String(info.name || fallbackPackageId || '').trim();
  if (!name) return null;

  const version = normalizeProviderVersion(info.version) || '';
  const summary = String(info.summary || '').trim();
  const fullDesc = String(info.description || '').trim();
  const description = fullDesc || summary;
  const shortDescription =
    summary || (description.length <= 200 ? description : `${description.slice(0, 197).trim()}...`);

  const author = String(info.author || info.maintainer || '').trim();
  const publisher = String(info.maintainer || info.author || '').trim();
  const license = String(info.license_expression || info.license || '').trim();
  const projectUrls = info.project_urls && typeof info.project_urls === 'object' ? info.project_urls : {};

  const pypiUrl =
    normalizeHttpUrl(info.project_url || info.package_url) || `https://pypi.org/project/${encodeURIComponent(name)}/`;
  const repositoryUrl = pickProjectUrl(projectUrls, ['Repository', 'Source', 'Source Code', 'GitHub', 'Code']);
  const homepage =
    normalizeHttpUrl(info.home_page) || pickProjectUrl(projectUrls, ['Homepage', 'Home']) || repositoryUrl || pypiUrl;
  const licenseUrl = pickProjectUrl(projectUrls, ['License']);
  const tags = normalizeKeywords(info.keywords);

  return {
    name,
    packageManager,
    packageId: name,
    version,
    publisher,
    author,
    shortDescription,
    description,
    homepage,
    repositoryUrl,
    license,
    licenseUrl,
    tags,
    pypiUrl,
  };
}

/**
 * Parst PyPI HTML-Suchergebnisse (`<a class="package-snippet" ...>`).
 * @param {string} html
 * @param {number} [limit]
 * @param {{ packageManager?: string }} [options]
 */
export function parsePyPiSearchHtml(html, limit = 25, { packageManager = 'pip' } = {}) {
  if (!html || typeof html !== 'string') return [];
  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const snippetRe = /<a\b[^>]*class="[^"]*\bpackage-snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  const results = [];
  const seen = new Set();

  let match = snippetRe.exec(html);
  while (match !== null) {
    if (results.length >= maxResults) break;
    const block = match[1];
    const nameMatch = block.match(/class="[^"]*\bpackage-snippet__name\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const verMatch = block.match(/class="[^"]*\bpackage-snippet__version\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const descMatch = block.match(/class="[^"]*\bpackage-snippet__description\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i);

    const name = decodeHtmlEntities(nameMatch?.[1] || '');
    if (name && isValidPythonPackageName(name)) {
      const key = normalizePythonPackageName(name);
      if (!seen.has(key)) {
        seen.add(key);
        const version = normalizeProviderVersion(decodeHtmlEntities(verMatch?.[1] || '')) || '';
        const desc = decodeHtmlEntities(descMatch?.[1] || '');
        results.push({
          packageManager,
          packageId: name,
          id: name,
          name,
          version,
          shortDescription: desc,
          description: desc,
          homepage: `https://pypi.org/project/${encodeURIComponent(name)}/`,
          source: packageManager,
        });
      }
    }
    match = snippetRe.exec(html);
  }

  return results;
}

/**
 * Parst PEP 503 Simple-Index HTML oder JSON und filtert nach Suchbegriff.
 * @param {string | Record<string, any>} rawHtmlOrJson
 * @param {string} query
 * @param {number} [limit]
 * @param {{ packageManager?: string }} [options]
 */
export function parsePyPiSimpleIndexHtml(rawHtmlOrJson, query = '', limit = 25, { packageManager = 'pip' } = {}) {
  const cleanQuery = String(query || '').trim();
  const normQuery = normalizePythonPackageName(cleanQuery);
  if (!normQuery) return [];

  /** @type {string[]} */
  const candidates = [];
  if (rawHtmlOrJson && typeof rawHtmlOrJson === 'object' && Array.isArray(rawHtmlOrJson.projects)) {
    for (const proj of rawHtmlOrJson.projects) {
      const n = String(proj?.name || '').trim();
      if (n) candidates.push(n);
    }
  } else if (typeof rawHtmlOrJson === 'string') {
    const linkRe = /<a\b[^>]*>([^<]+)<\/a>/gi;
    let m = linkRe.exec(rawHtmlOrJson);
    while (m !== null) {
      const n = decodeHtmlEntities(m[1]);
      if (n) candidates.push(n);
      m = linkRe.exec(rawHtmlOrJson);
    }
  }

  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : 25;
  const ranked = [];
  const seen = new Set();

  for (const name of candidates) {
    if (!isValidPythonPackageName(name)) continue;
    const norm = normalizePythonPackageName(name);
    if (seen.has(norm) || !norm.includes(normQuery)) continue;
    seen.add(norm);
    const rank = norm === normQuery ? 0 : norm.startsWith(normQuery) ? 1 : 2;
    ranked.push({ name, rank });
  }

  ranked.sort((a, b) => a.rank - b.rank || a.name.length - b.name.length || a.name.localeCompare(b.name));

  return ranked.slice(0, maxResults).map(({ name }) => ({
    packageManager,
    packageId: name,
    id: name,
    name,
    version: '',
    shortDescription: '',
    description: '',
    homepage: `https://pypi.org/project/${encodeURIComponent(name)}/`,
    source: packageManager,
  }));
}
