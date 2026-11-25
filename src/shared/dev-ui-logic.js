export const DEV_SEARCH_MANAGERS = Object.freeze([
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

export const DEV_PROJECT_EMOJI_PRESETS = Object.freeze(['🛠️', '⚡', '🌐', '💻', '📦', '🚀', '🐍', '🐘', '🦀', '🎯']);

const DEV_MANAGER_META = Object.freeze({
  npm: {
    id: 'npm',
    label: 'npm',
    badgeClass: 'is-npm',
    supportsDevScope: true,
    supportsToggleScope: true,
    supportsUninstall: true,
  },
  pnpm: {
    id: 'pnpm',
    label: 'pnpm',
    badgeClass: 'is-pnpm',
    supportsDevScope: true,
    supportsToggleScope: true,
    supportsUninstall: true,
  },
  bun: {
    id: 'bun',
    label: 'Bun',
    badgeClass: 'is-bun',
    supportsDevScope: true,
    supportsToggleScope: true,
    supportsUninstall: true,
  },
  yarn: {
    id: 'yarn',
    label: 'Yarn',
    badgeClass: 'is-yarn',
    supportsDevScope: true,
    supportsToggleScope: true,
    supportsUninstall: true,
  },
  composer: {
    id: 'composer',
    label: 'Composer',
    badgeClass: 'is-composer',
    supportsDevScope: true,
    supportsToggleScope: true,
    supportsUninstall: true,
  },
  uv: {
    id: 'uv',
    label: 'uv',
    badgeClass: 'is-uv',
    supportsDevScope: true,
    supportsToggleScope: true,
    supportsUninstall: true,
  },
  pip: {
    id: 'pip',
    label: 'Python (pip)',
    badgeClass: 'is-pip',
    supportsDevScope: false,
    supportsToggleScope: false,
    supportsUninstall: true,
  },
  cargo: {
    id: 'cargo',
    label: 'Cargo',
    badgeClass: 'is-cargo',
    supportsDevScope: true,
    supportsToggleScope: true,
    supportsUninstall: true,
  },
  dotnet: {
    id: 'dotnet',
    label: 'NuGet (.NET)',
    badgeClass: 'is-dotnet',
    supportsDevScope: false,
    supportsToggleScope: false,
    supportsUninstall: true,
  },
  vcpkg: {
    id: 'vcpkg',
    label: 'vcpkg',
    badgeClass: 'is-vcpkg',
    supportsDevScope: false,
    supportsToggleScope: false,
    supportsUninstall: false,
  },
});

/**
 * Extracts the final folder name from a Windows or POSIX directory path without Node builtins.
 * @param {unknown} rawPath
 * @returns {string}
 */
export function getProjectFolderBaseName(rawPath) {
  const clean = String(rawPath || '')
    .trim()
    .replace(/[\\/]+$/, '');
  if (!clean) return '';
  if (/^[A-Za-z]:$/.test(clean)) return clean;
  const parts = clean.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : clean;
}

/**
 * Shortens long project paths in the middle while preserving root and final segments.
 * @param {unknown} rawPath
 * @param {number} [maxLen]
 * @returns {string}
 */
export function shortenProjectPath(rawPath, maxLen = 46) {
  const clean = String(rawPath || '').trim();
  if (!clean || clean.length <= maxLen) return clean;

  const sep = clean.includes('\\') && !clean.includes('/') ? '\\' : '/';
  const isUnc = clean.startsWith('\\\\');
  const isPosixRoot = clean.startsWith('/');
  const segments = clean.split(/[\\/]+/).filter(Boolean);
  if (segments.length <= 2) {
    const keepHead = Math.max(8, Math.floor((maxLen - 3) / 2));
    const keepTail = Math.max(8, maxLen - 3 - keepHead);
    return `${clean.slice(0, keepHead)}...${clean.slice(-keepTail)}`;
  }

  const prefix = isUnc ? `\\\\${segments[0]}` : isPosixRoot ? `/${segments[0]}` : segments[0];
  const lastTwo = segments.slice(-2).join(sep);
  const candidateTwo = `${prefix}${sep}...${sep}${lastTwo}`;
  if (candidateTwo.length <= maxLen) return candidateTwo;

  const lastOne = segments[segments.length - 1];
  const candidateOne = `${prefix}${sep}...${sep}${lastOne}`;
  if (candidateOne.length <= maxLen) return candidateOne;

  const availableTail = Math.max(8, maxLen - prefix.length - 5);
  return `${prefix}${sep}...${lastOne.slice(-availableTail)}`;
}

/**
 * Returns display and capability metadata for a dev package manager.
 * @param {unknown} manager
 */
export function getDevManagerMeta(manager) {
  const id = String(manager || '')
    .trim()
    .toLowerCase();
  if (id && DEV_MANAGER_META[id]) {
    return DEV_MANAGER_META[id];
  }
  return {
    id: id || 'unknown',
    label: id || 'unknown',
    badgeClass: id ? `is-${id}` : '',
    supportsDevScope: false,
    supportsToggleScope: false,
    supportsUninstall: true,
  };
}

/**
 * Orders detected project managers first, followed by all other supported dev package managers.
 * @param {string[]} [detectedManagers]
 */
export function getOrderedSearchManagers(detectedManagers = []) {
  const detectedClean = [];
  const seen = new Set();
  for (const raw of Array.isArray(detectedManagers) ? detectedManagers : []) {
    const id = String(raw || '')
      .trim()
      .toLowerCase();
    if (!id || seen.has(id) || !DEV_MANAGER_META[id]) continue;
    seen.add(id);
    const meta = getDevManagerMeta(id);
    detectedClean.push({ ...meta, detected: true });
  }

  const remaining = [];
  for (const id of DEV_SEARCH_MANAGERS) {
    if (seen.has(id)) continue;
    seen.add(id);
    const meta = getDevManagerMeta(id);
    remaining.push({ ...meta, detected: false });
  }

  return [...detectedClean, ...remaining];
}

/**
 * Builds a unique key for a dev update item.
 * @param {{ manager?: unknown, name?: unknown } | null | undefined} upd
 * @returns {string}
 */
export function buildDevUpdateKey(upd) {
  const mgr = String(upd?.manager || '')
    .trim()
    .toLowerCase();
  const name = String(upd?.name || '')
    .trim()
    .toLowerCase();
  return `${mgr}:${name}`;
}

/**
 * Returns true if the update entry has a non-major compatible target version (`wanted`).
 * @param {Record<string, any> | null | undefined} upd
 * @returns {boolean}
 */
export function isCompatibleDevUpdate(upd) {
  if (!upd || typeof upd !== 'object') return false;
  const current = String(upd.current || '').trim();
  const wanted = String(upd.wanted || '').trim();
  return Boolean(upd.hasWantedUpdate && wanted && wanted !== current);
}

/**
 * Filters a list of updates down to compatible (`wanted`) updates.
 * @param {Array<Record<string, any>>} [updates]
 */
export function getCompatibleDevUpdates(updates = []) {
  return (Array.isArray(updates) ? updates : []).filter((upd) => isCompatibleDevUpdate(upd));
}

/**
 * Summarizes cached scan data for project overview cards and workspace headers.
 * @param {Record<string, any> | null | undefined} scan
 */
export function summarizeDevProjectScan(scan) {
  if (!scan || typeof scan !== 'object') {
    return {
      hasScan: false,
      hasCheckedUpdates: false,
      managers: [],
      directCount: 0,
      depsCount: 0,
      updatesCount: 0,
      compatibleUpdatesCount: 0,
      majorUpdatesCount: 0,
      unavailable: false,
      error: '',
    };
  }

  const managers = Array.isArray(scan.managers) ? scan.managers : [];
  const installed = Array.isArray(scan.installed) ? scan.installed : [];
  const dependencies = Array.isArray(scan.dependencies) ? scan.dependencies : [];
  const updates = Array.isArray(scan.updates) ? scan.updates : [];
  const compatibleUpdatesCount = getCompatibleDevUpdates(updates).length;
  const majorUpdatesCount = updates.filter((u) => Boolean(u?.isMajor)).length;

  return {
    hasScan: Boolean(scan.success || managers.length > 0 || installed.length > 0 || dependencies.length > 0),
    hasCheckedUpdates: Boolean(scan.hasCheckedUpdates),
    managers,
    directCount: installed.length,
    depsCount: dependencies.length,
    updatesCount: updates.length,
    compatibleUpdatesCount,
    majorUpdatesCount,
    unavailable: Boolean(scan.unavailable),
    error: String(scan.error || ''),
  };
}

function splitQueryTerms(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

function matchesAllTerms(haystack, terms) {
  if (terms.length === 0) return true;
  const lower = String(haystack || '').toLowerCase();
  return terms.every((term) => lower.includes(term));
}

/**
 * Filters linked dev projects by name, path, notes, or detected managers.
 * @param {Array<Record<string, any>>} [projects]
 * @param {string} [query]
 * @param {Record<string, any>} [scanByProjectId]
 */
export function filterDevProjects(projects = [], query = '', scanByProjectId = {}) {
  const list = Array.isArray(projects) ? projects : [];
  const terms = splitQueryTerms(query);
  if (terms.length === 0) return list;

  return list.filter((proj) => {
    const scan = proj?.id ? scanByProjectId?.[proj.id] : null;
    const mgrs = Array.isArray(scan?.managers) ? scan.managers.join(' ') : '';
    const hay = `${proj?.name || ''} ${proj?.path || ''} ${proj?.notes || ''} ${mgrs}`;
    return matchesAllTerms(hay, terms);
  });
}

/**
 * Filters outdated project packages by manager chip and search query.
 * @param {Array<Record<string, any>>} [updates]
 * @param {{ managerFilter?: string, query?: string }} [options]
 */
export function filterDevUpdates(updates = [], { managerFilter = 'all', query = '' } = {}) {
  const mgrFilter = String(managerFilter || 'all')
    .trim()
    .toLowerCase();
  const terms = splitQueryTerms(query);

  return (Array.isArray(updates) ? updates : []).filter((upd) => {
    if (!upd) return false;
    if (
      mgrFilter !== 'all' &&
      String(upd.manager || '')
        .trim()
        .toLowerCase() !== mgrFilter
    ) {
      return false;
    }
    return matchesAllTerms(
      `${upd.name || ''} ${upd.manager || ''} ${upd.current || ''} ${upd.wanted || ''} ${upd.latest || ''} ${upd.description || ''}`,
      terms
    );
  });
}

/**
 * Filters direct project packages by manager chip, scope (`all` | `prod` | `dev`), and query.
 * @param {Array<Record<string, any>>} [installed]
 * @param {{ managerFilter?: string, scopeFilter?: string, query?: string }} [options]
 */
export function filterDevInstalled(installed = [], { managerFilter = 'all', scopeFilter = 'all', query = '' } = {}) {
  const mgrFilter = String(managerFilter || 'all')
    .trim()
    .toLowerCase();
  const scope = String(scopeFilter || 'all')
    .trim()
    .toLowerCase();
  const terms = splitQueryTerms(query);

  return (Array.isArray(installed) ? installed : []).filter((pkg) => {
    if (!pkg) return false;
    if (
      mgrFilter !== 'all' &&
      String(pkg.manager || '')
        .trim()
        .toLowerCase() !== mgrFilter
    ) {
      return false;
    }
    const pkgScope = String(pkg.scope || 'prod').toLowerCase();
    if (scope === 'prod' && pkgScope === 'dev') return false;
    if (scope === 'dev' && pkgScope !== 'dev') return false;

    return matchesAllTerms(
      `${pkg.name || ''} ${pkg.manager || ''} ${pkg.declaredRange || ''} ${pkg.installedVersion || ''} ${pkg.description || ''}`,
      terms
    );
  });
}

/**
 * Filters lockfile dependencies by manager chip, direct/transitive filter, and query (incl. requiredBy & license).
 * @param {Array<Record<string, any>>} [dependencies]
 * @param {{ managerFilter?: string, directFilter?: string, query?: string }} [options]
 */
export function filterDevDependencies(
  dependencies = [],
  { managerFilter = 'all', directFilter = 'all', query = '' } = {}
) {
  const mgrFilter = String(managerFilter || 'all')
    .trim()
    .toLowerCase();
  const dirMode = String(directFilter || 'all')
    .trim()
    .toLowerCase();
  const terms = splitQueryTerms(query);

  return (Array.isArray(dependencies) ? dependencies : []).filter((dep) => {
    if (!dep) return false;
    if (
      mgrFilter !== 'all' &&
      String(dep.manager || '')
        .trim()
        .toLowerCase() !== mgrFilter
    ) {
      return false;
    }
    if (dirMode === 'direct' && !dep.direct) return false;
    if (dirMode === 'transitive' && dep.direct) return false;

    const reqBy = Array.isArray(dep.requiredBy) ? dep.requiredBy.join(' ') : '';
    return matchesAllTerms(
      `${dep.name || ''} ${dep.manager || ''} ${dep.version || ''} ${dep.license || ''} ${reqBy}`,
      terms
    );
  });
}
