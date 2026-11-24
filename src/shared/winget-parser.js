import { extractVersion } from './version.js';

const ANSI_REGEX = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, 'g');

/**
 * Bereinigt CLI-Ausgaben von ANSI-Steuerzeichen und \r-Spinner-Fragmenten.
 */
export function cleanCliLines(stdout) {
  if (!stdout || typeof stdout !== 'string') return [];
  return stdout
    .replace(ANSI_REGEX, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((rawLine) => {
      const lastCr = rawLine.lastIndexOf('\r');
      const cleaned = lastCr !== -1 ? rawLine.slice(lastCr + 1) : rawLine;
      return cleaned.trimEnd();
    });
}

const TOP_LEVEL_KEYS = new Map([
  ['name', 'name'],
  ['paket-id', 'packageId'],
  ['package id', 'packageId'],
  ['id', 'packageId'],
  ['version', 'version'],
  ['herausgeber', 'publisher'],
  ['publisher', 'publisher'],
  ['herausgeber-url', 'publisherUrl'],
  ['publisher url', 'publisherUrl'],
  ['autor', 'author'],
  ['author', 'author'],
  ['moniker', 'moniker'],
  ['kurzbeschreibung', 'shortDescription'],
  ['short description', 'shortDescription'],
  ['beschreibung', 'description'],
  ['description', 'description'],
  ['startseite', 'homepage'],
  ['homepage', 'homepage'],
  ['lizenz', 'license'],
  ['license', 'license'],
  ['lizenz-url', 'licenseUrl'],
  ['license url', 'licenseUrl'],
  ['versionshinweise', 'releaseNotes'],
  ['release notes', 'releaseNotes'],
  ['url der versionshinweise', 'releaseNotesUrl'],
  ['versionshinweis-url', 'releaseNotesUrl'],
  ['release notes url', 'releaseNotesUrl'],
  ['markierungen', 'tags'],
  ['schlagworte', 'tags'],
  ['tags', 'tags'],
  ['installationsprogramm', '__installerSection'],
  ['installer', '__installerSection'],
  // Ältere Winget-Versionen geben Installer-Felder teils auf Top-Level aus
  ['installertyp', 'installerType'],
  ['installationsprogrammtyp', 'installerType'],
  ['installer type', 'installerType'],
  ['installer-url', 'downloadUrl'],
  ['installationsprogramm-url', 'downloadUrl'],
  ['installer url', 'downloadUrl'],
  ['download-url', 'downloadUrl'],
  ['download url', 'downloadUrl'],
  ['sha256-installer', 'sha256'],
  ['installer-sha256', 'sha256'],
  ['installer sha256', 'sha256'],
  ['sha256', 'sha256'],
  ['freigabedatum', 'releaseDate'],
  ['release date', 'releaseDate'],
]);

const INSTALLER_SUB_KEYS = new Map([
  ['installertyp', 'installerType'],
  ['installationsprogrammtyp', 'installerType'],
  ['installer type', 'installerType'],
  ['installer-url', 'downloadUrl'],
  ['installationsprogramm-url', 'downloadUrl'],
  ['installer url', 'downloadUrl'],
  ['download-url', 'downloadUrl'],
  ['download url', 'downloadUrl'],
  ['sha256-installer', 'sha256'],
  ['installer-sha256', 'sha256'],
  ['installer sha256', 'sha256'],
  ['sha256', 'sha256'],
  ['freigabedatum', 'releaseDate'],
  ['release date', 'releaseDate'],
]);

function deriveShortDescription(description) {
  if (!description) return '';
  const firstPara = description
    .split(/\n{2,}/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  if (firstPara.length <= 200) return firstPara;
  const sentenceMatch = firstPara.match(/^(.{20,200}?[.!?])(?:\s|$)/);
  if (sentenceMatch) return sentenceMatch[1].trim();
  return `${firstPara.slice(0, 197).trim()}...`;
}

/**
 * Parst die Ausgabe von `winget show` (Deutsch & Englisch, inkl. eingerücktem Installer-Block).
 * @param {string} stdout
 * @param {string} [fallbackPackageId]
 * @param {{ packageManager?: string }} [options]
 */
export function parseWingetShowOutput(stdout, fallbackPackageId = '', { packageManager = 'winget' } = {}) {
  const lines = cleanCliLines(stdout);
  const result = {
    name: '',
    packageManager: packageManager || 'winget',
    packageId: fallbackPackageId ? String(fallbackPackageId).trim() : '',
    publisher: '',
    publisherUrl: '',
    author: '',
    moniker: '',
    version: '',
    shortDescription: '',
    description: '',
    homepage: '',
    license: '',
    licenseUrl: '',
    tags: [],
    installerType: '',
    downloadUrl: '',
    sha256: '',
    releaseNotes: '',
    releaseNotesUrl: '',
    releaseDate: '',
  };

  const headerLine = lines.find((l) => /^(?:Gefunden|Found)\s+.+\[[^\]]+\]\s*$/i.test(l.trim()));
  if (headerLine) {
    const headerMatch = headerLine.trim().match(/^(?:Gefunden|Found)\s+(.+?)\s+\[([^\]]+)\]\s*$/i);
    if (headerMatch) {
      if (headerMatch[1]) result.name = headerMatch[1].trim();
      if (headerMatch[2]) result.packageId = headerMatch[2].trim();
    }
  }

  let activeField = null;
  let inInstallerSection = false;
  const multiLines = {
    shortDescription: [],
    description: [],
    releaseNotes: [],
    tags: [],
  };

  for (const rawLine of lines) {
    const isIndented = /^\s{2,}\S/.test(rawLine);
    const trimmed = rawLine.trim();

    if (!trimmed) {
      if ((activeField === 'description' || activeField === 'releaseNotes') && multiLines[activeField].length > 0) {
        multiLines[activeField].push('');
      }
      continue;
    }

    if (!isIndented) {
      const kvMatch = trimmed.match(/^([^:]+):(.*)$/);
      if (kvMatch) {
        const normalizedKey = kvMatch[1].trim().toLowerCase();
        const val = kvMatch[2].trim();
        const mapped = TOP_LEVEL_KEYS.get(normalizedKey) || null;

        if (mapped === '__installerSection') {
          inInstallerSection = true;
          activeField = null;
          continue;
        }

        inInstallerSection = false;
        activeField = mapped;

        if (!mapped) continue;

        if (mapped === 'tags') {
          if (val) {
            multiLines.tags.push(
              ...val
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            );
          }
        } else if (mapped === 'shortDescription' || mapped === 'description' || mapped === 'releaseNotes') {
          if (val) multiLines[mapped].push(val);
        } else if (val) {
          result[mapped] = val;
        }
        continue;
      }
    }

    if (inInstallerSection && isIndented) {
      const subMatch = trimmed.match(/^([^:]+):(.*)$/);
      if (subMatch) {
        const subKey = subMatch[1].trim().toLowerCase();
        const subVal = subMatch[2].trim();
        const subMapped = INSTALLER_SUB_KEYS.get(subKey);
        if (subMapped && subVal) {
          result[subMapped] = subVal;
        }
      }
      continue;
    }

    if (activeField && isIndented) {
      if (activeField === 'tags') {
        multiLines.tags.push(
          ...trimmed
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        );
      } else if (
        activeField === 'shortDescription' ||
        activeField === 'description' ||
        activeField === 'releaseNotes'
      ) {
        multiLines[activeField].push(trimmed);
      }
    }
  }

  result.shortDescription = multiLines.shortDescription.join(' ').replace(/\s+/g, ' ').trim();
  result.description = multiLines.description
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  result.releaseNotes = multiLines.releaseNotes
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  result.tags = [...new Set(multiLines.tags.filter(Boolean))];

  if (!result.shortDescription && result.description) {
    result.shortDescription = deriveShortDescription(result.description);
  } else if (!result.description && result.shortDescription) {
    result.description = result.shortDescription;
  }

  if (result.version) {
    result.version = extractVersion(result.version) || result.version.trim();
  }
  if (result.sha256) {
    result.sha256 = result.sha256.trim().toLowerCase();
  }
  if (result.installerType) {
    result.installerType = result.installerType.trim().toLowerCase();
  }

  return result;
}

