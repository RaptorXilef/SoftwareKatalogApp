import { normalizeProviderCategory, normalizeProviderVersion } from '../../shared/provider-lifecycle-logic.js';
import { getConfig, saveConfig } from '../config.js';
import { archiveProvider } from './archive-provider.js';
import { chocoProvider } from './choco-provider.js';
import { msiProvider } from './msi-provider.js';
import { msstoreProvider } from './msstore-provider.js';
import { scoopProvider } from './scoop-provider.js';
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
  { id: 'npm', name: 'npm', status: 'planned' },
  { id: 'bun', name: 'Bun', status: 'planned' },
  { id: 'pip', name: 'pip', status: 'planned' },
  { id: 'cargo', name: 'Cargo', status: 'planned' },
  { id: 'vcpkg', name: 'vcpkg', status: 'planned' },
  { id: 'dotnet', name: '.NET Tools', status: 'planned' },
  { id: 'powershell', name: 'PowerShell Gallery', status: 'planned' },
];

const registry = new Map();
const availabilityCache = new Map();
let defaultsInitialized = false;

function normalizeCapabilities(raw = {}) {
  const normalized = {};
  for (const key of CAPABILITY_KEYS) {
    normalized[key] = Boolean(raw[key]);
  }
  return normalized;
}

function normalizeAvailabilityResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return { available: false, version: null, binaryPath: null, error: 'Ungültige Verfügbarkeitsantwort.' };
  }
  return {
    available: Boolean(raw.available),
    version: normalizeProviderVersion(raw.version),
    binaryPath: typeof raw.binaryPath === 'string' && raw.binaryPath.trim() ? raw.binaryPath.trim() : null,
    error: typeof raw.error === 'string' && raw.error.trim() ? raw.error.trim() : null,
  };
}

export function registerProvider(provider) {
  if (!provider?.id || !provider?.name) {
    throw new Error('Provider benötigt mindestens "id" und "name".');
  }
  const cleanId = String(provider.id).trim().toLowerCase();
  const cleanName = String(provider.name).trim();
  const rawCheckAvailability =
    typeof provider.checkAvailability === 'function'
      ? provider.checkAvailability.bind(provider)
      : typeof provider.isAvailable === 'function'
        ? provider.isAvailable.bind(provider)
        : async () => ({ available: true, version: null, binaryPath: null, error: null });

  const checkAvailabilityFn = async (opts = {}) => normalizeAvailabilityResult(await rawCheckAvailability(opts));
  const installManagerFn =
    typeof provider.installManager === 'function'
      ? provider.installManager.bind(provider)
      : async () => ({ success: false, error: `${cleanName} unterstützt keine automatische Installation.` });
  const uninstallManagerFn =
    typeof provider.uninstallManager === 'function'
      ? provider.uninstallManager.bind(provider)
      : async () => ({ success: false, error: `${cleanName} unterstützt keine automatische Deinstallation.` });

  const normalized = {
    ...provider,
    id: cleanId,
    name: cleanName,
    category: normalizeProviderCategory(provider.category),
    description: String(provider.description || '').trim(),
    uninstallWarning: String(provider.uninstallWarning || '').trim(),
    requiresAdminForBootstrap: Boolean(provider.requiresAdminForBootstrap),
    canInstallManager: Boolean(provider.canInstallManager),
    canUninstallManager: Boolean(provider.canUninstallManager),
    isSystemComponent: Boolean(provider.isSystemComponent),
    capabilities: normalizeCapabilities(provider.capabilities),
    checkAvailability: checkAvailabilityFn,
    isAvailable: checkAvailabilityFn,
    installManager: installManagerFn,
    uninstallManager: uninstallManagerFn,
  };
  registry.set(cleanId, normalized);
  availabilityCache.delete(cleanId);
  return normalized;
}

export function unregisterProvider(id) {
  const cleanId = String(id || '')
    .trim()
    .toLowerCase();
  availabilityCache.delete(cleanId);
  return registry.delete(cleanId);
}

export function initDefaultProviders() {
  if (defaultsInitialized) return;
  defaultsInitialized = true;
  registerProvider(archiveProvider);
  registerProvider(wingetProvider);
  registerProvider(msstoreProvider);
  registerProvider(scoopProvider);
  registerProvider(chocoProvider);
  registerProvider(msiProvider);
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
      category: p.category,
      description: p.description,
      uninstallWarning: p.uninstallWarning || '',
      requiresAdminForBootstrap: p.requiresAdminForBootstrap,
      canInstallManager: p.canInstallManager,
      canUninstallManager: p.canUninstallManager,
      isSystemComponent: p.isSystemComponent,
      enabled: enabledSet.has(p.id),
      availability: availabilityCache.get(p.id) || null,
      capabilities: { ...p.capabilities },
    })),
    planned: PLANNED_PROVIDERS,
  };
}

export async function checkProviderAvailability(providerId, { signal = null } = {}) {
  const provider = getProvider(providerId);
  if (!provider) {
    return { available: false, version: null, binaryPath: null, error: `Unbekannter Provider "${providerId}".` };
  }
  try {
    const normalized = normalizeAvailabilityResult(await provider.checkAvailability({ signal }));
    const cached = { ...normalized, checkedAt: Date.now() };
    availabilityCache.set(provider.id, cached);
    return cached;
  } catch (err) {
    const failed = {
      available: false,
      version: null,
      binaryPath: null,
      error: err?.message || `Fehler beim Prüfen von ${provider.name}.`,
      checkedAt: Date.now(),
    };
    availabilityCache.set(provider.id, failed);
    return failed;
  }
}

export async function checkAllProvidersAvailability({ signal = null } = {}) {
  initDefaultProviders();
  const all = [...registry.values()];
  const entries = await Promise.all(
    all.map(async (provider) => {
      const status = await checkProviderAvailability(provider.id, { signal });
      return [provider.id, status];
    })
  );
  return {
    success: true,
    results: Object.fromEntries(entries),
    providers: listProvidersInfo().providers,
  };
}

function isProviderUsableForExecution(provider) {
  if (!provider || !isProviderEnabled(provider.id)) return false;
  const cached = availabilityCache.get(provider.id);
  if (cached && cached.available === false) return false;
  return true;
}

export async function searchAcrossProviders(query, { providerIds = null, limit = 25, signal = null } = {}) {
  initDefaultProviders();
  const targets = providerIds
    ? providerIds.map((id) => getProvider(id)).filter((p) => p?.capabilities.search && isProviderUsableForExecution(p))
    : getEnabledProviders().filter((p) => p.capabilities.search && isProviderUsableForExecution(p));

  const settled = await Promise.allSettled(
    targets.map(async (provider) => {
      const res = await provider.search(query, { limit, signal });
      return {
        providerId: provider.id,
        providerName: provider.name,
        success: Boolean(res?.success),
        results: Array.isArray(res?.results) ? res.results : [],
        hint: res?.hint || '',
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
    ? providerIds
        .map((id) => getProvider(id))
        .filter((p) => p?.capabilities.listUpgrades && isProviderUsableForExecution(p))
    : getEnabledProviders().filter((p) => p.capabilities.listUpgrades && isProviderUsableForExecution(p));

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
