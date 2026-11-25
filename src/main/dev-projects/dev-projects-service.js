import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isSameProjectPath,
  normalizeDevProjectRecord,
  validateDevProjectInput,
} from '../../shared/dev-projects-logic.js';

const DEV_PROJECTS_FILENAME = 'dev-projects.json';

function defaultCheckPathAvailable(dirPath, existsSyncFn, statSyncFn) {
  if (!dirPath) return false;
  try {
    return Boolean(existsSyncFn(dirPath) && statSyncFn(dirPath).isDirectory());
  } catch {
    return false;
  }
}

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
 * Erzeugt eine isolierte Service-Instanz fuer lokale Entwicklungsprojekte in `data/dev-projects.json`.
 * @param {{
 *   getDataFolderFn?: () => string,
 *   existsSyncFn?: (p: string) => boolean,
 *   statSyncFn?: (p: string) => { isDirectory: () => boolean },
 *   nowFn?: () => number,
 *   randomUUIDFn?: () => string,
 * }} [deps]
 */
export function createDevProjectsService(deps = {}) {
  let getDataFolderFn =
    typeof deps.getDataFolderFn === 'function' ? deps.getDataFolderFn : () => path.join(process.cwd(), 'data');
  let existsSyncFn = typeof deps.existsSyncFn === 'function' ? deps.existsSyncFn : fs.existsSync;
  let statSyncFn = typeof deps.statSyncFn === 'function' ? deps.statSyncFn : fs.statSync;
  let nowFn = typeof deps.nowFn === 'function' ? deps.nowFn : () => Date.now();
  let randomUUIDFn = typeof deps.randomUUIDFn === 'function' ? deps.randomUUIDFn : () => crypto.randomUUID();

  function configure(options = {}) {
    if (typeof options.getDataFolderFn === 'function') getDataFolderFn = options.getDataFolderFn;
    if (typeof options.existsSyncFn === 'function') existsSyncFn = options.existsSyncFn;
    if (typeof options.statSyncFn === 'function') statSyncFn = options.statSyncFn;
    if (typeof options.nowFn === 'function') nowFn = options.nowFn;
    if (typeof options.randomUUIDFn === 'function') randomUUIDFn = options.randomUUIDFn;
  }

  function getFilePath() {
    return path.join(getDataFolderFn(), DEV_PROJECTS_FILENAME);
  }

  function checkPathAvailable(dirPath) {
    return defaultCheckPathAvailable(dirPath, existsSyncFn, statSyncFn);
  }

  function enrichWithAvailability(project) {
    return {
      ...project,
      isAvailable: checkPathAvailable(project.path),
    };
  }

  function readProjectsFromDisk() {
    const filePath = getFilePath();
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.projects) ? raw.projects : [];
      return list.map((p) => normalizeDevProjectRecord(p)).filter((p) => p.id && p.path);
    } catch (err) {
      console.error('Fehler beim Lesen der data/dev-projects.json:', err);
      return [];
    }
  }

  function writeProjectsToDisk(projects) {
    const clean = projects.map((p) => normalizeDevProjectRecord(p)).filter((p) => p.id && p.path);
    writeFileAtomic(getFilePath(), JSON.stringify(clean, null, 2));
  }

  function listDevProjects() {
    try {
      const projects = readProjectsFromDisk().map(enrichWithAvailability);
      return { success: true, projects };
    } catch (err) {
      return { success: false, projects: [], error: err?.message || 'Projekte konnten nicht geladen werden.' };
    }
  }

  function getDevProject(projectId) {
    const cleanId = String(projectId || '').trim();
    if (!cleanId) return null;
    const found = readProjectsFromDisk().find((p) => p.id === cleanId);
    return found ? enrichWithAvailability(found) : null;
  }

  function addDevProject(input = {}) {
    try {
      const validation = validateDevProjectInput(input);
      if (!validation.valid) {
        return { success: false, error: 'error' in validation ? validation.error : 'Ungueltige Projektdaten.' };
      }

      const projects = readProjectsFromDisk();
      if (projects.some((p) => isSameProjectPath(p.path, validation.path))) {
        return { success: false, error: 'Dieser Projektordner ist bereits verknuepft.' };
      }

      const now = nowFn();
      const record = normalizeDevProjectRecord(
        {
          id: randomUUIDFn(),
          name: validation.name,
          path: validation.path,
          icon: validation.icon,
          notes: validation.notes,
          createdAt: now,
          updatedAt: now,
          lastScannedAt: null,
        },
        { now }
      );

      projects.push(record);
      writeProjectsToDisk(projects);

      return {
        success: true,
        project: enrichWithAvailability(record),
        projects: projects.map(enrichWithAvailability),
      };
    } catch (err) {
      return { success: false, error: err?.message || 'Projekt konnte nicht gespeichert werden.' };
    }
  }

  function updateDevProject(projectId, patch = {}) {
    try {
      const cleanId = String(projectId || '').trim();
      if (!cleanId) return { success: false, error: 'Keine Projekt-ID angegeben.' };

      const projects = readProjectsFromDisk();
      const idx = projects.findIndex((p) => p.id === cleanId);
      if (idx === -1) {
        return { success: false, error: 'Projekt nicht gefunden.' };
      }

      const existing = projects[idx];
      const candidateInput = {
        path: patch?.path !== undefined ? patch.path : existing.path,
        name: patch?.name !== undefined ? patch.name : existing.name,
        icon: patch?.icon !== undefined ? patch.icon : existing.icon,
        notes: patch?.notes !== undefined ? patch.notes : existing.notes,
      };
      const validation = validateDevProjectInput(candidateInput);
      if (!validation.valid) {
        return { success: false, error: 'error' in validation ? validation.error : 'Ungueltige Projektdaten.' };
      }

      const duplicate = projects.some((p, i) => i !== idx && isSameProjectPath(p.path, validation.path));
      if (duplicate) {
        return { success: false, error: 'Ein anderes Projekt verweist bereits auf diesen Ordner.' };
      }

      const now = nowFn();
      const updated = normalizeDevProjectRecord(
        {
          ...existing,
          name: validation.name,
          path: validation.path,
          icon: validation.icon,
          notes: validation.notes,
          updatedAt: now,
          lastScannedAt: patch?.lastScannedAt !== undefined ? patch.lastScannedAt : existing.lastScannedAt,
        },
        { now }
      );

      projects[idx] = updated;
      writeProjectsToDisk(projects);

      return {
        success: true,
        project: enrichWithAvailability(updated),
        projects: projects.map(enrichWithAvailability),
      };
    } catch (err) {
      return { success: false, error: err?.message || 'Projekt konnte nicht aktualisiert werden.' };
    }
  }

  function removeDevProject(projectId) {
    try {
      const cleanId = String(projectId || '').trim();
      if (!cleanId) return { success: false, error: 'Keine Projekt-ID angegeben.' };

      const projects = readProjectsFromDisk();
      const next = projects.filter((p) => p.id !== cleanId);
      if (next.length === projects.length) {
        return { success: false, error: 'Projekt nicht gefunden.' };
      }

      writeProjectsToDisk(next);
      return {
        success: true,
        projects: next.map(enrichWithAvailability),
      };
    } catch (err) {
      return { success: false, error: err?.message || 'Projekt konnte nicht entfernt werden.' };
    }
  }

  function markDevProjectScanned(projectId, scannedAt = nowFn()) {
    try {
      const cleanId = String(projectId || '').trim();
      if (!cleanId) return { success: false, error: 'Keine Projekt-ID angegeben.' };

      const projects = readProjectsFromDisk();
      const idx = projects.findIndex((p) => p.id === cleanId);
      if (idx === -1) return { success: false, error: 'Projekt nicht gefunden.' };

      const existing = projects[idx];
      const updated = normalizeDevProjectRecord({
        ...existing,
        lastScannedAt: Number.isFinite(scannedAt) ? Number(scannedAt) : nowFn(),
      });
      projects[idx] = updated;
      writeProjectsToDisk(projects);

      return { success: true, project: enrichWithAvailability(updated) };
    } catch (err) {
      return { success: false, error: err?.message || 'Scan-Zeitstempel konnte nicht gespeichert werden.' };
    }
  }

  return {
    configure,
    listDevProjects,
    getDevProject,
    addDevProject,
    updateDevProject,
    removeDevProject,
    markDevProjectScanned,
  };
}

const defaultService = createDevProjectsService();

export const configureDevProjectsService = (options) => defaultService.configure(options);
export const listDevProjects = () => defaultService.listDevProjects();
export const getDevProject = (projectId) => defaultService.getDevProject(projectId);
export const addDevProject = (input) => defaultService.addDevProject(input);
export const updateDevProject = (projectId, patch) => defaultService.updateDevProject(projectId, patch);
export const removeDevProject = (projectId) => defaultService.removeDevProject(projectId);
export const markDevProjectScanned = (projectId, scannedAt) =>
  defaultService.markDevProjectScanned(projectId, scannedAt);
