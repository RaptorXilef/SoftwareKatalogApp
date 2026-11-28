import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildSettingsSavePlan,
  createSettingsDraft,
  hasSettingsDraftChanges,
  normalizeSettingsTab,
  parseAutoExtensionsInput,
  SETTINGS_TABS,
  toggleDraftProvider,
} from '../src/shared/settings-draft-logic.js';

describe('settings-draft-logic: Tabs & Eingabe-Normalisierung', () => {
  it('stellt alle 6 Einstellungs-Tabs bereit und normalisiert Tab-Namen', () => {
    assert.equal(SETTINGS_TABS.length, 6);
    assert.deepEqual(
      SETTINGS_TABS.map((t) => t.id),
      ['general', 'archive', 'providers', 'updates', 'security', 'maintenance']
    );
    assert.equal(normalizeSettingsTab('providers'), 'providers');
    assert.equal(normalizeSettingsTab(' SECURITY '), 'security');
    assert.equal(normalizeSettingsTab('unknown'), 'general');
    assert.equal(normalizeSettingsTab(null), 'general');
  });

  it('parst Setup-Dateiendungen aus Strings und Arrays mit Fallback', () => {
    assert.deepEqual(parseAutoExtensionsInput('exe, .msi, ZIP, .exe'), ['.exe', '.msi', '.ZIP']);
    assert.deepEqual(parseAutoExtensionsInput('exe, .msi, zip, .exe'), ['.exe', '.msi', '.zip']);
    assert.deepEqual(parseAutoExtensionsInput(['7z', '.msi', '.7z']), ['.7z', '.msi']);
    assert.deepEqual(parseAutoExtensionsInput('   '), ['.exe', '.msi', '.zip']);
  });
});

describe('settings-draft-logic: createSettingsDraft & toggleDraftProvider', () => {
  it('erzeugt saubere Defaults und behandelt 0 sowie askSaveDialog korrekt', () => {
    const defaults = createSettingsDraft({});
    assert.equal(defaults.language, 'en');
    assert.equal(defaults.showDevTab, true);
    assert.equal(defaults.startTab, 'updates');
    assert.equal(defaults.newBadgeDays, 14);
    assert.equal(defaults.versionCompareDepth, 3);
    assert.equal(defaults.nestedDepth, 1);
    assert.equal(defaults.scanNested, false);
    assert.equal(defaults.autoSaveDownloads, true);
    assert.equal(defaults.keepOriginalNameIfVersioned, true);
    assert.equal(defaults.filenamePattern, '{Name}_v{Version}{Arch}{Ext}');
    assert.equal(defaults.archiveSaveMode, 'ask');
    assert.deepEqual(defaults.enabledProviders, ['winget', 'archive']);
    assert.equal(defaults.vcpkgRoot, '');
    assert.equal(defaults.updateInterval, 24);
    assert.equal(defaults.scanOnStartup, true);
    assert.equal(defaults.autoRequestAdminForBatch, false);
    assert.equal(defaults.minimizeToTrayOnClose, true);
    assert.equal(defaults.autostartEnabled, false);
    assert.equal(defaults.autostartMode, 'normal');
    assert.equal(defaults.backgroundCheckEnabled, false);
    assert.equal(defaults.backgroundCheckIntervalMinutes, 360);
    assert.equal(defaults.notifyOnUpdates, true);
    assert.equal(defaults.autoUpdateEnabled, false);
    assert.equal(defaults.autoUpdateListType, 'all');
    assert.deepEqual(defaults.autoUpdateEntries, []);
    assert.deepEqual(defaults.defaultSortModes, { updates: 'az', installed: 'az', archive: 'az' });

    const customSortAndTrayOff = createSettingsDraft({
      minimizeToTrayOnClose: false,
      scanOnStartup: false,
      defaultSortModes: {
        updates: 'updates',
        installed: 'newest',
        archive: 'updated',
      },
    });
    assert.equal(customSortAndTrayOff.minimizeToTrayOnClose, false);
    assert.equal(customSortAndTrayOff.scanOnStartup, false);
    assert.deepEqual(customSortAndTrayOff.defaultSortModes, {
      updates: 'updates',
      installed: 'az',
      archive: 'updated',
    });

    const zeroValues = createSettingsDraft({
      newBadgeDays: 0,
      updateInterval: 0,
      askSaveDialog: true,
      autoSaveDownloads: true,
      providerSettings: { vcpkgRoot: '  C:\\tools\\vcpkg  ' },
    });
    assert.equal(zeroValues.newBadgeDays, 0);
    assert.equal(zeroValues.updateInterval, 0);
    assert.equal(zeroValues.autoSaveDownloads, false);
    assert.equal(zeroValues.vcpkgRoot, 'C:\\tools\\vcpkg');

    const neverUpdate = createSettingsDraft({ updateInterval: -1 });
    assert.equal(neverUpdate.updateInterval, -1);

    const devHidden = createSettingsDraft({ showDevTab: false, startTab: 'dev' });
    assert.equal(devHidden.showDevTab, false);
    assert.equal(devHidden.startTab, 'updates');

    const devStart = createSettingsDraft({ showDevTab: true, startTab: 'dev' });
    assert.equal(devStart.showDevTab, true);
    assert.equal(devStart.startTab, 'dev');
  });

  it('trennt Array-Referenzen vom Ausgangsobjekt', () => {
    const raw = {
      archivePaths: ['D:\\Archiv'],
      autoExtensions: ['.exe'],
      enabledProviders: ['winget'],
      visibleHiddenCats: ['Tools'],
    };
    const draft = createSettingsDraft(raw);
    draft.archivePaths.push('E:\\Archiv2');
    draft.enabledProviders.push('scoop');

    assert.deepEqual(raw.archivePaths, ['D:\\Archiv']);
    assert.deepEqual(raw.enabledProviders, ['winget']);
  });

  it('schaltet Paketmanager im Entwurf ohne Mutation um (inkl. leerer Liste)', () => {
    const initial = createSettingsDraft({ enabledProviders: ['winget', 'archive'] });
    const withScoop = toggleDraftProvider(initial, 'SCOOP', true);
    assert.deepEqual(initial.enabledProviders, ['winget', 'archive']);
    assert.deepEqual(withScoop.enabledProviders, ['winget', 'archive', 'scoop']);

    const withoutWinget = toggleDraftProvider(withScoop, 'winget', false);
    assert.deepEqual(withoutWinget.enabledProviders, ['archive', 'scoop']);

    const emptyProviders = toggleDraftProvider(toggleDraftProvider(initial, 'winget', false), 'archive', false);
    assert.deepEqual(emptyProviders.enabledProviders, []);
  });
});

