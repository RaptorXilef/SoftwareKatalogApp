import { getConfig, saveConfig } from '../config.js';
import { archiveProvider } from './archive-provider.js';
import { getWingetCache, wingetProvider } from './winget-provider.js';

const CAPABILITY_KEYS = [
  'search',
  'listInstalled',
  'listUpgrades',
  'show',
  'install',
  'uninstall',
  'supportsArchiveDownload',
];

/**
 * Strukturell vorbereitete Liste künftiger Paketquellen (noch nicht registriert/implementiert).
 */
export const PLANNED_PROVIDERS = [
  { id: 'scoop', name: 'Scoop', status: 'planned' },
  { id: 'chocolatey', name: 'Chocolatey', status: 'planned' },
  { id: 'npm', name: 'npm', status: 'planned' },
  { id: 'bun', name: 'Bun', status: 'planned' },
  { id: 'pip', name: 'pip', status: 'planned' },
  { id: 'cargo', name: 'Cargo', status: 'planned' },
  { id: 'vcpkg', name: 'vcpkg', status: 'planned' },
  { id: 'dotnet', name: '.NET Tools', status: 'planned' },
  { id: 'powershell', name: 'PowerShell Gallery', status: 'planned' },
  { id: 'msi', name: 'MSI / EXE Lokal', status: 'planned' },
];

const registry = new Map();
let defaultsInitialized = false;

function normalizeCapabilities(raw = {}) {
  const normalized = {};
  for (const key of CAPABILITY_KEYS) {
    normalized[key] = Boolean(raw[key]);
  }
  return normalized;
}

export function registerProvider(provider) {
  if (!provider?.id || !provider?.name) {
    throw new Error('Provider benötigt mindestens "id" und "name".');
  }
  const normalized = {
    ...provider,
    id: String(provider.id).trim().toLowerCase(),
    name: String(provider.name).trim(),
    description: String(provider.description || '').trim(),
    capabilities: normalizeCapabilities(provider.capabilities),
  };
  registry.set(normalized.id, normalized);
  return normalized;
}

export function initDefaultProviders() {
  if (defaultsInitialized) return;
  defaultsInitialized = true;
  registerProvider(archiveProvider);
  registerProvider(wingetProvider);
}

export function getProvider(id) {
  initDefaultProviders();
  if (!id) return null;
  return registry.get(String(id).trim().toLowerCase()) || null;
}

export function isProviderEnabled(id) {
  const { enabledProviders } = getConfig();
  return enabledProviders.includes(String(id).trim().toLowerCase());
}

export function getEnabledProviders() {
  initDefaultProviders();
  const { enabledProviders } = getConfig();
  const enabledSet = new Set(enabledProviders.map((p) => p.toLowerCase()));
  return [...registry.values()].filter((p) => enabledSet.has(p.id));
}

export function setProviderEnabled(id, enabled) {
  initDefaultProviders();
  const cleanId = String(id || '')
    .trim()
    .toLowerCase();
  if (!registry.has(cleanId)) {
    return { success: false, error: `Unbekannter Provider "${id}".` };
  }

  const { enabledProviders } = getConfig();
  const next = new Set(enabledProviders.map((p) => p.toLowerCase()));
  if (enabled) next.add(cleanId);
  else next.delete(cleanId);

  const updatedList = [...next];
  saveConfig({ enabledProviders: updatedList });
  return { success: true, enabledProviders: updatedList };
}

export function listProvidersInfo() {
  initDefaultProviders();
  const { enabledProviders } = getConfig();
  const enabledSet = new Set(enabledProviders.map((p) => p.toLowerCase()));

  return {
    providers: [...registry.values()].map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      enabled: enabledSet.has(p.id),
      capabilities: { ...p.capabilities },
    })),
    planned: PLANNED_PROVIDERS,
  };
}

