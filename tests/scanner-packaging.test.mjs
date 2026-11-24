import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveScannerAppDir } from '../src/shared/scanner-path-logic.js';

const ROOT_DIR = process.cwd();
const BUNDLED_SCANNER_PATH = path.join(ROOT_DIR, 'out', 'scanner', 'scanner.mjs');
const UNPACKED_DIR = path.join(ROOT_DIR, 'dist', 'win-unpacked');
const UNPACKED_EXE = path.join(UNPACKED_DIR, 'Software Katalog.exe');
const UNPACKED_RESOURCES_DIR = path.join(UNPACKED_DIR, 'resources');
const UNPACKED_SCANNER = path.join(UNPACKED_RESOURCES_DIR, 'scanner.mjs');
const UNPACKED_WORKER = path.join(UNPACKED_RESOURCES_DIR, 'elevated-worker.mjs');
const UNPACKED_ICON = path.join(UNPACKED_RESOURCES_DIR, 'icon.ico');

function runElectronAsNode(exePath, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, {
      shell: false,
      windowsHide: true,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

describe('scanner-packaging: APP_DIR-Aufloesung, extraResources und Standalone-Bundle', () => {
  it('loest APP_DIR fuer Dev, Build, Packaged resources/ und Env-Overrides korrekt auf', () => {
    assert.equal(
      resolveScannerAppDir(
        'Z:\\SoftwareKatalogApp\\resources',
        { SK_APP_DIR: 'D:\\CustomApp', PORTABLE_EXECUTABLE_DIR: 'E:\\Portable' },
        { pathApi: path.win32 }
      ),
      'D:\\CustomApp'
    );

    assert.equal(
      resolveScannerAppDir(
        'Z:\\SoftwareKatalogApp\\resources',
        { PORTABLE_EXECUTABLE_DIR: 'E:\\Portable' },
        { pathApi: path.win32 }
      ),
      'E:\\Portable'
    );

    assert.equal(
      resolveScannerAppDir('Z:\\SoftwareKatalogApp\\resources', {}, { pathApi: path.win32 }),
      'Z:\\SoftwareKatalogApp'
    );
    assert.equal(resolveScannerAppDir('C:\\repo\\src\\scanner', {}, { pathApi: path.win32 }), 'C:\\repo');
    assert.equal(resolveScannerAppDir('C:\\repo\\out\\scanner', {}, { pathApi: path.win32 }), 'C:\\repo');
    assert.equal(
      resolveScannerAppDir('Z:\\SoftwareKatalogApp\\resources\\scanner', {}, { pathApi: path.win32 }),
      'Z:\\SoftwareKatalogApp'
    );
    assert.equal(resolveScannerAppDir('Z:\\SoftwareKatalogApp', {}, { pathApi: path.win32 }), 'Z:\\SoftwareKatalogApp');

    assert.equal(
      resolveScannerAppDir('/opt/software-katalog/resources', {}, { pathApi: path.posix }),
      '/opt/software-katalog'
    );
    assert.equal(resolveScannerAppDir('/workspace/src/scanner', {}, { pathApi: path.posix }), '/workspace');
  });

  it('konfiguriert extraResources vollstaendig und haelt elevated-worker.mjs ohne relative Imports', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    const extraResources = pkg?.build?.extraResources || [];
    const filesConfig = pkg?.build?.files || [];

    assert.ok(filesConfig.includes('!out/scanner/**/*'));
    assert.ok(extraResources.some((r) => r.from === 'out/scanner/scanner.mjs' && r.to === 'scanner.mjs'));
    assert.ok(extraResources.some((r) => r.from === 'src/main/elevated-worker.mjs' && r.to === 'elevated-worker.mjs'));
    assert.ok(extraResources.some((r) => r.from === 'build/icon.ico' && r.to === 'icon.ico'));

    const workerSrcPath = path.join(ROOT_DIR, 'src', 'main', 'elevated-worker.mjs');
    const iconSrcPath = path.join(ROOT_DIR, 'build', 'icon.ico');
    assert.equal(fs.existsSync(workerSrcPath), true);
    assert.equal(fs.existsSync(iconSrcPath), true);

    const workerSource = fs.readFileSync(workerSrcPath, 'utf8');
    assert.doesNotMatch(workerSource, /\bfrom\s+['"]\.\.?\//);
    assert.doesNotMatch(workerSource, /\bimport\s*\(\s*['"]\.\.?\//);
  });

  it('erzeugt out/scanner/scanner.mjs als eigenstaendiges ESM-Bundle ohne relative Imports', (t) => {
    if (!fs.existsSync(BUNDLED_SCANNER_PATH)) {
      t.skip('out/scanner/scanner.mjs wurde noch nicht gebaut (npm run build:vite ausfuehren).');
      return;
    }

    const bundleSource = fs.readFileSync(BUNDLED_SCANNER_PATH, 'utf8');
    assert.match(bundleSource, /from\s+['"]node:fs['"]/);
    assert.match(bundleSource, /from\s+['"]node:path['"]/);
    assert.doesNotMatch(bundleSource, /\bfrom\s+['"]\.\.?\//);
    assert.doesNotMatch(bundleSource, /\bimport\s*\(\s*['"]\.\.?\//);
    assert.doesNotMatch(bundleSource, /\brequire\s*\(\s*['"]\.\.?\//);
  });
});

describe('dist/win-unpacked: Verifikation der gepackten Ressourcen mit ELECTRON_RUN_AS_NODE=1', () => {
  it('enthaelt alle deklarierten extraResources in dist/win-unpacked/resources', (t) => {
    if (!fs.existsSync(UNPACKED_EXE) || !fs.existsSync(UNPACKED_SCANNER)) {
      t.skip('dist/win-unpacked ist noch nicht gebaut (npm run build:dir ausfuehren).');
      return;
    }

    assert.equal(fs.existsSync(UNPACKED_SCANNER), true);
    assert.equal(fs.existsSync(UNPACKED_WORKER), true);
    assert.equal(fs.existsSync(UNPACKED_ICON), true);
  });

  it('fuehrt gepackte resources/scanner.mjs mit SK_APP_DIR und SK_DATA_DIR fehlerfrei via ELECTRON_RUN_AS_NODE=1 aus', async (t) => {
    if (!fs.existsSync(UNPACKED_EXE) || !fs.existsSync(UNPACKED_SCANNER)) {
      t.skip('dist/win-unpacked ist noch nicht gebaut (npm run build:dir ausfuehren).');
      return;
    }

    const tmpApp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-packed-scan-'));
    t.after(() => {
      fs.rmSync(tmpApp, { recursive: true, force: true });
    });

    const tmpData = path.join(tmpApp, 'data');
    const tmpSoftware = path.join(tmpApp, 'software');
    const demoDir = path.join(tmpSoftware, 'DemoTool');
    const demoMetaDir = path.join(demoDir, '_metadata');

    fs.mkdirSync(tmpData, { recursive: true });
    fs.mkdirSync(demoMetaDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpData, 'config.json'),
      JSON.stringify({ archivePaths: ['software'], jsonPath: 'catalog.json' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(demoMetaDir, 'meta.json'),
      JSON.stringify({ name: 'DemoTool', category: 'Tools' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(demoDir, 'DemoTool_v1.0.exe'), 'dummy', 'utf8');

    const res = await runElectronAsNode(UNPACKED_EXE, [UNPACKED_SCANNER, '--single', demoDir], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SK_APP_DIR: tmpApp,
      SK_DATA_DIR: tmpData,
    });

    assert.equal(res.code, 0, `Stderr: ${res.stderr}`);
    assert.equal(res.stderr.trim(), '');
    assert.match(res.stdout, /SINGLE_OK:/);

    const catalog = JSON.parse(fs.readFileSync(path.join(tmpData, 'catalog.json'), 'utf8'));
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].name, 'DemoTool');
    assert.deepEqual(catalog[0].lastFiles, [path.join('software', 'DemoTool', 'DemoTool_v1.0.exe')]);
  });

  it('loest APP_DIR in gepacktem resources/scanner.mjs auch ohne SK_APP_DIR/SK_DATA_DIR korrekt auf', async (t) => {
    if (!fs.existsSync(UNPACKED_EXE) || !fs.existsSync(UNPACKED_SCANNER)) {
      t.skip('dist/win-unpacked ist noch nicht gebaut (npm run build:dir ausfuehren).');
      return;
    }

    const tmpFallbackApp = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-packed-fallback-'));
    t.after(() => {
      fs.rmSync(tmpFallbackApp, { recursive: true, force: true });
    });

    const resourcesDir = path.join(tmpFallbackApp, 'resources');
    const copiedScanner = path.join(resourcesDir, 'scanner.mjs');
    const dataDir = path.join(tmpFallbackApp, 'data');
    const fallbackAppDir = path.join(tmpFallbackApp, 'software', 'FallbackApp');
    const fallbackMetaDir = path.join(fallbackAppDir, '_metadata');

    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(fallbackMetaDir, { recursive: true });
    fs.copyFileSync(UNPACKED_SCANNER, copiedScanner);

    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({ archivePaths: ['software'], jsonPath: 'catalog.json' }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(fallbackMetaDir, 'meta.json'),
      JSON.stringify({ name: 'FallbackApp', category: 'Utilities' }, null, 2),
      'utf8'
    );

    /** @type {NodeJS.ProcessEnv} */
    const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete childEnv.SK_APP_DIR;
    delete childEnv.SK_DATA_DIR;
    delete childEnv.PORTABLE_EXECUTABLE_DIR;

    const res = await runElectronAsNode(UNPACKED_EXE, [copiedScanner, '--single', fallbackAppDir], childEnv);

    assert.equal(res.code, 0, `Stderr: ${res.stderr}`);
    assert.equal(res.stderr.trim(), '');
    assert.match(res.stdout, /SINGLE_OK:/);

    const catalogPath = path.join(dataDir, 'catalog.json');
    assert.equal(fs.existsSync(catalogPath), true);
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].name, 'FallbackApp');
  });

  it('laedt gepackte resources/elevated-worker.mjs ohne Modul- oder Typeless-Warnungen', async (t) => {
    if (!fs.existsSync(UNPACKED_EXE) || !fs.existsSync(UNPACKED_WORKER)) {
      t.skip('dist/win-unpacked ist noch nicht gebaut (npm run build:dir ausfuehren).');
      return;
    }

    const res = await runElectronAsNode(UNPACKED_EXE, [UNPACKED_WORKER], {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    });

    // Ohne Konfig-Pfad beendet sich elevated-worker.mjs geordnet mit Exit-Code 2
    assert.equal(res.code, 2);
    assert.equal(res.stderr.trim(), '');
  });
});
