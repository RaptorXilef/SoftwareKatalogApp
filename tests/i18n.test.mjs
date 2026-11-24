import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createI18nService, loadLocalesFromDirs } from '../src/main/i18n-core.js';
import { formatInstallModeInfo } from '../src/shared/app-update-logic.js';
import { formatBytes } from '../src/shared/archive-cleaner-logic.js';
import { evaluateBundleStatus, planBundleExecution } from '../src/shared/bundles-logic.js';
import {
  createI18n,
  extractLocaleMeta,
  flattenMessages,
  interpolate,
  normalizeConfiguredLanguage,
  normalizeLocaleCode,
  resolveEffectiveLocale,
} from '../src/shared/i18n.js';
import { detectAdwareSignals, detectInstallerFromBuffer } from '../src/shared/installer-logic.js';
import { evaluatePackagePolicy } from '../src/shared/policy-logic.js';
import { formatProviderStatusBadge, groupProvidersByUiCategory } from '../src/shared/provider-lifecycle-logic.js';

const ROOT_DIR = process.cwd();
const BUILTIN_LOCALES_DIR = path.join(ROOT_DIR, 'src', 'locales');
const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-i18n-test-'));
  tempDirs.push(dir);
  return dir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function extractPlaceholders(text) {
  const matches = new Set();
  for (const m of String(text).matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    matches.add(m[1]);
  }
  return Array.from(matches).sort();
}

function hasBalancedBraces(text) {
  let depth = 0;
  for (const ch of String(text)) {
    if (ch === '{') {
      if (depth > 0) return false;
      depth++;
    } else if (ch === '}') {
      if (depth === 0) return false;
      depth--;
    }
  }
  return depth === 0;
}

function collectJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'locales') continue;
      out.push(...collectJsFiles(full));
    } else if (entry.isFile() && /\.(?:js|mjs)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

describe('i18n-core: interpolation, fallback chain, and locale resolution', () => {
  it('interpolates placeholders including 0 and preserves missing tokens', () => {
    assert.equal(interpolate('Found {count} updates for {name}', { count: 0, name: 'VLC' }), 'Found 0 updates for VLC');
    assert.equal(interpolate('v{version} - {version}', { version: '1.2.3' }), 'v1.2.3 - 1.2.3');
    assert.equal(interpolate('Hello {missing}', {}), 'Hello {missing}');
    assert.equal(interpolate('Hello {name}', { name: null }), 'Hello {name}');
  });

  it('follows strict fallback chain: active locale -> English -> key name', () => {
    const enDict = {
      app: { title: 'Software Catalog' },
      batch: { selectedOfTotal: '{selected} of {total} selected' },
      onlyEn: 'English fallback text',
    };
    const frDict = {
      app: { title: 'Catalogue Logiciel' },
    };

    const instance = createI18n({
      locale: 'fr',
      configuredLanguage: 'fr',
      messages: frDict,
      fallbackMessages: enDict,
    });

    assert.equal(instance.t('app.title'), 'Catalogue Logiciel');
    assert.equal(instance.t('batch.selectedOfTotal', { selected: 2, total: 5 }), '2 of 5 selected');
    assert.equal(instance.t('onlyEn'), 'English fallback text');
    assert.equal(instance.t('nonexistent.translation.key'), 'nonexistent.translation.key');
  });

  it('normalizes language codes and resolves auto / regional / unknown locales', () => {
    assert.equal(normalizeLocaleCode(' de_DE '), 'de-de');
    assert.equal(normalizeLocaleCode('auto'), '');
    assert.equal(normalizeLocaleCode('invalid code!'), '');
    assert.equal(normalizeConfiguredLanguage(undefined), 'en');
    assert.equal(normalizeConfiguredLanguage('AUTO'), 'auto');
    assert.equal(normalizeConfiguredLanguage('fr_FR'), 'fr-fr');

    assert.equal(resolveEffectiveLocale('en', ['en', 'de'], 'de-DE'), 'en');
    assert.equal(resolveEffectiveLocale('de', ['en', 'de'], 'en-US'), 'de');
    assert.equal(resolveEffectiveLocale('de-AT', ['en', 'de'], 'en-US'), 'de');
    assert.equal(resolveEffectiveLocale('auto', ['en', 'de'], 'de-DE'), 'de');
    assert.equal(resolveEffectiveLocale('auto', ['en', 'de'], 'ja-JP'), 'en');
    assert.equal(resolveEffectiveLocale('xx', ['en', 'de'], 'de-DE'), 'en');
  });

  it('extracts _meta metadata with safe fallbacks', () => {
    const meta = extractLocaleMeta({
      _meta: { code: 'FR', name: 'French', nativeName: 'Francais', author: 'Community' },
    });
    assert.deepEqual(meta, {
      code: 'fr',
      name: 'French',
      nativeName: 'Francais',
      author: 'Community',
    });

    const fallback = extractLocaleMeta({}, 'es');
    assert.deepEqual(fallback, {
      code: 'es',
      name: 'ES',
      nativeName: 'ES',
      author: '',
    });
  });
});

describe('i18n-service: external community locales and runtime reloading', () => {
  it('loads built-in locales and community overrides/additions from userDir while ignoring invalid JSON', () => {
    const tmpRoot = makeTempDir();
    const userLocalesDir = path.join(tmpRoot, 'data', 'locales');
    fs.mkdirSync(userLocalesDir, { recursive: true });

    fs.writeFileSync(
      path.join(userLocalesDir, 'fr.json'),
      JSON.stringify(
        {
          _meta: { code: 'fr', name: 'French', nativeName: 'Francais', author: 'Tester' },
          app: { title: 'Catalogue de Logiciels' },
        },
        null,
        2
      ),
      'utf-8'
    );
    fs.writeFileSync(path.join(userLocalesDir, 'broken.json'), '{ invalid json', 'utf-8');

    const loaded = loadLocalesFromDirs({ builtinDir: BUILTIN_LOCALES_DIR, userDir: userLocalesDir });
    const codes = loaded.availableLocales.map((l) => l.code);
    assert.deepEqual(codes.slice(0, 2), ['en', 'de']);
    assert.ok(codes.includes('fr'));

    const frMeta = loaded.availableLocales.find((l) => l.code === 'fr');
    assert.equal(frMeta?.source, 'custom');
    assert.equal(frMeta?.nativeName, 'Francais');
    assert.equal(loaded.localesMap.has('broken'), false);
  });

  it('switches language via createI18nService, falls back to English for missing keys, and persists config', () => {
    const tmpRoot = makeTempDir();
    const userLocalesDir = path.join(tmpRoot, 'data', 'locales');
    fs.mkdirSync(userLocalesDir, { recursive: true });
    fs.writeFileSync(
      path.join(userLocalesDir, 'es.json'),
      JSON.stringify(
        {
          _meta: { code: 'es', name: 'Spanish', nativeName: 'Espanol', author: 'Community' },
          tabs: { updates: 'Actualizaciones' },
        },
        null,
        2
      ),
      'utf-8'
    );

    const cfgState = { language: 'en' };
    const emitted = [];
    const instance = createI18n();

    const service = createI18nService({
      getBuiltinLocalesDirFn: () => BUILTIN_LOCALES_DIR,
      getUserLocalesDirFn: () => userLocalesDir,
      getConfigFn: () => ({ ...cfgState }),
      saveConfigFn: (patch) => Object.assign(cfgState, patch),
      getSystemLocaleFn: () => 'de-DE',
      onLanguageChanged: (snapshot) => emitted.push(snapshot),
      i18nInstance: instance,
    });

    const initSnap = service.init();
    assert.equal(initSnap.activeLocale, 'en');
    assert.equal(instance.t('tabs.updates'), 'Updates');

    const esRes = service.setLanguage('es');
    assert.equal(esRes.success, true);
    assert.equal(cfgState.language, 'es');
    assert.equal(esRes.activeLocale, 'es');
    assert.equal(instance.t('tabs.updates'), 'Actualizaciones');
    assert.equal(instance.t('tabs.archive'), 'Archive');
    assert.equal(emitted.length, 1);

    const autoRes = service.setLanguage('auto');
    assert.equal(autoRes.configuredLanguage, 'auto');
    assert.equal(autoRes.activeLocale, 'de');
    assert.equal(instance.t('tabs.archive'), 'Archiv');
  });
});

describe('locales parity, static key usage, and packaging checks', () => {
  it('enforces 100% key parity, non-empty values, valid _meta, placeholders, and ASCII punctuation across all src/locales/*.json', () => {
    const enJson = readJson(path.join(BUILTIN_LOCALES_DIR, 'en.json'));
    const enFlat = flattenMessages(enJson);
    const enKeys = Object.keys(enFlat).sort();
    assert.ok(enKeys.length > 0, 'en.json must contain translation keys');

    const localeFiles = fs.readdirSync(BUILTIN_LOCALES_DIR).filter((f) => f.endsWith('.json'));
    assert.ok(localeFiles.includes('en.json'));
    assert.ok(localeFiles.includes('de.json'));

    for (const fileName of localeFiles) {
      const codeStem = path.basename(fileName, '.json').toLowerCase();
      const dict = readJson(path.join(BUILTIN_LOCALES_DIR, fileName));

      assert.ok(dict._meta && typeof dict._meta === 'object', `${fileName} must define _meta`);
      assert.equal(
        String(dict._meta.code || '')
          .trim()
          .toLowerCase(),
        codeStem,
        `${fileName} _meta.code must match filename`
      );
      assert.ok(String(dict._meta.name || '').trim().length > 0, `${fileName} _meta.name must not be empty`);
      assert.ok(
        String(dict._meta.nativeName || '').trim().length > 0,
        `${fileName} _meta.nativeName must not be empty`
      );
      assert.ok(String(dict._meta.author || '').trim().length > 0, `${fileName} _meta.author must not be empty`);

      const flat = flattenMessages(dict);
      const keys = Object.keys(flat).sort();
      const missingKeys = enKeys.filter((k) => !Object.hasOwn(flat, k));
      const extraKeys = keys.filter((k) => !Object.hasOwn(enFlat, k));

      assert.deepEqual(missingKeys, [], `${fileName} is missing keys from en.json`);
      assert.deepEqual(extraKeys, [], `${fileName} has extra keys not present in en.json`);

      for (const key of enKeys) {
        const val = flat[key];
        assert.equal(typeof val, 'string', `${fileName} "${key}" must be a string`);
        assert.ok(val.trim().length > 0, `${fileName} has empty string for "${key}"`);
        assert.ok(hasBalancedBraces(val), `${fileName} has unbalanced braces in "${key}": ${val}`);
        assert.deepEqual(
          extractPlaceholders(val),
          extractPlaceholders(enFlat[key]),
          `${fileName} placeholder mismatch for key "${key}"`
        );
        assert.doesNotMatch(val, /[–—„“”’‘]/, `Forbidden typography character in ${fileName} "${key}"`);
      }
    }
  });

  it('verifies all static t(...) calls and data-i18n* DOM attributes exist in en.json', () => {
    const enJson = readJson(path.join(BUILTIN_LOCALES_DIR, 'en.json'));
    const enFlat = flattenMessages(enJson);
    const missing = [];

    const jsDirs = [
      path.join(ROOT_DIR, 'src', 'renderer'),
      path.join(ROOT_DIR, 'src', 'main'),
      path.join(ROOT_DIR, 'src', 'shared'),
    ];
    for (const dir of jsDirs) {
      for (const filePath of collectJsFiles(dir)) {
        const src = fs.readFileSync(filePath, 'utf-8');
        for (const match of src.matchAll(/(?<![a-zA-Z0-9_$.])t\(\s*['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9_.-]+)['"]/g)) {
          const key = match[1];
          if (!Object.hasOwn(enFlat, key)) {
            missing.push(`${path.relative(ROOT_DIR, filePath)} -> ${key}`);
          }
        }
      }
    }

    const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'src', 'renderer', 'index.html'), 'utf-8');
    for (const match of indexHtml.matchAll(/data-i18n(?:-[a-z-]+)?=['"]([a-zA-Z0-9_.-]+)['"]/g)) {
      const key = match[1];
      if (!Object.hasOwn(enFlat, key)) {
        missing.push(`src/renderer/index.html -> ${key}`);
      }
    }

    assert.deepEqual(missing, [], `Referenced i18n keys missing in en.json:\n${missing.join('\n')}`);
  });

  it('translates shared helper outputs when passed an English i18n translator and locale', () => {
    const enJson = readJson(path.join(BUILTIN_LOCALES_DIR, 'en.json'));
    const enI18n = createI18n({ locale: 'en', configuredLanguage: 'en', messages: enJson, fallbackMessages: enJson });
    const enT = enI18n.t;

    assert.equal(formatBytes(1536, 'en'), '1.5 KB');
    assert.equal(formatBytes(1536, 'de'), '1,5 KB');

    const modeInfo = formatInstallModeInfo('installed', 'x64', { isAllUsersInstall: true, t: enT });
    assert.equal(modeInfo.label, 'Installed (64-bit)');
    assert.equal(modeInfo.detail, 'System-wide installation (All users)');

    const badge = formatProviderStatusBadge({ id: 'winget', capabilities: {} }, { available: false }, { t: enT });
    assert.equal(badge.text, '⚪ Not installed');

    const groups = groupProvidersByUiCategory(
      [
        { id: 'archive', category: 'archive', name: 'Archiv' },
        { id: 'npm', category: 'developer', name: 'npm' },
      ],
      { t: enT }
    );
    assert.deepEqual(
      groups.map((g) => g.label),
      ['Languages & Developers', 'Archive']
    );

    const policyEval = evaluatePackagePolicy(
      { id: 'x', name: 'Foo', installMode: 'interactive-required' },
      'update',
      { enabled: true, shared: { listType: 'none', defaultExecutionMode: 'silent-only', entries: [] } },
      false,
      { t: enT }
    );
    assert.equal(policyEval.allowed, false);
    assert.ok(policyEval.error.includes('adware protection'));

    const adware = detectAdwareSignals({ name: 'Daemon Tools Lite', t: enT });
    assert.equal(adware.flagged, true);
    assert.ok(adware.reason.includes('Always Interactive'));

    const unknownInstaller = detectInstallerFromBuffer('setup.bin', Buffer.from('random'), { t: enT });
    assert.equal(unknownInstaller.label, 'Unknown');

    const bundleStatus = evaluateBundleStatus(
      { id: 'b1', name: 'Test', items: [{ source: 'winget', packageId: 'Foo.Bar', name: 'Foo' }] },
      { packages: [], t: enT }
    );
    assert.equal(bundleStatus.items[0].statusLabel, '⬇️ Missing - install');
    const plan = planBundleExecution(bundleStatus.items, { allowSilent: true, silentWinget: false, t: enT });
    assert.ok(plan.interactiveNotice.includes('interactively'));
  });

  it('bundles src/locales via build.extraResources in package.json', () => {
    const pkg = readJson(path.join(ROOT_DIR, 'package.json'));
    const extraResources = pkg?.build?.extraResources || [];
    assert.ok(
      extraResources.some((entry) => entry.from === 'src/locales' && entry.to === 'locales'),
      'package.json build.extraResources must copy src/locales to locales'
    );
  });
});
