import { cleanCliLines } from './winget-parser.js';

const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

function stripBomAndAnsi(text) {
  if (!text || typeof text !== 'string') return '';
  return cleanCliLines(text.replace(/^\uFEFF/, ''))
    .join('\n')
    .trim();
}

function extractJsonPayload(rawText) {
  const cleaned = stripBomAndAnsi(rawText);
  if (!cleaned) return null;

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstObj = cleaned.indexOf('{');
    const firstArr = cleaned.indexOf('[');
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

function cleanNpmVersion(raw) {
  if (raw === null || raw === undefined) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  return trimmed.replace(/^v(?=\d)/i, '').trim();
}

/**
 * Validiert reguläre (`foo`, `foo-bar`) und Scoped-npm-Paketnamen (`@scope/pkg`).
 * @param {unknown} pkgName
 * @returns {boolean}
 */
export function isValidNpmPackageName(pkgName) {
  const clean = String(pkgName || '').trim();
  if (!clean || clean.length > 214) return false;
  if (/\s/.test(clean) || clean.includes('..') || clean.startsWith('.') || clean.startsWith('-')) return false;
  return NPM_PACKAGE_NAME_RE.test(clean);
}

/**
 * Normalisiert Repository-Angaben (`git+https://...git`, `git://...`, `github:user/repo`, Objekt) auf HTTPS-URLs.
 * @param {unknown} rawRepo
 * @returns {string}
 */
export function normalizeRepositoryUrl(rawRepo) {
  let rawUrl = '';
  if (typeof rawRepo === 'string') {
    rawUrl = rawRepo.trim();
  } else if (rawRepo && typeof rawRepo === 'object' && 'url' in rawRepo) {
    rawUrl = String(rawRepo.url || '').trim();
  }
  if (!rawUrl) return '';

  let url = rawUrl.replace(/^git\+/i, '').trim();
  if (/^git:\/\//i.test(url)) {
    url = `https://${url.slice(6)}`;
  } else if (/^ssh:\/\/git@([^/]+)\/(.+)$/i.test(url)) {
    url = url.replace(/^ssh:\/\/git@([^/]+)\/(.+)$/i, 'https://$1/$2');
  } else if (/^git@([^:]+):(.+)$/i.test(url)) {
    url = url.replace(/^git@([^:]+):(.+)$/i, 'https://$1/$2');
  } else if (/^github:([^/\s]+\/[^/\s]+)$/i.test(url)) {
    url = `https://github.com/${url.slice(7)}`;
  } else if (/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(url)) {
    url = `https://github.com/${url}`;
  }

  url = url.replace(/\.git$/i, '').replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href.replace(/\/+$/, '');
    }
  } catch {
    return '';
  }
  return '';
}

function normalizeNpmAuthor(rawAuthor) {
  if (!rawAuthor) return '';
  if (typeof rawAuthor === 'string') {
    return rawAuthor
      .replace(/\s*<[^>]*>/g, '')
      .replace(/\s*\([^)]*\)/g, '')
      .trim();
  }
  if (typeof rawAuthor === 'object' && 'name' in rawAuthor) {
    return String(rawAuthor.name || '').trim();
  }
  return '';
}