/**
 * Führt eine lokalisierte `winget show`-Ausgabe (z. B. de-DE) mit dem Standard-Fallback zusammen,
 * sodass deutsche Texte erhalten bleiben, aber fehlende Installer-Daten ergänzt werden.
 */
export function mergeWingetShowResults(localized, fallback, { packageManager = 'winget' } = {}) {
  if (!localized) return fallback || null;
  if (!fallback) return localized;

  const merged = {
    name: localized.name || fallback.name || '',
    packageManager: localized.packageManager || fallback.packageManager || packageManager || 'winget',
    packageId: localized.packageId || fallback.packageId || '',
    publisher: localized.publisher || fallback.publisher || '',
    publisherUrl: localized.publisherUrl || fallback.publisherUrl || '',
    author: localized.author || fallback.author || '',
    moniker: localized.moniker || fallback.moniker || '',
    version: localized.version || fallback.version || '',
    shortDescription: localized.shortDescription || fallback.shortDescription || '',
    description: localized.description || fallback.description || '',
    homepage: localized.homepage || fallback.homepage || '',
    license: localized.license || fallback.license || '',
    licenseUrl: localized.licenseUrl || fallback.licenseUrl || '',
    tags: localized.tags?.length ? localized.tags : fallback.tags || [],
    installerType: localized.installerType || fallback.installerType || '',
    downloadUrl: localized.downloadUrl || fallback.downloadUrl || '',
    sha256: localized.sha256 || fallback.sha256 || '',
    releaseNotes: localized.releaseNotes || fallback.releaseNotes || '',
    releaseNotesUrl: localized.releaseNotesUrl || fallback.releaseNotesUrl || '',
    releaseDate: localized.releaseDate || fallback.releaseDate || '',
  };

  if (!merged.shortDescription && merged.description) {
    merged.shortDescription = deriveShortDescription(merged.description);
  }
  return merged;
}

