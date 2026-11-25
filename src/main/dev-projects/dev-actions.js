import fs from 'node:fs';
import path from 'node:path';
import {
  buildDevInstallCommand,
  buildDevSyncCommand,
  buildDevToggleScopeSteps,
  buildDevUninstallCommand,
  buildDevUpdateCommand,
  isValidDevPackageName,
  isValidDevVersionSpec,
  parseCargoTomlDirect,
  parseComposerJsonDirect,
  parsePackageJsonDirect,
  parsePyprojectTomlDirect,
  SUPPORTED_DEV_MANAGERS,
} from '../../shared/dev-projects-logic.js';
import { parseNugetSearchJson } from '../../shared/dotnet-parser.js';
import { parseNpmSearchJson } from '../../shared/npm-parser.js';
import { normalizePythonPackageName } from '../../shared/python-parser.js';
import { runDevManagerCli } from './dev-cli.js';
import { getDevProject } from './dev-projects-service.js';
import { scanDevProject } from './dev-scanner.js';

const ACTION_TIMEOUT_MS = 15 * 60 * 1000;
const NUGET_SEARCH_URL = 'https://azuresearch-usnc.nuget.org/query';
const NPM_SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';

async function defaultFetchJson(url, { signal = null, timeoutMs = 15000 } = {}) {
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
        'User-Agent': 'SoftwareKatalogApp',
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Registry-HTTP-Fehler ${res.status} (${url})`);
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function readManifestPackages(projectPath, manager) {
  const mgr = String(manager || '').toLowerCase();
  try {
    if (mgr === 'npm' || mgr === 'pnpm' || mgr === 'bun' || mgr === 'yarn') {
      const file = path.join(projectPath, 'package.json');
      if (fs.existsSync(file)) {
        return parsePackageJsonDirect(await fs.promises.readFile(file, 'utf-8'), mgr);
      }
    } else if (mgr === 'composer') {
      const file = path.join(projectPath, 'composer.json');
      if (fs.existsSync(file)) {
        return parseComposerJsonDirect(await fs.promises.readFile(file, 'utf-8'));
      }
    } else if (mgr === 'uv' || mgr === 'pip') {
      const file = path.join(projectPath, 'pyproject.toml');
      if (fs.existsSync(file)) {
        return parsePyprojectTomlDirect(await fs.promises.readFile(file, 'utf-8'), mgr).packages;
      }
    } else if (mgr === 'cargo') {
      const file = path.join(projectPath, 'Cargo.toml');
      if (fs.existsSync(file)) {
        return parseCargoTomlDirect(await fs.promises.readFile(file, 'utf-8')).packages;
      }
    }
  } catch {
    // Manifest-Lesefehler ignorieren
  }
  return [];
}

async function resolveDirectPkgMeta(projectPath, manager, packageName) {
  const directList = await readManifestPackages(projectPath, manager);
  const isPy = manager === 'pip' || manager === 'uv';
  const targetKey = isPy ? normalizePythonPackageName(packageName) : String(packageName || '').toLowerCase();
  return (
    directList.find((p) => (isPy ? normalizePythonPackageName(p.name) : p.name.toLowerCase()) === targetKey) || null
  );
}

/**
 * Erzeugt testbare projekt-lokale Paket-Operationen fuer den Tab "DEV".
 * @param {{
 *   getProjectFn?: (id: string) => any,
 *   scanProjectFn?: (id: string, opts?: Record<string, any>) => Promise<any>,
 *   createJobFn?: ((spec: Record<string, any>) => any) | null,
 *   runManagerCliFn?: (manager: string, args: string[], opts: Record<string, any>) => Promise<any>,
 *   searchProviderFn?: ((providerId: string, query: string, opts?: Record<string, any>) => Promise<any>) | null,
 *   fetchJsonFn?: (url: string, opts?: Record<string, any>) => Promise<any>,
 * }} [deps]
 */
export function createDevActions(deps = {}) {
  let getProjectFn = typeof deps.getProjectFn === 'function' ? deps.getProjectFn : getDevProject;
  let scanProjectFn = typeof deps.scanProjectFn === 'function' ? deps.scanProjectFn : scanDevProject;
  let createJobFn = typeof deps.createJobFn === 'function' ? deps.createJobFn : null;
  let runManagerCliFn = typeof deps.runManagerCliFn === 'function' ? deps.runManagerCliFn : runDevManagerCli;
  let searchProviderFn = typeof deps.searchProviderFn === 'function' ? deps.searchProviderFn : null;
  let fetchJsonFn = typeof deps.fetchJsonFn === 'function' ? deps.fetchJsonFn : defaultFetchJson;

  function configure(options = {}) {
    if (typeof options.getProjectFn === 'function') getProjectFn = options.getProjectFn;
    if (typeof options.scanProjectFn === 'function') scanProjectFn = options.scanProjectFn;
    if (typeof options.createJobFn === 'function') createJobFn = options.createJobFn;
    if (typeof options.runManagerCliFn === 'function') runManagerCliFn = options.runManagerCliFn;
    if (typeof options.searchProviderFn === 'function') searchProviderFn = options.searchProviderFn;
    if (typeof options.fetchJsonFn === 'function') fetchJsonFn = options.fetchJsonFn;
  }

  function validateProjectAndManager(projectId, manager) {
    const cleanId = String(projectId || '').trim();
    const mgr = String(manager || '')
      .trim()
      .toLowerCase();
    if (!SUPPORTED_DEV_MANAGERS.includes(mgr)) {
      return { ok: false, error: `Nicht unterstuetzter Paketmanager: "${manager}".` };
    }
    const project = getProjectFn(cleanId);
    if (!project) {
      return { ok: false, notFound: true, error: 'Entwicklungsprojekt nicht gefunden.' };
    }
    if (!project.isAvailable) {
      return { ok: false, unavailable: true, error: `Projektordner ist nicht erreichbar: ${project.path}` };
    }
    return { ok: true, project, manager: mgr, projectId: cleanId };
  }

  async function executeWithJobAndRescan({
    projectId,
    project,
    manager,
    jobType,
    jobTitle,
    steps,
    signal = null,
    useJob = true,
    checkUpdates = true,
  }) {
    let job = null;
    if (useJob && createJobFn) {
      job = createJobFn({
        type: jobType,
        title: jobTitle,
        dedupeKey: `dev-action:${projectId}`,
        cancelable: true,
      });
      if (!job) {
        return { success: false, alreadyRunning: true, error: 'In diesem Projekt laeuft bereits eine Paket-Aktion.' };
      }
      job.update(10, `Fuehre ${manager}-Kommando aus...`);
    }

    const activeSignal = job ? job.signal : signal;
    let lastStdout = '';
    let lastStderr = '';

    try {
      for (let i = 0; i < steps.length; i++) {
        if (activeSignal?.aborted) {
          job?.finish('canceled', 'Vorgang abgebrochen.', { autoRemoveMs: 3500 });
          return { success: false, canceled: true };
        }
        const args = steps[i];
        const res = await runManagerCliFn(manager, args, {
          projectPath: project.path,
          signal: activeSignal,
          timeoutMs: ACTION_TIMEOUT_MS,
        });
        lastStdout = res.stdout || lastStdout;
        lastStderr = res.stderr || lastStderr;

        if (activeSignal?.aborted || res.aborted) {
          job?.finish('canceled', 'Vorgang abgebrochen.', { autoRemoveMs: 3500 });
          return { success: false, canceled: true, exitCode: res.code };
        }
        if (res.notFound) {
          const msg = res.error || `${manager} ist auf diesem PC nicht verfuegbar.`;
          job?.finish('error', msg, { autoRemoveMs: 6000 });
          return { success: false, notFound: true, exitCode: res.code, error: msg };
        }
        if (res.code !== 0) {
          const errMsg = (res.stderr || res.stdout || res.error || `${manager}-Fehlercode ${res.code}`).trim();
          job?.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
          return {
            success: false,
            exitCode: res.code,
            stdout: res.stdout || '',
            stderr: res.stderr || '',
            error: errMsg,
          };
        }
      }

      job?.update(80, `Scanne Projekt ${project.name} neu...`);
      const scan = await scanProjectFn(projectId, {
        useJob: false,
        signal: activeSignal,
        checkUpdates,
      });

      if (activeSignal?.aborted || scan?.canceled) {
        job?.finish('canceled', 'Vorgang abgebrochen.', { autoRemoveMs: 3500 });
        return { success: false, canceled: true };
      }

      job?.finish('done', 'Abgeschlossen', { autoRemoveMs: 3500 });
      return {
        success: true,
        exitCode: 0,
        stdout: lastStdout,
        stderr: lastStderr,
        scan,
      };
    } catch (err) {
      if (activeSignal?.aborted || err?.name === 'AbortError') {
        job?.finish('canceled', 'Vorgang abgebrochen.', { autoRemoveMs: 3500 });
        return { success: false, canceled: true };
      }
      const msg = err?.message || 'Paket-Operation fehlgeschlagen.';
      job?.finish('error', msg.slice(0, 180), { autoRemoveMs: 6000 });
      return { success: false, error: msg };
    }
  }

  /**
   * Installiert ein Paket projekt-lokal und scannt das Projekt anschliessend neu.
   * @param {string} projectId
   * @param {{ manager?: string, packageName?: string, version?: string, isDev?: boolean }} [payload]
   * @param {{ signal?: AbortSignal | null, useJob?: boolean, checkUpdates?: boolean }} [opts]
   */
  async function devInstallPackage(
    projectId,
    { manager = '', packageName = '', version = '', isDev = false } = {},
    opts = {}
  ) {
    const check = validateProjectAndManager(projectId, manager);
    if (!check.ok)
      return { success: false, error: check.error, unavailable: check.unavailable, notFound: check.notFound };

    const cleanPkg = String(packageName || '').trim();
    if (!isValidDevPackageName(check.manager, cleanPkg)) {
      return { success: false, error: `Ungueltiger Paketname fuer ${check.manager}: "${packageName}".` };
    }
    const cleanVer = String(version || '').trim();
    if (!isValidDevVersionSpec(cleanVer)) {
      return { success: false, error: 'Ungueltige Versionsangabe.' };
    }

    const cmd = buildDevInstallCommand({
      manager: check.manager,
      packageName: cleanPkg,
      version: cleanVer,
      isDev: Boolean(isDev),
    });

    return executeWithJobAndRescan({
      projectId: check.projectId,
      project: check.project,
      manager: check.manager,
      jobType: 'dev-install',
      jobTitle: `${check.project.name}: Installiere ${cleanPkg} (${check.manager})`,
      steps: [cmd.args],
      signal: opts.signal || null,
      useJob: opts.useJob !== false,
      checkUpdates: opts.checkUpdates !== false,
    });
  }

  /**
   * Aktualisiert ein Paket projekt-lokal (unterscheidet `wanted` innerhalb Range vs `latest`/Major-Sprung).
   * @param {string} projectId
   * @param {{ manager?: string, packageName?: string, targetVersion?: string, allowMajor?: boolean, isDev?: boolean }} [payload]
   * @param {{ signal?: AbortSignal | null, useJob?: boolean, checkUpdates?: boolean }} [opts]
   */
  async function devUpdatePackage(
    projectId,
    { manager = '', packageName = '', targetVersion = '', allowMajor = false, isDev = undefined } = {},
    opts = {}
  ) {
    const check = validateProjectAndManager(projectId, manager);
    if (!check.ok)
      return { success: false, error: check.error, unavailable: check.unavailable, notFound: check.notFound };

    const cleanPkg = String(packageName || '').trim();
    if (!isValidDevPackageName(check.manager, cleanPkg)) {
      return { success: false, error: `Ungueltiger Paketname fuer ${check.manager}: "${packageName}".` };
    }
    const cleanVer = String(targetVersion || '').trim();
    if (!isValidDevVersionSpec(cleanVer)) {
      return { success: false, error: 'Ungueltige Zielversion angegeben.' };
    }

    let effectiveIsDev = isDev;
    if (effectiveIsDev === undefined) {
      const existingMeta = await resolveDirectPkgMeta(check.project.path, check.manager, cleanPkg);
      effectiveIsDev = existingMeta?.scope === 'dev';
    }

    const cmd = buildDevUpdateCommand({
      manager: check.manager,
      packageName: cleanPkg,
      targetVersion: cleanVer,
      allowMajor: Boolean(allowMajor),
      isDev: Boolean(effectiveIsDev),
    });

    return executeWithJobAndRescan({
      projectId: check.projectId,
      project: check.project,
      manager: check.manager,
      jobType: 'dev-update',
      jobTitle: `${check.project.name}: Aktualisiere ${cleanPkg} (${check.manager})`,
      steps: [cmd.args],
      signal: opts.signal || null,
      useJob: opts.useJob !== false,
      checkUpdates: opts.checkUpdates !== false,
    });
  }

  /**
   * Deinstalliert ein Paket projekt-lokal und scannt neu.
   * @param {string} projectId
   * @param {{ manager?: string, packageName?: string, isDev?: boolean }} [payload]
   * @param {{ signal?: AbortSignal | null, useJob?: boolean, checkUpdates?: boolean }} [opts]
   */
  async function devUninstallPackage(projectId, { manager = '', packageName = '', isDev = undefined } = {}, opts = {}) {
    const check = validateProjectAndManager(projectId, manager);
    if (!check.ok)
      return { success: false, error: check.error, unavailable: check.unavailable, notFound: check.notFound };

    const cleanPkg = String(packageName || '').trim();
    if (!isValidDevPackageName(check.manager, cleanPkg)) {
      return { success: false, error: `Ungueltiger Paketname fuer ${check.manager}: "${packageName}".` };
    }

    let effectiveIsDev = isDev;
    if (effectiveIsDev === undefined) {
      const existingMeta = await resolveDirectPkgMeta(check.project.path, check.manager, cleanPkg);
      effectiveIsDev = existingMeta?.scope === 'dev';
    }

    let cmd;
    try {
      cmd = buildDevUninstallCommand({
        manager: check.manager,
        packageName: cleanPkg,
        isDev: Boolean(effectiveIsDev),
      });
    } catch (err) {
      return { success: false, error: err?.message || 'Deinstallation nicht unterstuetzt.' };
    }

    return executeWithJobAndRescan({
      projectId: check.projectId,
      project: check.project,
      manager: check.manager,
      jobType: 'dev-uninstall',
      jobTitle: `${check.project.name}: Entferne ${cleanPkg} (${check.manager})`,
      steps: [cmd.args],
      signal: opts.signal || null,
      useJob: opts.useJob !== false,
      checkUpdates: opts.checkUpdates !== false,
    });
  }

  /**
   * Verschiebt ein Paket zwischen `prod` und `dev` und scannt neu.
   * @param {string} projectId
   * @param {{ manager?: string, packageName?: string, targetScope?: 'prod' | 'dev', currentRange?: string }} [payload]
   * @param {{ signal?: AbortSignal | null, useJob?: boolean, checkUpdates?: boolean }} [opts]
   */
  async function devToggleScope(
    projectId,
    { manager = '', packageName = '', targetScope = 'dev', currentRange = '' } = {},
    opts = {}
  ) {
    const check = validateProjectAndManager(projectId, manager);
    if (!check.ok)
      return { success: false, error: check.error, unavailable: check.unavailable, notFound: check.notFound };

    const cleanPkg = String(packageName || '').trim();
    if (!isValidDevPackageName(check.manager, cleanPkg)) {
      return { success: false, error: `Ungueltiger Paketname fuer ${check.manager}: "${packageName}".` };
    }
    const cleanScope = targetScope === 'prod' ? 'prod' : targetScope === 'dev' ? 'dev' : '';
    if (!cleanScope) {
      return { success: false, error: 'Ungueltiger Ziel-Scope (erlaubt: "prod" oder "dev").' };
    }

    let range = String(currentRange || '').trim();
    if (!range) {
      const existingMeta = await resolveDirectPkgMeta(check.project.path, check.manager, cleanPkg);
      range = existingMeta?.declaredRange || '';
    }

    const plan = buildDevToggleScopeSteps({
      manager: check.manager,
      packageName: cleanPkg,
      currentRange: range,
      targetScope: cleanScope,
    });
    if (!plan.supported) {
      return { success: false, error: 'error' in plan ? plan.error : 'Scope-Wechsel nicht unterstuetzt.' };
    }

    return executeWithJobAndRescan({
      projectId: check.projectId,
      project: check.project,
      manager: check.manager,
      jobType: 'dev-toggle-scope',
      jobTitle: `${check.project.name}: ${cleanPkg} -> ${cleanScope}`,
      steps: plan.steps,
      signal: opts.signal || null,
      useJob: opts.useJob !== false,
      checkUpdates: opts.checkUpdates !== false,
    });
  }

  /**
   * Synchronisiert/installiert Projekt-Abhaengigkeiten anhand des Lockfiles (`npm install`, `composer install`, ...).
   * @param {string} projectId
   * @param {string} manager
   * @param {{ signal?: AbortSignal | null, useJob?: boolean, checkUpdates?: boolean }} [opts]
   */
  async function devSyncProject(projectId, manager, opts = {}) {
    const check = validateProjectAndManager(projectId, manager);
    if (!check.ok)
      return { success: false, error: check.error, unavailable: check.unavailable, notFound: check.notFound };

    const hasRequirementsTxt = fs.existsSync(path.join(check.project.path, 'requirements.txt'));
    const hasPyprojectToml = fs.existsSync(path.join(check.project.path, 'pyproject.toml'));
    const cmd = buildDevSyncCommand(check.manager, { hasRequirementsTxt, hasPyprojectToml });

    return executeWithJobAndRescan({
      projectId: check.projectId,
      project: check.project,
      manager: check.manager,
      jobType: 'dev-sync',
      jobTitle: `${check.project.name}: Sync (${check.manager})`,
      steps: [cmd.args],
      signal: opts.signal || null,
      useJob: opts.useJob !== false,
      checkUpdates: opts.checkUpdates !== false,
    });
  }

  /**
   * Durchsucht die zum Projekt-Paketmanager passende Registry-API.
   * @param {string} manager
   * @param {string} query
   * @param {{ limit?: number, signal?: AbortSignal | null }} [opts]
   */
  async function devSearchPackages(manager, query, { limit = 25, signal = null } = {}) {
    const mgr = String(manager || '')
      .trim()
      .toLowerCase();
    if (!SUPPORTED_DEV_MANAGERS.includes(mgr)) {
      return { success: false, results: [], error: `Nicht unterstuetzter Paketmanager: "${manager}".` };
    }
    const cleanQuery = String(query || '').trim();
    if (cleanQuery.length < 2) {
      return { success: false, results: [], error: 'Bitte mindestens 2 Zeichen eingeben.' };
    }

    const take = Number.isFinite(limit) && limit > 0 ? Math.min(Math.max(Math.round(limit), 1), 50) : 25;

    try {
      // NuGet-Projekt-Bibliotheken duerfen NICHT auf packageType=DotnetTool gefiltert werden
      if (mgr === 'dotnet') {
        const url = `${NUGET_SEARCH_URL}?q=${encodeURIComponent(cleanQuery)}&take=${take}`;
        const data = await fetchJsonFn(url, { signal });
        const results = parseNugetSearchJson(data, take).map((item) => ({
          ...item,
          packageManager: 'dotnet',
          source: 'dotnet',
        }));
        return {
          success: true,
          results,
          hint: results.length === 0 ? 'Keine NuGet-Pakete gefunden.' : '',
        };
      }

      if (mgr === 'npm' || mgr === 'pnpm' || mgr === 'bun' || mgr === 'yarn') {
        if (searchProviderFn) {
          const res = await searchProviderFn('npm', cleanQuery, { limit: take, signal });
          if (res?.success) {
            return {
              ...res,
              results: (res.results || []).map((item) => ({
                ...item,
                packageManager: mgr,
                source: mgr,
              })),
            };
          }
          if (res?.canceled) return res;
        }
        const url = `${NPM_SEARCH_URL}?text=${encodeURIComponent(cleanQuery)}&size=${take}`;
        const data = await fetchJsonFn(url, { signal });
        const results = parseNpmSearchJson(data, take, { packageManager: mgr });
        return { success: true, results, hint: results.length === 0 ? 'Keine Treffer gefunden.' : '' };
      }

      const providerId = mgr === 'uv' ? 'pip' : mgr;
      if (searchProviderFn) {
        const res = await searchProviderFn(providerId, cleanQuery, { limit: take, signal });
        if (res?.success && mgr !== providerId) {
          return {
            ...res,
            results: (res.results || []).map((item) => ({
              ...item,
              packageManager: mgr,
              source: mgr,
            })),
          };
        }
        return res;
      }

      return { success: false, results: [], error: `Kein Such-Provider fuer "${mgr}" konfiguriert.` };
    } catch (err) {
      if (signal?.aborted || err?.name === 'AbortError') {
        return { success: false, results: [], canceled: true };
      }
      return { success: false, results: [], error: err?.message || `Suche fuer "${mgr}" fehlgeschlagen.` };
    }
  }

  return {
    configure,
    devInstallPackage,
    devUpdatePackage,
    devUninstallPackage,
    devToggleScope,
    devSyncProject,
    devSearchPackages,
  };
}

const defaultActions = createDevActions();

export const configureDevActions = (options) => defaultActions.configure(options);
export const devInstallPackage = (projectId, payload, opts) =>
  defaultActions.devInstallPackage(projectId, payload, opts);
export const devUpdatePackage = (projectId, payload, opts) => defaultActions.devUpdatePackage(projectId, payload, opts);
export const devUninstallPackage = (projectId, payload, opts) =>
  defaultActions.devUninstallPackage(projectId, payload, opts);
export const devToggleScope = (projectId, payload, opts) => defaultActions.devToggleScope(projectId, payload, opts);
export const devSyncProject = (projectId, manager, opts) => defaultActions.devSyncProject(projectId, manager, opts);
export const devSearchPackages = (manager, query, opts) => defaultActions.devSearchPackages(manager, query, opts);