function normalizeNpmLicense(rawLicense) {
  if (!rawLicense) return { license: '', licenseUrl: '' };
  if (typeof rawLicense === 'string') {
    return { license: rawLicense.trim(), licenseUrl: '' };
  }
  if (typeof rawLicense === 'object') {
    const type = 'type' in rawLicense ? String(rawLicense.type || '').trim() : '';
    const url = 'url' in rawLicense ? String(rawLicense.url || '').trim() : '';
    return { license: type, licenseUrl: /^https?:\/\//i.test(url) ? url : '' };
  }
  return { license: '', licenseUrl: '' };
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
  if (!Array.isArray(rawKeywords)) return [];
  const seen = new Set();
  const tags = [];
  for (const kw of rawKeywords) {
    const clean = String(kw || '').trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(clean);
  }
  return tags.slice(0, 15);
}

/**
 * Parst `npm list -g --depth=0 --json`.
 * @param {string} rawText
 * @param {{ packageManager?: string }} [options]
 */
export function parseNpmListJson(rawText, { packageManager = 'npm' } = {}) {
  const parsed = extractJsonPayload(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const deps = parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : {};
  const results = [];
  const seen = new Set();

  for (const [pkgName, info] of Object.entries(deps)) {
    const cleanName = String(pkgName || '').trim();
    if (!cleanName) continue;
    if (info && typeof info === 'object' && info.missing === true && !info.version) continue;

    const key = cleanName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const version = info && typeof info === 'object' ? cleanNpmVersion(info.version) : '';
    results.push({
      packageManager,
      packageId: cleanName,
      id: cleanName,
      name: cleanName,
      version,
      source: packageManager,
    });
  }

  return results;
}

/**
 * Parst `npm outdated -g --json` (beachtet auch Exit-Code 1 mit gültigem JSON).
 * @param {string} rawText
 * @param {{ packageManager?: string }} [options]
 */
export function parseNpmOutdatedJson(rawText, { packageManager = 'npm' } = {}) {
  const parsed = extractJsonPayload(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const upgrades = [];
  const seen = new Set();

  for (const [pkgName, info] of Object.entries(parsed)) {
    const cleanName = String(pkgName || '').trim();
    if (!cleanName || !info || typeof info !== 'object') continue;
    const key = cleanName.toLowerCase();
    if (seen.has(key)) continue;

    const current = cleanNpmVersion(info.current);
    const wanted = cleanNpmVersion(info.wanted);
    const latest = cleanNpmVersion(info.latest);
    if (!latest || (current && current === latest)) continue;

    seen.add(key);
    upgrades.push({
      packageManager,
      packageId: cleanName,
      id: cleanName,
      name: cleanName,
      installedVersion: current,
      wantedVersion: wanted,
      availableVersion: latest,
      source: packageManager,
    });
  }

  return upgrades;
}

/**
 * Parst Suchergebnisse von `https://registry.npmjs.org/-/v1/search` oder `npm search --json`.
 * @param {unknown} rawTextOrObj
 * @param {number} [limit]
 * @param {{ packageManager?: string }} [options]
 */
export function parseNpmSearchJson(rawTextOrObj, limit = 25, { packageManager = 'npm' } = {}) {
  const parsed = typeof rawTextOrObj === 'string' ? extractJsonPayload(rawTextOrObj) : rawTextOrObj;
  if (!parsed || typeof parsed !== 'object') return [];

  const rawEntries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.objects)
      ? parsed.objects.map((o) => o?.package || o)
      : [];

  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const results = [];
  const seen = new Set();

  for (const entry of rawEntries) {
    if (results.length >= maxResults) break;
    if (!entry || typeof entry !== 'object') continue;

    const name = String(entry.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const version = cleanNpmVersion(entry.version);
    const description = String(entry.description || '').trim();
    const links = entry.links && typeof entry.links === 'object' ? entry.links : {};
    const homepage = normalizeHttpUrl(links.homepage || entry.homepage) || normalizeHttpUrl(links.npm);
    const repositoryUrl = normalizeRepositoryUrl(links.repository || entry.repository);
    const publisher =
      normalizeNpmAuthor(entry.publisher?.username || entry.publisher) ||
      normalizeNpmAuthor(entry.author) ||
      normalizeNpmAuthor(
        Array.isArray(entry.maintainers) ? entry.maintainers[0]?.username || entry.maintainers[0] : ''
      );

    results.push({
      packageManager,
      packageId: name,
      id: name,
      name,
      version,
      shortDescription: description,
      description,
      publisher,
      homepage,
      repositoryUrl,
      tags: normalizeKeywords(entry.keywords),
      source: packageManager,
    });
  }

  return results;
}

/**
 * Normalisiert Details aus `/<pkg>/latest` oder einem vollen npm-Packument (für Scoped-Pakete).
 * @param {unknown} rawJsonOrObj
 * @param {string} [fallbackPackageId]
 * @param {{ packageManager?: string }} [options]
 */
export function parseNpmShowJson(rawJsonOrObj, fallbackPackageId = '', { packageManager = 'npm' } = {}) {
  const parsed = typeof rawJsonOrObj === 'string' ? extractJsonPayload(rawJsonOrObj) : rawJsonOrObj;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  let manifest = parsed;
  const distTags = parsed['dist-tags'];
  if (
    !parsed.version &&
    distTags &&
    typeof distTags === 'object' &&
    parsed.versions &&
    typeof parsed.versions === 'object'
  ) {
    const latestTag = String(distTags.latest || '').trim();
    const versionManifest = latestTag && parsed.versions[latestTag] ? parsed.versions[latestTag] : null;
    if (versionManifest && typeof versionManifest === 'object') {
      manifest = { ...parsed, ...versionManifest };
    }
  }

  const name = String(manifest.name || parsed.name || fallbackPackageId || '').trim();
  if (!name) return null;

  const version = cleanNpmVersion(manifest.version || distTags?.latest);
  const description = String(manifest.description || parsed.description || '').trim();
  const shortDescription = description.length <= 200 ? description : `${description.slice(0, 197).trim()}...`;
  const author = normalizeNpmAuthor(manifest.author || parsed.author);
  const npmUser = normalizeNpmAuthor(
    manifest._npmUser || (Array.isArray(manifest.maintainers) ? manifest.maintainers[0] : '')
  );
  const publisher = npmUser || author;
  const { license, licenseUrl } = normalizeNpmLicense(manifest.license || parsed.license);
  const repositoryUrl = normalizeRepositoryUrl(manifest.repository || parsed.repository);
  const npmUrl = `https://www.npmjs.com/package/${name}`;
  const homepage = normalizeHttpUrl(manifest.homepage || parsed.homepage) || repositoryUrl || npmUrl;
  const tags = normalizeKeywords(manifest.keywords || parsed.keywords);

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
    npmUrl,
  };
}

function cleanBunRangeVersion(spec) {
  const clean = String(spec || '').trim();
  if (!clean) return '';
  if (/^(?:latest|next|canary|beta|alpha|workspace:|file:|link:|git\+|https?:)/i.test(clean)) return '';
  const extracted = clean.replace(/^[~^=v<> ]+/, '').trim();
  const semver = extracted.match(/^(\d+\.\d+(?:\.\d+)*(?:-[A-Za-z0-9.-]+)?)/);
  return semver ? semver[1] : '';
}

/**
 * Parst `~/.bun/install/global/package.json`.
 * @param {string} rawText
 */
export function parseBunGlobalPackageJson(rawText) {
  const parsed = extractJsonPayload(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const combined = {
    ...(parsed.optionalDependencies && typeof parsed.optionalDependencies === 'object'
      ? parsed.optionalDependencies
      : {}),
    ...(parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : {}),
  };

  const results = [];
  const seen = new Set();

  for (const [pkgName, spec] of Object.entries(combined)) {
    const cleanName = String(pkgName || '').trim();
    if (!cleanName) continue;
    const key = cleanName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      packageManager: 'bun',
      packageId: cleanName,
      id: cleanName,
      name: cleanName,
      version: cleanBunRangeVersion(spec),
      source: 'bun',
    });
  }

  return results;
}

/**
 * Parst die Baum-Ausgabe von `bun pm ls -g`.
 * @param {string} rawText
 */
export function parseBunPmLsOutput(rawText) {
  const lines = cleanCliLines(String(rawText || '').replace(/^\uFEFF/, ''));
  const results = [];
  const seen = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Entferne Baum-Präfixe wie ├──, └──, │, +-, `-- sowie optionale Bulletpoints
    const cleaned = trimmed.replace(/^(?:[│├└─|+`\-\\\s]+)+/, '').trim();
    if (!cleaned || /^node_modules\b/i.test(cleaned)) continue;

    const atIdx = cleaned.lastIndexOf('@');
    if (atIdx <= 0) continue;

    const pkgName = cleaned.slice(0, atIdx).trim();
    const rawVer =
      cleaned
        .slice(atIdx + 1)
        .trim()
        .split(/\s+/)[0] || '';
    if (!isValidNpmPackageName(pkgName)) continue;

    const key = pkgName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      packageManager: 'bun',
      packageId: pkgName,
      id: pkgName,
      name: pkgName,
      version: cleanNpmVersion(rawVer),
      source: 'bun',
    });
  }

  return results;
}