function getColumnOffsets(headerLine) {
  if (!headerLine) return [];
  return [...headerLine.matchAll(/\S+/g)].map((m) => m.index);
}

function sliceByOffsets(line, offsets) {
  if (!offsets || offsets.length < 2) return [];
  const cells = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : line.length;
    cells.push(start < line.length ? line.slice(start, end).trim() : '');
  }
  return cells;
}

function isValidPackageId(id) {
  if (!id || /\s/.test(id)) return false;
  if (id.startsWith('-') || id.startsWith('<')) return false;
  return id.includes('.') || id.length >= 2;
}

/**
 * Parst die Ausgabe von `winget search`.
 * @param {string} stdout
 * @param {number} [limit]
 * @param {{ packageManager?: string, defaultSource?: string, requireDotInId?: boolean }} [options]
 */
export function parseWingetSearchOutput(
  stdout,
  limit = 25,
  { packageManager = 'winget', defaultSource = 'winget', requireDotInId = true } = {}
) {
  const lines = cleanCliLines(stdout).filter((l) => l.trim().length > 0);
  const sepIdx = lines.findIndex((l) => /^-{5,}/.test(l.trim()));
  if (sepIdx === -1) return [];

  const headerLine = sepIdx > 0 ? lines[sepIdx - 1] : '';
  const offsets = getColumnOffsets(headerLine);
  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const results = [];

  for (let i = sepIdx + 1; i < lines.length && results.length < maxResults; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || /^</.test(trimmed)) continue;

    let name = '';
    let packageId = '';
    let version = '';
    let source = '';

    if (offsets.length >= 3) {
      const cells = sliceByOffsets(line, offsets);
      [name, packageId, version, source = ''] = cells;
    }

    if (!isValidPackageId(packageId)) {
      const cols = trimmed.split(/\s{2,}/);
      if (cols.length >= 2) {
        name = cols[0]?.trim() || '';
        packageId = cols[1]?.trim() || '';
        version = cols[2]?.trim() || '';
        source = cols[3]?.trim() || '';
      }
    }

    if (!isValidPackageId(packageId) || !/^[A-Za-z0-9._-]+$/.test(packageId)) continue;
    if (requireDotInId && !packageId.includes('.')) continue;

    results.push({
      packageManager: packageManager || 'winget',
      packageId,
      id: packageId,
      name,
      version,
      source: source || defaultSource || 'winget',
    });
  }

  return results;
}

