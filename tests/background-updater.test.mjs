import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAutostartService } from '../src/main/autostart-core.js';
import { createBackgroundUpdater } from '../src/main/background-updater-core.js';
import {
  AUTOSTART_TASK_NAME,
  buildTrayMenuDescriptors,
  computeNotificationDelta,
  DEFAULT_BACKGROUND_SETTINGS,
  evaluateAutoUpdateEligibility,
  filterAutoUpdateCandidates,
  formatTrayTooltip,
  hasTrayStartupArg,
  normalizeBackgroundSettings,
  removeAutoUpdateEntry,
  upsertAutoUpdateEntry,
} from '../src/shared/background-update-logic.js';
import { createDefaultAccessPolicy } from '../src/shared/policy-logic.js';

describe('background-update-logic: CLI-Flags, Tooltip & Normalisierung', () => {
  it('erkennt --tray und --minimized unabhaengig von Gross-/Kleinschreibung', () => {
    assert.equal(hasTrayStartupArg(['app.exe', '--tray']), true);
    assert.equal(hasTrayStartupArg(['app.exe', '--minimized']), true);
    assert.equal(hasTrayStartupArg(['app.exe', ' --TRAY ']), true);
    assert.equal(hasTrayStartupArg(['app.exe', '--dev']), false);
    assert.equal(hasTrayStartupArg(null), false);
  });

  it('formatiert den dynamischen Tray-Tooltip mit ASCII-Bindestrichen', () => {
    assert.equal(formatTrayTooltip({ updateCount: 0 }), 'Software Katalog - Alle Programme aktuell');
    assert.equal(formatTrayTooltip({ updateCount: 1 }), 'Software Katalog - 1 Update verfuegbar');
    assert.equal(formatTrayTooltip({ updateCount: 3 }), 'Software Katalog - 3 Updates verfuegbar');
    assert.equal(formatTrayTooltip({ isChecking: true }), 'Software Katalog - Pruefe auf Updates...');
    assert.equal(
      formatTrayTooltip({ updateCount: 2, autoUpdateEnabled: true, autoUpdatePaused: true }),
      'Software Katalog - 2 Updates verfuegbar (Auto-Update pausiert)'
    );
  });

  it('setzt minimizeToTrayOnClose standardmaessig auf true und baut Tray-Menue mit Version & Einstellungen', () => {
    assert.equal(DEFAULT_BACKGROUND_SETTINGS.minimizeToTrayOnClose, true);
    assert.equal(normalizeBackgroundSettings({}).minimizeToTrayOnClose, true);
    assert.equal(normalizeBackgroundSettings({ minimizeToTrayOnClose: false }).minimizeToTrayOnClose, false);

    const unlockedMenu = buildTrayMenuDescriptors({
      appVersion: '1.27.0',
      isChecking: false,
      autoUpdateEnabled: true,
      autoUpdatePaused: false,
      settingsLocked: false,
    });
    assert.equal(unlockedMenu[0].type, 'item');
    if (unlockedMenu[0].type === 'item') {
      assert.equal(unlockedMenu[0].label, 'Software Katalog v1.27.0');
      assert.equal(unlockedMenu[0].enabled, false);
    }
    assert.equal(
      unlockedMenu.some((item) => item.type === 'item' && item.actionId === 'open-settings'),
      true
    );

    const lockedMenu = buildTrayMenuDescriptors({
      appVersion: '1.27.0',
      settingsLocked: true,
    });
    assert.equal(
      lockedMenu.some((item) => item.type === 'item' && item.actionId === 'open-settings'),
      false
    );
  });

  it('normalisiert Einstellungen sowie Whitelist-/Blacklist-Eintraege sauber und unveraenderlich', () => {
    const norm = normalizeBackgroundSettings({
      autostartMode: 'ADMIN',
      backgroundCheckIntervalMinutes: 999,
      autoUpdateListType: 'WHITELIST',
      autoUpdateEntries: [
        { matchType: 'provider', value: 'Winget', label: 'Winget' },
        { matchType: 'provider', value: 'winget', label: 'Winget Duplikat' },
        { matchType: 'invalid', value: 'foo' },
      ],
    });
    assert.equal(norm.autostartMode, 'admin');
    assert.equal(norm.backgroundCheckIntervalMinutes, 360);
    assert.equal(norm.autoUpdateListType, 'whitelist');
    assert.equal(norm.autoUpdateEntries.length, 1);
    assert.equal(norm.autoUpdateEntries[0].value, 'winget');

    const added = upsertAutoUpdateEntry(norm.autoUpdateEntries, {
      matchType: 'packageId',
      value: 'VideoLAN.VLC',
      label: 'VLC',
    });
    assert.equal(norm.autoUpdateEntries.length, 1);
    assert.equal(added.length, 2);

    const removed = removeAutoUpdateEntry(added, 'provider', 'winget');
    assert.equal(removed.length, 1);
    assert.equal(removed[0].value, 'VideoLAN.VLC');
  });
});

