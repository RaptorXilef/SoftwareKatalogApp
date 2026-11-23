import fs from 'node:fs';
import path from 'node:path';

/**
 * Erzeugt aus einer Paket-ID (z. B. "VideoLAN.VLC") einen sicheren Ordnernamen für Modus `auto-id`.
 */
export function buildAutoIdFolderName(packageId) {
  const cleaned = String(packageId || '')
    .trim()
    .replace(/\.\.+/g, '.')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '');
  return cleaned || 'Package';
}

export function isPathInsideDir(targetPath, baseDir) {
  if (!targetPath || !baseDir) return false;
  const ensureSlash = (p) => (p.endsWith(path.sep) ? p : p + path.sep);
  let resolvedTarget = ensureSlash(path.resolve(targetPath));
  let resolvedBase = ensureSlash(path.resolve(baseDir));
  if (process.platform === 'win32') {
    resolvedTarget = resolvedTarget.toLowerCase();
    resolvedBase = resolvedBase.toLowerCase();
  }
  return resolvedTarget.startsWith(resolvedBase);
}

export function readExistingMetaSummary(metaFilePath) {
  if (!fs.existsSync(metaFilePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(metaFilePath, 'utf-8'));
    return {
      name: raw.name || '',
      packageManager: raw.packageManager || (raw.wingetId ? 'winget' : ''),
      packageId: raw.packageId || raw.wingetId || '',
      wingetId: raw.wingetId || '',
      keepAllVersions: Boolean(raw.keepAllVersions),
      raw,
    };
  } catch {
    return null;
  }
}

/**
 * Prüft vor dem Schreiben, ob der Zielordner im Archiv liegt und ob bereits `_metadata/` existiert.
 */
export function inspectArchiveTargetCollision(targetDir, archiveRootDir) {
  if (!targetDir) {
    return { valid: false, error: 'Kein Zielordner angegeben.' };
  }

  const resolvedDir = path.resolve(targetDir);
  if (!isPathInsideDir(resolvedDir, archiveRootDir)) {
    return {
      valid: false,
      error: 'Sicherheitsverletzung: Zielordner liegt außerhalb des konfigurierten Archiv-Verzeichnisses.',
    };
  }

  const resolvedRoot = path.resolve(archiveRootDir);
  const isSameAsRoot =
    process.platform === 'win32'
      ? resolvedDir.toLowerCase() === resolvedRoot.toLowerCase()
      : resolvedDir === resolvedRoot;
  if (isSameAsRoot) {
    return {
      valid: false,
      error: 'Bitte einen Unterordner innerhalb des Archivs wählen (nicht das Archiv-Stammverzeichnis selbst).',
    };
  }

  const dirExists = fs.existsSync(resolvedDir);
  const metaDir = path.join(resolvedDir, '_metadata');
  const metaFile = path.join(metaDir, 'meta.json');
  const metaDirExists = fs.existsSync(metaDir);
  const metaFileExists = fs.existsSync(metaFile);
  const existing = readExistingMetaSummary(metaFile);

  return {
    valid: true,
    targetDir: resolvedDir,
    dirExists,
    hasMetadata: metaDirExists || metaFileExists,
    existingMeta: existing
      ? {
          name: existing.name,
          packageManager: existing.packageManager,
          packageId: existing.packageId,
          wingetId: existing.wingetId,
          keepAllVersions: existing.keepAllVersions,
        }
      : null,
  };
}

export function resolveAutoIdTargetDir(archiveRootDir, packageId) {
  return path.join(path.resolve(archiveRootDir), buildAutoIdFolderName(packageId));
}

function buildLinksObject(pkgMeta) {
  if (pkgMeta?.links && !Array.isArray(pkgMeta.links) && typeof pkgMeta.links === 'object') {
    return { ...pkgMeta.links };
  }
  const links = {};
  if (pkgMeta?.homepage) links.Homepage = pkgMeta.homepage;
  if (pkgMeta?.releaseNotesUrl) links.Changelog = pkgMeta.releaseNotesUrl;
  return links;
}

