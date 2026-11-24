import { cleanCliLines } from './winget-parser.js';

const SOURCE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const WINGET_TYPE_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Vorlagen fuer bekannte Bezugsquellen je Paketmanager.
 */
export const PROVIDER_SOURCE_TEMPLATES = Object.freeze({
  winget: Object.freeze([
    {
      name: 'winget',
      url: 'https://cdn.winget.microsoft.com/cache',
      type: 'Microsoft.PreIndexed.Package',
      description: 'Offizielles Winget-Community-Repository',
    },
    {
      name: 'msstore',
      url: 'https://storeedgefd.dsx.mp.microsoft.com/v9.0',
      type: 'Microsoft.Rest',
      description: 'Microsoft Store-Quelle',
    },
    {
      name: 'winget-font',
      url: 'https://cdn.winget.microsoft.com/fonts',
      type: 'Microsoft.PreIndexed.Package',
      description: 'Offizielle Winget-Schriftarten',
    },
  ]),
  pwsh7: Object.freeze([
    {
      name: 'PSGallery',
      url: 'https://www.powershellgallery.com/api/v2',
      description: 'Offizielle PowerShell Gallery',
    },
  ]),
  pwsh5: Object.freeze([
    {
      name: 'PSGallery',
      url: 'https://www.powershellgallery.com/api/v2',
      description: 'Offizielle PowerShell Gallery',
    },
  ]),
  scoop: Object.freeze([
    { name: 'main', url: '', description: 'Standard-Bucket fuer CLI-Tools' },
    { name: 'extras', url: '', description: 'GUI-Programme und zusaetzliche Tools' },
    { name: 'versions', url: '', description: 'Alternative und aeltere Programmversionen' },
    { name: 'nerd-fonts', url: '', description: 'Gepatchte Entwickler-Schriftarten' },
    { name: 'java', url: '', description: 'JDKs und Java-Runtimes' },
  ]),
  chocolatey: Object.freeze([
    {
      name: 'chocolatey',
      url: 'https://community.chocolatey.org/api/v2/',
      description: 'Offizielles Chocolatey Community Repository',
    },
  ]),
  npm: Object.freeze([
    { name: 'npmjs', url: 'https://registry.npmjs.org', description: 'Offizielle npm Registry (Standard)' },
    { name: 'npmmirror', url: 'https://registry.npmmirror.com', description: 'npmmirror Registry' },
  ]),
  bun: Object.freeze([
    { name: 'npmjs', url: 'https://registry.npmjs.org', description: 'Offizielle npm Registry (Standard)' },
    { name: 'npmmirror', url: 'https://registry.npmmirror.com', description: 'npmmirror Registry' },
  ]),
  pnpm: Object.freeze([
    { name: 'npmjs', url: 'https://registry.npmjs.org', description: 'Offizielle npm Registry (Standard)' },
    { name: 'npmmirror', url: 'https://registry.npmmirror.com', description: 'npmmirror Registry' },
  ]),
  pip: Object.freeze([
    { name: 'pypi', url: 'https://pypi.org/simple', description: 'Offizieller Python Package Index (Standard)' },
    { name: 'testpypi', url: 'https://test.pypi.org/simple', description: 'PyPI Test-Instanz' },
  ]),
  uv: Object.freeze([
    { name: 'pypi', url: 'https://pypi.org/simple', description: 'Offizieller Python Package Index (Standard)' },
    { name: 'testpypi', url: 'https://test.pypi.org/simple', description: 'PyPI Test-Instanz' },
  ]),
});

/**
 * Prueft, ob ein Quellenname gueltig und sicher fuer CLI-Parameter ist.
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidSourceName(name) {
  if (typeof name !== 'string') return false;
  return SOURCE_NAME_RE.test(name.trim());
}

/**
 * Prueft, ob eine Quellen-URL eine gueltige HTTP/HTTPS-URL ist.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isValidSourceUrl(url) {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Prueft einen optionalen Winget-Quelltyp (z. B. Microsoft.PreIndexed.Package).
 * @param {unknown} type
 * @returns {boolean}
 */
export function isValidWingetSourceType(type) {
  if (type === undefined || type === null) return true;
  if (typeof type !== 'string') return false;
  const trimmed = type.trim();
  if (!trimmed) return true;
  return WINGET_TYPE_RE.test(trimmed);
}

/**
 * Normalisiert eine Quellen-URL (entfernt ueberfluessige abschliessende Slashes ausser Root).
 * @param {unknown} url
 * @returns {string}
 */
