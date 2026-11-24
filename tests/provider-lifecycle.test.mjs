import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-provider-lifecycle-'));
const appDir = path.join(tempRoot, 'app');
const dataDir = path.join(appDir, 'data');
const userDataDir = path.join(tempRoot, 'userData');
const tempSubDir = path.join(tempRoot, 'temp');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(tempSubDir, { recursive: true });

const electronMockUrl = 'mock://electron-lifecycle';
const electronMockSource = `
  const appDir = ${JSON.stringify(appDir)};
  const userDataDir = ${JSON.stringify(userDataDir)};
  const tempDir = ${JSON.stringify(tempSubDir)};

  export const app = {
    isPackaged: false,
    getAppPath: () => appDir,
    getPath: (name) => {
      if (name === 'userData') return userDataDir;
      if (name === 'temp') return tempDir;
      return appDir;
    },
  };
  export const BrowserWindow = { getAllWindows: () => [] };
  export const dialog = {};
  export const ipcMain = { handle: () => {}, on: () => {} };
  export const net = {};
  export const protocol = {};
  export const session = { fromPartition: () => ({ on: () => {}, off: () => {} }) };
  export const shell = {};
`;

const electronHook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: electronMockUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === electronMockUrl) {
      return {
        format: 'module',
        shortCircuit: true,
        source: electronMockSource,
      };
    }
    return nextLoad(url, context);
  },
});

const { getConfig, saveConfig } = await import('../src/main/config.js');
const { runCli } = await import('../src/main/providers/cli-runner.js');
const { createCliAvailabilityChecker, installProviderManager, uninstallProviderManager } = await import(
  '../src/main/providers/manager-bootstrap.js'
);
const {
  checkAllProvidersAvailability,
  checkProviderAvailability,
  getEnabledProviders,
  installPackage,
  isProviderEnabled,
  listProvidersInfo,
  listUpgradesAcrossProviders,
  registerProvider,
  searchAcrossProviders,
  setProviderEnabled,
  unregisterProvider,
} = await import('../src/main/providers/registry.js');
const { filterUsableProviders, formatProviderStatusBadge, groupProvidersByUiCategory } = await import(
  '../src/shared/provider-lifecycle-logic.js'
);

const customRegisteredIds = new Set();

function registerTestProvider(def) {
  const normalized = registerProvider(def);
  customRegisteredIds.add(normalized.id);
  return normalized;
}

