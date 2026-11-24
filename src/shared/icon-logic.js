const DIRECT_IMAGE_EXTS = new Set(['.ico', '.png', '.svg', '.webp', '.jpg', '.jpeg', '.gif', '.avif']);
const EXECUTABLE_RESOURCE_EXTS = new Set(['.exe', '.dll', '.cpl', '.ocx', '.scr']);
const GENERIC_ICON_BASENAMES = new Set([
  'msiexec.exe',
  'rundll32.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe',
  'conhost.exe',
  'regsvr32.exe',
  'explorer.exe',
]);

const IGNORED_EXE_PREFIX_RE =
  /^(?:unins|uninstall|uninst|update|updater|crash|helper|setup|install|squirrel|elevate|vcredist|redist)/i;
const IGNORED_EXE_SEGMENT_RE =
  /(?:uninstall|updater|crashpad|crashreporter|crashhandler|helper|qtwebengineprocess|createdump|notification_helper|chrome_proxy)/i;

const BINARY_DOWNLOAD_EXT_RE = /\.(?:exe|msi|msix|msixbundle|appx|zip|7z|rar|tar|gz|xz)$/i;

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim();
}

function normalizeCompact(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]/g, '');
}

function stripVersionSuffix(name) {
  return String(name || '')
    .replace(/\s+\(?(?:x64|x86|64-bit|32-bit|current user|user)\)?/gi, '')
    .replace(/\s+v?\d+(?:\.\d+)+.*$/i, '')
    .trim();
}

function getBaseName(filePath) {
  const str = String(filePath || '').trim();
  if (!str) return '';
  const parts = str.split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

function getExtLower(filePath) {
  const base = getBaseName(filePath);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/**
 * Erweitert Windows-Umgebungsvariablen wie %LOCALAPPDATA% case-insensitiv.
 */
export function expandWindowsEnvVars(rawPath, env = {}) {
  const input = String(rawPath || '');
  if (!input.includes('%')) return input;

  const lookup = new Map();
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined && v !== null) {
        lookup.set(String(k).toLowerCase(), String(v));
      }
    }
  }

  return input.replace(/%([^%]+)%/g, (full, varName) => {
    const found = lookup.get(String(varName).toLowerCase());
    return found !== undefined ? found : full;
  });
}

/**
 * Prüft, ob ein Dateipfad auf ein generisches Windows-System-/Installer-Programm zeigt.
 */
export function isGenericIconSource(filePath) {
  const base = getBaseName(filePath).toLowerCase();
  return Boolean(base && GENERIC_ICON_BASENAMES.has(base));
}

/**
 * Erkennt Hilfs-, Updater-, Crash- und Deinstallations-Executables, die bei der Haupt-EXE-Suche ignoriert werden.
 */
export function isIgnoredExecutableName(fileName) {
  const base = getBaseName(fileName);
  if (!base) return true;
  return IGNORED_EXE_PREFIX_RE.test(base) || IGNORED_EXE_SEGMENT_RE.test(base);
}

/**
 * Bereinigt einen Windows-Registry-DisplayIcon-Eintrag (inkl. Anführungszeichen, Index wie ,0 / ,-101 und %VAR%).
 */
