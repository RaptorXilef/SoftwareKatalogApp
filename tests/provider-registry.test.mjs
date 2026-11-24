import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-provider-registry-'));
const appDir = path.join(tempRoot, 'app');
const dataDir = path.join(appDir, 'data');
const userDataDir = path.join(tempRoot, 'userData');
const tempSubDir = path.join(tempRoot, 'temp');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(userDataDir, { recursive: true });
fs.mkdirSync(tempSubDir, { recursive: true });

const electronMockUrl = 'mock://electron';
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

const {
  PLANNED_PROVIDERS,
  registerProvider,
  getProvider,
  isProviderEnabled,
  getEnabledProviders,
  setProviderEnabled,
  listProvidersInfo,
} = await import('../src/main/providers/registry.js');

describe('provider-registry', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ enabledProviders: ['winget', 'archive'] }, null, 2),
      'utf-8'
    );
    fs.writeFileSync(
      path.join(userDataDir, 'state.json'),
      JSON.stringify({ lastUpdateCheck: 0, favorites: [], installedVersions: {} }, null, 2),
      'utf-8'
    );
  });

  after(() => {
    electronHook.deregister();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('enthält geplante zukünftige Paketmanager in PLANNED_PROVIDERS', () => {
    assert.ok(Array.isArray(PLANNED_PROVIDERS));
    const ids = PLANNED_PROVIDERS.map((p) => p.id);
    assert.ok(ids.includes('scoop'));
    assert.ok(ids.includes('chocolatey'));
    assert.ok(ids.includes('npm'));
    assert.ok(ids.includes('pip'));
    assert.ok(ids.includes('cargo'));
    for (const entry of PLANNED_PROVIDERS) {
      assert.equal(typeof entry.id, 'string');
      assert.equal(typeof entry.name, 'string');
      assert.equal(entry.status, 'planned');
    }
  });

  it('validiert Pflichtfelder und normalisiert ID sowie Capabilities beim Registrieren', () => {
    assert.throws(() => registerProvider({ name: 'Ohne ID' }), /id.*name/i);
    assert.throws(() => registerProvider({ id: 'no-name' }), /id.*name/i);

    const registered = registerProvider({
      id: '  TestPM  ',
      name: '  Test Package Manager  ',
      description: '  Testbeschreibung  ',
      capabilities: {
        search: 1,
        install: true,
      },
    });

    assert.equal(registered.id, 'testpm');
    assert.equal(registered.name, 'Test Package Manager');
    assert.equal(registered.description, 'Testbeschreibung');
    assert.deepEqual(registered.capabilities, {
      search: true,
      listInstalled: false,
      listUpgrades: false,
      show: false,
      install: true,
      uninstall: false,
      supportsArchiveDownload: false,
    });

    const fetched = getProvider('  TESTPM ');
    assert.ok(fetched);
    assert.equal(fetched.id, 'testpm');
    assert.equal(fetched.capabilities.search, true);
    assert.equal(fetched.capabilities.supportsArchiveDownload, false);
  });

  it('aktiviert und deaktiviert Provider sauber über isProviderEnabled, setProviderEnabled, getEnabledProviders und listProvidersInfo', () => {
    registerProvider({
      id: 'scoop',
      name: 'Scoop',
      description: 'Kommandozeilen-Installer für Windows',
      capabilities: { search: true, install: true, uninstall: true },
    });

    assert.equal(isProviderEnabled('winget'), true);
    assert.equal(isProviderEnabled('archive'), true);
    assert.equal(isProviderEnabled('scoop'), false);

    const enableRes = setProviderEnabled('scoop', true);
    assert.equal(enableRes.success, true);
    assert.equal(isProviderEnabled('scoop'), true);
    assert.ok(getEnabledProviders().some((p) => p.id === 'scoop'));

    const infoEnabled = listProvidersInfo();
    const scoopInfo = infoEnabled.providers.find((p) => p.id === 'scoop');
    assert.ok(scoopInfo);
    assert.equal(scoopInfo.enabled, true);
    assert.equal(scoopInfo.capabilities.search, true);
    assert.equal(scoopInfo.capabilities.install, true);
    assert.equal(scoopInfo.capabilities.show, false);
    assert.equal(infoEnabled.planned, PLANNED_PROVIDERS);

    const disableRes = setProviderEnabled('scoop', false);
    assert.equal(disableRes.success, true);
    assert.equal(isProviderEnabled('scoop'), false);
    assert.equal(
      getEnabledProviders().some((p) => p.id === 'scoop'),
      false
    );

    const unknownRes = setProviderEnabled('unbekannt-pm', true);
    assert.equal(unknownRes.success, false);
    assert.match(unknownRes.error, /Unbekannter Provider/i);
  });
});