describe('provider-lifecycle', () => {
  beforeEach(() => {
    for (const id of customRegisteredIds) {
      unregisterProvider(id);
    }
    customRegisteredIds.clear();

    const cfgFile = path.join(dataDir, 'config.json');
    if (fs.existsSync(cfgFile)) fs.unlinkSync(cfgFile);
    const stateFile = path.join(userDataDir, 'state.json');
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  });

  after(() => {
    electronHook.deregister();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('aktiviert standardmäßig nur winget + archive und initialisiert providerSettings', () => {
    const cfg = getConfig();
    assert.deepEqual(cfg.enabledProviders, ['winget', 'archive']);
    assert.deepEqual(cfg.providerSettings, { vcpkgRoot: '' });

    registerTestProvider({
      id: 'scoop',
      name: 'Scoop',
      category: 'system',
      description: 'Portable Kommandozeilen-Apps für Windows',
      canInstallManager: true,
      canUninstallManager: true,
      capabilities: { search: true },
    });
    registerTestProvider({
      id: 'chocolatey',
      name: 'Chocolatey',
      category: 'system',
      requiresAdminForBootstrap: true,
      canInstallManager: true,
      canUninstallManager: true,
      capabilities: { search: true },
    });
    registerTestProvider({
      id: 'npm',
      name: 'npm',
      category: 'runtime',
      capabilities: { search: true },
    });
    registerTestProvider({
      id: 'powershell5',
      name: 'PowerShell Gallery',
      category: 'system',
      isSystemComponent: true,
      canInstallManager: false,
      canUninstallManager: false,
    });

    assert.equal(isProviderEnabled('winget'), true);
    assert.equal(isProviderEnabled('archive'), true);
    assert.equal(isProviderEnabled('scoop'), false);
    assert.equal(isProviderEnabled('chocolatey'), false);
    assert.equal(isProviderEnabled('npm'), false);
    assert.equal(isProviderEnabled('powershell5'), false);

    saveConfig({ providerSettings: { vcpkgRoot: '  C:\\tools\\vcpkg  ' } });
    const reloaded = getConfig();
    assert.equal(reloaded.providerSettings.vcpkgRoot, 'C:\\tools\\vcpkg');
    assert.deepEqual(reloaded.enabledProviders, ['winget', 'archive']);
  });

  it('aktiviert/deaktiviert Provider und blockiert deaktivierte Manager bei Suche, Upgrades und Installation', async () => {
    let searchCalls = 0;
    let upgradeCalls = 0;
    let installCalls = 0;

    registerTestProvider({
      id: 'mockpm',
      name: 'MockPM',
      category: 'developer',
      description: 'Test-Paketmanager',
      requiresAdminForBootstrap: false,
      canInstallManager: true,
      canUninstallManager: true,
      capabilities: { search: true, listUpgrades: true, install: true },
      checkAvailability: async () => ({ available: true, version: 'v2.4.1', binaryPath: 'C:\\mock\\mockpm.exe' }),
      search: async () => {
        searchCalls++;
        return { success: true, results: [{ name: 'MockPkg', packageId: 'mock.pkg', version: '1.0.0' }] };
      },
      listUpgrades: async () => {
        upgradeCalls++;
        return { success: true, upgrades: [{ packageManager: 'mockpm', packageId: 'mock.pkg', name: 'MockPkg' }] };
      },
      install: async () => {
        installCalls++;
        return { success: true };
      },
    });

    assert.equal(isProviderEnabled('mockpm'), false);

    // Deaktivierter Provider darf auch bei expliziter Angabe nicht ausgeführt werden
    const disabledSearch = await searchAcrossProviders('mock', { providerIds: ['mockpm'] });
    assert.equal(disabledSearch.results.length, 0);
    assert.equal(searchCalls, 0);

    const disabledUpgrades = await listUpgradesAcrossProviders({ providerIds: ['mockpm'] });
    assert.equal(disabledUpgrades.upgrades.length, 0);
    assert.equal(upgradeCalls, 0);

    const disabledInstall = await installPackage('mockpm', 'mock.pkg');
    assert.equal(disabledInstall.success, false);
    assert.match(disabledInstall.error, /deaktiviert/i);
    assert.equal(installCalls, 0);

    // Aktivieren
    const enableRes = setProviderEnabled('mockpm', true);
    assert.equal(enableRes.success, true);
    assert.equal(isProviderEnabled('mockpm'), true);
    assert.ok(getEnabledProviders().some((p) => p.id === 'mockpm'));

    const enabledSearch = await searchAcrossProviders('mock', { providerIds: ['mockpm'] });
    assert.equal(enabledSearch.results.length, 1);
    assert.equal(searchCalls, 1);

    const enabledUpgrades = await listUpgradesAcrossProviders({ providerIds: ['mockpm'] });
    assert.equal(enabledUpgrades.upgrades.length, 1);
    assert.equal(upgradeCalls, 1);

    const enabledInstall = await installPackage('mockpm', 'mock.pkg');
    assert.equal(enabledInstall.success, true);
    assert.equal(installCalls, 1);

    // Wieder deaktivieren
    const disableRes = setProviderEnabled('mockpm', false);
    assert.equal(disableRes.success, true);
    assert.equal(isProviderEnabled('mockpm'), false);
  });

  it('behandelt fehlende Binaries, AbortSignal und fehlerhafte checkAvailability-Hooks sauber ohne Absturz', async () => {
    const missingCliRes = await runCli('__sk_nonexistent_binary_987654__', ['--version'], { timeoutMs: 3000 });
    assert.equal(missingCliRes.code, -1);
    assert.equal(missingCliRes.notFound, true);
    assert.equal(missingCliRes.aborted, false);

    const ac = new AbortController();
    ac.abort();
    const abortedRes = await runCli('node', ['--version'], { signal: ac.signal });
    assert.equal(abortedRes.aborted, true);
    assert.equal(abortedRes.code, -1);

    const missingChecker = createCliAvailabilityChecker({
      binary: '__sk_nonexistent_binary_987654__',
      notFoundMessage: 'Test-Manager fehlt auf diesem PC.',
    });
    const missingStatus = await missingChecker();
    assert.deepEqual(missingStatus, {
      available: false,
      version: null,
      binaryPath: null,
      error: 'Test-Manager fehlt auf diesem PC.',
    });

    registerTestProvider({
      id: 'brokenpm',
      name: 'BrokenPM',
      category: 'runtime',
      checkAvailability: async () => {
        throw new Error('CLI abgestürzt');
      },
    });
    registerTestProvider({
      id: 'missingpm',
      name: 'MissingPM',
      category: 'developer',
      canInstallManager: true,
      checkAvailability: missingChecker,
    });

    const singleCheck = await checkProviderAvailability('brokenpm');
    assert.equal(singleCheck.available, false);
    assert.equal(singleCheck.version, null);
    assert.match(singleCheck.error, /CLI abgestürzt/);

    const unknownCheck = await checkProviderAvailability('does-not-exist');
    assert.equal(unknownCheck.available, false);
    assert.match(unknownCheck.error, /Unbekannter Provider/);

    const allRes = await checkAllProvidersAvailability();
    assert.equal(allRes.success, true);
    assert.equal(allRes.results.brokenpm.available, false);
    assert.equal(allRes.results.missingpm.available, false);
    assert.equal(allRes.results.missingpm.error, 'Test-Manager fehlt auf diesem PC.');

    const info = listProvidersInfo();
    const missingEntry = info.providers.find((p) => p.id === 'missingpm');
    assert.ok(missingEntry);
    assert.equal(missingEntry.availability?.available, false);
  });

  it('orchestriert installProviderManager & uninstallProviderManager über Jobs mit automatischer Re-Prüfung', async () => {
    let installedState = false;
    const jobEvents = [];

    registerTestProvider({
      id: 'bootpm',
      name: 'BootPM',
      category: 'system',
      requiresAdminForBootstrap: true,
      canInstallManager: true,
      canUninstallManager: true,
      checkAvailability: async () =>
        installedState
          ? { available: true, version: 'v1.4.0', binaryPath: 'C:\\tools\\bootpm.exe', error: null }
          : { available: false, version: null, binaryPath: null, error: 'Nicht installiert' },
      installManager: async ({ onProgress }) => {
        onProgress?.(50, 'Installiere BootPM...');
        installedState = true;
        return { success: true };
      },
      uninstallManager: async ({ onProgress }) => {
        onProgress?.(50, 'Entferne BootPM...');
        installedState = false;
        return { success: true };
      },
    });

    registerTestProvider({
      id: 'sysonly',
      name: 'Windows-Komponente',
      category: 'system',
      isSystemComponent: true,
      canInstallManager: false,
      canUninstallManager: false,
    });

    const createMockJob = (opts) => {
      const controller = new AbortController();
      const entry = { opts, updates: [], finished: null };
      jobEvents.push(entry);
      return {
        id: `job-${jobEvents.length}`,
        signal: controller.signal,
        update(pct, detail) {
          entry.updates.push({ pct, detail });
        },
        finish(status, detail) {
          entry.finished = { status, detail };
        },
      };
    };

    const blockedInstall = await installProviderManager('sysonly', { createJobFn: createMockJob });
    assert.equal(blockedInstall.success, false);
    assert.equal(jobEvents.length, 0);

    const blockedUninstall = await uninstallProviderManager('sysonly', { createJobFn: createMockJob });
    assert.equal(blockedUninstall.success, false);
    assert.equal(jobEvents.length, 0);

    const installRes = await installProviderManager('bootpm', { createJobFn: createMockJob });
    assert.equal(installRes.success, true);
    assert.equal(installRes.availability?.available, true);
    assert.equal(installRes.availability?.version, '1.4.0');
    assert.equal(jobEvents[0].opts.type, 'provider-install');
    assert.equal(jobEvents[0].finished?.status, 'done');

    const uninstallRes = await uninstallProviderManager('bootpm', { createJobFn: createMockJob });
    assert.equal(uninstallRes.success, true);
    assert.equal(uninstallRes.availability?.available, false);
    assert.equal(jobEvents[1].opts.type, 'provider-uninstall');
    assert.equal(jobEvents[1].finished?.status, 'done');
  });

  it('gruppiert Provider für die UI, formatiert Status-Badges sauber und filtert nicht nutzbare Quellen heraus', () => {
    const sampleProviders = [
      { id: 'archive', name: 'Archiv', category: 'archive', enabled: true, availability: { available: true } },
      {
        id: 'winget',
        name: 'Winget',
        category: 'system',
        enabled: true,
        availability: { available: true, version: 'v1.9.25200' },
      },
      {
        id: 'powershell5',
        name: 'PowerShell',
        category: 'system',
        isSystemComponent: true,
        enabled: false,
        availability: { available: true, version: '5.1' },
      },
      {
        id: 'npm',
        name: 'npm',
        category: 'runtime',
        enabled: true,
        capabilities: { search: true },
        availability: { available: false, error: 'npm fehlt' },
      },
      {
        id: 'vcpkg',
        name: 'vcpkg',
        category: 'developer',
        enabled: true,
        capabilities: { search: true },
        availability: { available: true, version: '2025.01' },
      },
    ];

    const groups = groupProvidersByUiCategory(sampleProviders);
    assert.deepEqual(
      groups.map((g) => g.label),
      ['System', 'Sprachen & Entwickler', 'Archiv']
    );
    assert.deepEqual(
      groups[1].providers.map((p) => p.id),
      ['npm', 'vcpkg']
    );

    assert.equal(
      formatProviderStatusBadge(sampleProviders[1], sampleProviders[1].availability).text,
      '🟢 Installiert v1.9.25200'
    );
    assert.equal(
      formatProviderStatusBadge(sampleProviders[2], sampleProviders[2].availability).text,
      '🔒 Systemkomponente v5.1'
    );
    assert.equal(
      formatProviderStatusBadge(sampleProviders[3], sampleProviders[3].availability).text,
      '⚪ Nicht installiert'
    );
    assert.equal(formatProviderStatusBadge(sampleProviders[0], null).text, '⏳ Prüfe...');

    const usableSearch = filterUsableProviders(sampleProviders, { capability: 'search' });
    assert.deepEqual(
      usableSearch.map((p) => p.id),
      ['vcpkg']
    );
  });
});