export function buildLinkedMetaObject({
  collisionMode = 'create',
  existingSummary = null,
  packageManager = '',
  packageId = '',
  softwareName = '',
  fetchedPkg = null,
  metadata = null,
  keepAllVersions = false,
  resolvedTargetDir = '',
} = {}) {
  const cleanPid = String(packageId || '').trim();
  const cleanPm = cleanPid
    ? String(packageManager || 'winget')
        .trim()
        .toLowerCase()
    : '';
  const normalizedMode = ['create', 'link', 'overwrite'].includes(collisionMode) ? collisionMode : 'create';

  // Anzeigename != Ordnername: In meta.json steht zwingend der echte Softwarename
  const realDisplayName = String(
    softwareName || fetchedPkg?.name || existingSummary?.name || cleanPid || path.basename(resolvedTargetDir)
  ).trim();

  if (normalizedMode === 'link' && existingSummary?.raw) {
    const nextMeta = {
      ...existingSummary.raw,
      name: existingSummary.raw.name || realDisplayName,
    };
    if (cleanPm && cleanPid) {
      nextMeta.packageManager = cleanPm;
      nextMeta.packageId = cleanPid;
    }
    if (cleanPm === 'winget' && cleanPid) {
      nextMeta.wingetId = cleanPid;
      if (!nextMeta.webSourceType || nextMeta.webSourceType === 'none') {
        nextMeta.webSourceType = 'winget';
      }
    }
    if (fetchedPkg?.version && !nextMeta.webVersion) {
      nextMeta.webVersion = fetchedPkg.version;
    }
    if (nextMeta.keepAllVersions === undefined) {
      nextMeta.keepAllVersions = Boolean(keepAllVersions);
    }
    return nextMeta;
  }

  return {
    name: realDisplayName,
    softwareType: 'default',
    category: '',
    hiddenCategory: '',
    tags: Array.isArray(fetchedPkg?.tags) ? fetchedPkg.tags.slice(0, 12) : [],
    formats: [],
    os: ['Windows 10', 'Windows 11'],
    description: fetchedPkg?.description || fetchedPkg?.shortDescription || '',
    searchNames: Array.isArray(metadata?.searchNames) ? metadata.searchNames : [],
    installPaths: Array.isArray(metadata?.installPaths) ? metadata.installPaths : [],
    autoPaths: [],
    packageManager: cleanPm,
    packageId: cleanPid,
    wingetId: cleanPm === 'winget' ? cleanPid : '',
    keepAllVersions: Boolean(keepAllVersions),
    installMode: 'interactive',
    silentArgs: '',
    innoInfFile: '',
    webSourceType: cleanPm === 'winget' && cleanPid ? 'winget' : 'none',
    webVersion: fetchedPkg?.version || '',
    links: buildLinksObject(fetchedPkg),
  };
}

export function writeLinkedMetaToTarget({
  archiveRootDir,
  targetDir = '',
  saveMode = 'ask',
  collisionMode = 'create',
  packageManager = '',
  packageId = '',
  softwareName = '',
  fetchedPkg = null,
  metadata = null,
  keepAllVersions = false,
} = {}) {
  const cleanPid = String(packageId || '').trim();
  const effectiveSaveMode = saveMode || 'ask';

  if (!cleanPid && !targetDir) {
    return {
      success: false,
      needsTargetDir: true,
      error: 'Bitte einen Zielordner im Archiv auswählen.',
    };
  }

  if (effectiveSaveMode === 'none' && !targetDir) {
    return {
      success: false,
      skipped: true,
      error: 'Archiv-Speicherung ist in den Einstellungen deaktiviert (Modus: none).',
    };
  }

  let resolvedTargetDir = '';
  if (targetDir) {
    resolvedTargetDir = path.resolve(targetDir);
  } else if (effectiveSaveMode === 'auto-id') {
    resolvedTargetDir = resolveAutoIdTargetDir(archiveRootDir, cleanPid);
  } else {
    return {
      success: false,
      needsTargetDir: true,
      error: 'Bitte einen Zielordner im Archiv auswählen.',
    };
  }

  const collision = inspectArchiveTargetCollision(resolvedTargetDir, archiveRootDir);
  if (!collision.valid) {
    return { success: false, error: collision.error };
  }

  const normalizedMode = ['create', 'link', 'overwrite'].includes(collisionMode) ? collisionMode : 'create';
  if (collision.hasMetadata && normalizedMode === 'create') {
    return {
      success: false,
      collision: true,
      targetDir: resolvedTargetDir,
      existingMeta: collision.existingMeta,
    };
  }

  const metaDir = path.join(resolvedTargetDir, '_metadata');
  const metaFile = path.join(metaDir, 'meta.json');
  if (!fs.existsSync(metaDir)) {
    fs.mkdirSync(metaDir, { recursive: true });
  }

  const existingSummary = readExistingMetaSummary(metaFile);
  const nextMeta = buildLinkedMetaObject({
    collisionMode: normalizedMode,
    existingSummary,
    packageManager,
    packageId: cleanPid,
    softwareName,
    fetchedPkg,
    metadata,
    keepAllVersions,
    resolvedTargetDir,
  });

  fs.writeFileSync(metaFile, JSON.stringify(nextMeta, null, 2), 'utf-8');

  return {
    success: true,
    mode: normalizedMode,
    targetDir: resolvedTargetDir,
    metaFile,
    meta: nextMeta,
  };
}
