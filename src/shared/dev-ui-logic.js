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
    const reqs = Array.isArray(dep.requires) ? dep.requires.join(' ') : '';
    return matchesAllTerms(
      `${dep.name || ''} ${dep.manager || ''} ${dep.version || ''} ${dep.license || ''} ${reqBy} ${reqs}`,
      terms
    );
  });
}

function buildDepNodeKey(manager, name) {
  return `${String(manager || '')
    .trim()
    .toLowerCase()}:${String(name || '')
    .trim()
    .toLowerCase()}`;
}

/**
 * Erzeugt einen aufklappbaren Abhaengigkeitsbaum (CMD-/tree-Stil) mit sicherem Zyklus-Schutz (`visited`-Set).
 * @param {Array<Record<string, any>>} [dependencies]
 * @param {{ managerFilter?: string, directFilter?: string, query?: string, maxNodes?: number }} [options]
 */
export function buildDevDependencyTree(
  dependencies = [],
  { managerFilter = 'all', directFilter = 'all', query = '', maxNodes = 2500 } = {}
) {
  const allList = Array.isArray(dependencies) ? dependencies.filter(Boolean) : [];
  const mgrFilter = String(managerFilter || 'all')
    .trim()
    .toLowerCase();
  const dirMode = String(directFilter || 'all')
    .trim()
    .toLowerCase();
  const hasSearch = Boolean(String(query || '').trim());

  const mgrScoped =
    mgrFilter === 'all'
      ? allList
      : allList.filter(
          (d) =>
            String(d.manager || '')
              .trim()
              .toLowerCase() === mgrFilter
        );

  const byNodeKey = new Map();
  for (const dep of mgrScoped) {
    const key = buildDepNodeKey(dep.manager, dep.name);
    if (!byNodeKey.has(key)) byNodeKey.set(key, dep);
  }

  const matchedKeys = new Set(
    filterDevDependencies(mgrScoped, { managerFilter: 'all', directFilter, query }).map((d) =>
      buildDepNodeKey(d.manager, d.name)
    )
  );

  let roots = mgrScoped.filter((d) => d.direct);
  if (roots.length === 0) {
    roots = mgrScoped.filter((d) => !Array.isArray(d.requiredBy) || d.requiredBy.length === 0);
  }
  if (dirMode === 'transitive' && !hasSearch) {
    // Auch im Transitive-Filter ueber direkte Roots starten, sofern mindestens ein Transitiv-Knoten passt
    const withTransitive = roots.filter((r) => Array.isArray(r.requires) && r.requires.length > 0);
    if (withTransitive.length > 0) roots = withTransitive;
  }
  roots = [...roots].sort((a, b) => a.name.localeCompare(b.name));

  let nodeCounter = 0;
  let truncated = false;

  const visit = (dep, parentPathKey, pathVisited, depth) => {
    const nodeKey = buildDepNodeKey(dep.manager, dep.name);
    const pathKey = parentPathKey ? `${parentPathKey}>${nodeKey}` : nodeKey;
    const isMatched = matchedKeys.has(nodeKey);

    if (pathVisited.has(nodeKey)) {
      return {
        node: {
          nodeKey,
          pathKey: `${pathKey}#cycle`,
          manager: dep.manager,
          name: dep.name,
          version: dep.version || '',
          scope: dep.scope || 'prod',
          direct: Boolean(dep.direct),
          license: dep.license || '',
          homepage: dep.homepage || '',
          cyclic: true,
          missing: false,
          matched: isMatched,
          children: [],
        },
        hasMatchInSubtree: isMatched,
      };
    }

    if (nodeCounter >= maxNodes || depth > 24) {
      truncated = true;
      return null;
    }
    nodeCounter += 1;

    const nextVisited = new Set(pathVisited);
    nextVisited.add(nodeKey);

    const rawReqs = Array.isArray(dep.requires) ? [...dep.requires].sort((a, b) => a.localeCompare(b)) : [];
    const children = [];
    let childSubtreeMatched = false;

    for (const reqName of rawReqs) {
      const childKey = buildDepNodeKey(dep.manager, reqName);
      const targetDep = byNodeKey.get(childKey);
      if (!targetDep) {
        const missingMatched = !hasSearch && dirMode === 'all';
        if (missingMatched || isMatched) {
          children.push({
            nodeKey: childKey,
            pathKey: `${pathKey}>${childKey}`,
            manager: dep.manager,
            name: reqName,
            version: '',
            scope: 'prod',
            direct: false,
            license: '',
            homepage: '',
            cyclic: false,
            missing: true,
            matched: false,
            children: [],
          });
        }
        continue;
      }
      const built = visit(targetDep, pathKey, nextVisited, depth + 1);
      if (!built) continue;
      if (built.hasMatchInSubtree) childSubtreeMatched = true;
      if (!hasSearch && dirMode === 'all') {
        children.push(built.node);
      } else if (built.hasMatchInSubtree) {
        children.push(built.node);
      }
    }

    const hasMatchInSubtree = isMatched || childSubtreeMatched;
    return {
      node: {
        nodeKey,
        pathKey,
        manager: dep.manager,
        name: dep.name,
        version: dep.version || '',
        scope: dep.scope || 'prod',
        direct: Boolean(dep.direct),
        license: dep.license || '',
        homepage: dep.homepage || '',
        cyclic: false,
        missing: false,
        matched: isMatched,
        children,
      },
      hasMatchInSubtree,
    };
  };

  const treeRoots = [];
  for (const rootDep of roots) {
    const built = visit(rootDep, '', new Set(), 0);
    if (!built) break;
    if (!hasSearch && dirMode === 'all') {
      treeRoots.push(built.node);
    } else if (built.hasMatchInSubtree) {
      treeRoots.push(built.node);
    }
  }

  return {
    roots: treeRoots,
    truncated,
    totalVisited: nodeCounter,
  };
}

