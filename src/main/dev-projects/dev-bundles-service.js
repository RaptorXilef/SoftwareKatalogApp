import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildExportDevBundlePayload,
  DEV_BUNDLE_MANAGERS,
  evaluateDevBundleForProject,
  normalizeDevBundle,
  normalizeDevBundlePkgKey,
  resolveImportedDevBundleId,
  validateImportDevBundlesPayload,
} from '../../shared/dev-bundles-logic.js';
import { SUPPORTED_DEV_MANAGERS } from '../../shared/dev-projects-logic.js';
import { sanitizeFileName } from '../../shared/version.js';
import { devInstallPackagesBatch } from './dev-actions.js';
import { getDevProject } from './dev-projects-service.js';
import { scanDevProject } from './dev-scanner.js';

const DEV_BUNDLES_FILENAME = 'dev-bundles.json';

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Temp-Datei konnte nicht bereinigt werden
    }
  }
}

/**
 * Erzeugt eine testbare Service-Instanz fuer projekt-lokale Dev-Buendel in `data/dev-bundles.json`.
 * @param {{
 *   getDataFolderFn?: () => string,
 *   getProjectFn?: (id: string) => any,
 *   scanProjectFn?: (id: string, opts?: Record<string, any>) => Promise<any>,
 *   installPackagesBatchFn?: (projectId: string, payload: Record<string, any>, opts?: Record<string, any>) => Promise<any>,
 *   createJobFn?: ((spec: Record<string, any>) => any) | null,
 *   showSaveDialogFn?: (opts: Record<string, any>) => Promise<{ canceled: boolean, filePath?: string }>,
 *   showOpenDialogFn?: (opts: Record<string, any>) => Promise<{ canceled: boolean, filePaths: string[] }>,
 *   nowFn?: () => number,
 *   randomUUIDFn?: () => string,
 * }} [deps]
 */