/**
 * Führt `~/.bun/install/global/package.json` und `bun pm ls -g` zusammen.
 * Exakte Versionen aus `bun pm ls -g` haben Vorrang vor Range-Specs.
 * @param {Array<Record<string, any>>} pkgJsonEntries
 * @param {Array<Record<string, any>>} pmLsEntries
 */
export function mergeBunGlobalPackages(pkgJsonEntries = [], pmLsEntries = []) {
  const merged = new Map();

  for (const entry of pkgJsonEntries || []) {
    const pkgId = String(entry?.packageId || entry?.name || '').trim();
    if (!pkgId) continue;
    merged.set(pkgId.toLowerCase(), {
      packageManager: 'bun',
      packageId: pkgId,
      id: pkgId,
      name: String(entry?.name || pkgId).trim(),
      version: cleanNpmVersion(entry?.version),
      source: 'bun',
    });
  }

  for (const entry of pmLsEntries || []) {
    const pkgId = String(entry?.packageId || entry?.name || '').trim();
    if (!pkgId) continue;
    const key = pkgId.toLowerCase();
    const existing = merged.get(key);
    const exactVer = cleanNpmVersion(entry?.version);
    merged.set(key, {
      packageManager: 'bun',
      packageId: pkgId,
      id: pkgId,
      name: String(entry?.name || existing?.name || pkgId).trim(),
      version: exactVer || existing?.version || '',
      source: 'bun',
    });
  }

  return [...merged.values()];
}

/**
 * Parst `pnpm list -g --depth=0 --json` (Array oder Einzelobjekt).
 * @param {string} rawText
 */
export function parsePnpmListJson(rawText) {
  const parsed = extractJsonPayload(rawText);
  if (!parsed || typeof parsed !== 'object') return [];

  const blocks = Array.isArray(parsed) ? parsed : [parsed];
  const results = [];
  const seen = new Set();

  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const deps = {
      ...(block.optionalDependencies && typeof block.optionalDependencies === 'object'
        ? block.optionalDependencies
        : {}),
      ...(block.dependencies && typeof block.dependencies === 'object' ? block.dependencies : {}),
    };

    for (const [pkgName, info] of Object.entries(deps)) {
      const cleanName = String(pkgName || '').trim();
      if (!cleanName) continue;
      const key = cleanName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const version = info && typeof info === 'object' ? cleanNpmVersion(info.version) : '';
      results.push({
        packageManager: 'pnpm',
        packageId: cleanName,
        id: cleanName,
        name: cleanName,
        version,
        source: 'pnpm',
      });
    }
  }

  return results;
}
