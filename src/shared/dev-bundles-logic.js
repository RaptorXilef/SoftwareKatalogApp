import { extractComposerJson } from './composer-parser.js';
import { isValidDevPackageName, isValidDevVersionSpec } from './dev-projects-logic.js';
import { normalizePythonPackageName } from './python-parser.js';
import { compareVersions, extractVersion } from './version.js';
import { cleanCliLines } from './winget-parser.js';

export const DEV_BUNDLE_MANAGERS = Object.freeze(['npm', 'pnpm', 'bun', 'composer', 'pip', 'uv', 'cargo', 'dotnet']);

export const DEFAULT_DEV_BUNDLE_ICON = '🧺';
export const DEV_BUNDLE_ICON_PRESETS = Object.freeze(['🧺', '🛠️', '⚡', '🧪', '🐘', '🐍', '🦀', '📦', '🚀', '🔒']);
const DEV_BUNDLE_EXPORT_FORMAT = 'software-katalog-dev-bundle';
const DEV_BUNDLES_EXPORT_FORMAT = 'software-katalog-dev-bundles';
export const AUDIT_SUPPORTED_MANAGERS = Object.freeze(['npm', 'pnpm', 'composer']);

const DEV_BUNDLE_MANAGER_SET = new Set(DEV_BUNDLE_MANAGERS);
const SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, moderate: 2, low: 3 });

function tr(translateFn, key, params, fallback) {
  if (typeof translateFn === 'function') {
    const translated = translateFn(key, params);
    if (typeof translated === 'string' && translated && translated !== key) {
      return translated;
    }
  }
  return fallback;
}

/**
 * Liefert das Oekosystem eines Paketmanagers (`node`, `php`, `python`, `rust`, `dotnet`, `cpp`).
 * @param {unknown} manager
 * @returns {string}
 */
export function getDevManagerEcosystem(manager) {
  const mgr = String(manager || '')
    .trim()
    .toLowerCase();
  if (mgr === 'npm' || mgr === 'pnpm' || mgr === 'bun' || mgr === 'yarn') return 'node';
  if (mgr === 'composer') return 'php';
  if (mgr === 'pip' || mgr === 'uv') return 'python';
  if (mgr === 'cargo') return 'rust';
  if (mgr === 'dotnet') return 'dotnet';
  if (mgr === 'vcpkg') return 'cpp';
  return mgr;
}

/**
 * Normalisiert den Vergleichsschluessel eines Pakets innerhalb eines Managers.
 * @param {unknown} manager
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeDevBundlePkgKey(manager, name) {
  const mgr = String(manager || '')
    .trim()
    .toLowerCase();
  const cleanName = String(name || '').trim();
  if (!cleanName) return '';
  if (mgr === 'pip' || mgr === 'uv') {
    return normalizePythonPackageName(cleanName);
  }
  return cleanName.toLowerCase();
}

/**
 * Liefert den Anzeigenamen der zugehoerigen Paket-Registry.
 * @param {unknown} manager
 * @returns {string}
 */
export function getDevBundleRegistryLabel(manager) {
  const mgr = String(manager || '')
    .trim()
    .toLowerCase();
  if (mgr === 'composer') return 'Packagist';
  if (mgr === 'pip' || mgr === 'uv') return 'PyPI';
  if (mgr === 'cargo') return 'crates.io';
  if (mgr === 'dotnet') return 'NuGet';
  return 'npm';
}

/**
 * Normalisiert einen einzelnen Paketeintrag in einem Dev-Buendel.
 * @param {unknown} raw
 * @param {string} manager
 * @returns {{ name: string, version: string, isDev: boolean, optional: boolean } | null}
 */
function normalizeDevBundlePackage(raw, manager) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const src = /** @type {Record<string, any>} */ (raw);
  const name = String(src.name || src.packageName || '').trim();
  if (!name || !isValidDevPackageName(manager, name)) return null;

  const rawVer = String(src.version ?? '').trim();
  const version = rawVer && isValidDevVersionSpec(rawVer) ? rawVer : '';

  return {
    name,
    version,
    isDev: Boolean(src.isDev),
    optional: Boolean(src.optional),
  };
}

