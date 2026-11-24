import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { getAppFolder, getConfig, getDataFolder, saveConfig } from './config.js';
import { createI18nService } from './i18n-core.js';

function resolveBuiltinLocalesDir() {
  const candidates = [
    app.isPackaged && process.resourcesPath ? path.join(process.resourcesPath, 'locales') : '',
    path.join(getAppFolder(), 'src', 'locales'),
    path.join(app.getAppPath(), 'src', 'locales'),
    path.resolve(__dirname, '../../src/locales'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Ignore inaccessible candidates
    }
  }

  return candidates[0] || '';
}

function resolveUserLocalesDir() {
  return path.join(getDataFolder(), 'locales');
}

const defaultI18nService = createI18nService({
  getBuiltinLocalesDirFn: resolveBuiltinLocalesDir,
  getUserLocalesDirFn: resolveUserLocalesDir,
  getConfigFn: getConfig,
  saveConfigFn: saveConfig,
  getSystemLocaleFn: () => (typeof app.getLocale === 'function' ? app.getLocale() : 'en'),
});

export const configureI18nService = (options) => defaultI18nService.configure(options);
export const initI18nService = () => defaultI18nService.init();
export const reloadI18nLocales = () => defaultI18nService.reloadLocales();
export const getI18nState = (opts) => defaultI18nService.getState(opts);
export const setLanguage = (code) => defaultI18nService.setLanguage(code);
