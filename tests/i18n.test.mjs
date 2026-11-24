import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createI18nService, loadLocalesFromDirs } from '../src/main/i18n-core.js';
import {
  createI18n,
  extractLocaleMeta,
  flattenMessages,
  interpolate,
  normalizeConfiguredLanguage,
  normalizeLocaleCode,
  resolveEffectiveLocale,
} from '../src/shared/i18n.js';

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

describe('locales parity and packaging checks', () => {
  it('maintains 100% key and placeholder parity between en.json and de.json with valid ASCII punctuation', () => {
    const enJson = readJson(path.join(BUILTIN_LOCALES_DIR, 'en.json'));
    const deJson = readJson(path.join(BUILTIN_LOCALES_DIR, 'de.json'));

    assert.equal(enJson._meta?.code, 'en');
    assert.equal(deJson._meta?.code, 'de');
    assert.ok(enJson._meta?.nativeName);
    assert.ok(deJson._meta?.nativeName);

    const enFlat = flattenMessages(enJson);
    const deFlat = flattenMessages(deJson);

    const enKeys = Object.keys(enFlat).sort();
    const deKeys = Object.keys(deFlat).sort();

    assert.deepEqual(deKeys, enKeys);

    for (const key of enKeys) {
      assert.ok(enFlat[key].length > 0, `Empty EN string for ${key}`);
      assert.ok(deFlat[key].length > 0, `Empty DE string for ${key}`);
      assert.deepEqual(
        extractPlaceholders(deFlat[key]),
        extractPlaceholders(enFlat[key]),
        `Placeholder mismatch for key "${key}"`
      );
      assert.doesNotMatch(enFlat[key], /[–—„“”’]/, `Forbidden typography character in EN "${key}"`);
      assert.doesNotMatch(deFlat[key], /[–—„“”’]/, `Forbidden typography character in DE "${key}"`);
    }
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