/**
 * Normalisiert und dedupliziert die Paketliste eines Dev-Buendels unter Beibehaltung der Reihenfolge.
 * @param {unknown} packages
 * @param {string} manager
 * @returns {Array<{ name: string, version: string, isDev: boolean, optional: boolean }>}
 */
export function dedupeDevBundlePackages(packages = [], manager = 'npm') {
  if (!Array.isArray(packages)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of packages) {
    const normalized = normalizeDevBundlePackage(raw, manager);
    if (!normalized) continue;
    const key = normalizeDevBundlePkgKey(manager, normalized.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

/**
 * Verschiebt ein Paket innerhalb der Liste (z. B. Drag & Drop oder Pfeiltasten).
 * @template T
 * @param {T[]} packages
 * @param {number} fromIndex
 * @param {number} toIndex
 * @returns {T[]}
 */
export function moveDevBundlePackage(packages = [], fromIndex, toIndex) {
  const list = Array.isArray(packages) ? [...packages] : [];
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= list.length ||
    toIndex >= list.length ||
    fromIndex === toIndex
  ) {
    return list;
  }
  const [moved] = list.splice(fromIndex, 1);
  list.splice(toIndex, 0, moved);
  return list;
}

/**
 * Normalisiert ein Dev-Buendel auf das feste Schema in `data/dev-bundles.json`.
 * @param {unknown} raw
 * @param {{ now?: number, fallbackId?: string }} [options]
 * @returns {{
 *   id: string,
 *   name: string,
 *   description: string,
 *   icon: string,
 *   manager: 'npm' | 'pnpm' | 'bun' | 'composer' | 'pip' | 'uv' | 'cargo' | 'dotnet',
 *   createdAt: number,
 *   updatedAt: number,
 *   packages: Array<{ name: string, version: string, isDev: boolean, optional: boolean }>,
 * }}
 */
export function normalizeDevBundle(raw, { now = Date.now(), fallbackId = '' } = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const id = String(src.id || fallbackId || '').trim();
  const rawMgr = String(src.manager || '')
    .trim()
    .toLowerCase();
  const manager = /** @type {'npm' | 'pnpm' | 'bun' | 'composer' | 'pip' | 'uv' | 'cargo' | 'dotnet'} */ (
    DEV_BUNDLE_MANAGER_SET.has(rawMgr) ? rawMgr : 'npm'
  );
  const name =
    typeof src.name === 'string' && src.name.replace(/[\r\n\0]/g, '').trim()
      ? src.name.replace(/[\r\n\0]/g, '').trim()
      : 'Unnamed Dev Bundle';
  const description = typeof src.description === 'string' ? src.description.replace(/\0/g, '').trim() : '';
  const icon =
    typeof src.icon === 'string' && src.icon.trim()
      ? src.icon.replace(/[\r\n\0]/g, '').trim()
      : DEFAULT_DEV_BUNDLE_ICON;

  const createdRaw = Number(src.createdAt);
  const updatedRaw = Number(src.updatedAt);
  const createdAt = Number.isFinite(createdRaw) && createdRaw > 0 ? createdRaw : now;
  const updatedAt = Number.isFinite(updatedRaw) && updatedRaw > 0 ? updatedRaw : createdAt;

  return {
    id,
    name,
    description,
    icon,
    manager,
    createdAt,
    updatedAt,
    packages: dedupeDevBundlePackages(src.packages || [], manager),
  };
}

/**
 * Erstellt die Export-Nutzlast fuer ein einzelnes Dev-Buendel.
 * @param {Record<string, any>} bundle
 */
export function buildExportDevBundlePayload(bundle) {
  return {
    format: DEV_BUNDLE_EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    bundle: normalizeDevBundle(bundle),
  };
}

/**
 * Validiert ein importiertes Einzel-Dev-Buendel-JSON.
 * @param {unknown} raw
 * @returns {{ valid: true, bundle: ReturnType<typeof normalizeDevBundle> } | { valid: false, error: string }}
 */
export function validateImportDevBundlePayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'Invalid JSON format: Dev bundle object expected.' };
  }
  const obj = /** @type {Record<string, any>} */ (raw);

  if (obj.format !== undefined && obj.format !== DEV_BUNDLE_EXPORT_FORMAT) {
    return { valid: false, error: 'Unknown dev bundle export format.' };
  }

  const candidate =
    obj.bundle && typeof obj.bundle === 'object' && !Array.isArray(obj.bundle)
      ? /** @type {Record<string, any>} */ (obj.bundle)
      : obj;

  const name = typeof candidate.name === 'string' ? candidate.name.replace(/[\r\n\0]/g, '').trim() : '';
  if (!name) {
    return { valid: false, error: 'Dev bundle name is missing or empty.' };
  }

  const manager = String(candidate.manager || '')
    .trim()
    .toLowerCase();
  if (!DEV_BUNDLE_MANAGER_SET.has(manager)) {
    return { valid: false, error: `Unsupported dev bundle manager: "${candidate.manager || ''}".` };
  }

  if (!Array.isArray(candidate.packages)) {
    return { valid: false, error: 'Dev bundle does not contain a valid packages array.' };
  }

  for (let i = 0; i < candidate.packages.length; i++) {
    const rawPkg = candidate.packages[i];
    if (!normalizeDevBundlePackage(rawPkg, manager)) {
      return {
        valid: false,
        error: `Package #${i + 1} has an invalid name for ${manager}.`,
      };
    }
  }

  const normalizedPackages = dedupeDevBundlePackages(candidate.packages, manager);
  if (candidate.packages.length > 0 && normalizedPackages.length === 0) {
    return { valid: false, error: 'No valid packages found in the imported dev bundle.' };
  }

  return {
    valid: true,
    bundle: normalizeDevBundle({
      ...candidate,
      name,
      manager,
      packages: normalizedPackages,
    }),
  };
}

