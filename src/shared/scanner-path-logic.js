import path from 'node:path';

/**
 * Loest das App-Stammverzeichnis fuer scanner.mjs auf (Dev, Build-Output, Packaged resources/ oder Fallback).
 * @param {string} scriptDir
 * @param {Record<string, string | undefined>} [env]
 * @param {{ pathApi?: Pick<typeof path, 'resolve' | 'basename' | 'dirname'> }} [options]
 * @returns {string}
 */
export function resolveScannerAppDir(scriptDir, env = {}, { pathApi = path } = {}) {
  const skAppDir = typeof env?.SK_APP_DIR === 'string' ? env.SK_APP_DIR.trim() : '';
  if (skAppDir) {
    return pathApi.resolve(skAppDir);
  }

  const portableDir = typeof env?.PORTABLE_EXECUTABLE_DIR === 'string' ? env.PORTABLE_EXECUTABLE_DIR.trim() : '';
  if (portableDir) {
    return pathApi.resolve(portableDir);
  }

  const normalizedDir = pathApi.resolve(String(scriptDir || '.'));
  const dirName = pathApi.basename(normalizedDir).toLowerCase();
  const parentDir = pathApi.dirname(normalizedDir);
  const parentName = pathApi.basename(parentDir).toLowerCase();

  if (dirName === 'resources') {
    return parentDir;
  }
  if (dirName === 'scanner' && (parentName === 'src' || parentName === 'out' || parentName === 'resources')) {
    return pathApi.dirname(parentDir);
  }
  return normalizedDir;
}
