import fs from 'node:fs';
import path from 'node:path';
import { scoreCatalogItem } from '../../shared/search.js';
import { compareVersions, extractVersion } from '../../shared/version.js';
import { loadCatalogWithLiveStatus } from '../catalog-service.js';
import { getConfig } from '../config.js';
import { executeAndVerifyInstaller } from '../windows-tools.js';

function getPrimarySetupFile(item) {
  if (!Array.isArray(item.lastFiles) || item.lastFiles.length === 0) return '';
  return item.lastFiles[0] || '';
}

function toArchivePackage(item) {
  const primarySetup = getPrimarySetupFile(item);
  const archiveVersion = primarySetup ? extractVersion(path.basename(primarySetup)) || '' : '';

  return {
    name: item.name,
    packageManager: 'archive',
    packageId: item.id,
    id: item.id,
    linkedPackageManager: item.packageManager || (item.wingetId ? 'winget' : ''),
    linkedPackageId: item.packageId || item.wingetId || '',
    version: archiveVersion || item.webVersion || '',
    installedVersion: item.installedVersion || '',
    shortDescription: item.description
      ? item.description
          .replace(/<[^>]*>/g, ' ')
          .trim()
          .slice(0, 200)
      : '',
    description: item.description || '',
    tags: item.subCategories || [],
    homepage: item.links?.find((l) => /homepage|web/i.test(l.label))?.url || item.links?.[0]?.url || '',
    isInstalled: Boolean(item.isInstalled),
    setupPath: primarySetup,
    archivePath: item.path,
    icon: item.icon || null,
    keepAllVersions: Boolean(item.keepAllVersions),
    installMode: item.installMode || 'interactive',
    silentArgs: item.silentArgs || '',
    innoInfFile: item.innoInfFile || '',
  };
}

export const archiveProvider = {
  id: 'archive',
  name: 'Archiv',
  category: 'archive',
  description: 'Lokales Software-Archiv mit eigenen Setup-Dateien und Metadaten',
  requiresAdminForBootstrap: false,
  canInstallManager: false,
  canUninstallManager: false,
  isSystemComponent: false,
  capabilities: {
    search: true,
    listInstalled: true,
    listUpgrades: true,
    show: true,
    install: true,
    uninstall: false,
    supportsArchiveDownload: false,
  },

  async checkAvailability() {
    const cfg = getConfig();
    const items = loadCatalogWithLiveStatus();
    const anyOnline = Array.isArray(cfg.archiveRootsStatus) && cfg.archiveRootsStatus.some((r) => r.online);
    const available = Boolean(anyOnline || items.length > 0);
    return {
      available,
      version: null,
      binaryPath: cfg.absTargetPath || null,
      count: items.length,
      error: available ? null : 'Kein konfigurierter Archiv-Ordner ist derzeit erreichbar.',
    };
  },

  async isAvailable() {
    return this.checkAvailability();
  },

  async installManager() {
    return { success: false, error: 'Das lokale Archiv ist fest in die App integriert.' };
  },

  async uninstallManager() {
    return { success: false, error: 'Das lokale Archiv ist fest in die App integriert.' };
  },

  async search(query, { limit = 50 } = {}) {
    const items = loadCatalogWithLiveStatus();
    const q = String(query || '').trim();
    if (!q) {
      return { success: true, results: items.slice(0, limit).map(toArchivePackage) };
    }

    const scored = [];
    for (const item of items) {
      const res = scoreCatalogItem(item, q);
      if (res.matched) {
        scored.push({ score: res.score, pkg: toArchivePackage(item) });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return { success: true, results: scored.slice(0, limit).map((entry) => entry.pkg) };
  },

  async listInstalled() {
    const items = loadCatalogWithLiveStatus();
    const installed = items.filter((item) => item.isInstalled || item.installedVersion).map(toArchivePackage);
    return { success: true, packages: installed };
  },

  async listUpgrades() {
    const items = loadCatalogWithLiveStatus();
    const upgrades = [];

    for (const item of items) {
      const setupFile = getPrimarySetupFile(item);
      const archiveVersion = setupFile ? extractVersion(path.basename(setupFile)) : null;
      const availableVersion = item.webVersion || archiveVersion || '';
      const installedVersion = item.installedVersion || '';

      if (installedVersion && availableVersion && compareVersions(availableVersion, installedVersion) > 0) {
        upgrades.push({
          packageManager: 'archive',
          packageId: item.id,
          id: item.id,
          name: item.name,
          installedVersion,
          availableVersion,
          source: 'archive',
        });
      }
    }

    return { success: true, upgrades };
  },

  async show(packageId) {
    const cleanId = String(packageId || '').trim();
    if (!cleanId) {
      return { success: false, package: null, error: 'Keine Archiv-ID angegeben.' };
    }

    const items = loadCatalogWithLiveStatus();
    const match = items.find(
      (i) =>
        i.id === cleanId ||
        (i.packageId && i.packageId.toLowerCase() === cleanId.toLowerCase()) ||
        (i.wingetId && i.wingetId.toLowerCase() === cleanId.toLowerCase())
    );

    if (!match) {
      return { success: false, package: null, error: `Archiv-Eintrag "${cleanId}" nicht gefunden.` };
    }

    return {
      success: true,
      package: toArchivePackage(match),
      fromCache: true,
      isStale: false,
      updatedAt: match.updatedAt || null,
    };
  },

  async install(packageId, { filePath = '', allowSilent = false } = {}) {
    const items = loadCatalogWithLiveStatus();
    const item = items.find((i) => i.id === packageId);
    if (!item) {
      return { success: false, error: `Archiv-Eintrag "${packageId}" nicht gefunden.` };
    }

    const sourcePath = filePath || getPrimarySetupFile(item);
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return { success: false, error: 'Keine ausführbare Setup-Datei im Archiv vorhanden.' };
    }

    const targetVersion = extractVersion(path.basename(sourcePath)) || item.webVersion || null;
    return executeAndVerifyInstaller({
      itemId: item.id,
      itemName: item.name,
      sourcePath,
      targetVersion,
      allowSilent: Boolean(allowSilent),
    });
  },
};