/**
 * Validiert Einzel- und Mehrfach-Dev-Buendel-Exporte beim JSON-Import.
 * @param {unknown} raw
 * @returns {{ valid: true, bundles: Array<ReturnType<typeof normalizeDevBundle>> } | { valid: false, error: string }}
 */
export function validateImportDevBundlesPayload(raw) {
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return { valid: false, error: 'JSON file does not contain any dev bundles.' };
    }
    const bundles = [];
    for (let i = 0; i < raw.length; i++) {
      const check = validateImportDevBundlePayload(raw[i]);
      if (!check.valid) {
        return { valid: false, error: `Dev bundle #${i + 1}: ${'error' in check ? check.error : 'Invalid'}` };
      }
      bundles.push(check.bundle);
    }
    return { valid: true, bundles };
  }

  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Invalid JSON format: Dev bundle object expected.' };
  }
  const obj = /** @type {Record<string, any>} */ (raw);

  if (obj.format !== undefined && obj.format !== DEV_BUNDLE_EXPORT_FORMAT && obj.format !== DEV_BUNDLES_EXPORT_FORMAT) {
    return { valid: false, error: 'Unknown dev bundle export format.' };
  }

  if (obj.format === DEV_BUNDLES_EXPORT_FORMAT || Array.isArray(obj.bundles)) {
    if (!Array.isArray(obj.bundles) || obj.bundles.length === 0) {
      return { valid: false, error: 'JSON file does not contain a valid dev bundles list.' };
    }
    const bundles = [];
    for (let i = 0; i < obj.bundles.length; i++) {
      const check = validateImportDevBundlePayload(obj.bundles[i]);
      if (!check.valid) {
        return { valid: false, error: `Dev bundle #${i + 1}: ${'error' in check ? check.error : 'Invalid'}` };
      }
      bundles.push(check.bundle);
    }
    return { valid: true, bundles };
  }

  const single = validateImportDevBundlePayload(obj);
  if (!single.valid) {
    return { valid: false, error: 'error' in single ? single.error : 'Invalid dev bundle.' };
  }
  return { valid: true, bundles: [single.bundle] };
}

