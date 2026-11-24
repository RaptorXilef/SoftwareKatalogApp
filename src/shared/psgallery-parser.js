import { normalizeProviderVersion } from './provider-lifecycle-logic.js';
import { cleanCliLines } from './winget-parser.js';

const PS_MODULE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function stripBomAndAnsi(text) {
  if (!text || typeof text !== 'string') return '';
  return cleanCliLines(text.replace(/^\uFEFF/, ''))
    .join('\n')
    .trim();
}

function extractJsonPayload(rawText) {
  if (rawText && typeof rawText === 'object') return rawText;
  const cleaned = stripBomAndAnsi(String(rawText || ''));
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

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim();
}

function normalizeHttpUrl(rawUrl) {
  if (!rawUrl) return '';
  const candidate =
    typeof rawUrl === 'object' && 'AbsoluteUri' in rawUrl ? String(rawUrl.AbsoluteUri || '') : String(rawUrl || '');
  const clean = candidate.trim();
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

function normalizePsVersion(rawVer) {
  if (!rawVer) return '';
  if (typeof rawVer === 'string' || typeof rawVer === 'number') {
    return normalizeProviderVersion(String(rawVer)) || '';
  }
  if (typeof rawVer === 'object') {
    const parts = [rawVer.Major, rawVer.Minor, rawVer.Build, rawVer.Revision].filter(
      (n) => typeof n === 'number' && n >= 0
    );
    if (parts.length >= 2) {
      return parts.join('.');
    }
  }
  return '';
}

function normalizePsTags(rawTags) {
  if (!rawTags) return [];
  const items = Array.isArray(rawTags) ? rawTags : String(rawTags).split(/[\s,;]+/);
  const seen = new Set();
  const tags = [];
  for (const tag of items) {
    const clean = String(tag || '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(clean);
  }
  return tags.slice(0, 15);
}

/**
 * Validiert PowerShell-Modulnamen.
 * @param {unknown} moduleName
 * @returns {boolean}
 */
export function isValidPsModuleName(moduleName) {
  const clean = String(moduleName || '').trim();
  if (!clean || clean.length > 128 || /\s/.test(clean)) return false;
  return PS_MODULE_NAME_RE.test(clean);
}

/**
 * Extrahiert die PowerShell-Version (z. B. `7.4.6` oder `5.1.22621.4391`).
 * @param {string} stdout
 * @returns {string | null}
 */
export function parsePowerShellVersionOutput(stdout) {
  const clean = stripBomAndAnsi(stdout);
  if (!clean) return null;
  const match = clean.match(/\bv?(\d+\.\d+(?:\.\d+)*(?:[-+._a-z0-9]*)?)/i);
  return match ? normalizeProviderVersion(match[1]) : null;
}

/**
 * Parst `Get-InstalledModule ... | ConvertTo-Json` bzw. `Get-InstalledPSResource ... | ConvertTo-Json`.
 * Behandelt sowohl Einzelobjekte (PowerShell 5.1) als auch Arrays und Versions-Objekte.
 * @param {string} rawText
 * @param {{ packageManager?: string }} [options]
 */
export function parsePsInstalledModulesJson(rawText, { packageManager = 'pwsh7' } = {}) {
  const parsed = extractJsonPayload(rawText);
  if (!parsed || typeof parsed !== 'object') return [];

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const results = [];
  const seen = new Set();

  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.Name || entry.name || entry.Id || entry.id || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const version = normalizePsVersion(entry.Version ?? entry.version);
    const author = String(entry.Author || entry.author || '').trim();
    const shortDescription = String(entry.Description || entry.description || '').trim();
    const homepage = normalizeHttpUrl(entry.ProjectUri || entry.projectUri || entry.ProjectUrl);
    const licenseUrl = normalizeHttpUrl(entry.LicenseUri || entry.licenseUri || entry.LicenseUrl);

    results.push({
      packageManager,
      packageId: name,
      id: name,
      name,
      version,
      author,
      shortDescription,
      homepage,
      licenseUrl,
      source: packageManager,
    });
  }

  return results;
}

function mapGalleryEntryToSearchItem(entry, packageManager) {
  const name = String(entry.Id || entry.Name || entry.name || entry.id || '').trim();
  if (!name) return null;

  const version = normalizePsVersion(entry.NormalizedVersion || entry.Version || entry.version);
  const desc = String(entry.Description || entry.Summary || entry.description || '').trim();
  const authors = String(entry.Authors || entry.Author || entry.author || '').trim();
  const homepage =
    normalizeHttpUrl(entry.ProjectUrl || entry.ProjectUri || entry.GalleryDetailsUrl) ||
    `https://www.powershellgallery.com/packages/${encodeURIComponent(name)}`;

  return {
    packageManager,
    packageId: name,
    id: name,
    name,
    version,
    publisher: authors,
    shortDescription: desc,
    description: desc,
    homepage,
    tags: normalizePsTags(entry.Tags || entry.tags),
    source: packageManager,
  };
}

/**
 * Parst PowerShell Gallery OData v2 JSON (`d.results`, `value`) oder `Find-Module | ConvertTo-Json`.
 * @param {unknown} rawJsonOrObj
 * @param {number} [limit]
 * @param {{ packageManager?: string }} [options]
 */
export function parsePsGalleryODataJson(rawJsonOrObj, limit = 25, { packageManager = 'pwsh7' } = {}) {
  const parsed = extractJsonPayload(rawJsonOrObj);
  if (!parsed || typeof parsed !== 'object') return [];

  const rawEntries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.d?.results)
      ? parsed.d.results
      : Array.isArray(parsed.value)
        ? parsed.value
        : parsed.d && typeof parsed.d === 'object'
          ? [parsed.d]
          : [parsed];

  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const results = [];
  const seen = new Set();

  for (const entry of rawEntries) {
    if (results.length >= maxResults) break;
    if (!entry || typeof entry !== 'object') continue;
    const mapped = mapGalleryEntryToSearchItem(entry, packageManager);
    if (!mapped) continue;
    const key = mapped.packageId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(mapped);
  }

  return results;
}