export async function checkProviderAvailability(providerId) {
  const provider = getProvider(providerId);
  if (!provider) return { available: false, error: `Unbekannter Provider "${providerId}".` };
  if (typeof provider.isAvailable !== 'function') return { available: true };
  return provider.isAvailable();
}

export async function searchAcrossProviders(query, { providerIds = null, limit = 25, signal = null } = {}) {
  initDefaultProviders();
  const targets = providerIds
    ? providerIds.map((id) => getProvider(id)).filter((p) => p?.capabilities.search)
    : getEnabledProviders().filter((p) => p.capabilities.search);

  const settled = await Promise.allSettled(
    targets.map(async (provider) => {
      const res = await provider.search(query, { limit, signal });
      return {
        providerId: provider.id,
        providerName: provider.name,
        success: Boolean(res?.success),
        results: Array.isArray(res?.results) ? res.results : [],
        error: res?.error || null,
      };
    })
  );

  const byProvider = {};
  const combined = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      byProvider[target.id] = outcome.value;
      for (const item of outcome.value.results) {
        combined.push({ ...item, providerId: target.id, providerName: target.name });
      }
    } else {
      byProvider[target.id] = {
        providerId: target.id,
        providerName: target.name,
        success: false,
        results: [],
        error: outcome.reason?.message || 'Suchfehler',
      };
    }
  }

  return { success: true, results: combined, byProvider };
}

export async function showPackage(providerId, packageId, opts = {}) {
  const provider = getProvider(providerId);
  if (!provider?.capabilities.show || typeof provider.show !== 'function') {
    return { success: false, error: `Provider "${providerId}" unterstützt kein Paket-Details-Abrufen.` };
  }
  return provider.show(packageId, opts);
}

export async function listUpgradesAcrossProviders({ providerIds = null, signal = null } = {}) {
  initDefaultProviders();
  const targets = providerIds
    ? providerIds.map((id) => getProvider(id)).filter((p) => p?.capabilities.listUpgrades)
    : getEnabledProviders().filter((p) => p.capabilities.listUpgrades);

  const settled = await Promise.allSettled(
    targets.map(async (provider) => {
      const res = await provider.listUpgrades({ signal });
      return {
        providerId: provider.id,
        success: Boolean(res?.success),
        upgrades: Array.isArray(res?.upgrades) ? res.upgrades : [],
        error: res?.error || null,
      };
    })
  );

  const upgrades = [];
  const byProvider = {};
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      byProvider[target.id] = outcome.value;
      upgrades.push(...outcome.value.upgrades);
    } else {
      byProvider[target.id] = {
        providerId: target.id,
        success: false,
        upgrades: [],
        error: outcome.reason?.message || 'Fehler bei Update-Prüfung',
      };
    }
  }

  return { success: true, upgrades, byProvider };
}

export async function installPackage(providerId, packageId, opts = {}) {
  const provider = getProvider(providerId);
  if (!provider?.capabilities.install || typeof provider.install !== 'function') {
    return { success: false, error: `Provider "${providerId}" unterstützt keine Installation.` };
  }
  if (!isProviderEnabled(provider.id)) {
    return { success: false, error: `Provider "${provider.name}" ist derzeit deaktiviert.` };
  }
  return provider.install(packageId, opts);
}

export async function uninstallPackage(providerId, packageId, opts = {}) {
  const provider = getProvider(providerId);
  if (!provider?.capabilities.uninstall || typeof provider.uninstall !== 'function') {
    return { success: false, error: `Provider "${providerId}" unterstützt keine Deinstallation.` };
  }
  return provider.uninstall(packageId, opts);
}

export function getProviderCacheStats() {
  const stats = getWingetCache().getStats();
  return {
    success: true,
    totalEntries: stats.totalEntries,
    expiredEntries: stats.expiredEntries,
    ttlMs: stats.ttlMs,
    filePath: stats.filePath,
  };
}

export function clearProviderCache() {
  getWingetCache().clear();
  return {
    success: true,
    totalEntries: 0,
    expiredEntries: 0,
  };
}