export function createDevBundlesService(deps = {}) {
  let getDataFolderFn =
    typeof deps.getDataFolderFn === 'function' ? deps.getDataFolderFn : () => path.join(process.cwd(), 'data');
  let getProjectFn = typeof deps.getProjectFn === 'function' ? deps.getProjectFn : getDevProject;
  let scanProjectFn = typeof deps.scanProjectFn === 'function' ? deps.scanProjectFn : scanDevProject;
  let installPackagesBatchFn =
    typeof deps.installPackagesBatchFn === 'function' ? deps.installPackagesBatchFn : devInstallPackagesBatch;
  let createJobFn = typeof deps.createJobFn === 'function' ? deps.createJobFn : null;
  let showSaveDialogFn =
    typeof deps.showSaveDialogFn === 'function'
      ? deps.showSaveDialogFn
      : async () => ({ canceled: true, filePath: '' });
  let showOpenDialogFn =
    typeof deps.showOpenDialogFn === 'function'
      ? deps.showOpenDialogFn
      : async () => ({ canceled: true, filePaths: [] });
  let nowFn = typeof deps.nowFn === 'function' ? deps.nowFn : () => Date.now();
  let randomUUIDFn = typeof deps.randomUUIDFn === 'function' ? deps.randomUUIDFn : () => crypto.randomUUID();

  function configure(options = {}) {
    if (typeof options.getDataFolderFn === 'function') getDataFolderFn = options.getDataFolderFn;
    if (typeof options.getProjectFn === 'function') getProjectFn = options.getProjectFn;
    if (typeof options.scanProjectFn === 'function') scanProjectFn = options.scanProjectFn;
    if (typeof options.installPackagesBatchFn === 'function') installPackagesBatchFn = options.installPackagesBatchFn;
    if (typeof options.createJobFn === 'function') createJobFn = options.createJobFn;
    if (typeof options.showSaveDialogFn === 'function') showSaveDialogFn = options.showSaveDialogFn;
    if (typeof options.showOpenDialogFn === 'function') showOpenDialogFn = options.showOpenDialogFn;
    if (typeof options.nowFn === 'function') nowFn = options.nowFn;
    if (typeof options.randomUUIDFn === 'function') randomUUIDFn = options.randomUUIDFn;
  }

  function getFilePath() {
    return path.join(getDataFolderFn(), DEV_BUNDLES_FILENAME);
  }

  function readBundlesFromDisk() {
    const filePath = getFilePath();
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.bundles) ? raw.bundles : [];
      return list.map((b) => normalizeDevBundle(b)).filter((b) => b.id);
    } catch (err) {
      console.error('Fehler beim Lesen der data/dev-bundles.json:', err);
      return [];
    }
  }

  function writeBundlesToDisk(bundles) {
    const clean = bundles.map((b) => normalizeDevBundle(b)).filter((b) => b.id);
    writeFileAtomic(getFilePath(), JSON.stringify(clean, null, 2));
    return clean;
  }

  function loadDevBundles() {
    try {
      return { success: true, bundles: readBundlesFromDisk() };
    } catch (err) {
      return { success: false, bundles: [], error: err?.message || 'Dev-Buendel konnten nicht geladen werden.' };
    }
  }

  function saveDevBundle(bundleInput) {
    try {
      const name = typeof bundleInput?.name === 'string' ? bundleInput.name.replace(/[\r\n\0]/g, '').trim() : '';
      if (!name) {
        return { success: false, error: 'Name des Dev-Buendels darf nicht leer sein.' };
      }
      const rawManager = String(bundleInput?.manager || '')
        .trim()
        .toLowerCase();
      if (!DEV_BUNDLE_MANAGERS.includes(rawManager)) {
        return { success: false, error: `Nicht unterstuetzter Dev-Buendel-Manager: "${bundleInput?.manager || ''}".` };
      }

      const now = nowFn();
      const bundles = readBundlesFromDisk();
      const requestedId = String(bundleInput?.id || '').trim();
      const existingIdx = requestedId ? bundles.findIndex((b) => b.id === requestedId) : -1;

      let saved;
      if (existingIdx !== -1) {
        const existing = bundles[existingIdx];
        saved = normalizeDevBundle(
          {
            ...existing,
            ...bundleInput,
            id: existing.id,
            name,
            manager: rawManager,
            createdAt: existing.createdAt,
            updatedAt: now,
          },
          { now }
        );
        bundles[existingIdx] = saved;
      } else {
        const newId = requestedId || randomUUIDFn();
        saved = normalizeDevBundle(
          {
            ...bundleInput,
            id: newId,
            name,
            manager: rawManager,
            createdAt: now,
            updatedAt: now,
          },
          { now, fallbackId: newId }
        );
        bundles.push(saved);
      }

      const persisted = writeBundlesToDisk(bundles);
      return { success: true, bundle: saved, bundles: persisted };
    } catch (err) {
      return { success: false, error: err?.message || 'Dev-Buendel konnte nicht gespeichert werden.' };
    }
  }

  function deleteDevBundle(bundleId) {
    try {
      const cleanId = String(bundleId || '').trim();
      if (!cleanId) return { success: false, error: 'Keine Dev-Buendel-ID angegeben.' };

      const bundles = readBundlesFromDisk();
      const next = bundles.filter((b) => b.id !== cleanId);
      if (next.length === bundles.length) {
        return { success: false, error: 'Dev-Buendel nicht gefunden.' };
      }

      const persisted = writeBundlesToDisk(next);
      return { success: true, bundles: persisted };
    } catch (err) {
      return { success: false, error: err?.message || 'Dev-Buendel konnte nicht geloescht werden.' };
    }
  }

  function duplicateDevBundle(bundleId) {
    try {
      const cleanId = String(bundleId || '').trim();
      const bundles = readBundlesFromDisk();
      const srcIdx = bundles.findIndex((b) => b.id === cleanId);
      if (srcIdx === -1) {
        return { success: false, error: 'Dev-Buendel nicht gefunden.' };
      }

      const src = bundles[srcIdx];
      const now = nowFn();
      const newId = randomUUIDFn();
      const copy = normalizeDevBundle(
        {
          ...src,
          id: newId,
          name: `${src.name} (Copy)`,
          createdAt: now,
          updatedAt: now,
        },
        { now, fallbackId: newId }
      );

      bundles.splice(srcIdx + 1, 0, copy);
      const persisted = writeBundlesToDisk(bundles);
      return { success: true, bundle: copy, bundles: persisted };
    } catch (err) {
      return { success: false, error: err?.message || 'Dev-Buendel konnte nicht dupliziert werden.' };
    }
  }

  async function exportDevBundle(bundleId) {
    try {
      const cleanId = String(bundleId || '').trim();
      const bundles = readBundlesFromDisk();
      const bundle = bundles.find((b) => b.id === cleanId);
      if (!bundle) {
        return { success: false, error: 'Dev-Buendel nicht gefunden.' };
      }

      const defaultName = `${sanitizeFileName(bundle.name)}_DevBundle.json`;
      const { canceled, filePath } = await showSaveDialogFn({
        title: 'Dev-Buendel als JSON exportieren',
        defaultPath: defaultName,
        filters: [{ name: 'Software-Katalog Dev-Buendel (JSON)', extensions: ['json'] }],
      });
      if (canceled || !filePath) {
        return { success: false, canceled: true };
      }

      const payload = buildExportDevBundlePayload(bundle);
      await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
      return { success: true, filePath };
    } catch (err) {
      return { success: false, error: err?.message || 'Export fehlgeschlagen.' };
    }
  }

  async function importDevBundle() {
    try {
      const { canceled, filePaths } = await showOpenDialogFn({
        title: 'Dev-Buendel aus JSON importieren',
        properties: ['openFile'],
        filters: [{ name: 'Software-Katalog Dev-Buendel (JSON)', extensions: ['json'] }],
      });
      if (canceled || !filePaths || filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const rawText = await fs.promises.readFile(filePaths[0], 'utf-8');
      let parsed;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return { success: false, error: 'Ungueltige JSON-Datei.' };
      }

      const validation = validateImportDevBundlesPayload(parsed);
      if (!validation.valid) {
        return { success: false, error: 'error' in validation ? validation.error : 'Ungueltiges Dev-Buendel.' };
      }

      const now = nowFn();
      const bundles = readBundlesFromDisk();
      const existingIds = new Set(bundles.map((b) => b.id));
      const imported = [];

      for (const candidate of validation.bundles) {
        const resolvedId = resolveImportedDevBundleId(candidate.id, existingIds, () => randomUUIDFn());
        existingIds.add(resolvedId);
        const normalized = normalizeDevBundle(
          {
            ...candidate,
            id: resolvedId,
            createdAt: now,
            updatedAt: now,
          },
          { now, fallbackId: resolvedId }
        );
        bundles.push(normalized);
        imported.push(normalized);
      }

      const persisted = writeBundlesToDisk(bundles);
      return {
        success: true,
        bundle: imported[0],
        importedBundles: imported,
        importedCount: imported.length,
        bundles: persisted,
      };
    } catch (err) {
      return { success: false, error: err?.message || 'Import fehlgeschlagen.' };
    }
  }

  /**
   * Fuehrt ein Projekt-Abgleich durch und installiert ausgewaehlte fehlende/veraltete Pakete gebuendelt ueber `dev-actions.js`.
   * @param {string} projectId
   * @param {string} bundleId
   * @param {string[] | null} [selectedPackageNames]
   * @param {{ manager?: string, scan?: Record<string, any> | null, useJob?: boolean, checkUpdates?: boolean, signal?: AbortSignal | null }} [opts]
   */
  async function installDevBundleInProject(projectId, bundleId, selectedPackageNames = null, opts = {}) {
    const cleanProjectId = String(projectId || '').trim();
    const cleanBundleId = String(bundleId || '').trim();
    const project = getProjectFn(cleanProjectId);
    if (!project) {
      return { success: false, notFound: true, error: 'Entwicklungsprojekt nicht gefunden.' };
    }
    if (!project.isAvailable) {
      return { success: false, unavailable: true, error: `Projektordner ist nicht erreichbar: ${project.path}` };
    }

    const bundles = readBundlesFromDisk();
    const bundle = bundles.find((b) => b.id === cleanBundleId);
    if (!bundle) {
      return { success: false, error: 'Dev-Buendel nicht gefunden.' };
    }

    const requestedMgr = String(opts?.manager || '')
      .trim()
      .toLowerCase();
    const targetManager = SUPPORTED_DEV_MANAGERS.includes(requestedMgr) ? requestedMgr : bundle.manager;

    let job = null;
    if (opts?.useJob !== false && createJobFn) {
      job = createJobFn({
        type: 'dev-bundle-install',
        title: `${project.name}: ${bundle.name} (${targetManager})`,
        dedupeKey: `dev-action:${cleanProjectId}`,
        cancelable: true,
      });
      if (!job) {
        return { success: false, alreadyRunning: true, error: 'In diesem Projekt laeuft bereits eine Paket-Aktion.' };
      }
      job.update(10, `Gleiche Buendel "${bundle.name}" ab...`);
    }

    const activeSignal = job ? job.signal : opts?.signal || null;

    try {
      let scan = opts?.scan || null;
      if (!scan) {
        scan = await scanProjectFn(cleanProjectId, {
          useJob: false,
          checkUpdates: true,
          signal: activeSignal,
        });
      }

      if (activeSignal?.aborted || scan?.canceled) {
        job?.finish('canceled', 'Vorgang abgebrochen.', { autoRemoveMs: 3500 });
        return { success: false, canceled: true };
      }

      const evaluation = evaluateDevBundleForProject(bundle, scan);
      const hasExplicitSelection = Array.isArray(selectedPackageNames);
      const selectedKeys = hasExplicitSelection
        ? new Set(selectedPackageNames.map((n) => normalizeDevBundlePkgKey(targetManager, n)).filter(Boolean))
        : null;

      const selectedPackages = [];
      let skippedCount = 0;

      for (const entry of evaluation.packages) {
        const isSelected = selectedKeys ? selectedKeys.has(entry.key) : entry.defaultSelected;
        if (!isSelected) {
          skippedCount++;
          continue;
        }
        selectedPackages.push({
          name: entry.name,
          version: entry.targetVersion || entry.version || '',
          isDev: entry.isDev,
          action: entry.status === 'outdated' ? 'update' : 'install',
        });
      }

      if (selectedPackages.length === 0) {
        job?.finish('done', 'Keine Pakete zur Installation ausgewaehlt.', { autoRemoveMs: 3000 });
        return {
          success: true,
          installedCount: 0,
          updatedCount: 0,
          skippedCount,
          manager: targetManager,
          scan,
        };
      }

      job?.update(35, `Installiere ${selectedPackages.length} Paket(e) ueber ${targetManager}...`);
      const batchRes = await installPackagesBatchFn(
        cleanProjectId,
        {
          manager: targetManager,
          packages: selectedPackages,
        },
        {
          useJob: false,
          signal: activeSignal,
          checkUpdates: opts?.checkUpdates !== false,
        }
      );

      if (batchRes?.canceled || activeSignal?.aborted) {
        job?.finish('canceled', 'Vorgang abgebrochen.', { autoRemoveMs: 3500 });
        return { success: false, canceled: true };
      }
      if (!batchRes?.success) {
        const msg = batchRes?.error || 'Buendel-Installation fehlgeschlagen.';
        job?.finish('error', msg.slice(0, 180), { autoRemoveMs: 6000 });
        return {
          success: false,
          error: msg,
          notFound: batchRes?.notFound,
          exitCode: batchRes?.exitCode,
        };
      }

      const installedCount = selectedPackages.filter((p) => p.action === 'install').length;
      const updatedCount = selectedPackages.filter((p) => p.action === 'update').length;
      job?.finish('done', `${selectedPackages.length} Paket(e) eingerichtet`, { autoRemoveMs: 3500 });
      return {
        success: true,
        installedCount,
        updatedCount,
        skippedCount,
        manager: targetManager,
        scan: batchRes.scan || scan,
      };
    } catch (err) {
      if (activeSignal?.aborted || err?.name === 'AbortError') {
        job?.finish('canceled', 'Vorgang abgebrochen.', { autoRemoveMs: 3500 });
        return { success: false, canceled: true };
      }
      const msg = err?.message || 'Buendel-Installation fehlgeschlagen.';
      job?.finish('error', msg.slice(0, 180), { autoRemoveMs: 6000 });
      return { success: false, error: msg };
    }
  }

  return {
    configure,
    loadDevBundles,
    saveDevBundle,
    deleteDevBundle,
    duplicateDevBundle,
    exportDevBundle,
    importDevBundle,
    installDevBundleInProject,
  };
}

const defaultDevBundlesService = createDevBundlesService();

export const configureDevBundlesService = (options) => defaultDevBundlesService.configure(options);
export const loadDevBundles = () => defaultDevBundlesService.loadDevBundles();
export const saveDevBundle = (bundle) => defaultDevBundlesService.saveDevBundle(bundle);
export const deleteDevBundle = (bundleId) => defaultDevBundlesService.deleteDevBundle(bundleId);
export const duplicateDevBundle = (bundleId) => defaultDevBundlesService.duplicateDevBundle(bundleId);
export const exportDevBundle = (bundleId) => defaultDevBundlesService.exportDevBundle(bundleId);
export const importDevBundle = () => defaultDevBundlesService.importDevBundle();
export const installDevBundleInProject = (projectId, bundleId, selectedPackageNames, opts) =>
  defaultDevBundlesService.installDevBundleInProject(projectId, bundleId, selectedPackageNames, opts);