describe('background-update-logic: Auto-Update Filterlogik', () => {
  const vlcPkg = {
    id: 'winget:VideoLAN.VLC',
    name: 'VLC media player',
    packageManager: 'winget',
    packageId: 'VideoLAN.VLC',
    installMode: 'interactive',
    webVersion: '3.0.21',
  };

  const sevenZipPkg = {
    id: 'winget:7zip.7zip',
    name: '7-Zip',
    packageManager: 'winget',
    packageId: '7zip.7zip',
    installMode: 'silent',
    webVersion: '24.09',
  };

  const interactiveRequiredPkg = {
    id: 'archive:custom-app',
    inArchive: true,
    archiveItemId: 'custom-app',
    name: 'Protected Setup',
    packageManager: 'winget',
    packageId: 'Vendor.Protected',
    installMode: 'interactive-required',
    webVersion: '2.0.0',
  };

  const adwareFlaggedPkg = {
    id: 'winget:Piriform.CCleaner',
    name: 'CCleaner',
    packageManager: 'winget',
    packageId: 'Piriform.CCleaner',
    installMode: 'interactive',
    webVersion: '6.30',
  };

  it('erzwingt Admin-Rechte (isElevated === true) und respektiert Pause/Aus', () => {
    const notElevated = evaluateAutoUpdateEligibility(vlcPkg, {
      isElevated: false,
      autoUpdateEnabled: true,
    });
    assert.equal(notElevated.eligible, false);
    assert.equal(notElevated.reason, 'not-elevated');

    const paused = evaluateAutoUpdateEligibility(vlcPkg, {
      isElevated: true,
      autoUpdateEnabled: true,
      autoUpdatePaused: true,
    });
    assert.equal(paused.eligible, false);
    assert.equal(paused.reason, 'auto-update-paused');

    const disabled = evaluateAutoUpdateEligibility(vlcPkg, {
      isElevated: true,
      autoUpdateEnabled: false,
    });
    assert.equal(disabled.eligible, false);
    assert.equal(disabled.reason, 'auto-update-disabled');

    const ok = evaluateAutoUpdateEligibility(vlcPkg, {
      isElevated: true,
      autoUpdateEnabled: true,
    });
    assert.equal(ok.eligible, true);
  });

  it('schliesst Pakete mit interactive-required und Adware-Signalen strikt aus (auch auf Whitelist)', () => {
    const whitelist = [
      { matchType: 'packageId', value: 'Vendor.Protected', label: 'Protected Setup' },
      { matchType: 'packageId', value: 'Piriform.CCleaner', label: 'CCleaner' },
      { matchType: 'packageId', value: 'VideoLAN.VLC', label: 'VLC' },
    ];

    const resProtected = evaluateAutoUpdateEligibility(interactiveRequiredPkg, {
      isElevated: true,
      autoUpdateEnabled: true,
      autoUpdateListType: 'whitelist',
      autoUpdateEntries: whitelist,
    });
    assert.equal(resProtected.eligible, false);
    assert.equal(resProtected.reason, 'interactive-required');

    const resAdware = evaluateAutoUpdateEligibility(adwareFlaggedPkg, {
      isElevated: true,
      autoUpdateEnabled: true,
      autoUpdateListType: 'whitelist',
      autoUpdateEntries: whitelist,
    });
    assert.equal(resAdware.eligible, false);
    assert.equal(resAdware.reason, 'interactive-required');

    const resVlc = evaluateAutoUpdateEligibility(vlcPkg, {
      isElevated: true,
      autoUpdateEnabled: true,
      autoUpdateListType: 'whitelist',
      autoUpdateEntries: whitelist,
    });
    assert.equal(resVlc.eligible, true);
  });

  it('wendet Ignorierliste (version & all) korrekt an', () => {
    const ignored = [
      { packageKey: 'winget:videolan.vlc', mode: 'version', ignoredVersion: '3.0.21' },
      { packageKey: 'winget:7zip.7zip', mode: 'all', ignoredVersion: '' },
    ];

    const vlcSame = evaluateAutoUpdateEligibility(vlcPkg, {
      targetVersion: 'v3.0.21',
      isElevated: true,
      autoUpdateEnabled: true,
      ignoredUpdates: ignored,
    });
    assert.equal(vlcSame.eligible, false);
    assert.equal(vlcSame.reason, 'ignored');

    const vlcNewer = evaluateAutoUpdateEligibility(vlcPkg, {
      targetVersion: '3.0.22',
      isElevated: true,
      autoUpdateEnabled: true,
      ignoredUpdates: ignored,
    });
    assert.equal(vlcNewer.eligible, true);

    const sevenAll = evaluateAutoUpdateEligibility(sevenZipPkg, {
      targetVersion: '25.00',
      isElevated: true,
      autoUpdateEnabled: true,
      ignoredUpdates: ignored,
    });
    assert.equal(sevenAll.eligible, false);
    assert.equal(sevenAll.reason, 'ignored');
  });

  it('unterstuetzt eigene Auto-Update-Whitelist/-Blacklist unabhaengig von der Nutzer-Policy', () => {
    const userPolicy = {
      ...createDefaultAccessPolicy(),
      enabled: true,
      scopeMode: 'shared',
      shared: {
        listType: 'blacklist',
        defaultExecutionMode: 'allow-interactive',
        entries: [{ matchType: 'packageId', value: '7zip.7zip', label: '7-Zip', executionMode: 'inherit' }],
      },
    };

    const candidates = [vlcPkg, sevenZipPkg, interactiveRequiredPkg];

    // Eigene Whitelist fuer Auto-Update erlaubt 7-Zip, aber Nutzer-Policy blockiert 7-Zip -> trotzdem gesperrt
    const wlRes = filterAutoUpdateCandidates(candidates, {
      isElevated: true,
      autoUpdateEnabled: true,
      autoUpdateListType: 'whitelist',
      autoUpdateEntries: [
        { matchType: 'packageId', value: '7zip.7zip', label: '7-Zip' },
        { matchType: 'packageId', value: 'VideoLAN.VLC', label: 'VLC' },
      ],
      accessPolicy: userPolicy,
    });
    assert.deepEqual(
      wlRes.eligible.map((e) => e.item.packageId),
      ['VideoLAN.VLC']
    );

    // Eigene Auto-Update-Blacklist sperrt VLC, obwohl Nutzer-Policy VLC erlaubt
    const blRes = filterAutoUpdateCandidates([vlcPkg, sevenZipPkg], {
      isElevated: true,
      autoUpdateEnabled: true,
      autoUpdateListType: 'blacklist',
      autoUpdateEntries: [{ matchType: 'name', value: '*VLC*', label: 'VLC' }],
      accessPolicy: null,
    });
    assert.deepEqual(
      blRes.eligible.map((e) => e.item.packageId),
      ['7zip.7zip']
    );
    assert.equal(blRes.skipped[0].decision.reason, 'in-auto-update-blacklist');
  });
});