/**
 * Loest ID-Kollisionen beim Import eines Dev-Buendels auf.
 * @param {unknown} importedId
 * @param {Set<string> | Iterable<string>} existingIds
 * @param {() => string} generateId
 * @returns {string}
 */
export function resolveImportedDevBundleId(importedId, existingIds, generateId) {
  const used = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  const cleanId = String(importedId || '').trim();
  if (cleanId && !used.has(cleanId)) {
    return cleanId;
  }
  let candidate = String(generateId() || '').trim();
  while (!candidate || used.has(candidate)) {
    candidate = String(generateId() || '').trim();
  }
  return candidate;
}

/**
 * Vergleicht jedes Paket eines Dev-Buendels mit dem Scan des geoeffneten Projekts.
 * @param {Record<string, any>} bundle
 * @param {Record<string, any> | null | undefined} projectScan
 * @param {{ t?: (key: string, params?: Record<string, unknown>) => string }} [options]
 */
export function evaluateDevBundleForProject(bundle, projectScan = null, { t = undefined } = {}) {
  const normalized = normalizeDevBundle(bundle);
  const targetEco = getDevManagerEcosystem(normalized.manager);
  const installedList = Array.isArray(projectScan?.installed) ? projectScan.installed : [];
  const updatesList = Array.isArray(projectScan?.updates) ? projectScan.updates : [];

  const installedExact = new Map();
  const installedEco = new Map();
  for (const pkg of installedList) {
    if (!pkg?.name) continue;
    const mgr = String(pkg.manager || '')
      .trim()
      .toLowerCase();
    const key = normalizeDevBundlePkgKey(normalized.manager, pkg.name);
    if (!key) continue;
    if (mgr === normalized.manager) {
      if (!installedExact.has(key)) installedExact.set(key, pkg);
    } else if (getDevManagerEcosystem(mgr) === targetEco) {
      if (!installedEco.has(key)) installedEco.set(key, pkg);
    }
  }

  const updateExact = new Map();
  const updateEco = new Map();
  for (const upd of updatesList) {
    if (!upd?.name) continue;
    const mgr = String(upd.manager || '')
      .trim()
      .toLowerCase();
    const key = normalizeDevBundlePkgKey(normalized.manager, upd.name);
    if (!key) continue;
    if (mgr === normalized.manager) {
      if (!updateExact.has(key)) updateExact.set(key, upd);
    } else if (getDevManagerEcosystem(mgr) === targetEco) {
      if (!updateEco.has(key)) updateEco.set(key, upd);
    }
  }

  let installedCount = 0;
  let outdatedCount = 0;
  let missingCount = 0;

  const evaluatedPackages = normalized.packages.map((pkg, idx) => {
    const key = normalizeDevBundlePkgKey(normalized.manager, pkg.name);
    const matchedInstalled = installedExact.get(key) || installedEco.get(key) || null;
    const matchedUpdate = updateExact.get(key) || updateEco.get(key) || null;

    const installedVersion = String(matchedInstalled?.installedVersion || '').trim();
    const declaredRange = String(matchedInstalled?.declaredRange || '').trim();
    const installedScope = String(matchedInstalled?.scope || '').trim();

    let status = 'missing';
    let action = 'install';
    let targetVersion = pkg.version || '';
    let wantedVersion = '';
    let latestVersion = '';
    let isMajor = false;

    if (matchedInstalled) {
      const requestedSemver = pkg.version ? extractVersion(pkg.version) : null;
      const installedSemver = installedVersion ? extractVersion(installedVersion) : null;
      const requestedNewerThanInstalled = Boolean(
        requestedSemver && installedSemver && compareVersions(requestedSemver, installedSemver, 3) > 0
      );

      if (matchedUpdate || requestedNewerThanInstalled) {
        status = 'outdated';
        action = 'update';
        wantedVersion = String(matchedUpdate?.wanted || '').trim();
        latestVersion = String(matchedUpdate?.latest || '').trim();
        targetVersion = pkg.version || latestVersion || wantedVersion || '';
        isMajor = Boolean(matchedUpdate?.isMajor);
        outdatedCount++;
      } else {
        status = 'installed';
        action = 'skip';
        targetVersion = '';
        installedCount++;
      }
    } else {
      missingCount++;
    }

    let statusLabel = `⬇️ ${tr(t, 'dev.bundles.statusMissing', {}, 'Missing')}`;
    if (status === 'installed') {
      statusLabel = `✅ ${tr(t, 'dev.bundles.statusInstalled', {}, 'Installed')}`;
    } else if (status === 'outdated') {
      statusLabel = `⬆️ ${tr(t, 'dev.bundles.statusOutdated', {}, 'Outdated')}`;
    }

    return {
      ...pkg,
      order: idx + 1,
      key,
      status,
      action,
      statusLabel,
      installedVersion,
      declaredRange,
      installedScope,
      targetVersion,
      wantedVersion,
      latestVersion,
      isMajor,
      defaultSelected: status !== 'installed' && !pkg.optional,
    };
  });

  const total = evaluatedPackages.length;
  const presentCount = installedCount + outdatedCount;
  const actionableCount = outdatedCount + missingCount;

  const statusText =
    total === 0
      ? tr(t, 'dev.bundles.noPackagesYet', {}, 'No packages yet')
      : tr(
          t,
          'dev.bundles.presentOfTotal',
          { present: presentCount, total },
          `${presentCount} of ${total} packages present in project`
        );

  return {
    bundleId: normalized.id,
    manager: normalized.manager,
    packages: evaluatedPackages,
    summary: {
      total,
      presentCount,
      installedCount,
      outdatedCount,
      missingCount,
      actionableCount,
      statusText,
    },
  };
}