describe('settings-draft-logic: hasSettingsDraftChanges', () => {
  it('erkennt unveraenderte und zurueckgestellte Entwuerfe als sauber', () => {
    const initial = createSettingsDraft({
      enabledProviders: ['winget', 'archive'],
      visibleHiddenCats: ['Admin', 'Dev'],
    });

    const toggledOn = toggleDraftProvider(initial, 'npm', true);
    assert.equal(hasSettingsDraftChanges(initial, toggledOn), true);

    const toggledBackOff = toggleDraftProvider(toggledOn, 'npm', false);
    assert.equal(hasSettingsDraftChanges(initial, toggledBackOff), false);

    // Reihenfolge in Sets darf keinen Dirty-Status ausloesen
    const reorderedSets = createSettingsDraft({
      enabledProviders: ['archive', 'winget'],
      visibleHiddenCats: ['Dev', 'Admin'],
    });
    assert.equal(hasSettingsDraftChanges(initial, reorderedSets), false);
  });

  it('erkennt Änderungen in allen Einstellungsfeldern und geordneten Listen', () => {
    const initial = createSettingsDraft({
      archivePaths: ['C:\\Archiv1', 'D:\\Archiv2'],
      autoExtensions: ['.exe', '.msi'],
    });

    assert.equal(hasSettingsDraftChanges(initial, { ...initial, language: 'de' }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, language: 'auto' }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, showDevTab: false }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, startTab: 'discover' }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, newBadgeDays: 0 }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, versionCompareDepth: 4 }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, nestedDepth: 2 }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, scanNested: true }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, autoSaveDownloads: false }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, keepOriginalNameIfVersioned: false }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, filenamePattern: '{Name}.{Ext}' }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, archiveSaveMode: 'auto-id' }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, vcpkgRoot: 'C:\\vcpkg' }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, updateInterval: 168 }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, scanOnStartup: false }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, autoRequestAdminForBatch: true }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, visibleHiddenCats: ['Beta'] }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, archivePaths: ['D:\\Archiv2', 'C:\\Archiv1'] }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, autoExtensions: ['.msi', '.exe'] }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, minimizeToTrayOnClose: false }), true);
    assert.equal(
      hasSettingsDraftChanges(initial, {
        ...initial,
        defaultSortModes: { ...initial.defaultSortModes, updates: 'updates' },
      }),
      true
    );
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, autostartEnabled: true }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, autostartMode: 'admin' }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, backgroundCheckEnabled: true }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, backgroundCheckIntervalMinutes: 60 }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, notifyOnUpdates: false }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, autoUpdateEnabled: true }), true);
    assert.equal(hasSettingsDraftChanges(initial, { ...initial, autoUpdateListType: 'whitelist' }), true);
    assert.equal(
      hasSettingsDraftChanges(initial, {
        ...initial,
        autoUpdateEntries: [{ matchType: 'packageId', value: 'VideoLAN.VLC', label: 'VLC' }],
      }),
      true
    );
  });
});