function isUpgradeFooterLine(trimmed) {
  return (
    /^\d+\s+(?:Aktualisierung|upgrade)/i.test(trimmed) ||
    /^(?:Mindestens|At least)\s+\d+/i.test(trimmed) ||
    /^Die folgenden Pakete/i.test(trimmed) ||
    /^The following packages/i.test(trimmed)
  );
}

function normalizeUpgradeVersion(raw) {
  if (!raw) return '';
  return raw.replace(/^[<>]\s*/, '').trim();
}

function parseUpgradeLineFallback(trimmed) {
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 4) return null;

  let end = tokens.length;
  let source = '';

  const last = tokens[end - 1];
  if (/^(?:winget|msstore)$/i.test(last)) {
    source = last;
    end--;
  }

  if (end < 3) return null;
  const availableVersion = tokens[--end];

  let rawInstalledVersion = tokens[--end];
  if (end > 1 && (tokens[end - 1] === '<' || tokens[end - 1] === '>')) {
    rawInstalledVersion = `${tokens[--end]} ${rawInstalledVersion}`;
  }

  if (end < 2) return null;
  const packageId = tokens[--end];
  const name = tokens.slice(0, end).join(' ');

  return { name, packageId, rawInstalledVersion, availableVersion, source };
}

function isTableHeaderRow(name, packageId) {
  return (
    /^name$/i.test(String(name || '').trim()) && /^(?:id|paket-id|package\s*id)$/i.test(String(packageId || '').trim())
  );
}

function isListFooterLine(trimmed) {
  return (
    isUpgradeFooterLine(trimmed) ||
    /^\d+\s+(?:Paket|package)/i.test(trimmed) ||
    /^(?:Keine|No)\s+(?:installierten|installed)/i.test(trimmed)
  );
}

function mapWingetListHeaderColumns(headerLine) {
  const matches = [...String(headerLine || '').matchAll(/\S+/g)];
  const offsets = matches.map((m) => m.index);
  const colMap = {
    name: 0,
    id: 1,
    version: 2,
    available: -1,
    source: -1,
  };

  for (let i = 0; i < matches.length; i++) {
    const token = matches[i][0].toLowerCase();
    if (token === 'name') colMap.name = i;
    else if (token === 'id') colMap.id = i;
    else if (token === 'version') colMap.version = i;
    else if (token === 'verfügbar' || token === 'verfuegbar' || token === 'available') colMap.available = i;
    else if (token === 'quelle' || token === 'source') colMap.source = i;
  }

  return { offsets, colMap };
}