export function normalizeSourceUrl(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
      return parsed.origin;
    }
    return parsed.href.replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function getWordOffsets(line) {
  if (!line) return [];
  return [...String(line).matchAll(/\S+/g)].map((m) => m.index);
}

function getDashOffsets(dashLine) {
  if (!dashLine) return [];
  return [...String(dashLine).matchAll(/-+/g)].map((m) => m.index);
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

/**
 * Parst die Ausgabe von `winget source list`.
 * @param {string} stdout
 * @returns {Array<{ name: string, url: string, type: string, explicit: boolean, enabled: boolean }>}
 */
export function parseWingetSourceListOutput(stdout) {
  const lines = cleanCliLines(stdout).filter((l) => l.trim().length > 0);
  const sepIdx = lines.findIndex((l) => /^-{5,}/.test(l.trim()));
  if (sepIdx === -1) return [];

  const headerLine = sepIdx > 0 ? lines[sepIdx - 1] : '';
  const offsets = getWordOffsets(headerLine);
  const headerCells = offsets.length >= 2 ? sliceByOffsets(headerLine, offsets).map((h) => h.toLowerCase()) : [];
  const explicitIdx = headerCells.findIndex((h) => h.includes('explicit') || h.includes('explizit'));

  const results = [];
  const seen = new Set();

  for (let i = sepIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    let name = '';
    let url = '';
    let explicitRaw = '';

    if (offsets.length >= 2) {
      const cells = sliceByOffsets(line, offsets);
      name = (cells[0] || '').trim();
      url = (cells[1] || '').trim();
      if (explicitIdx !== -1) {
        explicitRaw = (cells[explicitIdx] || '').trim();
      }
    }

    if (!isValidSourceName(name) || !url) {
      const cols = trimmed.split(/\s{2,}/);
      if (cols.length >= 2) {
        name = (cols[0] || '').trim();
        url = (cols[1] || '').trim();
        explicitRaw = (cols[2] || '').trim();
      } else {
        const m = trimmed.match(/^(\S+)\s+(https?:\/\/\S+)(?:\s+(true|false))?/i);
        if (m) {
          name = m[1].trim();
          url = m[2].trim();
          explicitRaw = (m[3] || '').trim();
        }
      }
    }

    if (!isValidSourceName(name) || !url) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      name,
      url,
      type: '',
      explicit: /^true$/i.test(explicitRaw),
      enabled: true,
    });
  }

  return results;
}

/**
 * Parst die Ausgabe von `scoop bucket list` (Tabellenformat oder Legacy-Liste).
 * @param {string} stdout
 * @returns {Array<{ name: string, url: string, updated: string, manifests: number | null, enabled: boolean }>}
 */
export function parseScoopBucketListOutput(stdout) {
  const lines = cleanCliLines(stdout).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const sepIdx = lines.findIndex((l) => /^-{2,}(?:\s+-{2,})+$/.test(l.trim()));
  const results = [];
  const seen = new Set();

  if (sepIdx !== -1) {
    const dashLine = lines[sepIdx];
    const offsets = getDashOffsets(dashLine);
    const headerLine = sepIdx > 0 ? lines[sepIdx - 1] : '';
    const headerCells = offsets.length >= 2 ? sliceByOffsets(headerLine, offsets).map((h) => h.toLowerCase()) : [];

    const nameIdx = Math.max(0, headerCells.indexOf('name'));
    const sourceIdx = headerCells.findIndex((h) => h === 'source' || h === 'url');
    const updatedIdx = headerCells.indexOf('updated');
    const manifestsIdx = headerCells.findIndex((h) => h.includes('manifest'));

    for (let i = sepIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || /^(?:warn|info|no buckets)/i.test(trimmed)) continue;

      let cells = offsets.length >= 2 ? sliceByOffsets(line, offsets) : [];
      if (cells.length < 2 || !cells[0]) {
        cells = trimmed.split(/\s{2,}/);
      }

      let name = (cells[nameIdx] || '').trim();
      let url = (sourceIdx !== -1 ? cells[sourceIdx] : cells[1] || '').trim();
      let updated = (updatedIdx !== -1 ? cells[updatedIdx] : cells[2] || '').trim();
      let manifestsRaw = (manifestsIdx !== -1 ? cells[manifestsIdx] : cells[3] || '').trim();

      const overflowMatch = trimmed.match(
        /^([A-Za-z0-9._-]+)\s+(https?:\/\/\S+)(?:\s+(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}:\d{2})?|\d{2}\.\d{2}\.\d{4}(?:\s+\d{2}:\d{2}:\d{2})?))?(?:\s+(\d+))?$/
      );
      if (
        overflowMatch &&
        (!isValidSourceName(name) || !url || /\s/.test(url) || (manifestsRaw && !/^\d+$/.test(manifestsRaw)))
      ) {
        name = overflowMatch[1].trim();
        url = overflowMatch[2].trim();
        updated = (overflowMatch[3] || '').trim();
        manifestsRaw = (overflowMatch[4] || '').trim();
      }

      if (!isValidSourceName(name)) continue;
      const manifestsNum = /^\d+$/.test(manifestsRaw) ? Number.parseInt(manifestsRaw, 10) : null;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        name,
        url,
        updated,
        manifests: manifestsNum,
        enabled: true,
      });
    }

    return results;
  }

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^(?:warn|info|no buckets|scoop\b)/i.test(trimmed)) continue;
    if (!isValidSourceName(trimmed)) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      name: trimmed,
      url: '',
      updated: '',
      manifests: null,
      enabled: true,
    });
  }

  return results;
}