describe('settings-draft-logic: buildSettingsSavePlan', () => {
  it('erstellt gebuendeltes Speicher-Payload und erhaelt fremde providerSettings-Schluessel', () => {
    const initial = createSettingsDraft({
      enabledProviders: ['winget', 'archive'],
      archivePaths: ['C:\\Archiv1'],
      autoExtensions: ['.exe', '.msi'],
      providerSettings: { vcpkgRoot: '' },
    });

    const current = {
      ...toggleDraftProvider(initial, 'npm', true),
      autoSaveDownloads: false,
      autoRequestAdminForBatch: true,
      scanOnStartup: false,
      vcpkgRoot: 'D:\\dev\\vcpkg',
      archivePaths: ['D:\\Archiv2', 'C:\\Archiv1'],
    };

    const plan = buildSettingsSavePlan(initial, current, {
      vcpkgRoot: '',
      npm: { customSources: [{ name: 'corp', url: 'https://npm.example.org' }] },
    });

    assert.equal(plan.payload.askSaveDialog, true);
    assert.equal(plan.payload.autoSaveDownloads, false);
    assert.equal(plan.payload.autoRequestAdminForBatch, true);
    assert.equal(plan.payload.scanOnStartup, false);
    assert.equal(plan.payload.targetPath, 'D:\\Archiv2');
    assert.deepEqual(plan.payload.enabledProviders, ['winget', 'archive', 'npm']);
    assert.equal(plan.payload.providerSettings.vcpkgRoot, 'D:\\dev\\vcpkg');
    assert.deepEqual(plan.payload.providerSettings.npm, {
      customSources: [{ name: 'corp', url: 'https://npm.example.org' }],
    });
    assert.equal(plan.needsRescan, true);
    assert.equal(plan.languageChanged, false);
    assert.equal(plan.payload.language, 'en');
    assert.equal(plan.providersChanged, true);
    assert.equal(plan.newlyEnabledProvider, true);
    assert.equal(plan.vcpkgRootChanged, true);
    assert.equal(plan.rescanInstalled, true);
    assert.equal(plan.autostartChanged, false);
    assert.equal(plan.sortDefaultsChanged, false);
    assert.equal(plan.backgroundChanged, false);

    const withBg = {
      ...current,
      language: 'de',
      showDevTab: false,
      startTab: 'dev',
      autostartEnabled: true,
      autostartMode: 'admin',
      autoUpdateEnabled: true,
      defaultSortModes: { updates: 'updates', installed: 'az', archive: 'newest' },
    };
    const bgPlan = buildSettingsSavePlan(initial, withBg);
    assert.equal(bgPlan.languageChanged, true);
    assert.equal(bgPlan.payload.language, 'de');
    assert.equal(bgPlan.payload.showDevTab, false);
    assert.equal(bgPlan.payload.startTab, 'updates');
    assert.equal(bgPlan.autostartChanged, true);
    assert.equal(bgPlan.sortDefaultsChanged, true);
    assert.equal(bgPlan.backgroundChanged, true);
    assert.equal(bgPlan.payload.autostartMode, 'admin');
    assert.equal(bgPlan.payload.autoUpdateEnabled, true);
    assert.deepEqual(bgPlan.payload.defaultSortModes, { updates: 'updates', installed: 'az', archive: 'newest' });
  });

  it('loest keinen PC-Rescan aus wenn nur ein Provider deaktiviert wurde oder vcpkg aus ist', () => {
    const initial = createSettingsDraft({
      enabledProviders: ['winget', 'archive'],
      providerSettings: { vcpkgRoot: '' },
    });
    const disabledOnly = {
      ...toggleDraftProvider(initial, 'winget', false),
      vcpkgRoot: 'C:\\vcpkg',
    };

    const plan = buildSettingsSavePlan(initial, disabledOnly);
    assert.equal(plan.providersChanged, true);
    assert.equal(plan.newlyEnabledProvider, false);
    assert.equal(plan.vcpkgRootChanged, true);
    assert.equal(plan.rescanInstalled, false);
    assert.equal(plan.needsRescan, false);

    const withVcpkgEnabled = toggleDraftProvider(disabledOnly, 'vcpkg', true);
    const planWithVcpkg = buildSettingsSavePlan(initial, withVcpkgEnabled);
    assert.equal(planWithVcpkg.rescanInstalled, true);
  });
});
