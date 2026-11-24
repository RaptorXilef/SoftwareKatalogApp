import { cleanCliLines } from './winget-parser.js';

function stripBomAndAnsi(text) {
  if (!text || typeof text !== 'string') return '';
  return cleanCliLines(text.replace(/^\uFEFF/, '')).join('\n');
}

function getColumnOffsetsFromDashes(dashLine) {
  if (!dashLine) return [];
  return [...dashLine.matchAll(/-+/g)].map((m) => m.index);
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

function mapHeaderColumns(headerLine, offsets) {
  const headerCells = sliceByOffsets(headerLine, offsets).map((h) => h.toLowerCase());
  const indexMap = new Map();
  for (let i = 0; i < headerCells.length; i++) {
    const h = headerCells[i];
    if (h === 'name') indexMap.set('name', i);
    else if (h.includes('installed')) indexMap.set('installedVersion', i);
    else if (h.includes('latest') || h === 'version') indexMap.set('availableVersion', i);
    else if (h.includes('missing')) indexMap.set('missingDependencies', i);
    else if (h === 'source' || h === 'bucket') indexMap.set('bucket', i);
    else if (h === 'binaries') indexMap.set('binaries', i);
    else if (h === 'info') indexMap.set('info', i);
  }
  return indexMap;
}

/**
 * Parst die JSON-Ausgabe von `scoop export`.
 * @param {string} rawText
 */
export function parseScoopExportJson(rawText) {
  const cleaned = stripBomAndAnsi(rawText).trim();
  if (!cleaned) return [];

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace <= firstBrace) return [];
    try {
      parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {
      return [];
    }
  }

  const apps = Array.isArray(parsed?.apps) ? parsed.apps : Array.isArray(parsed?.Apps) ? parsed.Apps : [];
  const byName = new Map();

  for (const app of apps) {
    if (!app || typeof app !== 'object') continue;
    const name = String(app.Name ?? app.name ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (byName.has(key)) continue;

    const version = String(app.Version ?? app.version ?? '').trim();
    const bucket = String(app.Source ?? app.source ?? '').trim();
    const updated = String(app.Updated ?? app.updated ?? '').trim();
    const info = String(app.Info ?? app.info ?? '').trim();

    byName.set(key, {
      packageManager: 'scoop',
      packageId: name,
      id: name,
      name,
      version,
      bucket,
      source: bucket || 'scoop',
      updated,
      info,
    });
  }

  return [...byName.values()];
}

/**
 * Parst die Tabellen-Ausgabe von `scoop status`.
 * @param {string} stdout
 * @param {{ includeHeld?: boolean }} [options]
 */
export function parseScoopStatusOutput(stdout, { includeHeld = false } = {}) {
  const lines = cleanCliLines(stdout).filter((l) => l.trim().length > 0);
  const sepIdx = lines.findIndex((l) => /^-{2,}(?:\s+-{2,})+$/.test(l.trim()));
  if (sepIdx === -1) return [];

  const dashLine = lines[sepIdx];
  const offsets = getColumnOffsetsFromDashes(dashLine);
  const headerLine = sepIdx > 0 ? lines[sepIdx - 1] : '';
  const colMap = mapHeaderColumns(headerLine, offsets);

  const results = [];

  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || /^scoop is up to date/i.test(trimmed) || /^everything is ok/i.test(trimmed)) {
      continue;
    }

    let cells = offsets.length >= 3 ? sliceByOffsets(line, offsets) : [];
    if (cells.length < 3 || !cells[0]) {
      cells = trimmed.split(/\s{2,}/);
    }

    const name = (cells[colMap.get('name') ?? 0] || '').trim();
    const installedVersion = (cells[colMap.get('installedVersion') ?? 1] || '').trim();
    const availableVersion = (cells[colMap.get('availableVersion') ?? 2] || '').trim();
    const missingDependencies = colMap.has('missingDependencies')
      ? (cells[colMap.get('missingDependencies')] || '').trim()
      : (cells[3] || '').trim();
    const info = colMap.has('info') ? (cells[colMap.get('info')] || '').trim() : (cells[4] || '').trim();

    if (!name || !availableVersion || availableVersion === '-') continue;
    if (installedVersion && installedVersion === availableVersion) continue;
    if (!includeHeld && /held package/i.test(info)) continue;

    results.push({
      packageManager: 'scoop',
      packageId: name,
      id: name,
      name,
      installedVersion,
      availableVersion,
      missingDependencies,
      info,
      source: 'scoop',
    });
  }

  return results;
}

/**
 * Parst die Ausgabe von `scoop search <query>` (Tabellenformat und klassisches Bucket-Gruppenformat).
 * @param {string} stdout
 * @param {number} [limit]
 */
