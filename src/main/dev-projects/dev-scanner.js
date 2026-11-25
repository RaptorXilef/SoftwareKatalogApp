import fs from 'node:fs';
import path from 'node:path';
import {
  classifySemverUpdates,
  detectProjectManagersFromFiles,
  isMajorUpgrade,
  mergeInstalledWithLockMeta,
  parseBunLock,
  parseCargoLock,
  parseCargoTomlDirect,
  parseComposerJsonDirect,
  parseComposerLock,
  parseCsprojDirect,
  parseDotnetPackagesLockJson,
  parsePackageJsonDirect,
  parsePackageLockJson,
  parsePnpmLockYaml,
  parseProjectBunOutdatedOutput,
  parseProjectCargoOutdatedJson,
  parseProjectComposerOutdatedJson,
  parseProjectDotnetOutdatedJson,
  parseProjectNpmOutdatedJson,
  parseProjectPipOutdatedJson,
  parseProjectYarnOutdatedOutput,
  parsePyprojectTomlDirect,
  parseRequirementsTxt,
  parseUvLock,
  parseVcpkgProjectManifest,
  parseYarnLock,
} from '../../shared/dev-projects-logic.js';
import { normalizeProviderVersion } from '../../shared/provider-lifecycle-logic.js';
import { normalizePythonPackageName } from '../../shared/python-parser.js';
import { compareVersions } from '../../shared/version.js';
import { runDevManagerCli } from './dev-cli.js';
import { getDevProject, markDevProjectScanned } from './dev-projects-service.js';

const DEFAULT_FETCH_TIMEOUT_MS = 12000;
const REGISTRY_VERSIONS_CACHE_TTL_MS = 5 * 60 * 1000;
const CRATES_USER_AGENT = 'SoftwareKatalogApp (https://github.com/RaptorXilef/SoftwareKatalogApp)';

function encodeNpmPackageNameForUrl(pkgName) {
  const clean = String(pkgName || '').trim();
  if (clean.startsWith('@') && clean.includes('/')) {
    const slash = clean.indexOf('/');
    return `@${encodeURIComponent(clean.slice(1, slash))}/${encodeURIComponent(clean.slice(slash + 1))}`;
  }
  return encodeURIComponent(clean);
}