/**
 * Parst die Pipe-Ausgabe von `choco source list -r`.
 * Format: `name|url|disabled|user|priority|bypassProxy|selfService|adminOnly`
 * @param {string} stdout
 * @returns {Array<{ name: string, url: string, enabled: boolean, priority: number, adminOnly: boolean }>}
 */
export function parseChocoSourceListOutput(stdout) {
  const lines = cleanCliLines(stdout);
  const results = [];
  const seen = new Set();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.includes('|')) continue;

    const parts = trimmed.split('|');
    if (parts.length < 2) continue;

    const name = parts[0].trim();
    const url = parts[1].trim();
    if (!isValidSourceName(name) || !url) continue;

    const disabledRaw = (parts[2] || '').trim().toLowerCase();
    const enabled = !(disabledRaw === 'true' || disabledRaw === '1' || disabledRaw === 'yes');
    const priorityRaw = (parts[4] || '').trim();
    const priority = /^-?\d+$/.test(priorityRaw) ? Number.parseInt(priorityRaw, 10) : 0;
    const adminRaw = (parts[7] || '').trim().toLowerCase();
    const adminOnly = adminRaw === 'true' || adminRaw === '1' || adminRaw === 'yes';

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      name,
      url,
      enabled,
      priority,
      adminOnly,
    });
  }

  return results;
}

/**
 * Parst die JSON-Ausgabe von `Get-PSResourceRepository | ConvertTo-Json` bzw. `Get-PSRepository | ConvertTo-Json`.
 * Behandelt sowohl Einzelobjekte (PowerShell 5.1) als auch Arrays.
 * @param {unknown} rawTextOrObj
 * @returns {Array<{ name: string, url: string, trusted: boolean, priority: number | null, enabled: boolean }>}
 */
export function parsePowerShellRepositoriesJson(rawTextOrObj) {
  const parsed = extractJsonPayload(rawTextOrObj);
  if (!parsed || typeof parsed !== 'object') return [];

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const results = [];
  const seen = new Set();

  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.Name ?? entry.name ?? '').trim();
    if (!name) continue;

    const rawUri = entry.Uri ?? entry.uri ?? entry.SourceLocation ?? entry.sourceLocation ?? '';
    const url =
      rawUri && typeof rawUri === 'object' && 'AbsoluteUri' in rawUri
        ? String(rawUri.AbsoluteUri || '').trim()
        : String(rawUri || '').trim();

    const trusted =
      typeof entry.Trusted === 'boolean'
        ? entry.Trusted
        : typeof entry.trusted === 'boolean'
          ? entry.trusted
          : /^trusted$/i.test(String(entry.InstallationPolicy ?? entry.installationPolicy ?? ''));

    const rawPriority = entry.Priority ?? entry.priority;
    const priority = typeof rawPriority === 'number' && Number.isFinite(rawPriority) ? rawPriority : null;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      name,
      url,
      trusted,
      priority,
      enabled: true,
    });
  }

  return results;
}

/**
 * Normalisiert benutzerdefinierte Registry-Quellen (`customSources`) aus `config.json`.
 * @param {unknown} raw
 * @returns {Array<{ name: string, url: string }>}
 */
export function normalizeCustomSourcesList(raw) {
  if (!Array.isArray(raw)) return [];
  const results = [];
  const seen = new Set();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    const url = normalizeSourceUrl(entry.url);
    if (!isValidSourceName(name) || !isValidSourceUrl(url)) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ name, url });
  }

  return results;
}
