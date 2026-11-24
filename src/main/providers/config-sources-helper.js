import {
  isValidSourceName,
  isValidSourceUrl,
  normalizeCustomSourcesList,
  normalizeSourceUrl,
  PROVIDER_SOURCE_TEMPLATES,
} from '../../shared/provider-sources-parser.js';
import { getConfig, saveConfig } from '../config.js';

/**
 * Liefert alle konfigurierten Custom-Registry-Quellen fuer einen Provider (`providerSettings.<id>.customSources`).
 * @param {string} providerId
 * @returns {Array<{ name: string, url: string }>}
 */
export function getConfiguredCustomSources(providerId) {
  const cleanId = String(providerId || '')
    .trim()
    .toLowerCase();
  if (!cleanId) return [];
  const cfg = getConfig();
  return normalizeCustomSourcesList(cfg.providerSettings?.[cleanId]?.customSources);
}

/**
 * Liefert die primaere benutzerdefinierte Registry-URL (erster Eintrag in `customSources`) oder `''`.
 * @param {string} providerId
 * @returns {string}
 */
export function getPrimaryCustomRegistryUrl(providerId) {
  return getConfiguredCustomSources(providerId)[0]?.url || '';
}

/**
 * Liefert zusaetzliche benutzerdefinierte Registry-URLs (ab dem zweiten Eintrag).
 * @param {string} providerId
 * @returns {string[]}
 */
export function getAdditionalCustomRegistryUrls(providerId) {
  return getConfiguredCustomSources(providerId)
    .slice(1)
    .map((entry) => entry.url);
}

/**
 * Erstellt `listSources`, `addSource` und `removeSource` fuer Config-basierte Registry-Provider
 * (`npm`, `bun`, `pnpm`, `pip`, `uv`).
 * @param {{
 *   providerId: string,
 *   defaultSource: { name: string, url: string, description?: string },
 *   templates?: ReadonlyArray<{ name: string, url: string, description?: string }>,
 *   hint?: string,
 * }} options
 */
export function createConfigSourceManager({ providerId, defaultSource, templates = null, hint = '' }) {
  const cleanId = String(providerId || '')
    .trim()
    .toLowerCase();
  const resolvedTemplates = templates || PROVIDER_SOURCE_TEMPLATES[cleanId] || [];

  return {
    async listSources() {
      const customSources = getConfiguredCustomSources(cleanId);
      const hasCustom = customSources.length > 0;
      const sources = [
        ...customSources.map((src, idx) => ({
          name: src.name,
          url: src.url,
          builtIn: false,
          active: idx === 0,
          enabled: true,
        })),
        {
          name: defaultSource.name,
          url: defaultSource.url,
          builtIn: true,
          active: !hasCustom,
          enabled: true,
        },
      ];

      return {
        success: true,
        mode: 'config',
        requiresAdmin: false,
        sources,
        templates: resolvedTemplates,
        hint:
          hint ||
          'Die oberste benutzerdefinierte Quelle wird bei Suche, Detail-Abruf und Installation bevorzugt verwendet.',
      };
    },

    async addSource({ name = '', url = '' } = {}) {
      const cleanName = String(name || '').trim();
      const cleanUrl = normalizeSourceUrl(url);
      if (!isValidSourceName(cleanName)) {
        return {
          success: false,
          error: 'Ungueltiger Quellenname (erlaubt: Buchstaben, Ziffern, Punkt, Unterstrich, Bindestrich).',
        };
      }
      if (!isValidSourceUrl(cleanUrl)) {
        return {
          success: false,
          error: 'Bitte eine gueltige HTTP/HTTPS-URL angeben.',
        };
      }

      const cfg = getConfig();
      const existing = normalizeCustomSourcesList(cfg.providerSettings?.[cleanId]?.customSources);
      const filtered = existing.filter((s) => s.name.toLowerCase() !== cleanName.toLowerCase());
      const nextSources = [{ name: cleanName, url: cleanUrl }, ...filtered];

      const currentProviderEntry =
        cfg.providerSettings?.[cleanId] && typeof cfg.providerSettings[cleanId] === 'object'
          ? { ...cfg.providerSettings[cleanId] }
          : {};
      currentProviderEntry.customSources = nextSources;

      saveConfig({
        providerSettings: {
          ...(cfg.providerSettings || {}),
          [cleanId]: currentProviderEntry,
        },
      });

      return { success: true, source: { name: cleanName, url: cleanUrl } };
    },

    async removeSource(name) {
      const cleanName = String(name || '').trim();
      if (!cleanName) {
        return { success: false, error: 'Kein Quellenname angegeben.' };
      }

      const cfg = getConfig();
      const existing = normalizeCustomSourcesList(cfg.providerSettings?.[cleanId]?.customSources);
      const nextSources = existing.filter((s) => s.name.toLowerCase() !== cleanName.toLowerCase());
      if (nextSources.length === existing.length) {
        return { success: false, error: `Quelle "${cleanName}" wurde nicht gefunden.` };
      }

      const nextProviderSettings = { ...(cfg.providerSettings || {}) };
      const currentEntry =
        nextProviderSettings[cleanId] && typeof nextProviderSettings[cleanId] === 'object'
          ? { ...nextProviderSettings[cleanId] }
          : {};

      if (nextSources.length > 0) {
        currentEntry.customSources = nextSources;
        nextProviderSettings[cleanId] = currentEntry;
      } else {
        delete currentEntry.customSources;
        if (Object.keys(currentEntry).length > 0) {
          nextProviderSettings[cleanId] = currentEntry;
        } else {
          // Entfernen aus config, falls keine weiteren Keys gesetzt sind
          nextProviderSettings[cleanId] = { customSources: [] };
        }
      }

      saveConfig({ providerSettings: nextProviderSettings });
      return { success: true };
    },
  };
}