/**
 * Prueft, ob ein Dev-Buendel zu den erkannten Managern des Projekts passt.
 * @param {string} bundleManager
 * @param {string[]} [detectedManagers]
 */
function isDevBundleCompatibleWithManagers(bundleManager, detectedManagers = []) {
  const cleanBundleMgr = String(bundleManager || '')
    .trim()
    .toLowerCase();
  const detected = (Array.isArray(detectedManagers) ? detectedManagers : [])
    .map((m) =>
      String(m || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
  if (detected.length === 0) return true;
  if (detected.includes(cleanBundleMgr)) return true;
  if (detected.includes('yarn') && cleanBundleMgr === 'npm') return true;
  return false;
}

/**
 * Filtert Dev-Buendel fuer die Anzeige im DEV-Workspace-Subtab.
 * @param {Array<Record<string, any>>} [bundles]
 * @param {{ detectedManagers?: string[], showAllManagers?: boolean, query?: string }} [options]
 */
export function filterDevBundlesForProject(
  bundles = [],
  { detectedManagers = [], showAllManagers = false, query = '' } = {}
) {
  const terms = String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  return (Array.isArray(bundles) ? bundles : []).filter((b) => {
    if (!b) return false;
    if (!showAllManagers && !isDevBundleCompatibleWithManagers(b.manager, detectedManagers)) {
      return false;
    }
    if (terms.length === 0) return true;
    const pkgNames = Array.isArray(b.packages) ? b.packages.map((p) => p?.name || '').join(' ') : '';
    const hay = `${b.name || ''} ${b.description || ''} ${b.manager || ''} ${pkgNames}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });
}

/**
 * Erstellt aus den direkten Paketen eines Projekts einen vorausgefuellten Dev-Buendel-Entwurf.
 * @param {{
 *   project?: Record<string, any> | null,
 *   scan?: Record<string, any> | null,
 *   manager?: string,
 *   includeProd?: boolean,
 *   includeDev?: boolean,
 *   includeOptional?: boolean,
 *   pinVersions?: boolean,
 *   name?: string,
 *   description?: string,
 *   icon?: string,
 *   t?: (key: string, params?: Record<string, unknown>) => string,
 * }} [options]
 */
export function buildDevBundleDraftFromProject({
  project = null,
  scan = null,
  manager = '',
  includeProd = true,
  includeDev = true,
  includeOptional = false,
  pinVersions = false,
  name = '',
  description = '',
  icon = '📸',
  t = undefined,
} = {}) {
  const rawInstalled = Array.isArray(scan?.installed) ? scan.installed : [];
  const rawManagers = Array.isArray(scan?.managers) ? scan.managers : [];

  const availableSet = new Set();
  for (const m of rawManagers) {
    const clean = String(m || '')
      .trim()
      .toLowerCase();
    const mapped = clean === 'yarn' ? 'npm' : clean;
    if (DEV_BUNDLE_MANAGER_SET.has(mapped)) availableSet.add(mapped);
  }
  for (const pkg of rawInstalled) {
    const clean = String(pkg?.manager || '')
      .trim()
      .toLowerCase();
    const mapped = clean === 'yarn' ? 'npm' : clean;
    if (DEV_BUNDLE_MANAGER_SET.has(mapped)) availableSet.add(mapped);
  }

  const availableManagers = [...availableSet];
  const requestedMgr = String(manager || '')
    .trim()
    .toLowerCase();
  const mappedRequested = requestedMgr === 'yarn' ? 'npm' : requestedMgr;
  const effectiveManager = DEV_BUNDLE_MANAGER_SET.has(mappedRequested)
    ? mappedRequested
    : availableManagers[0] || 'npm';
  const effectiveEco = getDevManagerEcosystem(effectiveManager);

  const matchingInstalled = rawInstalled.filter((pkg) => {
    const mgr = String(pkg?.manager || '')
      .trim()
      .toLowerCase();
    if (mgr === effectiveManager) return true;
    return getDevManagerEcosystem(mgr) === effectiveEco;
  });

  const packages = [];
  const seen = new Set();
  let prodCount = 0;
  let devCount = 0;
  let optionalCount = 0;

  for (const pkg of matchingInstalled) {
    const scope = String(pkg?.scope || 'prod')
      .trim()
      .toLowerCase();
    const isDev = scope === 'dev';
    const isOptional = scope === 'optional';
    if (isDev && !includeDev) continue;
    if (isOptional && !includeOptional) continue;
    if (!isDev && !isOptional && !includeProd) continue;

    const cleanName = String(pkg?.name || '').trim();
    if (!cleanName || !isValidDevPackageName(effectiveManager, cleanName)) continue;
    const key = normalizeDevBundlePkgKey(effectiveManager, cleanName);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    let version = '';
    if (pinVersions) {
      const candidateVer = String(pkg?.installedVersion || pkg?.declaredRange || '').trim();
      if (candidateVer && isValidDevVersionSpec(candidateVer)) {
        version = candidateVer;
      }
    }

    if (isDev) devCount++;
    else if (isOptional) optionalCount++;
    else prodCount++;

    packages.push({
      name: cleanName,
      version,
      isDev,
      optional: isOptional,
    });
  }

  packages.sort((a, b) => Number(a.isDev) - Number(b.isDev) || a.name.localeCompare(b.name));

  const projectName = String(project?.name || '').trim() || 'Project';
  const resolvedName =
    String(name || '').trim() ||
    tr(t, 'dev.bundleEditor.snapshotDefaultName', { project: projectName }, `${projectName} Stack`);
  const resolvedDesc =
    String(description || '').trim() ||
    tr(
      t,
      'dev.bundleEditor.snapshotDefaultDesc',
      { project: projectName, manager: effectiveManager },
      `Snapshot created from project ${projectName} (${effectiveManager}).`
    );

  return {
    draft: {
      id: '',
      name: resolvedName,
      description: resolvedDesc,
      icon: String(icon || '').trim() || '📸',
      manager: effectiveManager,
      packages,
    },
    manager: effectiveManager,
    totalCount: packages.length,
    prodCount,
    devCount,
    optionalCount,
    availableManagers,
  };
}

/**
 * Normalisiert Schweregrade aus npm/pnpm/Composer Audits auf `critical | high | moderate | low`.
 * @param {unknown} raw
 * @returns {'critical' | 'high' | 'moderate' | 'low'}
 */
function normalizeAuditSeverity(raw) {
  const low = String(raw || '')
    .trim()
    .toLowerCase();
  if (low === 'critical') return 'critical';
  if (low === 'high') return 'high';
  if (low === 'moderate' || low === 'medium') return 'moderate';
  if (low === 'low' || low === 'info') return 'low';
  return 'moderate';
}

function extractAuditJsonObject(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = cleanCliLines(rawText.replace(/^\uFEFF/, ''))
    .join('\n')
    .trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace <= firstBrace) return null;
    try {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    } catch {
      return null;
    }
  }
}

function buildEmptyAuditCounts() {
  return { critical: 0, high: 0, moderate: 0, low: 0, total: 0 };
}

function tallyAuditCounts(vulnerabilities) {
  const counts = buildEmptyAuditCounts();
  for (const v of vulnerabilities) {
    const sev = normalizeAuditSeverity(v.severity);
    counts[sev] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * Parst `npm audit --json` (v7+ `vulnerabilities` & v6/pnpm `advisories`).
 * @param {string} rawText
 * @param {{ manager?: string }} [options]
 */
export function parseNpmAuditJson(rawText, { manager = 'npm' } = {}) {
  const parsed = extractAuditJsonObject(rawText);
  const canAutoFix = manager === 'npm';
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      valid: false,
      manager,
      counts: buildEmptyAuditCounts(),
      vulnerabilities: [],
      abandoned: [],
      canAutoFix,
    };
  }

  /** @type {Array<Record<string, any>>} */
  const vulnerabilities = [];

  if (parsed.vulnerabilities && typeof parsed.vulnerabilities === 'object' && !Array.isArray(parsed.vulnerabilities)) {
    for (const [pkgKey, entry] of Object.entries(parsed.vulnerabilities)) {
      if (!entry || typeof entry !== 'object') continue;
      const packageName = String(entry.name || pkgKey || '').trim();
      if (!packageName) continue;

      const severity = normalizeAuditSeverity(entry.severity);
      const viaList = Array.isArray(entry.via) ? entry.via : [];
      const advisoryObjs = viaList.filter((v) => v && typeof v === 'object');
      const viaNames = viaList.filter((v) => typeof v === 'string').map((v) => v.trim());

      const primaryAdv = advisoryObjs[0] || null;
      const title =
        advisoryObjs
          .map((a) => String(a.title || '').trim())
          .filter(Boolean)
          .join(' / ') ||
        (viaNames.length > 0 ? `Transitive via ${viaNames.join(', ')}` : `Vulnerability in ${packageName}`);
      const url = String(primaryAdv?.url || '').trim();
      const range = String(primaryAdv?.range || entry.range || '').trim();
      const fixRaw = entry.fixAvailable;
      const fixAvailable = Boolean(fixRaw);
      const fixIsMajor = Boolean(fixRaw && typeof fixRaw === 'object' && fixRaw.isSemVerMajor);

      vulnerabilities.push({
        manager,
        packageName,
        severity,
        title,
        url,
        cve: '',
        affectedVersions: range,
        isDirect: Boolean(entry.isDirect),
        fixAvailable,
        fixIsMajor,
        via: viaNames,
      });
    }
  } else if (parsed.advisories && typeof parsed.advisories === 'object') {
    for (const adv of Object.values(parsed.advisories)) {
      if (!adv || typeof adv !== 'object') continue;
      const packageName = String(adv.module_name || adv.name || '').trim();
      if (!packageName) continue;
      const cves = Array.isArray(adv.cves) ? adv.cves.filter(Boolean) : [];
      const patched = String(adv.patched_versions || '').trim();
      vulnerabilities.push({
        manager,
        packageName,
        severity: normalizeAuditSeverity(adv.severity),
        title: String(adv.title || adv.overview || `Vulnerability in ${packageName}`).trim(),
        url: String(adv.url || '').trim(),
        cve: cves[0] ? String(cves[0]).trim() : '',
        affectedVersions: String(adv.vulnerable_versions || '').trim(),
        isDirect: true,
        fixAvailable: Boolean(patched && patched !== '<0.0.0'),
        fixIsMajor: false,
        via: [],
      });
    }
  } else if (!parsed.metadata && !parsed.auditReportVersion) {
    return {
      valid: false,
      manager,
      counts: buildEmptyAuditCounts(),
      vulnerabilities: [],
      abandoned: [],
      canAutoFix,
    };
  }

  vulnerabilities.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.packageName.localeCompare(b.packageName)
  );

  return {
    valid: true,
    manager,
    counts: tallyAuditCounts(vulnerabilities),
    vulnerabilities,
    abandoned: [],
    canAutoFix,
  };
}

/**
 * Parst `composer audit --format=json` inkl. Advisories & verlassener Pakete (`abandoned`).
 * @param {string} rawText
 */
export function parseComposerAuditJson(rawText) {
  const parsed = extractComposerJson(rawText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      valid: false,
      manager: 'composer',
      counts: buildEmptyAuditCounts(),
      vulnerabilities: [],
      abandoned: [],
      canAutoFix: true,
    };
  }

  const vulnerabilities = [];
  const rawAdvisories = parsed.advisories;

  if (rawAdvisories && typeof rawAdvisories === 'object') {
    const groups = Array.isArray(rawAdvisories)
      ? rawAdvisories.map((adv) => [String(adv?.packageName || '').trim(), [adv]])
      : Object.entries(rawAdvisories);

    for (const [pkgKey, listOrObj] of groups) {
      const items = Array.isArray(listOrObj)
        ? listOrObj
        : listOrObj && typeof listOrObj === 'object'
          ? [listOrObj]
          : [];
      for (const adv of items) {
        if (!adv || typeof adv !== 'object') continue;
        const packageName = String(adv.packageName || pkgKey || '').trim();
        if (!packageName) continue;
        vulnerabilities.push({
          manager: 'composer',
          packageName,
          severity: normalizeAuditSeverity(adv.severity),
          title: String(adv.title || `Advisory ${adv.advisoryId || ''}`).trim(),
          url: String(adv.link || adv.url || '').trim(),
          cve: String(adv.cve || adv.advisoryId || '').trim(),
          affectedVersions: String(adv.affectedVersions || '').trim(),
          isDirect: true,
          fixAvailable: true,
          fixIsMajor: false,
          via: [],
        });
      }
    }
  }

  const abandoned = [];
  if (parsed.abandoned && typeof parsed.abandoned === 'object' && !Array.isArray(parsed.abandoned)) {
    for (const [pkgName, replacement] of Object.entries(parsed.abandoned)) {
      const cleanName = String(pkgName || '').trim();
      if (!cleanName) continue;
      abandoned.push({
        packageName: cleanName,
        replacement: typeof replacement === 'string' ? replacement.trim() : '',
      });
    }
  }

  vulnerabilities.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.packageName.localeCompare(b.packageName)
  );

  return {
    valid: true,
    manager: 'composer',
    counts: tallyAuditCounts(vulnerabilities),
    vulnerabilities,
    abandoned,
    canAutoFix: true,
  };
}

/**
 * Fuehrt Audit-Berichte mehrerer Paketmanager eines Projekts zusammen.
 * @param {Array<ReturnType<typeof parseNpmAuditJson>>} [reports]
 */
export function mergeDevAuditReports(reports = []) {
  const managers = [];
  const vulnerabilities = [];
  const abandoned = [];
  const fixableManagers = [];

  for (const rep of Array.isArray(reports) ? reports : []) {
    if (!rep?.valid) continue;
    managers.push(rep.manager);
    vulnerabilities.push(...(rep.vulnerabilities || []));
    abandoned.push(...(rep.abandoned || []));
    if (rep.canAutoFix && (rep.counts?.total || 0) > 0) {
      fixableManagers.push(rep.manager);
    }
  }

  vulnerabilities.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.packageName.localeCompare(b.packageName)
  );

  return {
    managers,
    counts: tallyAuditCounts(vulnerabilities),
    vulnerabilities,
    abandoned,
    fixableManagers,
    canAutoFix: fixableManagers.length > 0,
  };
}