/**
 * Erzeugt ein ebenenbasiertes Flussdiagramm (Projekt -> Direkte Pakete -> Ebene 2..N) fuer den nativen SVG-Graph.
 * Begrenzt grosse Graphen auf `maxNodes` und unterstuetzt Fokus-Filter auf ein direktes Paket.
 * @param {Array<Record<string, any>>} [dependencies]
 * @param {{
 *   projectName?: string,
 *   managerFilter?: string,
 *   directFilter?: string,
 *   query?: string,
 *   focusNodeKey?: string,
 *   maxNodes?: number,
 * }} [options]
 */
export function buildDevDependencyGraph(
  dependencies = [],
  {
    projectName = 'Projekt',
    managerFilter = 'all',
    directFilter = 'all',
    query = '',
    focusNodeKey = '',
    maxNodes = 80,
  } = {}
) {
  const allList = Array.isArray(dependencies) ? dependencies.filter(Boolean) : [];
  const mgrFilter = String(managerFilter || 'all')
    .trim()
    .toLowerCase();
  const mgrScoped =
    mgrFilter === 'all'
      ? allList
      : allList.filter(
          (d) =>
            String(d.manager || '')
              .trim()
              .toLowerCase() === mgrFilter
        );

  const byKey = new Map();
  for (const dep of mgrScoped) {
    const key = buildDepNodeKey(dep.manager, dep.name);
    if (!byKey.has(key)) byKey.set(key, dep);
  }

  const directCandidates = mgrScoped
    .filter((d) => d.direct)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({
      nodeKey: buildDepNodeKey(d.manager, d.name),
      name: d.name,
      manager: d.manager,
      version: d.version || '',
    }));

  const filtered = filterDevDependencies(mgrScoped, { managerFilter: 'all', directFilter, query });
  const totalFilteredCount = filtered.length;
  const normalizedFocus = String(focusNodeKey || '')
    .trim()
    .toLowerCase();

  /** @type {Set<string>} */
  const includedKeys = new Set();

  if (normalizedFocus && byKey.has(normalizedFocus)) {
    const queue = [normalizedFocus];
    includedKeys.add(normalizedFocus);
    const focusDep = byKey.get(normalizedFocus);
    // Direkte Eltern (requiredBy) des Fokusknotens mit einbeziehen
    for (const parentName of Array.isArray(focusDep?.requiredBy) ? focusDep.requiredBy : []) {
      const pKey = buildDepNodeKey(focusDep.manager, parentName);
      if (byKey.has(pKey) && includedKeys.size < maxNodes) {
        includedKeys.add(pKey);
      }
    }
    while (queue.length > 0 && includedKeys.size < maxNodes) {
      const currKey = queue.shift();
      const currDep = currKey ? byKey.get(currKey) : null;
      if (!currDep) continue;
      for (const reqName of Array.isArray(currDep.requires) ? currDep.requires : []) {
        const nextKey = buildDepNodeKey(currDep.manager, reqName);
        if (byKey.has(nextKey) && !includedKeys.has(nextKey) && includedKeys.size < maxNodes) {
          includedKeys.add(nextKey);
          queue.push(nextKey);
        }
      }
    }
  } else {
    const sortedFiltered = [...filtered].sort(
      (a, b) => Number(Boolean(b.direct)) - Number(Boolean(a.direct)) || a.name.localeCompare(b.name)
    );
    for (const dep of sortedFiltered) {
      if (includedKeys.size >= maxNodes) break;
      includedKeys.add(buildDepNodeKey(dep.manager, dep.name));
    }
  }

  // BFS fuer saubere Ebenen ab Projekt-Wurzel (0 -> 1 Direkte -> 2..N Transitiv)
  const ROOT_ID = '__project__';
  /** @type {Map<string, number>} */
  const levelMap = new Map();
  const bfsQueue = [];

  for (const key of includedKeys) {
    const dep = byKey.get(key);
    if (dep?.direct || key === normalizedFocus) {
      levelMap.set(key, 1);
      bfsQueue.push(key);
    }
  }
  if (bfsQueue.length === 0) {
    for (const key of includedKeys) {
      const dep = byKey.get(key);
      const hasParentInSet = (Array.isArray(dep?.requiredBy) ? dep.requiredBy : []).some((p) =>
        includedKeys.has(buildDepNodeKey(dep.manager, p))
      );
      if (!hasParentInSet) {
        levelMap.set(key, 1);
        bfsQueue.push(key);
      }
    }
  }

  while (bfsQueue.length > 0) {
    const currKey = bfsQueue.shift();
    const currLevel = levelMap.get(currKey) || 1;
    const dep = byKey.get(currKey);
    if (!dep) continue;
    for (const reqName of Array.isArray(dep.requires) ? dep.requires : []) {
      const nextKey = buildDepNodeKey(dep.manager, reqName);
      if (!includedKeys.has(nextKey) || levelMap.has(nextKey)) continue;
      levelMap.set(nextKey, currLevel + 1);
      bfsQueue.push(nextKey);
    }
  }

  // Verbleibende isolierte Knoten auf Ebene 2 (oder 1) platzieren
  for (const key of includedKeys) {
    if (!levelMap.has(key)) {
      const dep = byKey.get(key);
      levelMap.set(key, dep?.direct ? 1 : 2);
    }
  }

  /** @type {Map<number, Array<{ id: string, kind: 'project' | 'package', dep?: any }>>} */
  const columns = new Map();
  columns.set(0, [{ id: ROOT_ID, kind: 'project' }]);
  let maxLevel = 0;

  for (const key of includedKeys) {
    const lvl = levelMap.get(key) || 1;
    if (lvl > maxLevel) maxLevel = lvl;
    if (!columns.has(lvl)) columns.set(lvl, []);
    columns.get(lvl).push({ id: key, kind: 'package', dep: byKey.get(key) });
  }

  for (const [lvl, colItems] of columns.entries()) {
    if (lvl === 0) continue;
    colItems.sort((a, b) => String(a.dep?.name || '').localeCompare(String(b.dep?.name || '')));
  }

  const NODE_W = 192;
  const NODE_H = 48;
  const COL_GAP = 250;
  const ROW_GAP = 64;
  const PAD_X = 36;
  const PAD_Y = 36;

  let maxColSize = 1;
  for (const colItems of columns.values()) {
    if (colItems.length > maxColSize) maxColSize = colItems.length;
  }

  const totalHeight = Math.max(260, PAD_Y * 2 + maxColSize * ROW_GAP);
  const totalWidth = Math.max(540, PAD_X * 2 + (maxLevel + 1) * NODE_W + maxLevel * (COL_GAP - NODE_W));

  /** @type {Array<{ id: string, kind: 'project' | 'package', name: string, manager: string, version: string, license: string, direct: boolean, scope: string, level: number, x: number, y: number, w: number, h: number, requiredBy: string[], requires: string[] }>} */
  const nodes = [];
  const nodeById = new Map();

  for (const [lvl, colItems] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const colHeight = colItems.length * ROW_GAP - (ROW_GAP - NODE_H);
    const startY = Math.max(PAD_Y, Math.round((totalHeight - colHeight) / 2));
    const x = PAD_X + lvl * COL_GAP;

    colItems.forEach((item, idx) => {
      const y = startY + idx * ROW_GAP;
      const dep = item.dep;
      const nodeObj =
        item.kind === 'project'
          ? {
              id: ROOT_ID,
              kind: /** @type {const} */ ('project'),
              name: projectName || 'Projekt',
              manager: '',
              version: '',
              license: '',
              direct: false,
              scope: 'root',
              level: 0,
              x,
              y,
              w: NODE_W,
              h: NODE_H,
              requiredBy: [],
              requires: [],
            }
          : {
              id: item.id,
              kind: /** @type {const} */ ('package'),
              name: dep?.name || item.id,
              manager: dep?.manager || '',
              version: dep?.version || '',
              license: dep?.license || '',
              direct: Boolean(dep?.direct),
              scope: dep?.scope || 'prod',
              level: lvl,
              x,
              y,
              w: NODE_W,
              h: NODE_H,
              requiredBy: Array.isArray(dep?.requiredBy) ? dep.requiredBy : [],
              requires: Array.isArray(dep?.requires) ? dep.requires : [],
            };
      nodes.push(nodeObj);
      nodeById.set(nodeObj.id, nodeObj);
    });
  }

  /** @type {Array<{ from: string, to: string, cyclic: boolean }>} */
  const edges = [];
  const edgeSet = new Set();

  for (const node of nodes) {
    if (node.kind !== 'package') continue;
    if (node.level === 1) {
      const eKey = `${ROOT_ID}->${node.id}`;
      if (!edgeSet.has(eKey)) {
        edgeSet.add(eKey);
        edges.push({ from: ROOT_ID, to: node.id, cyclic: false });
      }
    }
    for (const reqName of node.requires) {
      const targetId = buildDepNodeKey(node.manager, reqName);
      const targetNode = nodeById.get(targetId);
      if (!targetNode) continue;
      const eKey = `${node.id}->${targetId}`;
      if (edgeSet.has(eKey)) continue;
      edgeSet.add(eKey);
      edges.push({
        from: node.id,
        to: targetId,
        cyclic: targetNode.level <= node.level,
      });
    }
  }

  return {
    nodes,
    edges,
    width: totalWidth,
    height: totalHeight,
    maxLevel,
    totalFilteredCount,
    truncated: totalFilteredCount > includedKeys.size && !normalizedFocus,
    exceedsLimit: totalFilteredCount > maxNodes,
    focusOptions: directCandidates,
    focusNodeKey: normalizedFocus,
  };
}