describe('background-update-logic: Anti-Notification-Spam', () => {
  it('meldet nur neue/geaenderte Versionen und bereinigt erledigte Updates', () => {
    const updatesRun1 = [
      {
        item: { id: 'winget:VideoLAN.VLC', packageManager: 'winget', packageId: 'VideoLAN.VLC' },
        targetVersion: '3.0.21',
      },
      { item: { id: 'winget:7zip.7zip', packageManager: 'winget', packageId: '7zip.7zip' }, targetVersion: '24.09' },
    ];

    const d1 = computeNotificationDelta(updatesRun1, {});
    assert.equal(d1.newUpdates.length, 2);
    assert.equal(d1.changed, true);

    // Zweiter Lauf mit identischen (oder numerisch gleichen) Versionen -> kein Spam
    const updatesRun2 = [
      {
        item: { id: 'winget:VideoLAN.VLC', packageManager: 'winget', packageId: 'VideoLAN.VLC' },
        targetVersion: 'v3.0.21.0',
      },
      { item: { id: 'winget:7zip.7zip', packageManager: 'winget', packageId: '7zip.7zip' }, targetVersion: '24.09' },
    ];
    const d2 = computeNotificationDelta(updatesRun2, d1.nextNotifiedVersions);
    assert.equal(d2.newUpdates.length, 0);

    // Neuer Patch fuer VLC + 7-Zip behoben -> nur VLC neu melden, 7-Zip aus Merkliste entfernen
    const updatesRun3 = [
      {
        item: { id: 'winget:VideoLAN.VLC', packageManager: 'winget', packageId: 'VideoLAN.VLC' },
        targetVersion: '3.0.22',
      },
    ];
    const d3 = computeNotificationDelta(updatesRun3, d1.nextNotifiedVersions);
    assert.equal(d3.newUpdates.length, 1);
    assert.equal(d3.newUpdates[0].targetVersion, '3.0.22');
    assert.equal(Object.hasOwn(d3.nextNotifiedVersions, 'winget:7zip.7zip'), false);
    assert.equal(d3.changed, true);
  });
});