async function defaultFetchJson(url, { signal = null, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, headers = {} } = {}) {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': CRATES_USER_AGENT,
        ...headers,
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP-Fehler ${res.status} (${url})`);
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function readTextIfExists(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

async function enrichNodePackagesFromNodeModules(projectPath, installedList) {
  const nodeModulesDir = path.join(projectPath, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) return installedList;

  const enriched = [];
  for (const pkg of installedList) {
    if (pkg.installedVersion && pkg.description) {
      enriched.push(pkg);
      continue;
    }
    const pkgJsonPath = path.join(nodeModulesDir, ...pkg.name.split('/'), 'package.json');
    const raw = await readTextIfExists(pkgJsonPath);
    if (!raw) {
      enriched.push(pkg);
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      enriched.push({
        ...pkg,
        installedVersion: pkg.installedVersion || String(parsed?.version || '').trim(),
        description: pkg.description || String(parsed?.description || '').trim(),
      });
    } catch {
      enriched.push(pkg);
    }
  }
  return enriched;
}

async function enrichComposerPackagesFromVendor(projectPath, installedList) {
  const vendorDir = path.join(projectPath, 'vendor');
  if (!fs.existsSync(vendorDir)) return installedList;

  const enriched = [];
  for (const pkg of installedList) {
    if (pkg.installedVersion && pkg.description) {
      enriched.push(pkg);
      continue;
    }
    const composerJsonPath = path.join(vendorDir, ...pkg.name.split('/'), 'composer.json');
    const raw = await readTextIfExists(composerJsonPath);
    if (!raw) {
      enriched.push(pkg);
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      enriched.push({
        ...pkg,
        installedVersion:
          pkg.installedVersion ||
          String(parsed?.version || '')
            .replace(/^v(?=\d)/i, '')
            .trim(),
        description: pkg.description || String(parsed?.description || '').trim(),
      });
    } catch {
      enriched.push(pkg);
    }
  }
  return enriched;
}

function buildScopeLookup(installedList, normalizeFn = (name) => String(name || '').toLowerCase()) {
  const map = new Map();
  for (const pkg of installedList) {
    if (!pkg?.name) continue;
    map.set(normalizeFn(pkg.name), pkg.scope || 'prod');
  }
  return map;
}

async function runWithConcurrency(items, concurrency, fn, signal) {
  const executing = new Set();
  for (const item of items) {
    if (signal?.aborted) break;
    const task = Promise.resolve().then(() => fn(item));
    executing.add(task);
    task.finally(() => executing.delete(task));
    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

/**
 * Erzeugt einen testbaren Scanner fuer Entwicklungsprojekte (Manifeste, Lockfiles, Updates).
 * @param {{
 *   getProjectFn?: (id: string) => any,
 *   markScannedFn?: (id: string, ts?: number) => any,
 *   createJobFn?: ((spec: Record<string, any>) => any) | null,
 *   runManagerCliFn?: (manager: string, args: string[], opts: Record<string, any>) => Promise<any>,
 *   fetchJsonFn?: (url: string, opts?: Record<string, any>) => Promise<any>,
 *   nowFn?: () => number,
 * }} [deps]
 */
export function createDevScanner(deps = {}) {
  let getProjectFn = typeof deps.getProjectFn === 'function' ? deps.getProjectFn : getDevProject;
  let markScannedFn = typeof deps.markScannedFn === 'function' ? deps.markScannedFn : markDevProjectScanned;
  let createJobFn = typeof deps.createJobFn === 'function' ? deps.createJobFn : null;
  let runManagerCliFn = typeof deps.runManagerCliFn === 'function' ? deps.runManagerCliFn : runDevManagerCli;
  let fetchJsonFn = typeof deps.fetchJsonFn === 'function' ? deps.fetchJsonFn : defaultFetchJson;
  let nowFn = typeof deps.nowFn === 'function' ? deps.nowFn : () => Date.now();
  /** @type {Map<string, { versions: string[], fetchedAt: number }>} */
  const registryVersionsCache = new Map();

  function configure(options = {}) {
    if (typeof options.getProjectFn === 'function') getProjectFn = options.getProjectFn;
    if (typeof options.markScannedFn === 'function') markScannedFn = options.markScannedFn;
    if (typeof options.createJobFn === 'function') createJobFn = options.createJobFn;
    if (typeof options.runManagerCliFn === 'function') runManagerCliFn = options.runManagerCliFn;
    if (typeof options.fetchJsonFn === 'function') fetchJsonFn = options.fetchJsonFn;
    if (typeof options.nowFn === 'function') nowFn = options.nowFn;
  }

  async function fetchRegistryVersionsForUpdate(manager, packageName, signal) {
    const mgr = String(manager || '')
      .trim()
      .toLowerCase();
    const pkg = String(packageName || '').trim();
    if (!mgr || !pkg) return [];

    const cacheKey = `${mgr}:${pkg.toLowerCase()}`;
    const cached = registryVersionsCache.get(cacheKey);
    const now = nowFn();
    if (cached && now - cached.fetchedAt < REGISTRY_VERSIONS_CACHE_TTL_MS) {
      return cached.versions;
    }

    /** @type {string[]} */
    let versions = [];
    try {
      if (mgr === 'npm' || mgr === 'pnpm' || mgr === 'yarn' || mgr === 'bun') {
        const url = `https://registry.npmjs.org/${encodeNpmPackageNameForUrl(pkg)}`;
        const payload = await fetchJsonFn(url, {
          signal,
          headers: { Accept: 'application/vnd.npm.install-v1+json, application/json' },
        });
        if (payload?.versions && typeof payload.versions === 'object') {
          versions = Object.keys(payload.versions);
        } else if (payload?.version) {
          versions = [String(payload.version)];
        }
      } else if (mgr === 'composer') {
        const cleanComposer = pkg
          .split('/')
          .map((seg) => encodeURIComponent(seg))
          .join('/');
        const payload = await fetchJsonFn(`https://repo.packagist.org/p2/${cleanComposer}.json`, { signal });
        const entries = payload?.packages?.[pkg] || Object.values(payload?.packages || {}).flat();
        if (Array.isArray(entries)) {
          versions = entries.map((entry) => String(entry?.version || '').trim()).filter(Boolean);
        }
      } else if (mgr === 'pip' || mgr === 'uv') {
        const payload = await fetchJsonFn(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, { signal });
        if (payload?.releases && typeof payload.releases === 'object') {
          versions = Object.keys(payload.releases);
        } else if (payload?.info?.version) {
          versions = [String(payload.info.version)];
        }
      } else if (mgr === 'cargo') {
        const payload = await fetchJsonFn(`https://crates.io/api/v1/crates/${encodeURIComponent(pkg)}`, { signal });
        if (Array.isArray(payload?.versions)) {
          versions = payload.versions
            .filter((entry) => !entry?.yanked)
            .map((entry) => String(entry?.num || '').trim())
            .filter(Boolean);
        }
      } else if (mgr === 'dotnet') {
        const payload = await fetchJsonFn(
          `https://api.nuget.org/v3-flatcontainer/${encodeURIComponent(pkg.toLowerCase())}/index.json`,
          { signal }
        );
        if (Array.isArray(payload?.versions)) {
          versions = payload.versions.map((v) => String(v || '').trim()).filter(Boolean);
        }
      }
    } catch {
      return [];
    }

    if (versions.length > 0) {
      if (registryVersionsCache.size > 400) {
        const oldestKey = registryVersionsCache.keys().next().value;
        if (oldestKey) registryVersionsCache.delete(oldestKey);
      }
      registryVersionsCache.set(cacheKey, { versions, fetchedAt: now });
    }
    return versions;
  }

  async function enrichUpdatesWithSemverTiers(updatesList, signal) {
    await runWithConcurrency(
      updatesList,
      5,
      async (upd) => {
        if (!upd?.current || signal?.aborted) return;
        const fetchedVersions = await fetchRegistryVersionsForUpdate(upd.manager, upd.name, signal);
        const candidates = [...fetchedVersions, upd.wanted, upd.latest].filter(Boolean);
        const tiers = classifySemverUpdates(upd.current, candidates);
        upd.semverOptions = tiers;
      },
      signal
    );
  }

  async function checkUpdatesViaNpmRegistry(manager, directPkgs, signal) {
    const updates = [];
    const candidates = directPkgs.filter((p) => p.installedVersion);
    await runWithConcurrency(
      candidates,
      6,
      async (pkg) => {
        try {
          const encoded = encodeURIComponent(pkg.name);
          const url = pkg.name.startsWith('@')
            ? `https://registry.npmjs.org/${encoded}`
            : `https://registry.npmjs.org/${encoded}/latest`;
          const payload = await fetchJsonFn(url, { signal });
          const latest = String(payload?.['dist-tags']?.latest || payload?.version || '')
            .replace(/^v(?=\d)/i, '')
            .trim();
          if (!latest || compareVersions(latest, pkg.installedVersion, 3) <= 0) return;
          const isMajor = isMajorUpgrade(pkg.installedVersion, latest);
          updates.push({
            manager,
            name: pkg.name,
            current: pkg.installedVersion,
            wanted: isMajor ? pkg.installedVersion : latest,
            latest,
            scope: pkg.scope || 'prod',
            isMajor,
            hasWantedUpdate: !isMajor,
            hasLatestUpdate: true,
            description: pkg.description || '',
          });
        } catch {
          // Einzelne Registry-Fehler blockieren keine weiteren Pakete
        }
      },
      signal
    );
    return updates;
  }

  async function checkUpdatesViaPyPi(manager, directPkgs, signal) {
    const updates = [];
    const candidates = directPkgs.filter((p) => p.installedVersion);
    await runWithConcurrency(
      candidates,
      6,
      async (pkg) => {
        try {
          const payload = await fetchJsonFn(`https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/json`, { signal });
          const latest = normalizeProviderVersion(payload?.info?.version) || '';
          if (!latest || compareVersions(latest, pkg.installedVersion, 4) <= 0) return;
          const isMajor = isMajorUpgrade(pkg.installedVersion, latest);
          updates.push({
            manager,
            name: pkg.name,
            current: pkg.installedVersion,
            wanted: isMajor ? pkg.installedVersion : latest,
            latest,
            scope: pkg.scope || 'prod',
            isMajor,
            hasWantedUpdate: !isMajor,
            hasLatestUpdate: true,
            description: pkg.description || String(payload?.info?.summary || '').trim(),
          });
        } catch {
          // Einzelne PyPI-Fehler ignorieren
        }
      },
      signal
    );
    return updates;
  }

  async function checkUpdatesViaCratesIo(directPkgs, signal) {
    const updates = [];
    const candidates = directPkgs.filter((p) => p.installedVersion);
    await runWithConcurrency(
      candidates,
      2,
      async (pkg) => {
        try {
          const payload = await fetchJsonFn(`https://crates.io/api/v1/crates/${encodeURIComponent(pkg.name)}`, {
            signal,
          });
          const crate = payload?.crate || payload;
          const latest =
            normalizeProviderVersion(crate?.max_stable_version || crate?.max_version || crate?.newest_version) || '';
          if (!latest || compareVersions(latest, pkg.installedVersion, 4) <= 0) return;
          const isMajor = isMajorUpgrade(pkg.installedVersion, latest);
          updates.push({
            manager: 'cargo',
            name: pkg.name,
            current: pkg.installedVersion,
            wanted: isMajor ? pkg.installedVersion : latest,
            latest,
            scope: pkg.scope || 'prod',
            isMajor,
            hasWantedUpdate: !isMajor,
            hasLatestUpdate: true,
            description: pkg.description || String(crate?.description || '').trim(),
          });
        } catch {
          // Einzelne crates.io-Fehler ignorieren
        }
      },
      signal
    );
    return updates;
  }

  async function checkEcosystemUpdates(eco, directPkgs, projectPath, signal, warnings) {
    const mgr = eco.manager;
    const isPython = mgr === 'pip' || mgr === 'uv';
    const scopeMap = buildScopeLookup(directPkgs, isPython ? normalizePythonPackageName : undefined);

    if (mgr === 'npm') {
      const res = await runManagerCliFn('npm', ['outdated', '--json'], { projectPath, signal, timeoutMs: 60000 });
      if (res.aborted) return [];
      if (res.notFound) {
        warnings.push('npm CLI nicht gefunden - Update-Pruefung fuer npm uebersprungen.');
        return [];
      }
      const trimmed = String(res.stdout || '').trim();
      // `npm outdated` gibt Exit-Code 1 zurueck, wenn Updates vorliegen -> normal parsen!
      if ((res.code === 0 || res.code === 1) && (!trimmed || trimmed.startsWith('{') || trimmed.startsWith('['))) {
        return parseProjectNpmOutdatedJson(res.stdout, { manager: 'npm', directScopeMap: scopeMap });
      }
      if (res.code !== 0 && res.code !== 1) {
        warnings.push(`npm outdated fehlgeschlagen: ${(res.stderr || res.error || `Code ${res.code}`).trim()}`);
      }
      return parseProjectNpmOutdatedJson(res.stdout, { manager: 'npm', directScopeMap: scopeMap });
    }

    if (mgr === 'pnpm') {
      const res = await runManagerCliFn('pnpm', ['outdated', '--format', 'json'], {
        projectPath,
        signal,
        timeoutMs: 60000,
      });
      if (res.aborted) return [];
      if (res.notFound) {
        warnings.push('pnpm CLI nicht gefunden - Update-Pruefung fuer pnpm uebersprungen.');
        return [];
      }
      const parsed = parseProjectNpmOutdatedJson(res.stdout, { manager: 'pnpm', directScopeMap: scopeMap });
      if (res.code !== 0 && res.code !== 1 && parsed.length === 0) {
        warnings.push(`pnpm outdated fehlgeschlagen: ${(res.stderr || res.error || `Code ${res.code}`).trim()}`);
      }
      return parsed;
    }

    if (mgr === 'yarn') {
      const res = await runManagerCliFn('yarn', ['outdated', '--json'], { projectPath, signal, timeoutMs: 60000 });
      if (res.aborted) return [];
      if (res.notFound) {
        warnings.push('yarn CLI nicht gefunden - Update-Pruefung fuer yarn uebersprungen.');
        return [];
      }
      const parsed = parseProjectYarnOutdatedOutput(res.stdout, { directScopeMap: scopeMap });
      if (res.code !== 0 && res.code !== 1 && parsed.length === 0) {
        warnings.push(`yarn outdated fehlgeschlagen: ${(res.stderr || res.error || `Code ${res.code}`).trim()}`);
      }
      return parsed;
    }

    if (mgr === 'bun') {
      const res = await runManagerCliFn('bun', ['outdated'], { projectPath, signal, timeoutMs: 60000 });
      if (res.aborted) return [];
      if (!res.notFound && (res.code === 0 || res.code === 1)) {
        const parsed = parseProjectBunOutdatedOutput(res.stdout, { directScopeMap: scopeMap });
        if (parsed.length > 0 || (res.code === 0 && !res.stderr)) {
          return parsed;
        }
      }
      // Graceful Fallback ueber npm-Registry falls bun fehlt oder nichts liefert
      if (directPkgs.some((p) => p.installedVersion)) {
        return checkUpdatesViaNpmRegistry('bun', directPkgs, signal);
      }
      if (res.notFound) {
        warnings.push('bun CLI nicht gefunden und keine Lockfile-Versionen fuer Registry-Check vorhanden.');
      }
      return [];
    }

    if (mgr === 'composer') {
      const res = await runManagerCliFn('composer', ['outdated', '--format=json'], {
        projectPath,
        signal,
        timeoutMs: 60000,
      });
      if (res.aborted) return [];
      if (res.notFound) {
        warnings.push('Composer CLI nicht gefunden - Update-Pruefung fuer Composer uebersprungen.');
        return [];
      }
      const parsed = parseProjectComposerOutdatedJson(res.stdout, { directScopeMap: scopeMap });
      if (
        res.code !== 0 &&
        parsed.length === 0 &&
        !String(res.stdout || '')
          .trim()
          .startsWith('{')
      ) {
        warnings.push(`composer outdated fehlgeschlagen: ${(res.stderr || res.error || `Code ${res.code}`).trim()}`);
      }
      return parsed;
    }

    if (mgr === 'dotnet') {
      const res = await runManagerCliFn('dotnet', ['list', 'package', '--outdated', '--format', 'json'], {
        projectPath,
        signal,
        timeoutMs: 90000,
      });
      if (res.aborted) return [];
      if (res.notFound) {
        warnings.push('.NET SDK (dotnet) nicht gefunden - NuGet-Update-Pruefung uebersprungen.');
        return [];
      }
      const parsed = parseProjectDotnetOutdatedJson(res.stdout, { directScopeMap: scopeMap });
      if (res.code !== 0 && parsed.length === 0) {
        warnings.push(`dotnet list package fehlgeschlagen: ${(res.stderr || res.error || `Code ${res.code}`).trim()}`);
      }
      return parsed;
    }

    if (mgr === 'pip') {
      const res = await runManagerCliFn('pip', ['list', '--outdated', '--format=json'], {
        projectPath,
        signal,
        timeoutMs: 90000,
      });
      if (res.aborted) return [];
      if (!res.notFound && res.code === 0) {
        const allowedSet = res.usingProjectVenv
          ? null
          : new Set(directPkgs.map((p) => normalizePythonPackageName(p.name)));
        return parseProjectPipOutdatedJson(res.stdout, {
          manager: 'pip',
          directScopeMap: scopeMap,
          allowedNamesSet: allowedSet,
        });
      }
      if (directPkgs.some((p) => p.installedVersion)) {
        return checkUpdatesViaPyPi('pip', directPkgs, signal);
      }
      if (res.notFound) {
        warnings.push('Python / pip CLI nicht gefunden - Update-Pruefung uebersprungen.');
      }
      return [];
    }

    if (mgr === 'uv') {
      const hasVenv = fs.existsSync(path.join(projectPath, '.venv')) || fs.existsSync(path.join(projectPath, 'venv'));
      if (hasVenv) {
        const res = await runManagerCliFn('uv', ['pip', 'list', '--outdated', '--format=json'], {
          projectPath,
          signal,
          timeoutMs: 90000,
        });
        if (res.aborted) return [];
        if (!res.notFound && res.code === 0) {
          return parseProjectPipOutdatedJson(res.stdout, { manager: 'uv', directScopeMap: scopeMap });
        }
      }
      if (directPkgs.some((p) => p.installedVersion)) {
        return checkUpdatesViaPyPi('uv', directPkgs, signal);
      }
      warnings.push('uv Update-Pruefung: Keine .venv oder aufgeloesten Versionen in uv.lock gefunden.');
      return [];
    }

    if (mgr === 'cargo') {
      const res = await runManagerCliFn('cargo', ['outdated', '--format=json'], {
        projectPath,
        signal,
        timeoutMs: 90000,
      });
      if (res.aborted) return [];
      if (!res.notFound && res.code === 0) {
        const parsed = parseProjectCargoOutdatedJson(res.stdout, { directScopeMap: scopeMap });
        if (
          parsed.length > 0 ||
          String(res.stdout || '')
            .trim()
            .startsWith('{')
        ) {
          return parsed;
        }
      }
      if (directPkgs.some((p) => p.installedVersion)) {
        return checkUpdatesViaCratesIo(directPkgs, signal);
      }
      if (res.notFound) {
        warnings.push('Cargo CLI nicht gefunden und keine Cargo.lock-Versionen fuer crates.io-Check vorhanden.');
      }
      return [];
    }

    if (mgr === 'vcpkg') {
      warnings.push('vcpkg-Updates werden im Manifest-Modus ueber die Baseline verwaltet (vcpkg x-update-baseline).');
      return [];
    }

    return [];
  }

  /**
   * Scannt ein verknuepftes Entwicklungsprojekt nach Oekosystemen, direkten Paketen,
   * vollstaendigen Lockfile-Abhaengigkeiten und projekt-lokalen Updates.
   * @param {string} projectId
   * @param {{ useJob?: boolean, checkUpdates?: boolean, signal?: AbortSignal | null }} [options]
   */
  async function scanDevProject(projectId, { useJob = true, checkUpdates = true, signal = null } = {}) {
    const cleanId = String(projectId || '').trim();
    const project = getProjectFn(cleanId);
    if (!project) {
      return {
        success: false,
        notFound: true,
        project: null,
        managers: [],
        ecosystems: [],
        installed: [],
        dependencies: [],
        updates: [],
        warnings: [],
        error: 'Entwicklungsprojekt nicht gefunden.',
      };
    }

    if (!project.isAvailable) {
      return {
        success: false,
        unavailable: true,
        project,
        managers: [],
        ecosystems: [],
        installed: [],
        dependencies: [],
        updates: [],
        warnings: ['Projektordner ist aktuell nicht erreichbar (abgestecktes Laufwerk oder verschoben).'],
        error: `Projektordner nicht erreichbar: ${project.path}`,
      };
    }

    let job = null;
    if (useJob && createJobFn) {
      job = createJobFn({
        type: 'dev-scan',
        title: `DEV-Scan: ${project.name}`,
        dedupeKey: `dev-scan:${cleanId}`,
        cancelable: true,
      });
      if (!job) {
        return { success: false, alreadyRunning: true, error: 'Projekt-Scan laeuft bereits.' };
      }
      job.update(5, `Analysiere Manifeste in ${project.name}...`);
    }

    const activeSignal = job ? job.signal : signal;
    const warnings = [];
    const installed = [];
    const dependencies = [];
    const updates = [];

    try {
      const entries = await fs.promises.readdir(project.path);
      let hasUvToolConfig = false;
      const pyprojectName = entries.find((f) => f.toLowerCase() === 'pyproject.toml');
      if (pyprojectName) {
        const pyRaw = await readTextIfExists(path.join(project.path, pyprojectName));
        if (pyRaw) {
          hasUvToolConfig = parsePyprojectTomlDirect(pyRaw).hasUvToolConfig;
        }
      }

      const detected = detectProjectManagersFromFiles(entries, { hasUvToolConfig });
      const { managers, ecosystems } = detected;

      if (ecosystems.length === 0) {
        const scannedAt = nowFn();
        markScannedFn(cleanId, scannedAt);
        job?.finish('done', 'Keine bekannten Paketmanager-Manifeste gefunden.', { autoRemoveMs: 3000 });
        return {
          success: true,
          project: { ...project, lastScannedAt: scannedAt },
          managers: [],
          ecosystems: [],
          installed: [],
          dependencies: [],
          updates: [],
          warnings: [],
          scannedAt,
        };
      }

      for (let i = 0; i < ecosystems.length; i++) {
        if (activeSignal?.aborted) break;
        const eco = ecosystems[i];
        const basePct = 15 + Math.round((i / ecosystems.length) * 75);
        job?.update(basePct, `Lese ${eco.manager} Manifest & Lockfile...`);

        let directPkgs = [];
        let rootCargoName = '';

        if (eco.ecosystem === 'node') {
          const manifestRaw = await readTextIfExists(path.join(project.path, eco.manifestFile));
          if (manifestRaw) {
            directPkgs = parsePackageJsonDirect(manifestRaw, eco.manager);
          }
          let lockRes = { dependencies: [], versionByName: {}, metaByName: {} };
          if (eco.lockfile) {
            const lowerLock = eco.lockfile.toLowerCase();
            if (lowerLock === 'package-lock.json') {
              const lockRaw = await readTextIfExists(path.join(project.path, eco.lockfile));
              if (lockRaw) lockRes = parsePackageLockJson(lockRaw, directPkgs, eco.manager);
            } else if (lowerLock === 'pnpm-lock.yaml') {
              const lockRaw = await readTextIfExists(path.join(project.path, eco.lockfile));
              if (lockRaw) lockRes = parsePnpmLockYaml(lockRaw, directPkgs);
            } else if (lowerLock === 'yarn.lock') {
              const lockRaw = await readTextIfExists(path.join(project.path, eco.lockfile));
              if (lockRaw) lockRes = parseYarnLock(lockRaw, directPkgs);
            } else if (lowerLock === 'bun.lock') {
              const lockRaw = await readTextIfExists(path.join(project.path, eco.lockfile));
              if (lockRaw) lockRes = parseBunLock(lockRaw, directPkgs);
            }
          }
          directPkgs = mergeInstalledWithLockMeta(directPkgs, lockRes.versionByName, lockRes.metaByName);
          directPkgs = await enrichNodePackagesFromNodeModules(project.path, directPkgs);
          dependencies.push(...lockRes.dependencies);
        } else if (eco.ecosystem === 'php') {
          const manifestRaw = await readTextIfExists(path.join(project.path, eco.manifestFile));
          if (manifestRaw) {
            directPkgs = parseComposerJsonDirect(manifestRaw);
          }
          let lockRes = { dependencies: [], versionByName: {}, metaByName: {} };
          if (eco.lockfile) {
            const lockRaw = await readTextIfExists(path.join(project.path, eco.lockfile));
            if (lockRaw) lockRes = parseComposerLock(lockRaw, directPkgs);
          }
          directPkgs = mergeInstalledWithLockMeta(directPkgs, lockRes.versionByName, lockRes.metaByName);
          directPkgs = await enrichComposerPackagesFromVendor(project.path, directPkgs);
          dependencies.push(...lockRes.dependencies);
        } else if (eco.ecosystem === 'python') {
          const seenPy = new Set();
          for (const mf of eco.manifestFiles) {
            const raw = await readTextIfExists(path.join(project.path, mf));
            if (!raw) continue;
            const parsed =
              mf.toLowerCase() === 'pyproject.toml'
                ? parsePyprojectTomlDirect(raw, eco.manager).packages
                : parseRequirementsTxt(raw, eco.manager);
            for (const p of parsed) {
              const key = normalizePythonPackageName(p.name);
              if (seenPy.has(key)) continue;
              seenPy.add(key);
              directPkgs.push(p);
            }
          }
          let lockRes = { dependencies: [], versionByName: {}, metaByName: {} };
          if (eco.lockfile && eco.lockfile.toLowerCase() === 'uv.lock') {
            const lockRaw = await readTextIfExists(path.join(project.path, eco.lockfile));
            if (lockRaw) lockRes = parseUvLock(lockRaw, directPkgs);
          }
          directPkgs = mergeInstalledWithLockMeta(
            directPkgs,
            lockRes.versionByName,
            lockRes.metaByName,
            normalizePythonPackageName
          );
          dependencies.push(...lockRes.dependencies);
        } else if (eco.ecosystem === 'rust') {
          const manifestRaw = await readTextIfExists(path.join(project.path, eco.manifestFile));
          if (manifestRaw) {
            const parsedCargo = parseCargoTomlDirect(manifestRaw);
            directPkgs = parsedCargo.packages;
            rootCargoName = parsedCargo.rootPackageName;
          }
          let lockRes = { dependencies: [], versionByName: {}, metaByName: {} };
          if (eco.lockfile) {
            const lockRaw = await readTextIfExists(path.join(project.path, eco.lockfile));
            if (lockRaw) lockRes = parseCargoLock(lockRaw, directPkgs, rootCargoName);
          }
          directPkgs = mergeInstalledWithLockMeta(directPkgs, lockRes.versionByName, lockRes.metaByName);
          dependencies.push(...lockRes.dependencies);
        } else if (eco.ecosystem === 'dotnet') {
          const seenDotnet = new Set();
          for (const mf of eco.manifestFiles) {
            const raw = await readTextIfExists(path.join(project.path, mf));
            if (!raw) continue;
            for (const p of parseCsprojDirect(raw)) {
              const key = p.name.toLowerCase();
              if (seenDotnet.has(key)) continue;
              seenDotnet.add(key);
              directPkgs.push(p);
            }
          }
          let lockRes = { dependencies: [], versionByName: {}, metaByName: {} };
          if (eco.lockfile) {
            const lockRaw = await readTextIfExists(path.join(project.path, eco.lockfile));
            if (lockRaw) lockRes = parseDotnetPackagesLockJson(lockRaw, directPkgs);
          }
          directPkgs = mergeInstalledWithLockMeta(directPkgs, lockRes.versionByName, lockRes.metaByName);
          dependencies.push(...lockRes.dependencies);
        } else if (eco.ecosystem === 'cpp') {
          const manifestRaw = await readTextIfExists(path.join(project.path, eco.manifestFile));
          if (manifestRaw) {
            directPkgs = parseVcpkgProjectManifest(manifestRaw);
          }
        }

        installed.push(...directPkgs);

        if (checkUpdates !== false && !activeSignal?.aborted) {
          job?.update(basePct + 25, `Pruefe ${eco.manager} Updates...`);
          const ecoUpdates = await checkEcosystemUpdates(eco, directPkgs, project.path, activeSignal, warnings);
          const descByKey = new Map(directPkgs.map((p) => [p.name.toLowerCase(), p.description || '']));
          for (const upd of ecoUpdates) {
            updates.push({
              ...upd,
              description: upd.description || descByKey.get(upd.name.toLowerCase()) || '',
            });
          }
        }
      }

      if (updates.length > 0 && checkUpdates !== false && !activeSignal?.aborted) {
        job?.update(88, 'Ermittle Patch-, Minor- & Major-Versionen...');
        await enrichUpdatesWithSemverTiers(updates, activeSignal);
      }

      if (activeSignal?.aborted) {
        job?.finish('canceled', 'DEV-Scan abgebrochen.', { autoRemoveMs: 3000 });
        return {
          success: false,
          canceled: true,
          project,
          managers,
          ecosystems,
          installed,
          dependencies,
          updates,
          warnings,
        };
      }

      const scannedAt = nowFn();
      markScannedFn(cleanId, scannedAt);
      job?.finish('done', `${installed.length} Pakete · ${updates.length} Updates`, { autoRemoveMs: 3500 });

      return {
        success: true,
        project: { ...project, lastScannedAt: scannedAt },
        managers,
        ecosystems,
        installed,
        dependencies,
        updates,
        warnings,
        scannedAt,
      };
    } catch (err) {
      if (activeSignal?.aborted || err?.name === 'AbortError') {
        job?.finish('canceled', 'DEV-Scan abgebrochen.', { autoRemoveMs: 3000 });
        return {
          success: false,
          canceled: true,
          project,
          managers: [],
          ecosystems: [],
          installed,
          dependencies,
          updates,
          warnings,
        };
      }
      job?.finish('error', err?.message || 'DEV-Scan fehlgeschlagen.', { autoRemoveMs: 5000 });
      return {
        success: false,
        project,
        managers: [],
        ecosystems: [],
        installed,
        dependencies,
        updates,
        warnings,
        error: err?.message || 'DEV-Scan fehlgeschlagen.',
      };
    }
  }

  return {
    configure,
    scanDevProject,
  };
}

const defaultScanner = createDevScanner();

export const configureDevScanner = (options) => defaultScanner.configure(options);
export const scanDevProject = (projectId, options) => defaultScanner.scanDevProject(projectId, options);
