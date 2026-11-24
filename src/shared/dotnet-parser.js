import { normalizeProviderVersion } from './provider-lifecycle-logic.js';
import { cleanCliLines } from './winget-parser.js';

const DOTNET_TOOL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function parseJsonSafe(raw) {
  if (raw && typeof raw === 'object') return raw;
  const clean = cleanCliLines(String(raw || '').replace(/^\uFEFF/, ''))
    .join('\n')
    .trim();
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
 * Validiert NuGet / .NET Global Tool Paket-IDs.
 * @param {unknown} toolId
 * @returns {boolean}
 */
export function isValidDotnetToolId(toolId) {
  const clean = String(toolId || '').trim();
  if (!clean || clean.length > 128 || /\s/.test(clean)) return false;
  return DOTNET_TOOL_ID_RE.test(clean);
}

/**
 * Extrahiert die .NET SDK Version aus `dotnet --version`.
 * @param {string} stdout
 * @returns {string | null}
 */
export function parseDotnetVersionOutput(stdout) {
  const clean = cleanCliLines(String(stdout || '').replace(/^\uFEFF/, ''))
    .join(' ')
    .trim();
  if (!clean) return null;
  const match = clean.match(/\bv?(\d+\.\d+\.\d+(?:[-+._a-z0-9]*)?)/i);
  return match ? normalizeProviderVersion(match[1]) : null;
}

/**
 * Parst die Tabelle von `dotnet tool list -g` (englische und deutsche Kopfzeile).
 * Beispiel:
 *   Package Id      Version      Commands
 *   -------------------------------------
 *   dotnet-ef       9.0.0        dotnet-ef
 * @param {string} rawText
 */
export function parseDotnetToolListOutput(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = cleanCliLines(rawText.replace(/^\uFEFF/, ''));
  const results = [];
  const seen = new Set();
  let passedSeparator = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (/^-{5,}$/.test(trimmed) || /^[-]{3,}\s+[-]{3,}/.test(trimmed)) {
      passedSeparator = true;
      continue;
    }

    if (!passedSeparator) {
      if (/^(?:package\s+id|paket-id)\s+/i.test(trimmed)) {
        continue;
      }
      // Falls CLI ohne Trennlinie direkt Daten ausgibt, pruefen wir auf gueltiges Zeilenmuster
    }

    const rowMatch = trimmed.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s{2,}([^\s]+)(?:\s{2,}(.*))?$/);
    if (!rowMatch) continue;

    const id = rowMatch[1].trim();
    const version = normalizeProviderVersion(rowMatch[2].trim()) || '';
    if (!isValidDotnetToolId(id) || !/\d/.test(version)) continue;

    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const commands = String(rowMatch[3] || '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    results.push({
      packageManager: 'dotnet',
      packageId: id,
      id,
      name: id,
      version,
      commands,
      source: 'dotnet',
    });
  }

  return results;
}

/**
 * Parst NuGet Search API (`https://azuresearch-usnc.nuget.org/query?q=...&packageType=DotnetTool`).
 * @param {unknown} rawJsonOrObj
 * @param {number} [limit]
 */
export function parseNugetSearchJson(rawJsonOrObj, limit = 25) {
  const parsed = parseJsonSafe(rawJsonOrObj);
  if (!parsed || typeof parsed !== 'object') return [];

  const rows = Array.isArray(parsed.data) ? parsed.data : [];
  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const results = [];
  const seen = new Set();

  for (const entry of rows) {
    if (results.length >= maxResults) break;
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id || '').trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const version = normalizeProviderVersion(entry.version) || '';
    const desc = String(entry.description || entry.summary || '').trim();
    const authors = Array.isArray(entry.authors)
      ? entry.authors.filter(Boolean).join(', ')
      : String(entry.authors || '').trim();
    const homepage = normalizeHttpUrl(entry.projectUrl) || `https://www.nuget.org/packages/${encodeURIComponent(id)}`;
    const tags = Array.isArray(entry.tags)
      ? [...new Set(entry.tags.map((t) => String(t || '').trim()).filter(Boolean))].slice(0, 15)
      : [];

    results.push({
      packageManager: 'dotnet',
      packageId: id,
      id,
      name: String(entry.title || id).trim() || id,
      version,
      publisher: authors,
      shortDescription: desc,
      description: desc,
      homepage,
      tags,
      source: 'dotnet',
    });
  }

  return results;
}

/**
 * Parst ein NuGet-Suchergebnis oder Einzel-Objekt fuer `show()`.
 * @param {unknown} rawJsonOrObj
 * @param {string} [fallbackPackageId]
 */
export function parseNugetShowJson(rawJsonOrObj, fallbackPackageId = '') {
  const parsed = parseJsonSafe(rawJsonOrObj);
  if (!parsed || typeof parsed !== 'object') return null;

  let entry = parsed;
  if (Array.isArray(parsed.data)) {
    const cleanFallback = String(fallbackPackageId || '')
      .trim()
      .toLowerCase();
    entry =
      (cleanFallback
        ? parsed.data.find(
            (d) =>
              String(d?.id || '')
                .trim()
                .toLowerCase() === cleanFallback
          )
        : null) ||
      parsed.data[0] ||
      null;
  }

  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id || fallbackPackageId || '').trim();
  if (!id) return null;

  const version = normalizeProviderVersion(entry.version) || '';
  const description = String(entry.description || entry.summary || '').trim();
  const shortDescription = description.length <= 200 ? description : `${description.slice(0, 197).trim()}...`;
  const authors = Array.isArray(entry.authors)
    ? entry.authors.filter(Boolean).join(', ')
    : String(entry.authors || '').trim();
  const nugetUrl = `https://www.nuget.org/packages/${encodeURIComponent(id)}`;
  const homepage = normalizeHttpUrl(entry.projectUrl) || nugetUrl;
  const licenseUrl = normalizeHttpUrl(entry.licenseUrl);
  const tags = Array.isArray(entry.tags)
    ? [...new Set(entry.tags.map((t) => String(t || '').trim()).filter(Boolean))].slice(0, 15)
    : [];

  return {
    name: String(entry.title || id).trim() || id,
    packageManager: 'dotnet',
    packageId: id,
    version,
    publisher: authors,
    author: authors,
    shortDescription,
    description,
    homepage,
    repositoryUrl: '',
    license: '',
    licenseUrl,
    tags,
    nugetUrl,
  };
}