export function parseScoopSearchOutput(stdout, limit = 25) {
  const lines = cleanCliLines(stdout);
  const maxResults = Number.isFinite(limit) && limit > 0 ? limit : Number.POSITIVE_INFINITY;
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const sepIdx = nonEmpty.findIndex((l) => /^-{2,}(?:\s+-{2,})+$/.test(l.trim()));

  const results = [];
  const seen = new Set();

  if (sepIdx !== -1) {
    const dashLine = nonEmpty[sepIdx];
    const offsets = getColumnOffsetsFromDashes(dashLine);
    const headerLine = sepIdx > 0 ? nonEmpty[sepIdx - 1] : '';
    const colMap = mapHeaderColumns(headerLine, offsets);

    for (let i = sepIdx + 1; i < nonEmpty.length && results.length < maxResults; i++) {
      const line = nonEmpty[i];
      const trimmed = line.trim();
      if (!trimmed || /^results from/i.test(trimmed) || /^warn\b/i.test(trimmed)) continue;

      let cells = offsets.length >= 2 ? sliceByOffsets(line, offsets) : [];
      if (cells.length < 2 || !cells[0]) {
        cells = trimmed.split(/\s{2,}/);
      }

      const name = (cells[colMap.get('name') ?? 0] || '').trim();
      const version = (cells[colMap.get('availableVersion') ?? 1] || '').trim();
      const bucket = (cells[colMap.get('bucket') ?? 2] || '').trim();
      const binaries = colMap.has('binaries') ? (cells[colMap.get('binaries')] || '').trim() : (cells[3] || '').trim();

      if (!name || /\s/.test(name)) continue;
      const key = `${bucket.toLowerCase()}:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        packageManager: 'scoop',
        packageId: name,
        id: name,
        name,
        version,
        bucket,
        source: bucket || 'scoop',
        binaries,
      });
    }
    return results;
  }

  // Fallback für klassisches Bucket-Gruppenformat: `'main' bucket:` + `  git (2.47.0)`
  let currentBucket = '';
  for (const rawLine of lines) {
    if (results.length >= maxResults) break;
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const bucketHeader = trimmed.match(/^['"]?([A-Za-z0-9._-]+)['"]?\s+bucket:$/i);
    if (bucketHeader) {
      currentBucket = bucketHeader[1].trim();
      continue;
    }

    const legacyMatch = trimmed.match(/^([A-Za-z0-9._+-]+)\s+\(([^)]+)\)(?:\s+-->\s+includes\s+'([^']+)')?/);
    if (legacyMatch) {
      const name = legacyMatch[1].trim();
      const version = legacyMatch[2].trim();
      const binaries = legacyMatch[3] ? legacyMatch[3].trim() : '';
      const key = `${currentBucket.toLowerCase()}:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        packageManager: 'scoop',
        packageId: name,
        id: name,
        name,
        version,
        bucket: currentBucket,
        source: currentBucket || 'scoop',
        binaries,
      });
    }
  }

  return results;
}

function parseScoopLicenseField(rawLicense) {
  const text = String(rawLicense || '').trim();
  if (!text) return { license: '', licenseUrl: '' };

  const parenUrlMatch = text.match(/^(.+?)\s*\((https?:\/\/[^)\s]+)\)\s*$/i);
  if (parenUrlMatch) {
    return {
      license: parenUrlMatch[1].trim(),
      licenseUrl: parenUrlMatch[2].trim(),
    };
  }
  if (/^https?:\/\//i.test(text)) {
    return { license: '', licenseUrl: text };
  }
  return { license: text, licenseUrl: '' };
}

/**
 * Parst die Ausgabe von `scoop info <pkg>`.
 * @param {string} stdout
 * @param {string} [fallbackPackageId]
 */
export function parseScoopInfoOutput(stdout, fallbackPackageId = '') {
  const lines = cleanCliLines(stdout);
  const result = {
    name: '',
    packageManager: 'scoop',
    packageId: fallbackPackageId ? String(fallbackPackageId).trim() : '',
    version: '',
    bucket: '',
    shortDescription: '',
    description: '',
    homepage: '',
    license: '',
    licenseUrl: '',
    installedPath: '',
    notes: '',
    tags: [],
  };

  let activeField = null;
  const multiLines = {
    description: [],
    notes: [],
  };

  for (const rawLine of lines) {
    const kvMatch = rawLine.match(/^\s*([A-Za-z][A-Za-z0-9 _-]+?)\s*:\s*(.*)$/);
    const isIndentedContinuation = /^\s{2,}\S/.test(rawLine) && !kvMatch;

    if (!rawLine.trim()) {
      if ((activeField === 'description' || activeField === 'notes') && multiLines[activeField].length > 0) {
        multiLines[activeField].push('');
      }
      continue;
    }

    if (kvMatch) {
      const key = kvMatch[1].trim().toLowerCase();
      const val = kvMatch[2].trim();
      activeField = null;

      if (key === 'name') {
        if (val) {
          result.name = val;
          if (!result.packageId) result.packageId = val;
        }
      } else if (key === 'description') {
        activeField = 'description';
        if (val) multiLines.description.push(val);
      } else if (key === 'version') {
        result.version = val;
      } else if (key === 'bucket') {
        result.bucket = val;
      } else if (key === 'website' || key === 'homepage') {
        result.homepage = val;
      } else if (key === 'license') {
        const parsedLic = parseScoopLicenseField(val);
        result.license = parsedLic.license;
        result.licenseUrl = parsedLic.licenseUrl;
      } else if (key === 'installed') {
        result.installedPath = val;
      } else if (key === 'notes') {
        activeField = 'notes';
        if (val) multiLines.notes.push(val);
      }
      continue;
    }

    if (isIndentedContinuation && (activeField === 'description' || activeField === 'notes')) {
      multiLines[activeField].push(rawLine.trim());
    }
  }

  result.description = multiLines.description
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  result.notes = multiLines.notes
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (result.description) {
    const firstPara = result.description
      .split(/\n{2,}/)[0]
      .replace(/\s+/g, ' ')
      .trim();
    result.shortDescription = firstPara.length <= 200 ? firstPara : `${firstPara.slice(0, 197).trim()}...`;
  }

  if (!result.name && result.packageId) {
    result.name = result.packageId;
  }
  if (!result.packageId && result.name) {
    result.packageId = result.name;
  }
  if (result.bucket) {
    result.tags = [result.bucket];
  }

  return result;
}