function parseListLineFallback(trimmed, colMap, defaultSource) {
  const cols = trimmed.split(/\s{2,}/);
  if (cols.length >= 3) {
    const name = (cols[colMap.name] || cols[0] || '').trim();
    const packageId = (cols[colMap.id] || cols[1] || '').trim();
    if (isValidPackageId(packageId)) {
      const rawVersion = (cols[colMap.version] || cols[2] || '').trim();
      let availableVersion = '';
      let source = '';

      if (colMap.available !== -1 && colMap.source !== -1) {
        if (cols.length >= 5) {
          availableVersion = (cols[colMap.available] || '').trim();
          source = (cols[colMap.source] || '').trim();
        } else if (cols.length === 4) {
          const fourth = (cols[3] || '').trim();
          if (/^(?:winget|msstore)$/i.test(fourth)) {
            source = fourth;
          } else {
            availableVersion = fourth;
          }
        }
      } else if (colMap.available !== -1) {
        availableVersion = (cols[colMap.available] || '').trim();
      } else if (colMap.source !== -1) {
        source = (cols[colMap.source] || '').trim();
      }

      return { name, packageId, rawVersion, availableVersion, source: source || defaultSource };
    }
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 3) return null;

  let end = tokens.length;
  let source = '';
  const last = tokens[end - 1];
  if (colMap.source !== -1 && /^(?:winget|msstore)$/i.test(last)) {
    source = last;
    end--;
  }

  if (end < 3) return null;
  let availableVersion = '';
  let rawVersion = tokens[--end];
  if (end > 1 && (tokens[end - 1] === '<' || tokens[end - 1] === '>')) {
    rawVersion = `${tokens[--end]} ${rawVersion}`;
  } else if (
    colMap.available !== -1 &&
    end >= 3 &&
    /^\d+(?:\.\d+)+/.test(rawVersion) &&
    (/^[\d.<>-]+$/.test(tokens[end - 1]) || /^(?:unbekannt|unknown)$/i.test(tokens[end - 1]))
  ) {
    availableVersion = rawVersion;
    rawVersion = tokens[--end];
    if (end > 1 && (tokens[end - 1] === '<' || tokens[end - 1] === '>')) {
      rawVersion = `${tokens[--end]} ${rawVersion}`;
    }
  }

  if (end < 2) return null;
  const packageId = tokens[--end];
  const name = tokens.slice(0, end).join(' ');
  return { name, packageId, rawVersion, availableVersion, source: source || defaultSource };
}

/**
 * Parst die Ausgabe von `winget upgrade` (inkl. abgeschnittener `...`-IDs, `< Version`-Angaben und Multi-Tabellen).
 * @param {string} stdout
 * @param {{ packageManager?: string, defaultSource?: string }} [options]
 */
export function parseWingetUpgradeOutput(stdout, { packageManager = 'winget', defaultSource = 'winget' } = {}) {
  const lines = cleanCliLines(stdout).filter((l) => l.trim().length > 0);
  const sepIdx = lines.findIndex((l) => /^-{5,}/.test(l.trim()));
  if (sepIdx === -1) return [];

  let headerLine = sepIdx > 0 ? lines[sepIdx - 1] : '';
  let offsets = getColumnOffsets(headerLine);
  const results = [];

  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^-{5,}/.test(trimmed)) {
      headerLine = i > 0 ? lines[i - 1] : '';
      offsets = getColumnOffsets(headerLine);
      continue;
    }
    if (i + 1 < lines.length && /^-{5,}/.test(lines[i + 1].trim())) {
      continue;
    }
    if (isUpgradeFooterLine(trimmed)) continue;

    let name = '';
    let packageId = '';
    let rawInstalledVersion = '';
    let availableVersion = '';
    let source = '';

    if (offsets.length >= 4) {
      const cells = sliceByOffsets(line, offsets);
      name = cells[0] || '';
      packageId = cells[1] || '';
      rawInstalledVersion = cells[2] || '';
      availableVersion = cells[3] || '';
      source = cells[4] || '';
    }

    const offsetParsedLooksBroken =
      !isValidPackageId(packageId) ||
      !availableVersion ||
      /\s/.test(availableVersion) ||
      (rawInstalledVersion && /\s/.test(normalizeUpgradeVersion(rawInstalledVersion)));

    if (offsetParsedLooksBroken) {
      const fb = parseUpgradeLineFallback(trimmed);
      if (fb) {
        name = fb.name;
        packageId = fb.packageId;
        rawInstalledVersion = fb.rawInstalledVersion;
        availableVersion = fb.availableVersion;
        source = fb.source;
      }
    }

    if (isTableHeaderRow(name, packageId)) continue;
    if (!isValidPackageId(packageId) || !availableVersion) continue;

    const idTruncated = packageId.endsWith('…') || packageId.endsWith('...');
    const installedVersionIsLowerBound = /^\s*</.test(rawInstalledVersion);

    results.push({
      packageManager: packageManager || 'winget',
      packageId,
      id: packageId,
      name: name.trim(),
      installedVersion: normalizeUpgradeVersion(rawInstalledVersion),
      rawInstalledVersion: rawInstalledVersion.trim(),
      installedVersionIsLowerBound,
      availableVersion: availableVersion.trim(),
      source: source.trim() || defaultSource || 'winget',
      idTruncated,
    });
  }

  return results;
}

