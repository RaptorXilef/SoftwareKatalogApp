import { extractVersion } from './version.js';

function decodeBasicHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripTagsToText(htmlFragment) {
  return decodeBasicHtmlEntities(
    String(htmlFragment || '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFragmentForPlainText(fragment, isPrefix) {
  let clean = String(fragment || '');
  if (isPrefix) {
    clean = clean.replace(/^[^<>]*>/, '');
  } else {
    clean = clean.replace(/<[^<>]*$/, '');
  }
  return stripTagsToText(clean);
}

function buildFlexRegex(str, wildcardNumbers = false) {
  let escaped = String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wildcardNumbers) {
    escaped = escaped.replace(/\d+(?:\\.\d+)+|\b\d+\b|(?<=_|-|\/)\d+/g, '\\d+(?:\\.\\d+)*');
  }
  return escaped
    .replace(/["']/g, '["\']')
    .replace(/<br\s*\\?\/?>/gi, '<br\\s*\\/?>')
    .replace(/\s+/g, '\\s+');
}

function getPreferredSearchScopes(html) {
  const full = String(html || '');
  if (!full) return [];
  const bodyMatch = full.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch?.[1]) {
    return [bodyMatch[1], full];
  }
  return [full];
}

/**
 * Sammelt alle Kandidaten-Ausschnitte zwischen `prefix` und `suffix` aus einem HTML-Dokument
 * (zuerst exakt, dann mit flexiblem Whitespace/Quotes und optionalen Zahlen-Wildcards).
 * @param {string} html
 * @param {string} prefix
 * @param {string} [suffix]
 * @param {{ maxCandidates?: number }} [options]
 * @returns {string[]}
 */
export function extractBetweenAll(html, prefix, suffix = '', { maxCandidates = 60 } = {}) {
  if (!html || !prefix) return [];

  const candidates = [];
  const seen = new Set();
  const pushCandidate = (raw) => {
    const trimmed = String(raw || '').trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  const scopes = getPreferredSearchScopes(html);

  // 1. Exakte Suche über alle Vorkommen
  for (const scope of scopes) {
    if (candidates.length >= maxCandidates) break;
    if (suffix) {
      let searchFrom = 0;
      while (searchFrom < scope.length && candidates.length < maxCandidates) {
        const preIdx = scope.indexOf(prefix, searchFrom);
        if (preIdx === -1) break;
        const startIdx = preIdx + prefix.length;
        const sufIdx = scope.indexOf(suffix, startIdx);
        if (sufIdx === -1) break;

        const closerPreIdx = scope.lastIndexOf(prefix, sufIdx);
        const actualStart = closerPreIdx !== -1 && closerPreIdx >= preIdx ? closerPreIdx + prefix.length : startIdx;

        if (sufIdx - actualStart <= 500) {
          pushCandidate(scope.substring(actualStart, sufIdx));
          searchFrom = sufIdx + suffix.length;
        } else {
          searchFrom = actualStart;
        }
      }
    } else {
      let searchFrom = 0;
      while (searchFrom < scope.length && candidates.length < maxCandidates) {
        const preIdx = scope.indexOf(prefix, searchFrom);
        if (preIdx === -1) break;
        const startIdx = preIdx + prefix.length;
        pushCandidate(scope.substring(startIdx, startIdx + 60));
        searchFrom = startIdx;
      }
    }
  }

  // 2. Flexible Regex-Suche (Quotes, Whitespace, <br>, danach Wildcard-Zahlen)
  for (const useWildcard of [false, true]) {
    if (candidates.length >= maxCandidates) break;
    try {
      const prePat = buildFlexRegex(prefix, useWildcard);
      const sufPat = suffix ? buildFlexRegex(suffix, useWildcard) : '';
      const fullRegex = suffix
        ? new RegExp(`${prePat}([\\s\\S]{1,500}?)${sufPat}`, 'gi')
        : new RegExp(`${prePat}([\\s\\S]{1,60})`, 'gi');

      for (const scope of scopes) {
        fullRegex.lastIndex = 0;
        let match = fullRegex.exec(scope);
        while (match !== null && candidates.length < maxCandidates) {
          if (match[1]) pushCandidate(match[1]);
          if (match.index === fullRegex.lastIndex) fullRegex.lastIndex++;
          match = fullRegex.exec(scope);
        }
      }
    } catch {
      // Ungültige Regex-Konstruktion ignorieren
    }
  }

  return candidates;
}

/**
 * Extrahiert eine gültige Versionsnummer aus HTML anhand von Präfix/Suffix.
 * Prüft alle Treffer (nicht nur den ersten im Dokument) und nutzt einen Klartext-/Entity-Fallback.
 * @param {string} html
 * @param {string} prefix
 * @param {string} [suffix]
 * @returns {string | null}
 */
export function extractVersionFromHtml(html, prefix, suffix = '') {
  if (!html || !prefix) return null;

  const htmlCandidates = extractBetweenAll(html, prefix, suffix);
  for (const raw of htmlCandidates) {
    const plain = stripTagsToText(raw);
    const ver = extractVersion(plain) || extractVersion(raw);
    if (ver) return ver;
  }

  // Klartext-Fallback (fängt abweichende Attribut-Reihenfolgen zwischen Chromium-DOM und Server-HTML ab)
  const plainPrefix = normalizeFragmentForPlainText(prefix, true);
  const plainSuffix = normalizeFragmentForPlainText(suffix, false);
  if (plainPrefix.length >= 2) {
    const scopes = getPreferredSearchScopes(html);
    for (const scope of scopes) {
      const bodyText = stripTagsToText(scope);
      if (!bodyText) continue;
      for (const useWildcard of [false, true]) {
        try {
          const prePat = buildFlexRegex(plainPrefix, useWildcard);
          const sufPat = plainSuffix.length >= 1 ? buildFlexRegex(plainSuffix, useWildcard) : '';
          const re = sufPat
            ? new RegExp(`${prePat}\\s*([\\s\\S]{1,120}?)\\s*${sufPat}`, 'gi')
            : new RegExp(`${prePat}\\s*([\\s\\S]{1,40})`, 'gi');

          let match = re.exec(bodyText);
          while (match !== null) {
            const ver = extractVersion(match[1] || '');
            if (ver) return ver;
            if (match.index === re.lastIndex) re.lastIndex++;
            match = re.exec(bodyText);
          }
        } catch {
          // Ignorieren
        }
      }
    }
  }

  return null;
}

/**
 * Extrahiert eine Download-Link-URL zwischen `prefix` und `suffix` aus HTML.
 * @param {string} html
 * @param {string} prefix
 * @param {string} [suffix]
 * @returns {string | null}
 */
export function extractLinkFromHtml(html, prefix, suffix = '') {
  if (!html || !prefix) return null;
  const candidates = extractBetweenAll(html, prefix, suffix, { maxCandidates: 25 });
  for (const raw of candidates) {
    const cleanHref = decodeBasicHtmlEntities(raw)
      .split(/["'\s>]/)[0]
      .trim();
    if (cleanHref && !cleanHref.startsWith('#') && !/^javascript:/i.test(cleanHref)) {
      return cleanHref;
    }
  }
  return null;
}