describe('background-updater & autostart-core: Orchestrierung mit Mocks', () => {
  it('reiht bei aktivem Auto-Update und Admin-Rechten nur erlaubte Pakete still ein', async () => {
    let savedPatch = {};
    const enqueuedCalls = [];
    const notifications = [];

    const updater = createBackgroundUpdater({
      getConfigFn: () => ({
        versionCompareDepth: 3,
        notifyOnUpdates: true,
        autoUpdateEnabled: true,
        autoUpdateListType: 'all',
        autoUpdateEntries: [],
        notifiedUpdateVersions: savedPatch.notifiedUpdateVersions || {},
      }),
      saveConfigFn: (patch) => {
        savedPatch = { ...savedPatch, ...patch };
      },
      loadCatalogFn: () => [],
      scanInstalledFn: async () => ({
        success: true,
        programs: [
          {
            id: 'winget:7zip.7zip',
            name: '7-Zip',
            packageManager: 'winget',
            packageId: '7zip.7zip',
            installedVersion: '24.08',
            availableVersion: '24.09',
            hasUpdate: true,
          },
          {
            id: 'winget:Piriform.CCleaner',
            name: 'CCleaner',
            packageManager: 'winget',
            packageId: 'Piriform.CCleaner',
            installedVersion: '6.29',
            availableVersion: '6.30',
            hasUpdate: true,
          },
        ],
      }),
      checkWebVersionsFn: async () => ({ success: true, count: 0 }),
      loadIgnoredFn: () => ({ entries: [] }),
      getAccessPolicyFn: () => ({ accessPolicy: null, isAdmin: false }),
      isProcessElevatedFn: async () => true,
      enqueueUpdatesFn: async (items, opts) => {
        enqueuedCalls.push({ items, opts });
        return { success: true, added: items.length };
      },
      getQueueStateFn: () => ({ isRunning: false }),
      waitForQueueIdleFn: async () => ({
        completedCount: 1,
        failedCount: 0,
        history: [{ itemId: 'winget:7zip.7zip', status: 'done' }],
      }),
      sendNotificationFn: (payload) => notifications.push(payload),
    });

    const res = await updater.runCheck({ manual: true });
    assert.equal(res.success, true);
    assert.equal(enqueuedCalls.length, 1);
    assert.deepEqual(
      enqueuedCalls[0].items.map((i) => i.packageId),
      ['7zip.7zip']
    );
    assert.equal(enqueuedCalls[0].opts.silent, true);
    assert.equal(enqueuedCalls[0].opts.skipAutoAdminPrompt, true);
    assert.equal(notifications.length, 2);
    assert.equal(notifications[0].title, 'Software Katalog - Auto-Update');
    assert.match(notifications[0].body, /1 Programm automatisch aktualisiert/);
    assert.equal(notifications[1].title, 'Software Katalog - Updates verfuegbar');
    assert.match(notifications[1].body, /CCleaner/);

    // Zweiter Lauf ohne neue Updates sendet keine doppelte "Updates verfuegbar"-Benachrichtigung
    const res2 = await updater.runCheck({ manual: false });
    assert.equal(res2.success, true);
    assert.equal(notifications.length, 3);
  });

  it('fuehrt ohne Admin-Rechte kein Auto-Update aus und prueft Anti-Spam', async () => {
    let savedState = {};
    const enqueuedCalls = [];
    const notifications = [];

    const updater = createBackgroundUpdater({
      getConfigFn: () => ({
        versionCompareDepth: 3,
        notifyOnUpdates: true,
        autoUpdateEnabled: true,
        autoUpdateListType: 'all',
        autoUpdateEntries: [],
        notifiedUpdateVersions: savedState.notifiedUpdateVersions || {},
      }),
      saveConfigFn: (patch) => {
        savedState = { ...savedState, ...patch };
      },
      loadCatalogFn: () => [],
      scanInstalledFn: async () => ({
        success: true,
        programs: [
          {
            id: 'winget:7zip.7zip',
            name: '7-Zip',
            packageManager: 'winget',
            packageId: '7zip.7zip',
            installedVersion: '24.08',
            availableVersion: '24.09',
            hasUpdate: true,
          },
        ],
      }),
      checkWebVersionsFn: async () => ({ success: true, count: 0 }),
      loadIgnoredFn: () => ({ entries: [] }),
      getAccessPolicyFn: () => ({ accessPolicy: null, isAdmin: false }),
      isProcessElevatedFn: async () => false,
      enqueueUpdatesFn: async (items, opts) => {
        enqueuedCalls.push({ items, opts });
        return { success: true, added: items.length };
      },
      sendNotificationFn: (payload) => notifications.push(payload),
    });

    await updater.runCheck({ manual: false });
    assert.equal(enqueuedCalls.length, 0);
    assert.equal(notifications.length, 1);

    await updater.runCheck({ manual: false });
    assert.equal(notifications.length, 1);
  });

  it('verwaltet Normal- und Admin-Autostart sauber ohne echte System-Seiteneffekte', async () => {
    let loginItemEnabled = false;
    let loginItemArgs = [];
    let adminTaskExists = false;
    const psScripts = [];

    const autostart = createAutostartService({
      platform: 'win32',
      execPath: 'C:\\Program Files\\Software Katalog\\Software Katalog.exe',
      isPackaged: true,
      appPath: 'C:\\Program Files\\Software Katalog',
      username: 'tester',
      userDomain: 'PC',
      getLoginItemSettingsFn: () => ({ openAtLogin: loginItemEnabled }),
      setLoginItemSettingsFn: (settings) => {
        loginItemEnabled = Boolean(settings.openAtLogin);
        loginItemArgs = settings.args || [];
      },
      queryScheduledTaskFn: async () => ({ exists: adminTaskExists, accessDenied: false }),
      isProcessElevatedFn: async () => false,
      isAdminSessionActiveFn: () => true,
      runPowerShellElevatedFn: async (script) => {
        psScripts.push(script);
        if (script.includes('Register-ScheduledTask')) {
          adminTaskExists = true;
          return { code: 0, stdout: 'TASK_OK', stderr: '' };
        }
        if (script.includes('Unregister-ScheduledTask')) {
          adminTaskExists = false;
          return { code: 0, stdout: 'TASK_REMOVED', stderr: '' };
        }
        return { code: -1, stdout: '', stderr: '' };
      },
    });

    const resNormal = await autostart.applySettings({ enabled: true, mode: 'normal' });
    assert.equal(resNormal.success, true);
    assert.equal(loginItemEnabled, true);
    assert.deepEqual(loginItemArgs, ['--tray']);
    assert.equal(resNormal.status.mode, 'normal');

    const resAdmin = await autostart.applySettings({ enabled: true, mode: 'admin' });
    assert.equal(resAdmin.success, true);
    assert.equal(loginItemEnabled, false);
    assert.equal(adminTaskExists, true);
    assert.equal(resAdmin.status.mode, 'admin');
    assert.match(psScripts.at(-1) || '', new RegExp(AUTOSTART_TASK_NAME));
    assert.match(psScripts.at(-1) || '', /RunLevel Highest/);
    assert.match(psScripts.at(-1) || '', /--tray/);

    const resBackToNormal = await autostart.applySettings({ enabled: true, mode: 'normal' });
    assert.equal(resBackToNormal.success, true);
    assert.equal(adminTaskExists, false);
    assert.equal(loginItemEnabled, true);

    const resOff = await autostart.applySettings({ enabled: false, mode: 'normal' });
    assert.equal(resOff.success, true);
    assert.equal(loginItemEnabled, false);
    assert.equal(adminTaskExists, false);
  });
});