/**
 * Parst die Tabellenausgabe von `winget list` (3, 4 oder 5 Spalten sowie Multi-Tabellen).
 * @param {string} stdout
 * @param {{ packageManager?: string, defaultSource?: string, requireDotInId?: boolean }} [options]
 */
export function parseWingetListOutput(
  stdout,
  { packageManager = 'winget', defaultSource = 'winget', requireDotInId = false } = {}
) {
  const lines = cleanCliLines(stdout).filter((l) => l.trim().length > 0);
  const sepIdx = lines.findIndex((l) => /^-{5,}/.test(l.trim()));
  if (sepIdx === -1) return [];

  let headerLine = sepIdx > 0 ? lines[sepIdx - 1] : '';
  let { offsets, colMap } = mapWingetListHeaderColumns(headerLine);
  const results = [];
  const seenIds = new Set();

  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^-{5,}/.test(trimmed)) {
      headerLine = i > 0 ? lines[i - 1] : '';
      ({ offsets, colMap } = mapWingetListHeaderColumns(headerLine));
      continue;
    }
    if (i + 1 < lines.length && /^-{5,}/.test(lines[i + 1].trim())) {
      continue;
    }
    if (isListFooterLine(trimmed)) continue;

    let name = '';
    let packageId = '';
    let rawVersion = '';
    let availableVersion = '';
    let source = '';

    if (offsets.length >= 3) {
      const cells = sliceByOffsets(line, offsets);
      name = cells[colMap.name] || '';
      packageId = cells[colMap.id] || '';
      rawVersion = cells[colMap.version] || '';
      availableVersion = colMap.available !== -1 ? cells[colMap.available] || '' : '';
      source = colMap.source !== -1 ? cells[colMap.source] || '' : '';
    }

    const offsetParsedLooksBroken =
      !isValidPackageId(packageId) ||
      !rawVersion ||
      /\s/.test(normalizeUpgradeVersion(rawVersion)) ||
      (availableVersion && /\s/.test(availableVersion));

    if (offsetParsedLooksBroken) {
      const fb = parseListLineFallback(trimmed, colMap, defaultSource);
      if (fb) {
        name = fb.name;
        packageId = fb.packageId;
        rawVersion = fb.rawVersion;
        availableVersion = fb.availableVersion;
        source = fb.source;
      }
    }

    if (isTableHeaderRow(name, packageId)) continue;
    if (!isValidPackageId(packageId)) continue;
    if (requireDotInId && !packageId.includes('.')) continue;

    const key = packageId.toLowerCase();
    if (seenIds.has(key)) continue;
    seenIds.add(key);

    const idTruncated = packageId.endsWith('…') || packageId.endsWith('...');
    const installedVersionIsLowerBound = /^\s*</.test(rawVersion);

    results.push({
      packageManager: packageManager || 'winget',
      packageId,
      id: packageId,
      name: name.trim(),
      version: normalizeUpgradeVersion(rawVersion),
      rawVersion: rawVersion.trim(),
      installedVersionIsLowerBound,
      availableVersion: availableVersion.trim(),
      source: source.trim() || defaultSource || 'winget',
      idTruncated,
    });
  }

  return results;
}