export function parseDisplayIcon(raw, env = {}) {
  const original = String(raw || '').trim();
  if (!original) {
    return {
      raw: original,
      path: '',
      index: null,
      ext: '',
      isGeneric: false,
      isDirectImage: false,
      isExecutableResource: false,
    };
  }

  let working = original.replace(/^@+/, '').trim();
  let index = null;

  // Fall 1: Pfad in Anführungszeichen, optional gefolgt von ",0" oder ",-101" (innerhalb oder außerhalb)
  const quotedMatch = working.match(/^"([^"]+)"(?:\s*,\s*(-?\d+))?$/);
  if (quotedMatch) {
    working = quotedMatch[1].trim();
    if (quotedMatch[2] !== undefined) {
      index = Number.parseInt(quotedMatch[2], 10);
    }
  } else {
    working = working.replace(/^["']|["']$/g, '').trim();
  }

  // Fall 2: Index direkt am Ende (z. B. C:\App\app.exe,0 oder "C:\App\app.exe,-101")
  const trailingIdxMatch = working.match(/^(.*?\.[a-z0-9]{2,5})\s*,\s*(-?\d+)$/i);
  if (trailingIdxMatch) {
    working = trailingIdxMatch[1].trim();
    if (index === null) {
      index = Number.parseInt(trailingIdxMatch[2], 10);
    }
  } else if (index === null) {
    const genericIdxMatch = working.match(/^(.*)\s*,\s*(-?\d+)$/);
    if (genericIdxMatch && /[\\/]/.test(genericIdxMatch[1])) {
      working = genericIdxMatch[1].trim();
      index = Number.parseInt(genericIdxMatch[2], 10);
    }
  }

  const expanded = expandWindowsEnvVars(working, env).trim();
  const ext = getExtLower(expanded);
  const isDirectImage = DIRECT_IMAGE_EXTS.has(ext);
  const isExecutableResource = EXECUTABLE_RESOURCE_EXTS.has(ext);
  const isGeneric = isGenericIconSource(expanded);

  return {
    raw: original,
    path: expanded,
    index: Number.isFinite(index) ? index : null,
    ext,
    isGeneric,
    isDirectImage,
    isExecutableResource,
  };
}

/**
 * Erzeugt einen eindeutigen, kollisionsfreien Cache-Schlüssel für SHA-256-Dateinamen unter userData/icon-cache/.
 */
export function buildIconCacheKey({ appKey = '', sourceType = '', sourcePath = '', iconIndex = null } = {}) {
  const cleanAppKey = String(appKey || '')
    .trim()
    .toLowerCase();
  const cleanType = String(sourceType || '')
    .trim()
    .toLowerCase();
  const normSource = String(sourcePath || '')
    .trim()
    .replace(/\//g, '\\')
    .toLowerCase();
  const idxPart = iconIndex === null || iconIndex === undefined || iconIndex === '' ? '' : String(iconIndex);
  return `${cleanAppKey}|${cleanType}|${normSource}|${idxPart}`;
}

/**
 * Bewertet eine gefundene .exe-Datei als Icon-Kandidat innerhalb eines Installationsordners.
 */
export function scoreExecutableCandidate(filePath, { appName = '', packageId = '', rootDir = '' } = {}) {
  const ext = getExtLower(filePath);
  if (ext !== '.exe') return -1;

  const base = getBaseName(filePath);
  if (isGenericIconSource(base) || isIgnoredExecutableName(base)) {
    return -1;
  }

  const stem = base.slice(0, -ext.length);
  const stemNorm = normalizeText(stem);
  const stemCompact = normalizeCompact(stem);

  const strippedApp = stripVersionSuffix(appName);
  const appNorm = normalizeText(strippedApp || appName);
  const appCompact = normalizeCompact(strippedApp || appName);
  const appTokens = appNorm.split(/\s+/).filter((t) => t.length >= 2);

  const idParts = String(packageId || '')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean);
  const idTailCompact = idParts.length > 0 ? normalizeCompact(idParts[idParts.length - 1]) : '';

  let score = 10;

  if ((appCompact && stemCompact === appCompact) || (idTailCompact && stemCompact === idTailCompact)) {
    score += 100;
  } else if (
    (appTokens[0] && stemCompact.startsWith(normalizeCompact(appTokens[0]))) ||
    (idTailCompact && idTailCompact.length >= 3 && stemCompact.startsWith(idTailCompact))
  ) {
    score += 50;
  }

  if (appTokens.length > 0) {
    const stemWords = new Set(stemNorm.split(/\s+/).filter(Boolean));
    for (const tok of appTokens) {
      if (stemWords.has(tok) || (tok.length >= 3 && stemCompact.includes(tok))) {
        score += 25;
      }
    }
  }

  if (rootDir) {
    const normRoot = String(rootDir).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const normFile = String(filePath).replace(/\//g, '\\').toLowerCase();
    if (normFile.startsWith(`${normRoot}\\`)) {
      const rel = normFile.slice(normRoot.length + 1);
      const segments = rel.split('\\');
      const depth = segments.length - 1;
      if (depth === 0) score += 15;
      else if (depth === 1) score += 8;

      if (segments.slice(0, -1).some((s) => /^(?:resources|locales|redist|tools|bin32)$/i.test(s))) {
        score -= 15;
      }
    }
  }

  return score;
}

/**
 * Bestimmt das finale Icon eines Pakets gemäß Priorität:
 * 1. _metadata/icon.* (Archiv) > 2. extrahiertes PC-Icon > 3. gecachtes Winget/Online-Icon > 4. Platzhalter
 */
export function resolvePackageIcon({ archiveIcon = null, pcIcon = null, cachedIcon = null, origin = 'archive' } = {}) {
  const placeholder = origin === 'pc' ? '💻' : '📦';
  const cleanArchive = typeof archiveIcon === 'string' && archiveIcon.trim() ? archiveIcon.trim() : null;
  if (cleanArchive) {
    return { icon: cleanArchive, source: 'archive', placeholder };
  }

  const cleanPc = typeof pcIcon === 'string' && pcIcon.trim() ? pcIcon.trim() : null;
  if (cleanPc) {
    return { icon: cleanPc, source: 'pc', placeholder };
  }

  const cleanCached = typeof cachedIcon === 'string' && cachedIcon.trim() ? cachedIcon.trim() : null;
  if (cleanCached) {
    return { icon: cleanCached, source: 'cache', placeholder };
  }

  return { icon: null, source: 'placeholder', placeholder };
}

function isValidHomepageCandidate(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (BINARY_DOWNLOAD_EXT_RE.test(parsed.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Leitet für GitHub-Repository-URLs das Owner-Avatar-Bild als Icon-Fallback ab.
 */
export function deriveGitHubAvatarUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (!/^(?:www\.)?github\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length < 1) return null;
    const owner = parts[0];
    if (/^(?:features|marketplace|topics|explore|orgs|settings|login|signup|about|pricing|sponsors)$/i.test(owner)) {
      return null;
    }
    return `https://github.com/${encodeURIComponent(owner)}.png?size=128`;
  } catch {
    return null;
  }
}

/**
 * Extrahiert priorisierte Homepage-URLs für den Online-Favicon-Fallback.
 */
export function extractCandidateHomepageUrls({
  homepage = '',
  repositoryUrl = '',
  publisherUrl = '',
  webVersionUrl = '',
  links = [],
} = {}) {
  const ordered = [];
  const seen = new Set();

  const pushUrl = (url) => {
    if (!isValidHomepageCandidate(url)) return;
    const trimmed = url.trim();
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(trimmed);
    }
  };

  pushUrl(homepage);

  if (Array.isArray(links)) {
    const prioritized = [...links].sort((a, b) => {
      const aHome = /home|web|seite|site|offiziell|github/i.test(String(a?.label || ''));
      const bHome = /home|web|seite|site|offiziell|github/i.test(String(b?.label || ''));
      return Number(bHome) - Number(aHome);
    });
    for (const l of prioritized) {
      pushUrl(l?.url);
    }
  }

  pushUrl(repositoryUrl);
  pushUrl(webVersionUrl);
  pushUrl(publisherUrl);

  return ordered;
}

function getAttr(tag, attrName) {
  const re = new RegExp(`${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = tag.match(re);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
}

function parseMaxIconSize(sizesAttr) {
  if (!sizesAttr) return 0;
  let best = 0;
  for (const m of sizesAttr.matchAll(/(\d+)\s*x\s*(\d+)/gi)) {
    const w = Number.parseInt(m[1], 10);
    if (Number.isFinite(w) && w > best) best = w;
  }
  return best;
}

/**
 * Parst <link rel="icon"> / <link rel="apple-touch-icon"> aus HTML und sortiert nach Qualität.
 */
export function parseFaviconLinksFromHtml(html, baseUrl) {
  if (!baseUrl) return [];
  let originFallback = '';
  try {
    const parsedBase = new URL(baseUrl);
    originFallback = `${parsedBase.origin}/favicon.ico`;
  } catch {
    return [];
  }

  const candidates = [];
  const htmlStr = String(html || '');

  for (const match of htmlStr.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = getAttr(tag, 'rel').toLowerCase();
    if (!rel) continue;
    if (!/\b(?:apple-touch-icon|apple-touch-icon-precomposed|icon|shortcut)\b/.test(rel)) continue;

    const href = getAttr(tag, 'href');
    if (!href || href.startsWith('data:')) continue;

    let resolved;
    try {
      resolved = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }

    const sizes = getAttr(tag, 'sizes');
    const maxPx = parseMaxIconSize(sizes);
    let score = 0;

    if (rel.includes('apple-touch-icon')) score += 100;
    else if (rel.includes('icon')) score += 60;

    if (/\.svg(?:$|\?)/i.test(resolved)) score += 45;
    else if (/\.png(?:$|\?)/i.test(resolved)) score += 35;
    else if (/\.webp(?:$|\?)/i.test(resolved)) score += 30;
    else if (/\.ico(?:$|\?)/i.test(resolved)) score += 10;

    if (maxPx >= 128) score += 30;
    else if (maxPx >= 64) score += 20;
    else if (maxPx >= 32) score += 10;

    candidates.push({ url: resolved, score });
  }

  candidates.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const result = [];
  for (const c of candidates) {
    const key = c.url.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(c.url);
    }
  }

  if (originFallback && !seen.has(originFallback.toLowerCase())) {
    result.push(originFallback);
  }

  return result;
}

function decodeBasicXmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function isResourcePlaceholder(value) {
  const clean = String(value || '').trim();
  return !clean || /^ms-resource:/i.test(clean);
}

function normalizeManifestRelPath(rawPath) {
  return String(rawPath || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

function readXmlTagText(xml, tagName) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_]+:)?${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? decodeBasicXmlEntities(match[1]) : '';
}

function readXmlAttribute(tagText, attrName) {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const match = tagText.match(re);
  return match ? decodeBasicXmlEntities(match[1] ?? match[2] ?? '') : '';
}

/**
 * Parst `AppxManifest.xml` einer MS-Store-/UWP-/AppX-App und extrahiert Anzeigename,
 * Herausgeber sowie priorisierte relative Logo-Pfade (`Square150x150Logo`, `Square44x44Logo`, `Logo`).
 * @param {string} xmlText
 * @returns {{ displayName: string, publisherDisplayName: string, logoCandidates: string[] }}
 */
export function parseAppxManifestMetadata(xmlText) {
  const xml = String(xmlText || '');
  if (!xml.trim()) {
    return { displayName: '', publisherDisplayName: '', logoCandidates: [] };
  }

  const propertiesMatch = xml.match(
    /<(?:[A-Za-z0-9_]+:)?Properties\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?Properties>/i
  );
  const propertiesXml = propertiesMatch ? propertiesMatch[1] : '';

  const propDisplayName = propertiesXml ? readXmlTagText(propertiesXml, 'DisplayName') : '';
  const propPublisher = propertiesXml ? readXmlTagText(propertiesXml, 'PublisherDisplayName') : '';
  const propLogo = propertiesXml ? readXmlTagText(propertiesXml, 'Logo') : '';

  const visualElementsMatches = [...xml.matchAll(/<(?:[A-Za-z0-9_]+:)?VisualElements\b[^>]*>/gi)];
  const defaultTileMatches = [...xml.matchAll(/<(?:[A-Za-z0-9_]+:)?DefaultTile\b[^>]*>/gi)];

  let veDisplayName = '';
  const veSquare150 = [];
  const veSquare44 = [];
  const veLogos = [];
  for (const m of visualElementsMatches) {
    const tag = m[0];
    const dn = readXmlAttribute(tag, 'DisplayName');
    if (!veDisplayName && !isResourcePlaceholder(dn)) {
      veDisplayName = dn;
    }
    const s150 = readXmlAttribute(tag, 'Square150x150Logo');
    if (s150) veSquare150.push(s150);
    const s44 = readXmlAttribute(tag, 'Square44x44Logo');
    if (s44) veSquare44.push(s44);
    const smallLogo = readXmlAttribute(tag, 'Square30x30Logo') || readXmlAttribute(tag, 'SmallLogo');
    const logoAttr = readXmlAttribute(tag, 'Logo');
    if (logoAttr) veLogos.push(logoAttr);
    if (smallLogo) veLogos.push(smallLogo);
  }

  const tileLogos = [];
  for (const m of defaultTileMatches) {
    const tag = m[0];
    const s71 = readXmlAttribute(tag, 'Square71x71Logo');
    const s310 = readXmlAttribute(tag, 'Square310x310Logo');
    if (s71) tileLogos.push(s71);
    if (s310) tileLogos.push(s310);
  }

  const displayName = !isResourcePlaceholder(propDisplayName)
    ? propDisplayName
    : !isResourcePlaceholder(veDisplayName)
      ? veDisplayName
      : '';
  const publisherDisplayName = !isResourcePlaceholder(propPublisher) ? propPublisher : '';

  const rawCandidates = [...veSquare150, ...veSquare44, propLogo, ...veLogos, ...tileLogos];
  const seen = new Set();
  const logoCandidates = [];
  for (const raw of rawCandidates) {
    const norm = normalizeManifestRelPath(raw);
    if (!norm) continue;
    const key = norm.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      logoCandidates.push(norm);
    }
  }

  return {
    displayName,
    publisherDisplayName,
    logoCandidates,
  };
}

function scoreAppxLogoVariant(relPath, { stemLower, isExact }) {
  const lower = relPath.toLowerCase();
  const baseName = getBaseName(lower);
  const ext = getExtLower(lower);
  if (!DIRECT_IMAGE_EXTS.has(ext)) return -9999;

  let score = 0;

  if (/(?:contrast-high|contrast-black|contrast-white)/i.test(lower)) {
    score -= 100;
  }
  if (/(?:theme-light|altform-lightunplated)/i.test(lower)) {
    score -= 15;
  }
  if (/(?:theme-dark|altform-unplated)/i.test(lower)) {
    score += 15;
  }

  const targetMatch = baseName.match(/targetsize-(\d+)/i) || lower.match(/targetsize-(\d+)/i);
  if (targetMatch) {
    const px = Number.parseInt(targetMatch[1], 10);
    if (px >= 64 && px <= 256) score += 70;
    else if (px === 48) score += 45;
    else if (px === 32) score += 20;
    else if (px > 0) score += 5;
  }

  const scaleMatch = baseName.match(/scale-(\d+)/i) || lower.match(/scale-(\d+)/i);
  if (scaleMatch) {
    const scale = Number.parseInt(scaleMatch[1], 10);
    if (scale === 200) score += 65;
    else if (scale === 150) score += 50;
    else if (scale === 400) score += 48;
    else if (scale === 125) score += 38;
    else if (scale === 100) score += 25;
    else if (scale > 0) score += 20;
  }

  if (isExact) {
    score += 30;
  }

  if (ext === '.svg') score += 12;
  else if (ext === '.png') score += 10;
  else if (ext === '.webp') score += 8;
  else if (ext === '.ico') score += 5;

  if (baseName.startsWith(`${stemLower}.`) || baseName.startsWith(`${stemLower}_`)) {
    score += 2;
  }

  return score;
}

/**
 * Waehlt aus vorhandenen AppX-Asset-Dateien die beste konkrete Datei fuer einen logischen
 * Manifest-Logo-Pfad (z. B. `Assets/Square44x44Logo.png` -> `Assets/Square44x44Logo.scale-200.png`).
 * @param {string} logicalRelPath
 * @param {string[]} [availableFiles]
 * @returns {string | null}
 */
export function selectBestAppxLogoFile(logicalRelPath, availableFiles = []) {
  const normTarget = normalizeManifestRelPath(logicalRelPath);
  if (!normTarget || !Array.isArray(availableFiles) || availableFiles.length === 0) return null;

  const targetLower = normTarget.toLowerCase();
  const lastSlash = targetLower.lastIndexOf('/');
  const targetDir = lastSlash !== -1 ? targetLower.slice(0, lastSlash) : '';
  const targetFile = lastSlash !== -1 ? targetLower.slice(lastSlash + 1) : targetLower;
  const dotIdx = targetFile.lastIndexOf('.');
  const stemLower = dotIdx > 0 ? targetFile.slice(0, dotIdx) : targetFile;
  if (!stemLower) return null;

  const scored = [];

  for (const rawFile of availableFiles) {
    const normFile = normalizeManifestRelPath(rawFile);
    if (!normFile) continue;
    const fileLower = normFile.toLowerCase();
    const ext = getExtLower(fileLower);
    if (!DIRECT_IMAGE_EXTS.has(ext)) continue;

    const fileSlash = fileLower.lastIndexOf('/');
    const fileDir = fileSlash !== -1 ? fileLower.slice(0, fileSlash) : '';
    const fileBase = fileSlash !== -1 ? fileLower.slice(fileSlash + 1) : fileLower;

    // Muss im selben Verzeichnis oder einem direkten Qualifier-Unterordner liegen
    let inExpectedDir = fileDir === targetDir;
    if (!inExpectedDir && targetDir && fileDir.startsWith(`${targetDir}/`)) {
      const sub = fileDir.slice(targetDir.length + 1);
      inExpectedDir = !sub.includes('/');
    } else if (!inExpectedDir && !targetDir && fileDir && !fileDir.includes('/')) {
      inExpectedDir = true;
    }
    if (!inExpectedDir) continue;

    const isExact = fileLower === targetLower;
    const fileDot = fileBase.lastIndexOf('.');
    const fileStem = fileDot > 0 ? fileBase.slice(0, fileDot) : fileBase;
    const isVariant = fileStem === stemLower || fileStem.startsWith(`${stemLower}.`);
    if (!isExact && !isVariant) continue;

    const score = scoreAppxLogoVariant(normFile, { stemLower, isExact });
    scored.push({ original: String(rawFile), score, isExact });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || Number(b.isExact) - Number(a.isExact));
  return scored[0].original;
}