function readXmlTag(block, tagName) {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1]) : '';
}

/**
 * Parst PowerShell Gallery OData v2 Atom XML (`<entry>...<m:properties>...</m:properties></entry>`).
 * @param {string} xmlText
 * @param {number} [limit]
 * @param {{ packageManager?: string }} [options]
 */
export function parsePsGalleryODataAtomXml(xmlText, limit = 25, { packageManager = 'pwsh7' } = {}) {
  if (!xmlText || typeof xmlText !== 'string') return [];
  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  const results = [];
  const seen = new Set();

  let match = entryRe.exec(xmlText);
  while (match !== null) {
    if (results.length >= maxResults) break;
    const block = match[1];
    const id = readXmlTag(block, 'd:Id') || readXmlTag(block, 'title');
    if (id) {
      const key = id.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        const version =
          normalizeProviderVersion(readXmlTag(block, 'd:NormalizedVersion') || readXmlTag(block, 'd:Version')) || '';
        const authors = readXmlTag(block, 'd:Authors');
        const desc = readXmlTag(block, 'd:Description') || readXmlTag(block, 'd:Summary');
        const projectUrl = normalizeHttpUrl(readXmlTag(block, 'd:ProjectUrl'));
        const licenseUrl = normalizeHttpUrl(readXmlTag(block, 'd:LicenseUrl'));
        const galleryUrl =
          normalizeHttpUrl(readXmlTag(block, 'd:GalleryDetailsUrl')) ||
          `https://www.powershellgallery.com/packages/${encodeURIComponent(id)}`;
        const isLatestRaw = readXmlTag(block, 'd:IsLatestVersion');
        const tags = normalizePsTags(readXmlTag(block, 'd:Tags'));

        results.push({
          packageManager,
          packageId: id,
          id,
          name: id,
          version,
          publisher: authors,
          shortDescription: desc,
          description: desc,
          homepage: projectUrl || galleryUrl,
          licenseUrl,
          tags,
          isLatestVersion: /^true$/i.test(isLatestRaw),
          source: packageManager,
        });
      }
    }
    match = entryRe.exec(xmlText);
  }

  return results;
}

/**
 * Normalisiert einen OData- oder Find-Module-Eintrag fuer `show()`.
 * @param {Record<string, any>} entry
 * @param {string} [fallbackName]
 * @param {{ packageManager?: string }} [options]
 */
export function parsePsGalleryShowEntry(entry, fallbackName = '', { packageManager = 'pwsh7' } = {}) {
  if (!entry || typeof entry !== 'object') return null;
  const name = String(entry.packageId || entry.Id || entry.Name || entry.name || fallbackName || '').trim();
  if (!name) return null;

  const version = normalizePsVersion(entry.NormalizedVersion || entry.Version || entry.version);
  const description = String(entry.Description || entry.Summary || entry.description || '').trim();
  const shortDescription = description.length <= 200 ? description : `${description.slice(0, 197).trim()}...`;
  const authors = String(entry.Authors || entry.Author || entry.publisher || entry.author || '').trim();
  const galleryUrl = `https://www.powershellgallery.com/packages/${encodeURIComponent(name)}`;
  const homepage = normalizeHttpUrl(entry.ProjectUrl || entry.ProjectUri || entry.homepage) || galleryUrl;
  const licenseUrl = normalizeHttpUrl(entry.LicenseUrl || entry.LicenseUri || entry.licenseUrl);
  const tags = normalizePsTags(entry.Tags || entry.tags);

  return {
    name,
    packageManager,
    packageId: name,
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
    galleryUrl,
  };
}
