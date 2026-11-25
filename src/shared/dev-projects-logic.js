import path from 'node:path';
import { isValidCargoCrateName } from './cargo-parser.js';
import { extractComposerJson, isValidComposerPackageName } from './composer-parser.js';
import { isValidDotnetToolId } from './dotnet-parser.js';
import { isValidNpmPackageName } from './npm-parser.js';
import { isValidPythonPackageName, normalizePythonPackageName } from './python-parser.js';
import { isValidVcpkgPortName } from './vcpkg-parser.js';
import { cleanCliLines } from './winget-parser.js';

export const SUPPORTED_DEV_MANAGERS = Object.freeze([
  'npm',
  'pnpm',
  'bun',
  'yarn',
  'composer',
  'uv',
  'pip',
  'cargo',
  'dotnet',
  'vcpkg',
]);

const SUPPORTED_MANAGER_SET = new Set(SUPPORTED_DEV_MANAGERS);
const CONTROL_CHAR_RE = /[\r\n\0]/;
const SAFE_VERSION_SPEC_RE = /^[A-Za-z0-9._^~><=+-]+$/;

function hasControlChars(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Normalisiert einen Projektordner-Pfad und entfernt abschliessende Slashes (ausser Root).
 * @param {unknown} rawPath
 * @returns {string}
 */
export function normalizeProjectPath(rawPath) {
  if (typeof rawPath !== 'string') return '';
  const cleaned = rawPath.replace(/[\r\n\0]/g, '').trim();
  if (!cleaned) return '';
  const normalized = path.normalize(cleaned);
  if (/^[A-Za-z]:[\\/]?$/.test(normalized)) {
    return `${normalized[0].toUpperCase()}:\\`;
  }
  if (normalized === '/' || normalized === '\\') {
    return normalized;
  }
  return normalized.replace(/[\\/]+$/, '');
}

/**
 * Vergleicht zwei Projektpfade plattformgerecht.
 * @param {unknown} pathA
 * @param {unknown} pathB
 * @param {string} [platform]
 * @returns {boolean}
 */
export function isSameProjectPath(pathA, pathB, platform = process.platform) {
  const normA = normalizeProjectPath(pathA);
  const normB = normalizeProjectPath(pathB);
  if (!normA || !normB) return false;
  if (platform === 'win32') {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return normA === normB;
}

/**
 * Validiert Eingaben zum Anlegen/Aktualisieren eines Entwicklungsprojekts.
 * @param {{ name?: unknown, path?: unknown, icon?: unknown, notes?: unknown }} [input]
 * @returns {{ valid: true, path: string, name: string, icon: string, notes: string } | { valid: false, error: string }}
 */
export function validateDevProjectInput(input = {}) {
  const rawPath = typeof input?.path === 'string' ? input.path : '';
  if (!rawPath?.trim()) {
    return { valid: false, error: 'Projektpfad darf nicht leer sein.' };
  }
  if (CONTROL_CHAR_RE.test(rawPath) || hasControlChars(rawPath)) {
    return { valid: false, error: 'Projektpfad enthaelt unzulaessige Steuerzeichen.' };
  }
  const normalizedPath = normalizeProjectPath(rawPath);
  if (!normalizedPath) {
    return { valid: false, error: 'Ungueltiger Projektpfad angegeben.' };
  }

  const rawName = typeof input?.name === 'string' ? input.name.replace(/[\r\n\0]/g, '').trim() : '';
  const fallbackName = path.basename(normalizedPath) || normalizedPath;
  const name = rawName || fallbackName;
  const icon = typeof input?.icon === 'string' ? input.icon.replace(/[\r\n\0]/g, '').trim() : '';
  const notes = typeof input?.notes === 'string' ? input.notes.replace(/\0/g, '').trim() : '';

  return {
    valid: true,
    path: normalizedPath,
    name,
    icon,
    notes,
  };
}

/**
 * Normalisiert einen gespeicherten Projekt-Datensatz auf das feste Schema.
 * @param {Record<string, any>} raw
 * @param {{ now?: number, fallbackId?: string }} [options]
 * @returns {{ id: string, name: string, path: string, icon: string, notes: string, createdAt: number, updatedAt: number, lastScannedAt: number | null }}
 */
export function normalizeDevProjectRecord(raw, { now = Date.now(), fallbackId = '' } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const id = String(src.id || fallbackId || '').trim();
  const projectPath = normalizeProjectPath(src.path);
  const fallbackName = projectPath ? path.basename(projectPath) || projectPath : 'Projekt';
  const name =
    typeof src.name === 'string' && src.name.trim() ? src.name.replace(/[\r\n\0]/g, '').trim() : fallbackName;
  const icon = typeof src.icon === 'string' ? src.icon.replace(/[\r\n\0]/g, '').trim() : '';
  const notes = typeof src.notes === 'string' ? src.notes.replace(/\0/g, '') : '';
  const createdAt = Number.isFinite(src.createdAt) ? Number(src.createdAt) : now;
  const updatedAt = Number.isFinite(src.updatedAt) ? Number(src.updatedAt) : createdAt;
  const lastScannedAt = Number.isFinite(src.lastScannedAt) ? Number(src.lastScannedAt) : null;

  return {
    id,
    name,
    path: projectPath,
    icon,
    notes,
    createdAt,
    updatedAt,
    lastScannedAt,
  };
}

/**
 * Erkennt anhand der Dateinamen im Projektordner alle aktiven Paketmanager & Oekosysteme.
 * @param {string[]} [fileNames]
 * @param {{ hasUvToolConfig?: boolean }} [options]
 * @returns {{
 *   managers: string[],
 *   ecosystems: Array<{ manager: string, ecosystem: string, manifestFile: string, manifestFiles: string[], lockfile: string | null }>
 * }}
 */
export function detectProjectManagersFromFiles(fileNames = [], { hasUvToolConfig = false } = {}) {
  const byLower = new Map();
  for (const rawName of Array.isArray(fileNames) ? fileNames : []) {
    const clean = String(rawName || '').trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (!byLower.has(lower)) {
      byLower.set(lower, clean);
    }
  }

  /** @type {Array<{ manager: string, ecosystem: string, manifestFile: string, manifestFiles: string[], lockfile: string | null }>} */
  const ecosystems = [];

  // 1. JavaScript / Node
  if (byLower.has('package.json')) {
    const manifestFile = byLower.get('package.json');
    let manager = 'npm';
    let lockfile = byLower.get('package-lock.json') || null;
    if (byLower.has('pnpm-lock.yaml')) {
      manager = 'pnpm';
      lockfile = byLower.get('pnpm-lock.yaml');
    } else if (byLower.has('bun.lock')) {
      manager = 'bun';
      lockfile = byLower.get('bun.lock');
    } else if (byLower.has('bun.lockb')) {
      manager = 'bun';
      lockfile = byLower.get('bun.lockb');
    } else if (byLower.has('yarn.lock')) {
      manager = 'yarn';
      lockfile = byLower.get('yarn.lock');
    }
    ecosystems.push({
      manager,
      ecosystem: 'node',
      manifestFile,
      manifestFiles: [manifestFile],
      lockfile,
    });
  }

  // 2. PHP / Composer
  if (byLower.has('composer.json')) {
    const manifestFile = byLower.get('composer.json');
    ecosystems.push({
      manager: 'composer',
      ecosystem: 'php',
      manifestFile,
      manifestFiles: [manifestFile],
      lockfile: byLower.get('composer.lock') || null,
    });
  }

  // 3. Python (uv / pip)
  const pyManifests = [];
  if (byLower.has('pyproject.toml')) pyManifests.push(byLower.get('pyproject.toml'));
  if (byLower.has('requirements.txt')) pyManifests.push(byLower.get('requirements.txt'));
  if (pyManifests.length > 0 || byLower.has('uv.lock')) {
    const uvLock = byLower.get('uv.lock') || null;
    const manager = uvLock || hasUvToolConfig ? 'uv' : 'pip';
    ecosystems.push({
      manager,
      ecosystem: 'python',
      manifestFile: pyManifests[0] || uvLock || 'pyproject.toml',
      manifestFiles: pyManifests.length > 0 ? pyManifests : [uvLock],
      lockfile: uvLock,
    });
  }

  // 4. Rust / Cargo
  if (byLower.has('cargo.toml')) {
    const manifestFile = byLower.get('cargo.toml');
    ecosystems.push({
      manager: 'cargo',
      ecosystem: 'rust',
      manifestFile,
      manifestFiles: [manifestFile],
      lockfile: byLower.get('cargo.lock') || null,
    });
  }

  // 5. .NET / NuGet
  const csprojFiles = [...byLower.entries()]
    .filter(([lower]) => lower.endsWith('.csproj'))
    .map(([, original]) => original)
    .sort((a, b) => a.localeCompare(b));
  if (csprojFiles.length > 0) {
    ecosystems.push({
      manager: 'dotnet',
      ecosystem: 'dotnet',
      manifestFile: csprojFiles[0],
      manifestFiles: csprojFiles,
      lockfile: byLower.get('packages.lock.json') || null,
    });
  }

  // 6. C/C++ / vcpkg
  if (byLower.has('vcpkg.json')) {
    const manifestFile = byLower.get('vcpkg.json');
    ecosystems.push({
      manager: 'vcpkg',
      ecosystem: 'cpp',
      manifestFile,
      manifestFiles: [manifestFile],
      lockfile: byLower.get('vcpkg-configuration.json') || null,
    });
  }

  const managers = [...new Set(ecosystems.map((e) => e.manager))];
  return { managers, ecosystems };
}

function stripBom(rawText) {
  return typeof rawText === 'string' ? rawText.replace(/^\uFEFF/, '') : '';
}

function safeJsonParse(rawText) {
  const clean = stripBom(rawText).trim();
  if (!clean) return null;
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function extractJsonPayload(rawText) {
  const cleaned = cleanCliLines(stripBom(rawText)).join('\n').trim();
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

function cleanVersion(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .trim()
    .replace(/^v(?=\d)/i, '')
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

function normalizeLicense(rawLicense) {
  if (!rawLicense) return '';
  if (typeof rawLicense === 'string') return rawLicense.trim();
  if (Array.isArray(rawLicense)) {
    return rawLicense
      .map((item) => (typeof item === 'string' ? item.trim() : String(item?.type || '').trim()))
      .filter(Boolean)
      .join(', ');
  }
  if (typeof rawLicense === 'object' && 'type' in rawLicense) {
    return String(rawLicense.type || '').trim();
  }
  return '';
}

function buildDirectScopeMap(directList = [], normalizeFn = (name) => String(name || '').toLowerCase()) {
  const map = new Map();
  for (const item of Array.isArray(directList) ? directList : []) {
    const name = String(item?.name || '').trim();
    if (!name) continue;
    const key = normalizeFn(name);
    if (!map.has(key)) {
      map.set(key, item.scope === 'dev' || item.scope === 'optional' ? item.scope : 'prod');
    }
  }
  return map;
}

function extractNodeModulesPkgName(pkgPath) {
  if (typeof pkgPath !== 'string' || !pkgPath) return '';
  const idx = pkgPath.lastIndexOf('node_modules/');
  if (idx === -1) return '';
  return pkgPath.slice(idx + 'node_modules/'.length).trim();
}

/**
 * Parst direkte Abhaengigkeiten aus `package.json`.
 * @param {string} rawText
 * @param {string} [manager]
 * @returns {Array<{ manager: string, name: string, declaredRange: string, installedVersion: string, scope: 'prod' | 'dev' | 'optional', description: string }>}
 */
export function parsePackageJsonDirect(rawText, manager = 'npm') {
  const parsed = safeJsonParse(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  /** @type {Array<{ field: string, scope: 'prod' | 'dev' | 'optional' }>} */
  const groups = [
    { field: 'dependencies', scope: 'prod' },
    { field: 'devDependencies', scope: 'dev' },
    { field: 'optionalDependencies', scope: 'optional' },
  ];

  const results = [];
  const seen = new Set();

  for (const { field, scope } of groups) {
    const map = parsed[field];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [name, range] of Object.entries(map)) {
      const cleanName = String(name || '').trim();
      if (!cleanName) continue;
      const key = cleanName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        manager,
        name: cleanName,
        declaredRange: String(range ?? '').trim(),
        installedVersion: '',
        scope,
        description: '',
      });
    }
  }

  return results;
}

/**
 * Parst `package-lock.json` (v2/v3 sowie v1-Fallback) in vollstaendige Abhaengigkeiten inkl. `requiredBy`.
 * @param {string} rawText
 * @param {Array<{ name: string, scope?: string }>} [directList]
 * @param {string} [manager]
 */
export function parsePackageLockJson(rawText, directList = [], manager = 'npm') {
  const parsed = safeJsonParse(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { dependencies: [], versionByName: {}, metaByName: {} };
  }

  const directScopeMap = buildDirectScopeMap(directList);
  /** @type {Map<string, Set<string>>} */
  const requiredByMap = new Map();
  /** @type {Map<string, any>} */
  const packageByKey = new Map();
  /** @type {Record<string, string>} */
  const versionByName = {};
  /** @type {Record<string, { version: string, description: string, license: string, homepage: string }>} */
  const metaByName = {};

  const addRequiredBy = (depName, parentName) => {
    const cleanDep = String(depName || '').trim();
    if (!cleanDep) return;
    const key = cleanDep.toLowerCase();
    if (!requiredByMap.has(key)) requiredByMap.set(key, new Set());
    if (parentName) {
      requiredByMap.get(key).add(parentName);
    }
  };

  if (parsed.packages && typeof parsed.packages === 'object') {
    const rootPkg = parsed.packages[''] && typeof parsed.packages[''] === 'object' ? parsed.packages[''] : {};
    for (const [field, scope] of [
      ['dependencies', 'prod'],
      ['devDependencies', 'dev'],
      ['optionalDependencies', 'optional'],
    ]) {
      const rootDeps = rootPkg[field];
      if (rootDeps && typeof rootDeps === 'object') {
        for (const depName of Object.keys(rootDeps)) {
          const key = String(depName).trim().toLowerCase();
          if (key && !directScopeMap.has(key)) {
            directScopeMap.set(key, scope);
          }
        }
      }
    }

    for (const [pkgPath, info] of Object.entries(parsed.packages)) {
      if (!info || typeof info !== 'object' || pkgPath === '') continue;
      const pkgName = String(info.name || extractNodeModulesPkgName(pkgPath)).trim();
      if (!pkgName) continue;

      for (const depField of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const depMap = info[depField];
        if (depMap && typeof depMap === 'object') {
          for (const childName of Object.keys(depMap)) {
            addRequiredBy(childName, pkgName);
          }
        }
      }

      const key = pkgName.toLowerCase();
      const version = cleanVersion(info.version);
      const isNested = pkgPath.indexOf('node_modules/', pkgPath.indexOf('node_modules/') + 1) !== -1;
      const existing = packageByKey.get(key);
      // Top-level node_modules/<pkg> gewinnt gegen verschachtelte Duplikate
      if (!existing || (!isNested && existing.isNested)) {
        const scope = directScopeMap.has(key)
          ? directScopeMap.get(key)
          : info.devOptional || info.optional
            ? 'optional'
            : info.dev
              ? 'dev'
              : 'prod';
        const license = normalizeLicense(info.license || info.licenses);
        const homepage = normalizeHttpUrl(info.homepage) || `https://www.npmjs.com/package/${pkgName}`;
        packageByKey.set(key, {
          name: pkgName,
          version,
          direct: directScopeMap.has(key),
          scope,
          license,
          homepage,
          description: String(info.description || '').trim(),
          isNested,
        });
      }
    }
  } else if (parsed.dependencies && typeof parsed.dependencies === 'object') {
    const visitV1 = (depsObj, parentName = '') => {
      for (const [pkgName, info] of Object.entries(depsObj)) {
        if (!info || typeof info !== 'object') continue;
        const cleanName = String(pkgName || '').trim();
        if (!cleanName) continue;
        if (parentName) {
          addRequiredBy(cleanName, parentName);
        } else if (!directScopeMap.has(cleanName.toLowerCase())) {
          directScopeMap.set(cleanName.toLowerCase(), info.dev ? 'dev' : info.optional ? 'optional' : 'prod');
        }

        const key = cleanName.toLowerCase();
        if (!packageByKey.has(key) || !parentName) {
          packageByKey.set(key, {
            name: cleanName,
            version: cleanVersion(info.version),
            direct: directScopeMap.has(key),
            scope: directScopeMap.get(key) || (info.dev ? 'dev' : info.optional ? 'optional' : 'prod'),
            license: '',
            homepage: `https://www.npmjs.com/package/${cleanName}`,
            description: '',
            isNested: Boolean(parentName),
          });
        }
        if (info.requires && typeof info.requires === 'object') {
          for (const reqName of Object.keys(info.requires)) {
            addRequiredBy(reqName, cleanName);
          }
        }
        if (info.dependencies && typeof info.dependencies === 'object') {
          visitV1(info.dependencies, cleanName);
        }
      }
    };
    visitV1(parsed.dependencies, '');
  }

  const dependencies = [];
  for (const [key, entry] of packageByKey.entries()) {
    const requiredBy = [...(requiredByMap.get(key) || [])].sort((a, b) => a.localeCompare(b));
    dependencies.push({
      manager,
      name: entry.name,
      version: entry.version,
      direct: Boolean(entry.direct),
      scope: entry.scope,
      requiredBy,
      license: entry.license,
      homepage: entry.homepage,
    });
    if (entry.version) {
      versionByName[key] = entry.version;
    }
    metaByName[key] = {
      version: entry.version,
      description: entry.description || '',
      license: entry.license,
      homepage: entry.homepage,
    };
  }

  dependencies.sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
  return { dependencies, versionByName, metaByName };
}

function unquoteYamlScalar(raw) {
  const trimmed = String(raw || '').trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitPnpmPkgVersionKey(rawKey) {
  const clean = unquoteYamlScalar(rawKey).replace(/^\//, '');
  // v6: /@scope/pkg@1.2.3 oder pkg@1.2.3(peer) ; v9: '@scope/pkg@1.2.3'
  const withoutPeers = clean.split('(')[0];
  const atIdx = withoutPeers.lastIndexOf('@');
  if (atIdx > 0) {
    const name = withoutPeers.slice(0, atIdx).trim();
    const version = cleanVersion(withoutPeers.slice(atIdx + 1).trim());
    if (name && version) return { name, version };
  }
  // Aelteres v5 Format: /name/1.2.3
  const lastSlash = withoutPeers.lastIndexOf('/');
  if (lastSlash > 0) {
    const name = withoutPeers.slice(0, lastSlash).trim();
    const version = cleanVersion(withoutPeers.slice(lastSlash + 1).trim());
    if (name && /^\d/.test(version)) return { name, version };
  }
  return null;
}

/**
 * Parst `pnpm-lock.yaml` (v6 & v9) ohne externe YAML-Abhaengigkeit.
 * @param {string} rawText
 * @param {Array<{ name: string, scope?: string }>} [directList]
 */
export function parsePnpmLockYaml(rawText, directList = []) {
  const text = stripBom(rawText);
  if (!text.trim()) return { dependencies: [], versionByName: {}, metaByName: {} };

  const directScopeMap = buildDirectScopeMap(directList);
  /** @type {Map<string, Set<string>>} */
  const requiredByMap = new Map();
  /** @type {Map<string, { name: string, version: string, scope: string }>} */
  const pkgMap = new Map();

  const lines = text.split(/\r?\n/);
  let topSection = '';
  let importerScope = '';
  let importerPkg = '';
  let currentPkgName = '';
  let inPkgDeps = false;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.search(/\S/);
    const trimmed = rawLine.trim();

    if (indent === 0) {
      topSection = trimmed.replace(/:$/, '');
      importerScope = '';
      importerPkg = '';
      currentPkgName = '';
      inPkgDeps = false;
      continue;
    }

    if (topSection === 'importers') {
      if (indent === 2 && trimmed.endsWith(':')) {
        importerScope = '';
        importerPkg = '';
        continue;
      }
      if (indent === 4 && trimmed.endsWith(':')) {
        const sec = trimmed.slice(0, -1);
        importerScope = sec === 'devDependencies' ? 'dev' : sec === 'optionalDependencies' ? 'optional' : 'prod';
        importerPkg = '';
        continue;
      }
      if (indent === 6 && importerScope && trimmed.endsWith(':')) {
        importerPkg = unquoteYamlScalar(trimmed.slice(0, -1));
        const key = importerPkg.toLowerCase();
        if (key && !directScopeMap.has(key)) {
          directScopeMap.set(key, importerScope);
        }
        continue;
      }
      if (indent === 8 && importerPkg && trimmed.startsWith('version:')) {
        const rawVer = unquoteYamlScalar(trimmed.slice('version:'.length)).split('(')[0];
        const ver = cleanVersion(rawVer);
        const key = importerPkg.toLowerCase();
        if (ver && !pkgMap.has(key)) {
          pkgMap.set(key, {
            name: importerPkg,
            version: ver,
            scope: directScopeMap.get(key) || importerScope || 'prod',
          });
        }
      }
      continue;
    }

    if (topSection === 'packages' || topSection === 'snapshots') {
      if (indent === 2) {
        const headerMatch = trimmed.match(/^(.+?):(?:\s*\{\s*\})?$/);
        if (headerMatch) {
          const parsedKey = splitPnpmPkgVersionKey(headerMatch[1]);
          inPkgDeps = false;
          if (parsedKey) {
            currentPkgName = parsedKey.name;
            const key = parsedKey.name.toLowerCase();
            if (!pkgMap.has(key)) {
              pkgMap.set(key, {
                name: parsedKey.name,
                version: parsedKey.version,
                scope: directScopeMap.get(key) || 'prod',
              });
            }
          } else {
            currentPkgName = '';
          }
          continue;
        }
      }
      if (currentPkgName && indent === 4) {
        if (trimmed === 'dependencies:' || trimmed === 'optionalDependencies:') {
          inPkgDeps = true;
          continue;
        }
        inPkgDeps = false;
        if (trimmed === 'dev: true') {
          const key = currentPkgName.toLowerCase();
          const entry = pkgMap.get(key);
          if (entry && !directScopeMap.has(key)) {
            entry.scope = 'dev';
          }
        } else if (trimmed === 'optional: true') {
          const key = currentPkgName.toLowerCase();
          const entry = pkgMap.get(key);
          if (entry && !directScopeMap.has(key)) {
            entry.scope = 'optional';
          }
        }
        continue;
      }
      if (currentPkgName && inPkgDeps && indent === 6) {
        const colonIdx = trimmed.indexOf(':');
        if (colonIdx > 0) {
          const depName = unquoteYamlScalar(trimmed.slice(0, colonIdx)).trim();
          if (depName) {
            const depKey = depName.toLowerCase();
            if (!requiredByMap.has(depKey)) requiredByMap.set(depKey, new Set());
            requiredByMap.get(depKey).add(currentPkgName);
          }
        }
      }
    }
  }

  return finalizeNodeLockMap(pkgMap, directScopeMap, requiredByMap, 'pnpm');
}

function finalizeNodeLockMap(pkgMap, directScopeMap, requiredByMap, manager) {
  const dependencies = [];
  /** @type {Record<string, string>} */
  const versionByName = {};
  /** @type {Record<string, { version: string, description: string, license: string, homepage: string }>} */
  const metaByName = {};

  for (const [key, entry] of pkgMap.entries()) {
    const requiredBy = [...(requiredByMap.get(key) || [])].sort((a, b) => a.localeCompare(b));
    const homepage = `https://www.npmjs.com/package/${entry.name}`;
    dependencies.push({
      manager,
      name: entry.name,
      version: entry.version,
      direct: directScopeMap.has(key),
      scope: directScopeMap.get(key) || entry.scope || 'prod',
      requiredBy,
      license: '',
      homepage,
    });
    if (entry.version) {
      versionByName[key] = entry.version;
    }
    metaByName[key] = {
      version: entry.version,
      description: '',
      license: '',
      homepage,
    };
  }

  dependencies.sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
  return { dependencies, versionByName, metaByName };
}

function extractPkgNameFromYarnHeader(headerText) {
  const firstSpec = headerText
    .split(',')[0]
    .trim()
    .replace(/^["']|["']$/g, '');
  // Bei Berry/v2+: "pkg@npm:^1.0.0" oder "@scope/pkg@npm:^1.0.0"
  const atIdx = firstSpec.startsWith('@') ? firstSpec.indexOf('@', 1) : firstSpec.indexOf('@');
  if (atIdx <= 0) return '';
  return firstSpec.slice(0, atIdx).trim();
}

/**
 * Parst `yarn.lock` (v1 & Berry v2+).
 * @param {string} rawText
 * @param {Array<{ name: string, scope?: string }>} [directList]
 */
export function parseYarnLock(rawText, directList = []) {
  const text = stripBom(rawText);
  if (!text.trim()) return { dependencies: [], versionByName: {}, metaByName: {} };

  const directScopeMap = buildDirectScopeMap(directList);
  /** @type {Map<string, Set<string>>} */
  const requiredByMap = new Map();
  /** @type {Map<string, { name: string, version: string, scope: string }>} */
  const pkgMap = new Map();

  const lines = text.split(/\r?\n/);
  let currentName = '';
  let inDeps = false;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.search(/\S/);
    const trimmed = rawLine.trim();

    if (indent === 0 && trimmed.endsWith(':')) {
      if (trimmed === '__metadata:') {
        currentName = '';
        inDeps = false;
        continue;
      }
      currentName = extractPkgNameFromYarnHeader(trimmed.slice(0, -1));
      inDeps = false;
      continue;
    }

    if (!currentName) continue;

    if (indent === 2) {
      if (trimmed === 'dependencies:' || trimmed === 'optionalDependencies:') {
        inDeps = true;
        continue;
      }
      inDeps = false;
      const verMatch = trimmed.match(/^version(?::|\s+)\s*["']?([^"'\s]+)["']?/);
      if (verMatch) {
        const ver = cleanVersion(verMatch[1]);
        const key = currentName.toLowerCase();
        if (ver && !pkgMap.has(key)) {
          pkgMap.set(key, {
            name: currentName,
            version: ver,
            scope: directScopeMap.get(key) || 'prod',
          });
        }
      }
      continue;
    }

    if (inDeps && indent >= 4) {
      const depMatch = trimmed.match(/^["']?(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)["']?(?::|\s+)/);
      if (depMatch) {
        const depName = depMatch[1];
        const depKey = depName.toLowerCase();
        if (!requiredByMap.has(depKey)) requiredByMap.set(depKey, new Set());
        requiredByMap.get(depKey).add(currentName);
      }
    }
  }

  return finalizeNodeLockMap(pkgMap, directScopeMap, requiredByMap, 'yarn');
}

function stripJsoncCommentsAndTrailingCommas(rawText) {
  let out = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    const next = rawText[i + 1];

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  // Trailing commas ausserhalb Strings entfernen (iterativ fuer verschachtelte Strukturen)
  let cleaned = out;
  let prev;
  do {
    prev = cleaned;
    cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  } while (cleaned !== prev);
  return cleaned;
}

/**
 * Parst textbasiertes `bun.lock` (JSONC).
 * @param {string} rawText
 * @param {Array<{ name: string, scope?: string }>} [directList]
 */
export function parseBunLock(rawText, directList = []) {
  const cleanText = stripBom(rawText).trim();
  if (!cleanText) return { dependencies: [], versionByName: {}, metaByName: {} };

  let parsed = null;
  try {
    parsed = JSON.parse(stripJsoncCommentsAndTrailingCommas(cleanText));
  } catch {
    return { dependencies: [], versionByName: {}, metaByName: {} };
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.packages || typeof parsed.packages !== 'object') {
    return { dependencies: [], versionByName: {}, metaByName: {} };
  }

  const directScopeMap = buildDirectScopeMap(directList);
  /** @type {Map<string, Set<string>>} */
  const requiredByMap = new Map();
  /** @type {Map<string, { name: string, version: string, scope: string }>} */
  const pkgMap = new Map();

  for (const [pkgPath, tuple] of Object.entries(parsed.packages)) {
    if (!Array.isArray(tuple) || tuple.length === 0) continue;
    const spec = String(tuple[0] || '').trim();
    const atIdx = spec.lastIndexOf('@');
    const pkgName = atIdx > 0 ? spec.slice(0, atIdx).trim() : String(pkgPath).split('/').pop() || '';
    const version = atIdx > 0 ? cleanVersion(spec.slice(atIdx + 1)) : '';
    if (!pkgName) continue;

    const meta = tuple[2] && typeof tuple[2] === 'object' ? tuple[2] : {};
    for (const depField of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const depsObj = meta[depField];
      if (depsObj && typeof depsObj === 'object') {
        for (const depName of Object.keys(depsObj)) {
          const depKey = String(depName).toLowerCase();
          if (!requiredByMap.has(depKey)) requiredByMap.set(depKey, new Set());
          requiredByMap.get(depKey).add(pkgName);
        }
      }
    }

    const key = pkgName.toLowerCase();
    if (!pkgMap.has(key)) {
      pkgMap.set(key, {
        name: pkgName,
        version,
        scope: directScopeMap.get(key) || 'prod',
      });
    }
  }

  return finalizeNodeLockMap(pkgMap, directScopeMap, requiredByMap, 'bun');
}

/**
 * Parst direkte Composer-Pakete aus `composer.json` (filtert PHP-Plattform-Constraints wie `php`, `ext-*`).
 * @param {string} rawText
 * @returns {Array<{ manager: string, name: string, declaredRange: string, installedVersion: string, scope: 'prod' | 'dev' | 'optional', description: string }>}
 */
export function parseComposerJsonDirect(rawText) {
  const parsed = safeJsonParse(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  /** @type {Array<{ field: string, scope: 'prod' | 'dev' }>} */
  const groups = [
    { field: 'require', scope: 'prod' },
    { field: 'require-dev', scope: 'dev' },
  ];

  const results = [];
  const seen = new Set();

  for (const { field, scope } of groups) {
    const map = parsed[field];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [name, constraint] of Object.entries(map)) {
      const cleanName = String(name || '').trim();
      // Plattform-Pakete (php, ext-json, lib-openssl, composer-plugin-api) enthalten keinen Slash
      if (!cleanName?.includes('/')) continue;
      const key = cleanName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        manager: 'composer',
        name: cleanName,
        declaredRange: String(constraint ?? '').trim(),
        installedVersion: '',
        scope,
        description: '',
      });
    }
  }

  return results;
}

/**
 * Parst `composer.lock` in direkte + transitive Abhaengigkeiten inkl. `requiredBy`.
 * @param {string} rawText
 * @param {Array<{ name: string, scope?: string }>} [directList]
 */
export function parseComposerLock(rawText, directList = []) {
  const parsed = safeJsonParse(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { dependencies: [], versionByName: {}, metaByName: {} };
  }

  const directScopeMap = buildDirectScopeMap(directList);
  /** @type {Map<string, Set<string>>} */
  const requiredByMap = new Map();
  /** @type {Array<{ pkg: Record<string, any>, defaultScope: 'prod' | 'dev' }>} */
  const rawEntries = [];

  for (const pkg of Array.isArray(parsed.packages) ? parsed.packages : []) {
    rawEntries.push({ pkg, defaultScope: 'prod' });
  }
  for (const pkg of Array.isArray(parsed['packages-dev']) ? parsed['packages-dev'] : []) {
    rawEntries.push({ pkg, defaultScope: 'dev' });
  }

  const dependencies = [];
  const seen = new Set();
  /** @type {Record<string, string>} */
  const versionByName = {};
  /** @type {Record<string, { version: string, description: string, license: string, homepage: string }>} */
  const metaByName = {};

  // 1. Reverse-Graph fuer requiredBy aufbauen
  for (const { pkg } of rawEntries) {
    if (!pkg || typeof pkg !== 'object') continue;
    const parentName = String(pkg.name || '').trim();
    if (!parentName) continue;
    const reqMap = pkg.require && typeof pkg.require === 'object' ? pkg.require : {};
    for (const depName of Object.keys(reqMap)) {
      const cleanDep = String(depName || '').trim();
      if (!cleanDep?.includes('/')) continue;
      const depKey = cleanDep.toLowerCase();
      if (!requiredByMap.has(depKey)) requiredByMap.set(depKey, new Set());
      requiredByMap.get(depKey).add(parentName);
    }
  }

  // 2. Paketobjekte normieren
  for (const { pkg, defaultScope } of rawEntries) {
    if (!pkg || typeof pkg !== 'object') continue;
    const name = String(pkg.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const version = cleanVersion(pkg.version);
    const direct = directScopeMap.has(key);
    const scope = directScopeMap.get(key) || defaultScope;
    const license = normalizeLicense(pkg.license);
    const homepage =
      normalizeHttpUrl(pkg.homepage) || normalizeHttpUrl(pkg.source?.url) || `https://packagist.org/packages/${name}`;
    const description = String(pkg.description || '').trim();

    if (version) {
      versionByName[key] = version;
    }
    metaByName[key] = { version, description, license, homepage };
    dependencies.push({
      manager: 'composer',
      name,
      version,
      direct,
      scope,
      requiredBy: [...(requiredByMap.get(key) || [])].sort((a, b) => a.localeCompare(b)),
      license,
      homepage,
    });
  }

  dependencies.sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
  return { dependencies, versionByName, metaByName };
}

function splitPep508Requirement(rawLine) {
  const clean = String(rawLine || '')
    .replace(/#.*$/, '')
    .trim();
  if (!clean || clean.startsWith('-')) return null;

  // Marker `; python_version < ...` abschneiden
  const base = clean.split(';')[0].trim();
  if (!base) return null;

  // Format: pkg[extra] @ https://... oder pkg[extra] >=1.0,<2.0
  const atMatch = base.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*@\s*(.+)$/);
  if (atMatch) {
    return { name: atMatch[1].trim(), declaredRange: atMatch[2].trim() };
  }

  const verMatch = base.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*(.*)$/);
  if (!verMatch) return null;
  const name = verMatch[1].trim();
  if (!isValidPythonPackageName(name)) return null;
  return { name, declaredRange: verMatch[2].trim() };
}

function stripTomlComment(line) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function extractTomlQuotedStrings(text) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let match = re.exec(text);
  while (match !== null) {
    out.push(match[1] !== undefined ? match[1] : match[2]);
    match = re.exec(text);
  }
  return out;
}

/**
 * Parst direkte Python-Abhaengigkeiten aus `pyproject.toml` (PEP 621, PEP 735, Poetry, uv).
 * @param {string} rawText
 * @param {string} [manager]
 * @returns {{ packages: Array<{ manager: string, name: string, declaredRange: string, installedVersion: string, scope: 'prod' | 'dev' | 'optional', description: string }>, hasUvToolConfig: boolean }}
 */
export function parsePyprojectTomlDirect(rawText, manager = 'pip') {
  const text = stripBom(rawText);
  if (!text.trim()) return { packages: [], hasUvToolConfig: false };

  const lines = text.split(/\r?\n/);
  let currentSection = '';
  let hasUvToolConfig = false;
  let collectingArray = false;
  let arrayBuffer = '';
  /** @type {'prod' | 'dev' | 'optional'} */
  let arrayScope = 'prod';

  const results = [];
  const seen = new Set();

  const pushReq = (name, declaredRange, scope) => {
    const cleanName = String(name || '').trim();
    if (!cleanName || cleanName.toLowerCase() === 'python') return;
    if (!isValidPythonPackageName(cleanName)) return;
    const key = normalizePythonPackageName(cleanName);
    if (seen.has(key)) return;
    seen.add(key);
    results.push({
      manager,
      name: cleanName,
      declaredRange: String(declaredRange || '').trim(),
      installedVersion: '',
      scope,
      description: '',
    });
  };

  const flushArray = () => {
    for (const item of extractTomlQuotedStrings(arrayBuffer)) {
      const parsed = splitPep508Requirement(item);
      if (parsed) pushReq(parsed.name, parsed.declaredRange, arrayScope);
    }
    collectingArray = false;
    arrayBuffer = '';
  };

  for (const rawLine of lines) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (collectingArray) {
      arrayBuffer += ` ${line}`;
      if (line.includes(']')) {
        flushArray();
      }
      continue;
    }

    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch && !line.startsWith('[[')) {
      currentSection = secMatch[1].trim();
      if (currentSection === 'tool.uv' || currentSection.startsWith('tool.uv.')) {
        hasUvToolConfig = true;
      }
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line
      .slice(0, eqIdx)
      .trim()
      .replace(/^["']|["']$/g, '');
    const val = line.slice(eqIdx + 1).trim();

    const isPep621Deps = currentSection === 'project' && key === 'dependencies';
    const isPep621Opt = currentSection === 'project.optional-dependencies';
    const isDepGroups = currentSection === 'dependency-groups';
    const isUvDevDeps = currentSection === 'tool.uv' && key === 'dev-dependencies';

    if (isPep621Deps || isPep621Opt || isDepGroups || isUvDevDeps) {
      const scope =
        isUvDevDeps || (isDepGroups && /dev|test|lint/i.test(key))
          ? 'dev'
          : isPep621Opt
            ? /dev|test|lint/i.test(key)
              ? 'dev'
              : 'optional'
            : isDepGroups
              ? 'dev'
              : 'prod';
      if (val.startsWith('[')) {
        arrayScope = scope;
        arrayBuffer = val;
        if (val.includes(']')) {
          flushArray();
        } else {
          collectingArray = true;
        }
      }
      continue;
    }

    if (
      currentSection === 'tool.poetry.dependencies' ||
      currentSection === 'tool.poetry.dev-dependencies' ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(currentSection)
    ) {
      const scope = currentSection === 'tool.poetry.dependencies' ? 'prod' : 'dev';
      let declared = '';
      if (val.startsWith('{')) {
        const verMatch = val.match(/version\s*=\s*["']([^"']+)["']/);
        declared = verMatch ? verMatch[1] : '';
      } else {
        declared = unquoteYamlScalar(val);
      }
      pushReq(key, declared, scope);
    }
  }

  return { packages: results, hasUvToolConfig };
}

/**
 * Parst `requirements.txt`.
 * @param {string} rawText
 * @param {string} [manager]
 */
export function parseRequirementsTxt(rawText, manager = 'pip') {
  const text = stripBom(rawText);
  if (!text.trim()) return [];
  const results = [];
  const seen = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    const parsed = splitPep508Requirement(rawLine);
    if (!parsed) continue;
    const key = normalizePythonPackageName(parsed.name);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      manager,
      name: parsed.name,
      declaredRange: parsed.declaredRange,
      installedVersion: '',
      scope: 'prod',
      description: '',
    });
  }
  return results;
}

/**
 * Parst `uv.lock` (`[[package]]` TOML Bloecke).
 * @param {string} rawText
 * @param {Array<{ name: string, scope?: string }>} [directList]
 */
export function parseUvLock(rawText, directList = []) {
  const text = stripBom(rawText);
  if (!text.trim()) return { dependencies: [], versionByName: {}, metaByName: {} };

  const directScopeMap = buildDirectScopeMap(directList, normalizePythonPackageName);
  /** @type {Array<{ name: string, version: string, source: string, deps: string[] }>} */
  const packages = [];
  let current = null;
  let inDepsArray = false;
  let depsBuf = '';

  const flushDeps = () => {
    if (!current) return;
    const nameMatches = [...depsBuf.matchAll(/name\s*=\s*["']([^"']+)["']/g)].map((m) => m[1].trim());
    if (nameMatches.length > 0) {
      current.deps.push(...nameMatches);
    } else {
      for (const s of extractTomlQuotedStrings(depsBuf)) {
        const dep = s.trim();
        if (dep) current.deps.push(dep);
      }
    }
    inDepsArray = false;
    depsBuf = '';
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (inDepsArray) {
      depsBuf += ` ${line}`;
      if (line.includes(']')) {
        flushDeps();
      }
      continue;
    }

    if (line === '[[package]]') {
      current = { name: '', version: '', source: '', deps: [] };
      packages.push(current);
      continue;
    }

    if (line.startsWith('[') && line !== '[[package]]') {
      if (line.startsWith('[[package.')) {
        // Untertabelle wie [[package.wheels]]
        continue;
      }
      current = null;
      continue;
    }

    if (!current) continue;
    if (line.startsWith('name =')) {
      current.name = unquoteYamlScalar(line.slice('name ='.length));
    } else if (line.startsWith('version =')) {
      current.version = cleanVersion(unquoteYamlScalar(line.slice('version ='.length)));
    } else if (line.startsWith('source =')) {
      current.source = line.slice('source ='.length).trim();
    } else if (line.startsWith('dependencies =')) {
      const val = line.slice('dependencies ='.length).trim();
      depsBuf = val;
      if (val.includes(']')) {
        flushDeps();
      } else {
        inDepsArray = true;
      }
    }
  }

  /** @type {Map<string, Set<string>>} */
  const requiredByMap = new Map();
  for (const pkg of packages) {
    if (!pkg.name) continue;
    const isVirtualRoot =
      /virtual\s*=|editable\s*=/.test(pkg.source) && !directScopeMap.has(normalizePythonPackageName(pkg.name));
    if (isVirtualRoot) continue;
    for (const dep of pkg.deps) {
      const depKey = normalizePythonPackageName(dep);
      if (!requiredByMap.has(depKey)) requiredByMap.set(depKey, new Set());
      requiredByMap.get(depKey).add(pkg.name);
    }
  }

  const dependencies = [];
  const seen = new Set();
  /** @type {Record<string, string>} */
  const versionByName = {};
  /** @type {Record<string, { version: string, description: string, license: string, homepage: string }>} */
  const metaByName = {};

  for (const pkg of packages) {
    if (!pkg.name) continue;
    const key = normalizePythonPackageName(pkg.name);
    const isVirtualRoot = /virtual\s*=|editable\s*=/.test(pkg.source) && !directScopeMap.has(key);
    if (isVirtualRoot || seen.has(key)) continue;
    seen.add(key);

    const homepage = `https://pypi.org/project/${encodeURIComponent(pkg.name)}/`;
    dependencies.push({
      manager: 'uv',
      name: pkg.name,
      version: pkg.version,
      direct: directScopeMap.has(key),
      scope: directScopeMap.get(key) || 'prod',
      requiredBy: [...(requiredByMap.get(key) || [])].sort((a, b) => a.localeCompare(b)),
      license: '',
      homepage,
    });
    if (pkg.version) versionByName[key] = pkg.version;
    metaByName[key] = { version: pkg.version, description: '', license: '', homepage };
  }

  dependencies.sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
  return { dependencies, versionByName, metaByName };
}

/**
 * Parst direkte Rust-Crates aus `Cargo.toml`.
 * @param {string} rawText
 * @returns {{ packages: Array<{ manager: string, name: string, declaredRange: string, installedVersion: string, scope: 'prod' | 'dev' | 'optional', description: string }>, rootPackageName: string }}
 */
export function parseCargoTomlDirect(rawText) {
  const text = stripBom(rawText);
  if (!text.trim()) return { packages: [], rootPackageName: '' };

  let currentSection = '';
  let rootPackageName = '';
  const results = [];
  const seen = new Set();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const secMatch = line.match(/^\[([^\]]+)\]$/);
    if (secMatch && !line.startsWith('[[')) {
      currentSection = secMatch[1].trim();
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line
      .slice(0, eqIdx)
      .trim()
      .replace(/^["']|["']$/g, '');
    const val = line.slice(eqIdx + 1).trim();

    if (currentSection === 'package' && key === 'name') {
      rootPackageName = unquoteYamlScalar(val);
      continue;
    }

    const isProd =
      currentSection === 'dependencies' ||
      currentSection === 'workspace.dependencies' ||
      /^target\.[^.]+\.dependencies$/.test(currentSection);
    const isDev =
      currentSection === 'dev-dependencies' ||
      currentSection === 'build-dependencies' ||
      /^target\.[^.]+\.(?:dev-dependencies|build-dependencies)$/.test(currentSection);

    if (!isProd && !isDev) continue;

    let crateName = key;
    let declaredRange = '';
    let isOptional = false;

    if (val.startsWith('{')) {
      const verMatch = val.match(/\bversion\s*=\s*["']([^"']+)["']/);
      const pkgMatch = val.match(/\bpackage\s*=\s*["']([^"']+)["']/);
      const optMatch = val.match(/\boptional\s*=\s*(true|false)/i);
      const gitMatch = val.match(/\bgit\s*=\s*["']([^"']+)["']/);
      const pathMatch = val.match(/\bpath\s*=\s*["']([^"']+)["']/);
      if (pkgMatch) crateName = pkgMatch[1].trim();
      declaredRange = verMatch ? verMatch[1].trim() : gitMatch ? gitMatch[1] : pathMatch ? `path:${pathMatch[1]}` : '';
      isOptional = optMatch?.[1]?.toLowerCase() === 'true';
    } else {
      declaredRange = unquoteYamlScalar(val);
    }

    if (!isValidCargoCrateName(crateName)) continue;
    const normKey = crateName.toLowerCase();
    if (seen.has(normKey)) continue;
    seen.add(normKey);

    results.push({
      manager: 'cargo',
      name: crateName,
      declaredRange,
      installedVersion: '',
      scope: isDev ? 'dev' : isOptional ? 'optional' : 'prod',
      description: '',
    });
  }

  return { packages: results, rootPackageName };
}

/**
 * Parst `Cargo.lock` (`[[package]]`) inkl. `requiredBy` und Ueberspringen des Root-Crates.
 * @param {string} rawText
 * @param {Array<{ name: string, scope?: string }>} [directList]
 * @param {string} [rootPackageName]
 */
export function parseCargoLock(rawText, directList = [], rootPackageName = '') {
  const text = stripBom(rawText);
  if (!text.trim()) return { dependencies: [], versionByName: {}, metaByName: {} };

  const directScopeMap = buildDirectScopeMap(directList);
  const rootLower = String(rootPackageName || '')
    .trim()
    .toLowerCase();
  /** @type {Array<{ name: string, version: string, source: string, deps: string[] }>} */
  const rawPackages = [];
  let current = null;
  let inDeps = false;
  let depsBuf = '';

  const flushDeps = () => {
    if (!current) return;
    for (const item of extractTomlQuotedStrings(depsBuf)) {
      const depName = item.trim().split(/\s+/)[0];
      if (depName) current.deps.push(depName);
    }
    inDeps = false;
    depsBuf = '';
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    if (inDeps) {
      depsBuf += ` ${line}`;
      if (line.includes(']')) {
        flushDeps();
      }
      continue;
    }

    if (line === '[[package]]') {
      current = { name: '', version: '', source: '', deps: [] };
      rawPackages.push(current);
      continue;
    }

    if (!current) continue;
    if (line.startsWith('name =')) {
      current.name = unquoteYamlScalar(line.slice('name ='.length));
    } else if (line.startsWith('version =')) {
      current.version = cleanVersion(unquoteYamlScalar(line.slice('version ='.length)));
    } else if (line.startsWith('source =')) {
      current.source = unquoteYamlScalar(line.slice('source ='.length));
    } else if (line.startsWith('dependencies =')) {
      const val = line.slice('dependencies ='.length).trim();
      depsBuf = val;
      if (val.includes(']')) {
        flushDeps();
      } else {
        inDeps = true;
      }
    }
  }

  /** @type {Map<string, Set<string>>} */
  const requiredByMap = new Map();
  for (const pkg of rawPackages) {
    if (!pkg.name) continue;
    const isRoot = !pkg.source && rootLower && pkg.name.toLowerCase() === rootLower;
    if (isRoot) continue;
    for (const dep of pkg.deps) {
      const depKey = dep.toLowerCase();
      if (!requiredByMap.has(depKey)) requiredByMap.set(depKey, new Set());
      requiredByMap.get(depKey).add(pkg.name);
    }
  }

  const dependencies = [];
  const seen = new Set();
  /** @type {Record<string, string>} */
  const versionByName = {};
  /** @type {Record<string, { version: string, description: string, license: string, homepage: string }>} */
  const metaByName = {};

  for (const pkg of rawPackages) {
    if (!pkg.name) continue;
    const key = pkg.name.toLowerCase();
    const isRoot = !pkg.source && rootLower && key === rootLower;
    if (isRoot || seen.has(key)) continue;
    seen.add(key);

    const homepage = `https://crates.io/crates/${encodeURIComponent(pkg.name)}`;
    dependencies.push({
      manager: 'cargo',
      name: pkg.name,
      version: pkg.version,
      direct: directScopeMap.has(key),
      scope: directScopeMap.get(key) || 'prod',
      requiredBy: [...(requiredByMap.get(key) || [])].sort((a, b) => a.localeCompare(b)),
      license: '',
      homepage,
    });
    if (pkg.version) versionByName[key] = pkg.version;
    metaByName[key] = { version: pkg.version, description: '', license: '', homepage };
  }

  dependencies.sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
  return { dependencies, versionByName, metaByName };
}

/**
 * Parst `<PackageReference ... />` aus `.csproj` Dateien.
 * @param {string} rawText
 * @returns {Array<{ manager: string, name: string, declaredRange: string, installedVersion: string, scope: 'prod' | 'dev' | 'optional', description: string }>}
 */
export function parseCsprojDirect(rawText) {
  const text = stripBom(rawText);
  if (!text.trim()) return [];

  const results = [];
  const seen = new Set();

  const tagRe = /<PackageReference\b([^>]*?)(?:\/>|>([\s\S]*?)<\/PackageReference>)/gi;
  let match = tagRe.exec(text);
  while (match !== null) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const includeMatch = attrs.match(/\bInclude\s*=\s*["']([^"']+)["']/i);
    const attrVerMatch = attrs.match(/\bVersion\s*=\s*["']([^"']+)["']/i);
    const bodyVerMatch = body.match(/<Version>([^<]+)<\/Version>/i);
    const isDevAttr =
      /\bPrivateAssets\s*=\s*["']all["']/i.test(attrs) || /<PrivateAssets>\s*all\s*<\/PrivateAssets>/i.test(body);

    const name = String(includeMatch?.[1] || '').trim();
    if (name && isValidDotnetToolId(name)) {
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        const declaredRange = String(attrVerMatch?.[1] || bodyVerMatch?.[1] || '').trim();
        results.push({
          manager: 'dotnet',
          name,
          declaredRange,
          installedVersion: '',
          scope: isDevAttr ? 'dev' : 'prod',
          description: '',
        });
      }
    }
    match = tagRe.exec(text);
  }

  return results;
}

/**
 * Parst NuGet `packages.lock.json` (`dependencies[tfm][pkg]`).
 * @param {string} rawText
 * @param {Array<{ name: string, scope?: string }>} [directList]
 */
export function parseDotnetPackagesLockJson(rawText, directList = []) {
  const parsed = safeJsonParse(rawText);
  if (!parsed || typeof parsed !== 'object' || !parsed.dependencies || typeof parsed.dependencies !== 'object') {
    return { dependencies: [], versionByName: {}, metaByName: {} };
  }

  const directScopeMap = buildDirectScopeMap(directList);
  /** @type {Map<string, Set<string>>} */
  const requiredByMap = new Map();
  /** @type {Map<string, { name: string, version: string, direct: boolean, scope: string }>} */
  const pkgMap = new Map();

  for (const tfmMap of Object.values(parsed.dependencies)) {
    if (!tfmMap || typeof tfmMap !== 'object') continue;
    for (const [pkgName, info] of Object.entries(tfmMap)) {
      if (!info || typeof info !== 'object') continue;
      const cleanName = String(pkgName || '').trim();
      if (!cleanName) continue;
      const key = cleanName.toLowerCase();
      const version = cleanVersion(info.resolved || info.requested);
      const isDirect =
        directScopeMap.has(key) ||
        String(info.type || '')
          .trim()
          .toLowerCase() === 'direct';

      if (info.dependencies && typeof info.dependencies === 'object') {
        for (const childName of Object.keys(info.dependencies)) {
          const childKey = String(childName).trim().toLowerCase();
          if (!requiredByMap.has(childKey)) requiredByMap.set(childKey, new Set());
          requiredByMap.get(childKey).add(cleanName);
        }
      }

      if (!pkgMap.has(key)) {
        pkgMap.set(key, {
          name: cleanName,
          version,
          direct: isDirect,
          scope: directScopeMap.get(key) || 'prod',
        });
      }
    }
  }

  const dependencies = [];
  /** @type {Record<string, string>} */
  const versionByName = {};
  /** @type {Record<string, { version: string, description: string, license: string, homepage: string }>} */
  const metaByName = {};

  for (const [key, entry] of pkgMap.entries()) {
    const homepage = `https://www.nuget.org/packages/${encodeURIComponent(entry.name)}`;
    dependencies.push({
      manager: 'dotnet',
      name: entry.name,
      version: entry.version,
      direct: entry.direct,
      scope: entry.scope,
      requiredBy: [...(requiredByMap.get(key) || [])].sort((a, b) => a.localeCompare(b)),
      license: '',
      homepage,
    });
    if (entry.version) versionByName[key] = entry.version;
    metaByName[key] = { version: entry.version, description: '', license: '', homepage };
  }

  dependencies.sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
  return { dependencies, versionByName, metaByName };
}

/**
 * Parst `vcpkg.json` Projekt-Manifest (`dependencies` + `overrides`).
 * @param {string} rawText
 */
export function parseVcpkgProjectManifest(rawText) {
  const parsed = safeJsonParse(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  /** @type {Map<string, string>} */
  const overrideMap = new Map();
  if (Array.isArray(parsed.overrides)) {
    for (const ov of parsed.overrides) {
      if (!ov || typeof ov !== 'object') continue;
      const name = String(ov.name || '').trim();
      const ver = String(ov.version ?? ov['version-semver'] ?? ov['version-date'] ?? ov['version-string'] ?? '').trim();
      if (name && ver) {
        overrideMap.set(name.toLowerCase(), ver);
      }
    }
  }

  const results = [];
  const seen = new Set();
  for (const entry of Array.isArray(parsed.dependencies) ? parsed.dependencies : []) {
    const name = typeof entry === 'string' ? entry.trim() : String(entry?.name || '').trim();
    if (!name || !isValidVcpkgPortName(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const declaredRange =
      (typeof entry === 'object' && entry !== null ? String(entry['version>='] || '').trim() : '') ||
      overrideMap.get(key) ||
      '';
    results.push({
      manager: 'vcpkg',
      name,
      declaredRange,
      installedVersion: overrideMap.get(key) || '',
      scope: 'prod',
      description: '',
    });
  }

  return results;
}

/**
 * Reichert direkte Pakete (`installed`) mit Lockfile-Versionen & Beschreibungen an.
 * @param {Array<{ manager: string, name: string, declaredRange: string, installedVersion: string, scope: string, description: string }>} installedList
 * @param {Record<string, string>} [versionByName]
 * @param {Record<string, { version?: string, description?: string }>} [metaByName]
 * @param {(name: string) => string} [normalizeFn]
 */
export function mergeInstalledWithLockMeta(
  installedList = [],
  versionByName = {},
  metaByName = {},
  normalizeFn = (n) => String(n || '').toLowerCase()
) {
  return (Array.isArray(installedList) ? installedList : []).map((pkg) => {
    const key = normalizeFn(pkg.name);
    const meta = metaByName?.[key];
    const lockVer = versionByName?.[key] || meta?.version || '';
    return {
      ...pkg,
      installedVersion: pkg.installedVersion || lockVer || '',
      description: pkg.description || meta?.description || '',
    };
  });
}

/**
 * Zerlegt eine SemVer-aehnliche Version in `[major, minor, patch]`.
 * @param {unknown} version
 * @returns {[number, number, number] | null}
 */
export function parseSemverParts(version) {
  const clean = cleanVersion(version);
  if (!clean) return null;
  const match = clean.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

/**
 * Prueft, ob `targetVersion` einen hoeheren Major-Stand als `currentVersion` hat.
 * @param {unknown} currentVersion
 * @param {unknown} targetVersion
 * @returns {boolean}
 */
export function isMajorUpgrade(currentVersion, targetVersion) {
  const cur = parseSemverParts(currentVersion);
  const tgt = parseSemverParts(targetVersion);
  if (!cur || !tgt) return false;
  return tgt[0] > cur[0];
}

function resolveScope(rawType, fallback = 'prod') {
  const low = String(rawType || '')
    .trim()
    .toLowerCase();
  if (low === 'dev' || low === 'devdependencies' || low === 'require-dev') return 'dev';
  if (low === 'optional' || low === 'optionaldependencies') return 'optional';
  if (low === 'prod' || low === 'dependencies' || low === 'require') return 'prod';
  return fallback;
}

/**
 * Parst `npm outdated --json` und `pnpm outdated --format json` (beachtet Exit-Code 1 und Objekt/Array-Formate).
 * @param {string} rawText
 * @param {{ manager?: string, directScopeMap?: Map<string, string> | null }} [options]
 */
export function parseProjectNpmOutdatedJson(rawText, { manager = 'npm', directScopeMap = null } = {}) {
  const parsed = extractJsonPayload(rawText);
  if (!parsed || typeof parsed !== 'object') return [];

  /** @type {Array<[string, Record<string, any>]>} */
  const entries = Array.isArray(parsed)
    ? parsed.map((item) => [String(item?.name || item?.package || '').trim(), item])
    : Object.entries(parsed);

  const updates = [];
  const seen = new Set();

  for (const [pkgName, info] of entries) {
    const name = String(pkgName || '').trim();
    if (!name || !info || typeof info !== 'object') continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;

    const current = cleanVersion(info.current ?? info.installed);
    const wanted = cleanVersion(info.wanted) || current;
    const latest = cleanVersion(info.latest ?? info.available);
    if (!latest && !wanted) continue;

    const hasWantedUpdate = Boolean(wanted && current && wanted !== current);
    const hasLatestUpdate = Boolean(latest && current && latest !== current);
    if (current && !hasWantedUpdate && !hasLatestUpdate) continue;

    seen.add(key);
    const scope = directScopeMap?.get(key) || resolveScope(info.dependencyType || info.type, 'prod');
    updates.push({
      manager,
      name,
      current,
      wanted: wanted || latest,
      latest: latest || wanted,
      scope,
      isMajor: isMajorUpgrade(current, latest || wanted),
      hasWantedUpdate,
      hasLatestUpdate,
      description: '',
    });
  }

  return updates;
}

/**
 * Parst `composer outdated --format=json` inkl. Unterscheidung `semver-safe-update` vs `update-possible`.
 * @param {string} rawText
 * @param {{ directScopeMap?: Map<string, string> | null }} [options]
 */
export function parseProjectComposerOutdatedJson(rawText, { directScopeMap = null } = {}) {
  const parsed = extractComposerJson(rawText);
  if (!parsed || typeof parsed !== 'object') return [];

  const installed = Array.isArray(parsed.installed) ? parsed.installed : [];
  const updates = [];
  const seen = new Set();

  for (const entry of installed) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;

    const current = cleanVersion(entry.version);
    const latest = cleanVersion(entry.latest);
    const status = String(entry['latest-status'] || '')
      .trim()
      .toLowerCase();
    if (!latest || status === 'up-to-date' || (current && current === latest)) continue;

    seen.add(key);
    const isSemverSafe = status === 'semver-safe-update';
    const isMajor = status === 'update-possible' ? true : isMajorUpgrade(current, latest);
    const wanted = isSemverSafe ? latest : current || latest;
    const hasWantedUpdate = Boolean(wanted && current && wanted !== current);
    const hasLatestUpdate = Boolean(latest && current && latest !== current);
    const scope = directScopeMap?.get(key) || 'prod';

    updates.push({
      manager: 'composer',
      name,
      current,
      wanted,
      latest,
      scope,
      isMajor,
      hasWantedUpdate,
      hasLatestUpdate,
      description: String(entry.description || '').trim(),
    });
  }

  return updates;
}

/**
 * Parst `dotnet list package --outdated --format json`.
 * @param {string} rawText
 * @param {{ directScopeMap?: Map<string, string> | null }} [options]
 */
export function parseProjectDotnetOutdatedJson(rawText, { directScopeMap = null } = {}) {
  const parsed = extractJsonPayload(rawText);
  if (!parsed || typeof parsed !== 'object') return [];

  const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
  const updates = [];
  const seen = new Set();

  for (const project of projects) {
    const frameworks = Array.isArray(project?.frameworks) ? project.frameworks : [];
    for (const fw of frameworks) {
      const pkgs = Array.isArray(fw?.topLevelPackages) ? fw.topLevelPackages : [];
      for (const entry of pkgs) {
        if (!entry || typeof entry !== 'object') continue;
        const name = String(entry.id || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;

        const current = cleanVersion(entry.resolvedVersion);
        const latest = cleanVersion(entry.latestVersion);
        if (!latest || (current && current === latest)) continue;

        seen.add(key);
        const isMajor = isMajorUpgrade(current, latest);
        const wanted = isMajor ? current || latest : latest;
        updates.push({
          manager: 'dotnet',
          name,
          current,
          wanted,
          latest,
          scope: directScopeMap?.get(key) || 'prod',
          isMajor,
          hasWantedUpdate: Boolean(wanted && current && wanted !== current),
          hasLatestUpdate: Boolean(latest && current && latest !== current),
          description: '',
        });
      }
    }
  }

  return updates;
}

/**
 * Parst `pip list --outdated --format=json` (oder `uv pip list --outdated --format=json`).
 * @param {string} rawText
 * @param {{ manager?: string, directScopeMap?: Map<string, string> | null, allowedNamesSet?: Set<string> | null }} [options]
 */
export function parseProjectPipOutdatedJson(
  rawText,
  { manager = 'pip', directScopeMap = null, allowedNamesSet = null } = {}
) {
  const parsed = extractJsonPayload(rawText);
  if (!Array.isArray(parsed)) return [];

  const updates = [];
  const seen = new Set();

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    const key = normalizePythonPackageName(name);
    if (allowedNamesSet && !allowedNamesSet.has(key)) continue;
    if (seen.has(key)) continue;

    const current = cleanVersion(entry.version);
    const latest = cleanVersion(entry.latest_version ?? entry.latest);
    if (!latest || (current && current === latest)) continue;

    seen.add(key);
    const isMajor = isMajorUpgrade(current, latest);
    const wanted = isMajor ? current || latest : latest;
    updates.push({
      manager,
      name,
      current,
      wanted,
      latest,
      scope: directScopeMap?.get(key) || 'prod',
      isMajor,
      hasWantedUpdate: Boolean(wanted && current && wanted !== current),
      hasLatestUpdate: Boolean(latest && current && latest !== current),
      description: '',
    });
  }

  return updates;
}

/**
 * Parst `bun outdated` Tabellenausgabe (`| Package | Current | Update | Latest |`).
 * @param {string} rawText
 * @param {{ directScopeMap?: Map<string, string> | null }} [options]
 */
export function parseProjectBunOutdatedOutput(rawText, { directScopeMap = null } = {}) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = cleanCliLines(stripBom(rawText));
  const updates = [];
  const seen = new Set();

  for (const line of lines) {
    if (!line.includes('|')) continue;
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean);
    if (cells.length < 4) continue;
    if (/^package$/i.test(cells[0]) || /^-+$/.test(cells[0])) continue;

    const rawName = cells[0].replace(/\s+\(dev\)|\s+\(optional\)/gi, '').trim();
    if (!isValidNpmPackageName(rawName)) continue;
    const key = rawName.toLowerCase();
    if (seen.has(key)) continue;

    const current = cleanVersion(cells[1]);
    const wanted = cleanVersion(cells[2]) || current;
    const latest = cleanVersion(cells[3]) || wanted;
    if (!latest || (current && current === latest && wanted === current)) continue;

    seen.add(key);
    updates.push({
      manager: 'bun',
      name: rawName,
      current,
      wanted,
      latest,
      scope: directScopeMap?.get(key) || (/\(dev\)/i.test(cells[0]) ? 'dev' : 'prod'),
      isMajor: isMajorUpgrade(current, latest),
      hasWantedUpdate: Boolean(wanted && current && wanted !== current),
      hasLatestUpdate: Boolean(latest && current && latest !== current),
      description: '',
    });
  }

  return updates;
}

/**
 * Parst `yarn outdated --json` NDJSON-Tabelle.
 * @param {string} rawText
 * @param {{ directScopeMap?: Map<string, string> | null }} [options]
 */
export function parseProjectYarnOutdatedOutput(rawText, { directScopeMap = null } = {}) {
  if (!rawText || typeof rawText !== 'string') return [];
  const lines = cleanCliLines(stripBom(rawText));
  const updates = [];
  const seen = new Set();

  for (const line of lines) {
    const parsed = safeJsonParse(line);
    if (parsed?.type !== 'table' || !Array.isArray(parsed.data?.body)) continue;
    for (const row of parsed.data.body) {
      if (!Array.isArray(row) || row.length < 4) continue;
      const name = String(row[0] || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;

      const current = cleanVersion(row[1]);
      const wanted = cleanVersion(row[2]) || current;
      const latest = cleanVersion(row[3]) || wanted;
      if (!latest || (current && current === latest && wanted === current)) continue;

      seen.add(key);
      updates.push({
        manager: 'yarn',
        name,
        current,
        wanted,
        latest,
        scope: directScopeMap?.get(key) || resolveScope(row[4], 'prod'),
        isMajor: isMajorUpgrade(current, latest),
        hasWantedUpdate: Boolean(wanted && current && wanted !== current),
        hasLatestUpdate: Boolean(latest && current && latest !== current),
        description: '',
      });
    }
  }

  return updates;
}

/**
 * Parst `cargo outdated --format=json` (falls `cargo-outdated` Subcommand installiert ist).
 * @param {string} rawText
 * @param {{ directScopeMap?: Map<string, string> | null }} [options]
 */
export function parseProjectCargoOutdatedJson(rawText, { directScopeMap = null } = {}) {
  const parsed = extractJsonPayload(rawText);
  if (!parsed || typeof parsed !== 'object') return [];

  const deps = Array.isArray(parsed.dependencies) ? parsed.dependencies : [];
  const updates = [];
  const seen = new Set();

  for (const entry of deps) {
    if (!entry || typeof entry !== 'object') continue;
    const name = String(entry.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;

    const current = cleanVersion(entry.project);
    const wanted = cleanVersion(entry.compat) || current;
    const latest = cleanVersion(entry.latest) || wanted;
    if (!latest || (current && current === latest && wanted === current)) continue;

    seen.add(key);
    updates.push({
      manager: 'cargo',
      name,
      current,
      wanted,
      latest,
      scope: directScopeMap?.get(key) || resolveScope(entry.kind, 'prod'),
      isMajor: isMajorUpgrade(current, latest),
      hasWantedUpdate: Boolean(wanted && current && wanted !== current && wanted !== '---'),
      hasLatestUpdate: Boolean(latest && current && latest !== current && latest !== '---'),
      description: '',
    });
  }

  return updates;
}

/**
 * Validiert Paketnamen pro Projekt-Paketmanager gegen Command-Injection.
 * @param {string} manager
 * @param {unknown} packageName
 * @returns {boolean}
 */
export function isValidDevPackageName(manager, packageName) {
  const cleanMgr = String(manager || '')
    .trim()
    .toLowerCase();
  switch (cleanMgr) {
    case 'npm':
    case 'pnpm':
    case 'bun':
    case 'yarn':
      return isValidNpmPackageName(packageName);
    case 'composer':
      return isValidComposerPackageName(packageName);
    case 'pip':
    case 'uv':
      return isValidPythonPackageName(packageName);
    case 'cargo':
      return isValidCargoCrateName(packageName);
    case 'dotnet':
      return isValidDotnetToolId(packageName);
    case 'vcpkg':
      return isValidVcpkgPortName(packageName);
    default:
      return false;
  }
}

/**
 * Validiert eine optionale Versionsangabe / SemVer-Range fuer sichere Argument-Uebergabe.
 * @param {unknown} version
 * @returns {boolean}
 */
export function isValidDevVersionSpec(version) {
  const clean = String(version ?? '').trim();
  if (!clean) return true;
  if (clean.length > 64 || /\s/.test(clean) || CONTROL_CHAR_RE.test(clean)) return false;
  return SAFE_VERSION_SPEC_RE.test(clean);
}

/**
 * Erzeugt Argumente fuer `devInstallPackage`.
 * @param {{ manager: string, packageName: string, version?: string, isDev?: boolean }} params
 * @returns {{ args: string[], description: string }}
 */
export function buildDevInstallCommand({ manager, packageName, version = '', isDev = false }) {
  const mgr = String(manager || '')
    .trim()
    .toLowerCase();
  const pkg = String(packageName || '').trim();
  const ver = String(version || '').trim();

  switch (mgr) {
    case 'npm':
      return {
        args: ['install', ...(isDev ? ['-D'] : []), ver ? `${pkg}@${ver}` : pkg],
        description: `npm install ${isDev ? '-D ' : ''}${ver ? `${pkg}@${ver}` : pkg}`,
      };
    case 'pnpm':
      return {
        args: ['add', ...(isDev ? ['-D'] : []), ver ? `${pkg}@${ver}` : pkg],
        description: `pnpm add ${isDev ? '-D ' : ''}${ver ? `${pkg}@${ver}` : pkg}`,
      };
    case 'bun':
      return {
        args: ['add', ...(isDev ? ['-d'] : []), ver ? `${pkg}@${ver}` : pkg],
        description: `bun add ${isDev ? '-d ' : ''}${ver ? `${pkg}@${ver}` : pkg}`,
      };
    case 'yarn':
      return {
        args: ['add', ...(isDev ? ['-D'] : []), ver ? `${pkg}@${ver}` : pkg],
        description: `yarn add ${isDev ? '-D ' : ''}${ver ? `${pkg}@${ver}` : pkg}`,
      };
    case 'composer':
      return {
        args: ['require', ...(isDev ? ['--dev'] : []), ver ? `${pkg}:${ver}` : pkg],
        description: `composer require ${isDev ? '--dev ' : ''}${ver ? `${pkg}:${ver}` : pkg}`,
      };
    case 'uv':
      return {
        args: ['add', ...(isDev ? ['--dev'] : []), ver ? `${pkg}==${ver}` : pkg],
        description: `uv add ${isDev ? '--dev ' : ''}${ver ? `${pkg}==${ver}` : pkg}`,
      };
    case 'pip':
      return {
        args: ['install', ver ? `${pkg}==${ver}` : pkg],
        description: `pip install ${ver ? `${pkg}==${ver}` : pkg}`,
      };
    case 'cargo':
      return {
        args: ['add', ...(isDev ? ['--dev'] : []), ver ? `${pkg}@${ver}` : pkg],
        description: `cargo add ${isDev ? '--dev ' : ''}${ver ? `${pkg}@${ver}` : pkg}`,
      };
    case 'dotnet':
      return {
        args: ['add', 'package', pkg, ...(ver ? ['--version', ver] : [])],
        description: `dotnet add package ${pkg}${ver ? ` --version ${ver}` : ''}`,
      };
    case 'vcpkg':
      return {
        args: ['add', 'port', pkg],
        description: `vcpkg add port ${pkg}`,
      };
    default:
      throw new Error(`Nicht unterstuetzter Paketmanager: ${mgr}`);
  }
}

/**
 * Erzeugt Argumente fuer `devUpdatePackage` (unterscheidet `wanted` vs `latest` / Major-Sprung).
 * @param {{ manager: string, packageName: string, targetVersion?: string, allowMajor?: boolean, isDev?: boolean }} params
 * @returns {{ args: string[], description: string }}
 */
export function buildDevUpdateCommand({ manager, packageName, targetVersion = '', allowMajor = false, isDev = false }) {
  const mgr = String(manager || '')
    .trim()
    .toLowerCase();
  const pkg = String(packageName || '').trim();
  const ver = cleanVersion(targetVersion);

  if (!allowMajor) {
    switch (mgr) {
      case 'npm':
        return { args: ['update', pkg], description: `npm update ${pkg}` };
      case 'pnpm':
        return { args: ['update', pkg], description: `pnpm update ${pkg}` };
      case 'bun':
        return { args: ['update', pkg], description: `bun update ${pkg}` };
      case 'yarn':
        return { args: ['upgrade', pkg], description: `yarn upgrade ${pkg}` };
      case 'composer':
        return {
          args: ['update', pkg, '--with-all-dependencies'],
          description: `composer update ${pkg} --with-all-dependencies`,
        };
      case 'uv':
        return {
          args: ['sync', '--upgrade-package', pkg],
          description: `uv sync --upgrade-package ${pkg}`,
        };
      case 'pip':
        return {
          args: ['install', '--upgrade', ver ? `${pkg}==${ver}` : pkg],
          description: `pip install --upgrade ${ver ? `${pkg}==${ver}` : pkg}`,
        };
      case 'cargo':
        return {
          args: ['update', '-p', pkg],
          description: `cargo update -p ${pkg}`,
        };
      case 'dotnet':
        return {
          args: ['add', 'package', pkg, ...(ver ? ['--version', ver] : [])],
          description: `dotnet add package ${pkg}${ver ? ` --version ${ver}` : ''}`,
        };
      case 'vcpkg':
        return { args: ['x-update-baseline'], description: 'vcpkg x-update-baseline' };
      default:
        throw new Error(`Nicht unterstuetzter Paketmanager: ${mgr}`);
    }
  }

  // Major-Sprung (allowMajor: true) auf targetVersion oder latest
  switch (mgr) {
    case 'npm': {
      const spec = ver ? `${pkg}@${ver}` : `${pkg}@latest`;
      return {
        args: ['install', ...(isDev ? ['-D'] : []), spec],
        description: `npm install ${isDev ? '-D ' : ''}${spec}`,
      };
    }
    case 'pnpm':
      if (ver) {
        return {
          args: ['add', ...(isDev ? ['-D'] : []), `${pkg}@${ver}`],
          description: `pnpm add ${isDev ? '-D ' : ''}${pkg}@${ver}`,
        };
      }
      return { args: ['update', '--latest', pkg], description: `pnpm update --latest ${pkg}` };
    case 'bun': {
      const spec = ver ? `${pkg}@${ver}` : `${pkg}@latest`;
      return {
        args: ['add', ...(isDev ? ['-d'] : []), spec],
        description: `bun add ${isDev ? '-d ' : ''}${spec}`,
      };
    }
    case 'yarn': {
      const spec = ver ? `${pkg}@${ver}` : `${pkg}@latest`;
      return {
        args: ['add', ...(isDev ? ['-D'] : []), spec],
        description: `yarn add ${isDev ? '-D ' : ''}${spec}`,
      };
    }
    case 'composer': {
      const spec = ver ? `${pkg}:^${ver}` : `${pkg}:*`;
      return {
        args: ['require', ...(isDev ? ['--dev'] : []), spec, '--with-all-dependencies'],
        description: `composer require ${isDev ? '--dev ' : ''}${spec} --with-all-dependencies`,
      };
    }
    case 'uv':
      return {
        args: ['add', ...(isDev ? ['--dev'] : []), ver ? `${pkg}>=${ver}` : pkg, '--upgrade-package', pkg],
        description: `uv add ${isDev ? '--dev ' : ''}${ver ? `${pkg}>=${ver}` : pkg}`,
      };
    case 'pip':
      return {
        args: ['install', '--upgrade', ver ? `${pkg}==${ver}` : pkg],
        description: `pip install --upgrade ${ver ? `${pkg}==${ver}` : pkg}`,
      };
    case 'cargo': {
      const spec = ver ? `${pkg}@${ver}` : pkg;
      return {
        args: ['add', ...(isDev ? ['--dev'] : []), spec],
        description: `cargo add ${isDev ? '--dev ' : ''}${spec}`,
      };
    }
    case 'dotnet':
      return {
        args: ['add', 'package', pkg, ...(ver ? ['--version', ver] : [])],
        description: `dotnet add package ${pkg}${ver ? ` --version ${ver}` : ''}`,
      };
    case 'vcpkg':
      return { args: ['x-update-baseline'], description: 'vcpkg x-update-baseline' };
    default:
      throw new Error(`Nicht unterstuetzter Paketmanager: ${mgr}`);
  }
}

/**
 * Erzeugt Argumente fuer `devUninstallPackage`.
 * @param {{ manager: string, packageName: string, isDev?: boolean }} params
 * @returns {{ args: string[], description: string }}
 */
export function buildDevUninstallCommand({ manager, packageName, isDev = false }) {
  const mgr = String(manager || '')
    .trim()
    .toLowerCase();
  const pkg = String(packageName || '').trim();

  switch (mgr) {
    case 'npm':
      return { args: ['uninstall', pkg], description: `npm uninstall ${pkg}` };
    case 'pnpm':
      return { args: ['remove', pkg], description: `pnpm remove ${pkg}` };
    case 'bun':
      return { args: ['remove', pkg], description: `bun remove ${pkg}` };
    case 'yarn':
      return { args: ['remove', pkg], description: `yarn remove ${pkg}` };
    case 'composer':
      return {
        args: ['remove', ...(isDev ? ['--dev'] : []), pkg],
        description: `composer remove ${isDev ? '--dev ' : ''}${pkg}`,
      };
    case 'uv':
      return {
        args: ['remove', ...(isDev ? ['--dev'] : []), pkg],
        description: `uv remove ${isDev ? '--dev ' : ''}${pkg}`,
      };
    case 'pip':
      return { args: ['uninstall', '-y', pkg], description: `pip uninstall -y ${pkg}` };
    case 'cargo':
      return {
        args: ['remove', ...(isDev ? ['--dev'] : []), pkg],
        description: `cargo remove ${isDev ? '--dev ' : ''}${pkg}`,
      };
    case 'dotnet':
      return { args: ['remove', 'package', pkg], description: `dotnet remove package ${pkg}` };
    default:
      throw new Error(`Deinstallation fuer "${mgr}" wird nicht unterstuetzt.`);
  }
}

/**
 * Erzeugt Argumente fuer `devSyncProject`.
 * @param {string} manager
 * @param {{ hasRequirementsTxt?: boolean, hasPyprojectToml?: boolean }} [options]
 * @returns {{ args: string[], description: string }}
 */
export function buildDevSyncCommand(manager, { hasRequirementsTxt = false, hasPyprojectToml = false } = {}) {
  const mgr = String(manager || '')
    .trim()
    .toLowerCase();

  switch (mgr) {
    case 'npm':
      return { args: ['install'], description: 'npm install' };
    case 'pnpm':
      return { args: ['install'], description: 'pnpm install' };
    case 'bun':
      return { args: ['install'], description: 'bun install' };
    case 'yarn':
      return { args: ['install'], description: 'yarn install' };
    case 'composer':
      return { args: ['install'], description: 'composer install' };
    case 'uv':
      return { args: ['sync'], description: 'uv sync' };
    case 'pip':
      if (hasRequirementsTxt) {
        return { args: ['install', '-r', 'requirements.txt'], description: 'pip install -r requirements.txt' };
      }
      if (hasPyprojectToml) {
        return { args: ['install', '.'], description: 'pip install .' };
      }
      return { args: ['install', '-r', 'requirements.txt'], description: 'pip install -r requirements.txt' };
    case 'cargo':
      return { args: ['fetch'], description: 'cargo fetch' };
    case 'dotnet':
      return { args: ['restore'], description: 'dotnet restore' };
    case 'vcpkg':
      return { args: ['install'], description: 'vcpkg install' };
    default:
      throw new Error(`Sync fuer "${mgr}" wird nicht unterstuetzt.`);
  }
}

/**
 * Erzeugt 1- oder 2-stufige CLI-Schritte zum Wechsel zwischen `prod` und `dev`.
 * @param {{ manager: string, packageName: string, currentRange?: string, targetScope?: 'prod' | 'dev' }} params
 * @returns {{ supported: true, steps: string[][] } | { supported: false, error: string }}
 */
export function buildDevToggleScopeSteps({ manager, packageName, currentRange = '', targetScope = 'dev' }) {
  const mgr = String(manager || '')
    .trim()
    .toLowerCase();
  if (!SUPPORTED_MANAGER_SET.has(mgr)) {
    return { supported: false, error: `Unbekannter Paketmanager: ${mgr}` };
  }

  const pkg = String(packageName || '').trim();
  const range = String(currentRange || '').trim();
  const toDev = targetScope === 'dev';

  switch (mgr) {
    case 'npm': {
      const spec = range && isValidDevVersionSpec(range) ? `${pkg}@${range}` : pkg;
      return { supported: true, steps: [['install', toDev ? '--save-dev' : '--save-prod', spec]] };
    }
    case 'pnpm': {
      const spec = range && isValidDevVersionSpec(range) ? `${pkg}@${range}` : pkg;
      return { supported: true, steps: [['add', toDev ? '--save-dev' : '--save-prod', spec]] };
    }
    case 'bun': {
      const spec = range && isValidDevVersionSpec(range) ? `${pkg}@${range}` : pkg;
      return { supported: true, steps: [['add', ...(toDev ? ['-d'] : []), spec]] };
    }
    case 'yarn': {
      const spec = range && isValidDevVersionSpec(range) ? `${pkg}@${range}` : pkg;
      return { supported: true, steps: [['add', ...(toDev ? ['-D'] : []), spec]] };
    }
    case 'composer': {
      const spec = range && isValidDevVersionSpec(range) ? `${pkg}:${range}` : pkg;
      return {
        supported: true,
        steps: [
          ['remove', ...(toDev ? [] : ['--dev']), pkg],
          ['require', ...(toDev ? ['--dev'] : []), spec],
        ],
      };
    }
    case 'uv': {
      const spec = range && isValidDevVersionSpec(range) ? `${pkg}${range}` : pkg;
      return {
        supported: true,
        steps: [
          ['remove', ...(toDev ? [] : ['--dev']), pkg],
          ['add', ...(toDev ? ['--dev'] : []), spec],
        ],
      };
    }
    case 'cargo': {
      const cleanRange = cleanVersion(range);
      const spec = cleanRange && isValidDevVersionSpec(cleanRange) ? `${pkg}@${cleanRange}` : pkg;
      return {
        supported: true,
        steps: [
          ['remove', ...(toDev ? [] : ['--dev']), pkg],
          ['add', ...(toDev ? ['--dev'] : []), spec],
        ],
      };
    }
    default:
      return {
        supported: false,
        error: `Scope-Wechsel (prod/dev) wird fuer "${mgr}" nicht ueber CLI unterstuetzt.`,
      };
  }
}