/**
 * Ergaenzt `winget export`-Eintraege (volle IDs, ohne Name) mit lesbaren Namen und optionalen
 * Update-Spalten aus `winget list` (inkl. Aufloesung abgeschnittener `...`-IDs).
 * @param {Array<Record<string, any>>} [exportPackages]
 * @param {Array<Record<string, any>>} [listPackages]
 * @param {{ packageManager?: string, defaultSource?: string }} [options]
 */
export function mergeWingetExportWithList(
  exportPackages = [],
  listPackages = [],
  { packageManager = 'winget', defaultSource = 'winget' } = {}
) {
  const listByExactId = new Map();
  const truncatedList = [];

  for (const item of listPackages || []) {
    const pid = String(item?.packageId || item?.id || '').trim();
    if (!pid) continue;
    if (item.idTruncated || pid.endsWith('…') || pid.endsWith('...')) {
      truncatedList.push(item);
    } else {
      listByExactId.set(pid.toLowerCase(), item);
    }
  }

  const matchedListKeys = new Set();
  const merged = [];

  for (const exp of exportPackages || []) {
    const pid = String(exp?.packageId || exp?.id || '').trim();
    if (!pid) continue;
    const key = pid.toLowerCase();

    let match = listByExactId.get(key) || null;
    if (match) {
      matchedListKeys.add(key);
    } else {
      match =
        truncatedList.find((t) => {
          const prefix = String(t.packageId || '')
            .replace(/(?:…|\.\.\.)$/, '')
            .toLowerCase();
          return prefix.length >= 4 && key.startsWith(prefix);
        }) || null;
    }

    const version = String(exp?.version || '').trim() || String(match?.version || '').trim();
    merged.push({
      ...exp,
      packageManager: exp?.packageManager || packageManager || 'winget',
      packageId: pid,
      id: pid,
      name: String(match?.name || exp?.name || '').trim(),
      version,
      availableVersion: String(match?.availableVersion || exp?.availableVersion || '').trim(),
      installedVersionIsLowerBound: Boolean(match?.installedVersionIsLowerBound || exp?.installedVersionIsLowerBound),
      source: String(exp?.source || match?.source || defaultSource || 'winget').trim(),
    });
  }

  const seenMerged = new Set(merged.map((m) => String(m.packageId || '').toLowerCase()));
  for (const item of listPackages || []) {
    const pid = String(item?.packageId || item?.id || '').trim();
    if (!pid || item.idTruncated || pid.endsWith('…') || pid.endsWith('...')) continue;
    const key = pid.toLowerCase();
    if (matchedListKeys.has(key) || seenMerged.has(key)) continue;
    seenMerged.add(key);
    merged.push({
      ...item,
      packageManager: item?.packageManager || packageManager || 'winget',
      packageId: pid,
      id: pid,
      source: String(item?.source || defaultSource || 'winget').trim(),
    });
  }

  return merged;
}

/**
 * Parst die JSON-Ausgabe von `winget export -o <file> --include-versions`.
 */
export function parseWingetExportJson(rawText) {
  if (!rawText || typeof rawText !== 'string') return [];
  const cleaned = rawText.replace(/^\uFEFF/, '').trim();
  if (!cleaned) return [];

  const parsed = JSON.parse(cleaned);
  const sources = Array.isArray(parsed?.Sources) ? parsed.Sources : [];
  const byId = new Map();

  for (const src of sources) {
    const sourceName = src?.SourceDetails?.Name || 'winget';
    const pkgs = Array.isArray(src?.Packages) ? src.Packages : [];
    for (const pkg of pkgs) {
      const packageId = String(pkg?.PackageIdentifier || '').trim();
      if (!packageId) continue;
      const key = packageId.toLowerCase();
      if (!byId.has(key)) {
        byId.set(key, {
          packageManager: 'winget',
          packageId,
          version: pkg?.Version ? String(pkg.Version).trim() : '',
          source: sourceName,
        });
      }
    }
  }

  return [...byId.values()];
}
