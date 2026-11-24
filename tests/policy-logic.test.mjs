import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createAuthService } from '../src/main/auth-service.js';
import {
  createPolicyDocument,
  evaluateAdminAccess,
  hashPassword,
  isProtectedAdminChannel,
  verifyPolicyIntegrity,
} from '../src/shared/auth-logic.js';
import {
  buildExportPolicyPayload,
  createDefaultAccessPolicy,
  evaluatePackagePolicy,
  matchesPolicyEntry,
  normalizeAccessPolicy,
  POLICY_EXPORT_FORMAT,
  removePolicyEntry,
  updatePolicyEntryExecutionMode,
  upsertPolicyEntry,
  validateImportPolicyPayload,
} from '../src/shared/policy-logic.js';
import { computeTabCounts } from '../src/shared/unified-packages.js';

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-policy-test-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignorieren
    }
  }
});

describe('policy-logic: Normalisierung, Listen-Helper & Export/Import', () => {
  it('erstellt gueltige Standard-Richtlinie und dedupliziert Eintraege sauber', () => {
    const def = createDefaultAccessPolicy();
    assert.equal(def.enabled, false);
    assert.equal(def.applyToAdmin, false);
    assert.equal(def.scopeMode, 'shared');
    assert.equal(def.shared.listType, 'none');
    assert.equal(def.shared.defaultExecutionMode, 'allow-interactive');

    let entries = upsertPolicyEntry([], {
      matchType: 'packageId',
      value: 'VideoLAN.VLC',
      label: 'VLC',
      executionMode: 'inherit',
    });
    entries = upsertPolicyEntry(entries, {
      matchType: 'packageId',
      value: 'videolan.vlc',
      label: 'VLC Media Player',
      executionMode: 'silent-only',
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].label, 'VLC Media Player');
    assert.equal(entries[0].executionMode, 'silent-only');

    entries = updatePolicyEntryExecutionMode(entries, 'packageId', 'VideoLAN.VLC', 'allow-interactive');
    assert.equal(entries[0].executionMode, 'allow-interactive');

    entries = removePolicyEntry(entries, 'packageId', 'VIDEOLAN.VLC');
    assert.equal(entries.length, 0);
  });

  it('exportiert und validiert Richtlinien inkl. Import aus admin-policy.json', () => {
    const policy = normalizeAccessPolicy({
      enabled: true,
      applyToAdmin: false,
      scopeMode: 'separate',
      updates: {
        listType: 'whitelist',
        defaultExecutionMode: 'silent-only',
        entries: [{ matchType: 'packageId', value: '7zip.7zip', label: '7-Zip', executionMode: 'inherit' }],
      },
      install: {
        listType: 'blacklist',
        defaultExecutionMode: 'allow-interactive',
        entries: [{ matchType: 'provider', value: 'Chocolatey', label: 'Chocolatey' }],
      },
    });

    const exported = buildExportPolicyPayload(policy);
    assert.equal(exported.format, POLICY_EXPORT_FORMAT);
    const resExport = validateImportPolicyPayload(exported);
    assert.equal(resExport.valid, true);
    if (resExport.valid) {
      assert.equal(resExport.accessPolicy.enabled, true);
      assert.equal(resExport.accessPolicy.scopeMode, 'separate');
      assert.equal(resExport.accessPolicy.updates.entries[0].value, '7zip.7zip');
      assert.equal(resExport.accessPolicy.install.entries[0].value, 'chocolatey');
    }

    const resAdminDoc = validateImportPolicyPayload({
      schemaVersion: 1,
      auth: { enabled: true, username: 'admin' },
      accessPolicy: policy,
    });
    assert.equal(resAdminDoc.valid, true);

    assert.equal(validateImportPolicyPayload([]).valid, false);
    assert.equal(validateImportPolicyPayload({ format: 'wrong-format', accessPolicy: policy }).valid, false);
    assert.equal(validateImportPolicyPayload({ foo: 'bar' }).valid, false);
  });
});

describe('policy-logic: Matching-Typen, Whitelist & Blacklist', () => {
  it('matched packageId, archiveId, name (exakt & Wildcard) und provider korrekt', () => {
    const archivePkg = {
      id: 'arc-vlc',
      archiveItemId: 'arc-vlc',
      inArchive: true,
      packageManager: 'winget',
      packageId: 'VideoLAN.VLC',
      name: 'VLC Media Player 3.0',
    };
    const remotePkg = {
      id: 'remote:winget:Mozilla.Firefox',
      origin: 'remote',
      inArchive: false,
      providerId: 'winget',
      packageManager: 'winget',
      packageId: 'Mozilla.Firefox',
      name: 'Mozilla Firefox',
    };

    assert.equal(
      matchesPolicyEntry(archivePkg, {
        matchType: 'packageId',
        value: 'videolan.vlc',
        label: '',
        executionMode: 'inherit',
      }),
      true
    );
    assert.equal(
      matchesPolicyEntry(archivePkg, { matchType: 'archiveId', value: 'ARC-VLC', label: '', executionMode: 'inherit' }),
      true
    );
    assert.equal(
      matchesPolicyEntry(archivePkg, {
        matchType: 'name',
        value: '*Media Player*',
        label: '',
        executionMode: 'inherit',
      }),
      true
    );
    assert.equal(
      matchesPolicyEntry(archivePkg, { matchType: 'provider', value: 'archive', label: '', executionMode: 'inherit' }),
      true
    );
    assert.equal(
      matchesPolicyEntry(archivePkg, { matchType: 'provider', value: 'winget', label: '', executionMode: 'inherit' }),
      true
    );

    assert.equal(
      matchesPolicyEntry(remotePkg, {
        matchType: 'packageId',
        value: 'Mozilla.Firefox',
        label: '',
        executionMode: 'inherit',
      }),
      true
    );
    assert.equal(
      matchesPolicyEntry(remotePkg, { matchType: 'provider', value: 'archive', label: '', executionMode: 'inherit' }),
      false
    );
    assert.equal(
      matchesPolicyEntry(remotePkg, {
        matchType: 'name',
        value: 'Mozilla Firefox',
        label: '',
        executionMode: 'inherit',
      }),
      true
    );
  });

  it('setzt Whitelist konsequent durch (nur passende sichtbar & erlaubt)', () => {
    const policy = normalizeAccessPolicy({
      enabled: true,
      scopeMode: 'shared',
      shared: {
        listType: 'whitelist',
        defaultExecutionMode: 'allow-interactive',
        entries: [
          { matchType: 'packageId', value: '7zip.7zip', label: '7-Zip' },
          { matchType: 'archiveId', value: 'arc-notepad', label: 'Notepad++' },
        ],
      },
    });

    const allowedWinget = evaluatePackagePolicy(
      { packageManager: 'winget', packageId: '7zip.7zip', name: '7-Zip' },
      'install',
      policy,
      false
    );
    assert.equal(allowedWinget.allowed, true);
    assert.equal(allowedWinget.visible, true);

    const allowedArchive = evaluatePackagePolicy(
      { id: 'arc-notepad', inArchive: true, name: 'Notepad++' },
      'update',
      policy,
      false
    );
    assert.equal(allowedArchive.allowed, true);
    assert.equal(allowedArchive.visible, true);

    const blockedOther = evaluatePackagePolicy(
      { packageManager: 'winget', packageId: 'Valve.Steam', name: 'Steam' },
      'install',
      policy,
      false
    );
    assert.equal(blockedOther.allowed, false);
    assert.equal(blockedOther.visible, false);
    assert.equal(blockedOther.reason, 'not-in-whitelist');
  });

  it('setzt Blacklist konsequent durch (alles erlaubt ausser gesperrte Eintraege)', () => {
    const policy = normalizeAccessPolicy({
      enabled: true,
      scopeMode: 'shared',
      shared: {
        listType: 'blacklist',
        defaultExecutionMode: 'allow-interactive',
        entries: [
          { matchType: 'name', value: '*Torrent*', label: 'Torrent-Tools' },
          { matchType: 'provider', value: 'chocolatey', label: 'Chocolatey' },
        ],
      },
    });

    const blockedByName = evaluatePackagePolicy(
      { packageManager: 'winget', packageId: 'qBittorrent.qBittorrent', name: 'qBittorrent' },
      'install',
      policy,
      false
    );
    assert.equal(blockedByName.allowed, false);
    assert.equal(blockedByName.visible, false);
    assert.equal(blockedByName.reason, 'in-blacklist');

    const blockedByProvider = evaluatePackagePolicy(
      { packageManager: 'chocolatey', packageId: 'git', name: 'Git' },
      'update',
      policy,
      false
    );
    assert.equal(blockedByProvider.allowed, false);
    assert.equal(blockedByProvider.visible, false);

    const allowedClean = evaluatePackagePolicy(
      { packageManager: 'winget', packageId: 'Mozilla.Firefox', name: 'Firefox' },
      'install',
      policy,
      false
    );
    assert.equal(allowedClean.allowed, true);
    assert.equal(allowedClean.visible, true);
  });
});

describe('policy-logic: shared vs. separate, silent-only, Admin-Bypass & Adware-Kollision', () => {
  it('unterscheidet shared vs. separate sauber fuer update, install und view', () => {
    const separatePolicy = normalizeAccessPolicy({
      enabled: true,
      scopeMode: 'separate',
      updates: {
        listType: 'none',
        defaultExecutionMode: 'silent-only',
        entries: [],
      },
      install: {
        listType: 'whitelist',
        defaultExecutionMode: 'allow-interactive',
        entries: [{ matchType: 'packageId', value: '7zip.7zip', label: '7-Zip' }],
      },
    });

    const vlcPkg = {
      id: 'winget:VideoLAN.VLC',
      packageManager: 'winget',
      packageId: 'VideoLAN.VLC',
      name: 'VLC',
      isInstalled: true,
    };

    const updDecision = evaluatePackagePolicy(vlcPkg, 'update', separatePolicy, false);
    assert.equal(updDecision.allowed, true);
    assert.equal(updDecision.visible, true);
    assert.equal(updDecision.silentOnly, true);

    const instDecision = evaluatePackagePolicy(vlcPkg, 'install', separatePolicy, false);
    assert.equal(instDecision.allowed, false);
    assert.equal(instDecision.visible, false);

    // view fuer installiertes Paket greift auf Updates-Regelset zu -> sichtbar
    const viewDecision = evaluatePackagePolicy(vlcPkg, 'view', separatePolicy, false);
    assert.equal(viewDecision.visible, true);
    assert.equal(viewDecision.silentOnly, true);

    // Nicht installiertes Paket ausserhalb install-Whitelist -> bei separate ausgeblendet, wenn updates auch verbietet
    const strictSeparate = normalizeAccessPolicy({
      enabled: true,
      scopeMode: 'separate',
      updates: { listType: 'whitelist', defaultExecutionMode: 'silent-only', entries: [] },
      install: {
        listType: 'whitelist',
        defaultExecutionMode: 'allow-interactive',
        entries: [{ matchType: 'packageId', value: '7zip.7zip', label: '7-Zip' }],
      },
    });
    assert.equal(evaluatePackagePolicy(vlcPkg, 'view', strictSeparate, false).visible, false);
    assert.equal(
      evaluatePackagePolicy(
        { packageManager: 'winget', packageId: '7zip.7zip', name: '7-Zip', isInstalled: false },
        'view',
        strictSeparate,
        false
      ).visible,
      true
    );
  });

  it('respektiert Spezifitaet bei Ueberschreibungen (packageId > provider)', () => {
    const policy = normalizeAccessPolicy({
      enabled: true,
      scopeMode: 'shared',
      shared: {
        listType: 'whitelist',
        defaultExecutionMode: 'silent-only',
        entries: [
          { matchType: 'provider', value: 'winget', label: 'Winget', executionMode: 'silent-only' },
          {
            matchType: 'packageId',
            value: 'Custom.InteractiveApp',
            label: 'Custom App',
            executionMode: 'allow-interactive',
          },
        ],
      },
    });

    const normalPkg = evaluatePackagePolicy(
      { packageManager: 'winget', packageId: '7zip.7zip', name: '7-Zip' },
      'install',
      policy,
      false
    );
    assert.equal(normalPkg.silentOnly, true);
    assert.equal(normalPkg.executionMode, 'silent-only');

    const overridePkg = evaluatePackagePolicy(
      { packageManager: 'winget', packageId: 'Custom.InteractiveApp', name: 'Custom App' },
      'install',
      policy,
      false
    );
    assert.equal(overridePkg.silentOnly, false);
    assert.equal(overridePkg.executionMode, 'allow-interactive');
  });

  it('erlaubt Admin-Bypass bei applyToAdmin=false und erzwingt Policy bei applyToAdmin=true', () => {
    const bypassPolicy = normalizeAccessPolicy({
      enabled: true,
      applyToAdmin: false,
      scopeMode: 'shared',
      shared: {
        listType: 'whitelist',
        defaultExecutionMode: 'silent-only',
        entries: [],
      },
    });

    const restrictedPkg = {
      packageManager: 'winget',
      packageId: 'Piriform.CCleaner',
      name: 'CCleaner',
      installMode: 'interactive-required',
    };

    const userRes = evaluatePackagePolicy(restrictedPkg, 'install', bypassPolicy, false);
    assert.equal(userRes.allowed, false);
    assert.equal(userRes.visible, false);

    const adminBypassRes = evaluatePackagePolicy(restrictedPkg, 'install', bypassPolicy, true);
    assert.equal(adminBypassRes.allowed, true);
    assert.equal(adminBypassRes.visible, true);
    assert.equal(adminBypassRes.silentOnly, false);
    assert.equal(adminBypassRes.reason, 'admin-bypass');

    const strictAdminPolicy = normalizeAccessPolicy({ ...bypassPolicy, applyToAdmin: true });
    const adminEnforcedRes = evaluatePackagePolicy(restrictedPkg, 'install', strictAdminPolicy, true);
    assert.equal(adminEnforcedRes.allowed, false);
    assert.equal(adminEnforcedRes.visible, false);
  });

  it('blockiert Adware-Kollision (silent-only + interactive-required) statt Adware still zu installieren', () => {
    const policy = normalizeAccessPolicy({
      enabled: true,
      scopeMode: 'shared',
      shared: {
        listType: 'none',
        defaultExecutionMode: 'silent-only',
        entries: [],
      },
    });

    const adwarePkg = {
      id: 'arc-ccleaner',
      inArchive: true,
      name: 'CCleaner',
      installMode: 'interactive-required',
    };

    const installDecision = evaluatePackagePolicy(adwarePkg, 'install', policy, false);
    assert.equal(installDecision.allowed, false);
    assert.equal(installDecision.visible, true);
    assert.equal(installDecision.adwareConflict, true);
    assert.equal(installDecision.blockedByAdwareConflict, true);
    assert.equal(installDecision.silentOnly, true);
    assert.match(installDecision.error, /Adware-Schutz/i);

    const updateDecision = evaluatePackagePolicy(adwarePkg, 'update', policy, false);
    assert.equal(updateDecision.allowed, false);
    assert.equal(updateDecision.adwareConflict, true);

    const viewDecision = evaluatePackagePolicy(adwarePkg, 'view', policy, false);
    assert.equal(viewDecision.visible, true);
    assert.equal(viewDecision.allowed, true);
    assert.equal(viewDecision.adwareConflict, true);

    // Ausnahme fuer einzelnes Programm auf allow-interactive loest den Konflikt auf
    const resolvedPolicy = normalizeAccessPolicy({
      ...policy,
      shared: {
        ...policy.shared,
        entries: [
          { matchType: 'archiveId', value: 'arc-ccleaner', label: 'CCleaner', executionMode: 'allow-interactive' },
        ],
      },
    });
    const resolvedDecision = evaluatePackagePolicy(adwarePkg, 'install', resolvedPolicy, false);
    assert.equal(resolvedDecision.allowed, true);
    assert.equal(resolvedDecision.adwareConflict, false);
    assert.equal(resolvedDecision.silentOnly, false);
  });

  it('filtert Tab-Zaehler (computeTabCounts) fuer Endnutzer vs. Admin korrekt', () => {
    const packages = [
      {
        id: 'arc-1',
        inArchive: true,
        isInstalled: true,
        installedVersion: '1.0.0',
        lastFiles: ['setup_v2.0.0.exe'],
        packageManager: 'winget',
        packageId: 'Allowed.App',
        name: 'Allowed App',
      },
      {
        id: 'arc-2',
        inArchive: true,
        isInstalled: true,
        installedVersion: '1.0.0',
        lastFiles: ['setup_v2.0.0.exe'],
        packageManager: 'winget',
        packageId: 'Blocked.App',
        name: 'Blocked App',
      },
    ];

    const policy = normalizeAccessPolicy({
      enabled: true,
      applyToAdmin: false,
      scopeMode: 'shared',
      shared: {
        listType: 'whitelist',
        defaultExecutionMode: 'allow-interactive',
        entries: [{ matchType: 'packageId', value: 'Allowed.App', label: 'Allowed App' }],
      },
    });

    const userCounts = computeTabCounts(packages, { accessPolicy: policy, isAdmin: false, bundlesCount: 1 });
    assert.equal(userCounts.updates, 1);
    assert.equal(userCounts.installed, 1);
    assert.equal(userCounts.archive, 1);
    assert.equal(userCounts.bundles, 1);

    const adminCounts = computeTabCounts(packages, { accessPolicy: policy, isAdmin: true, bundlesCount: 1 });
    assert.equal(adminCounts.updates, 2);
    assert.equal(adminCounts.installed, 2);
    assert.equal(adminCounts.archive, 2);
  });
});

describe('auth-service & auth-logic: Integration von Zugriffsrichtlinien in admin-policy.json', () => {
  it('speichert, schuetzt, prueft und erzwingt Zugriffsrichtlinien manipulationssicher', async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const configState = { authFilePath: '' };
    let writableOverride = null;

    const service = createAuthService({
      platform: 'win32',
      enableTimer: false,
      getConfigFn: () => ({ ...configState }),
      saveConfigFn: (patch) => {
        Object.assign(configState, patch);
      },
      getAppFolderFn: () => root,
      getDataFolderFn: () => dataDir,
      checkWritableFn: (p) => (writableOverride !== null ? writableOverride : fs.existsSync(path.dirname(p))),
    });

    try {
      await service.init();

      // Admin-Schutz einrichten
      const authRes = await service.updateAuthConfig({
        enabled: true,
        username: 'PolicyAdmin',
        password: 'SuperSecret#2026',
        sessionTimeoutMinutes: 30,
      });
      assert.equal(authRes.success, true);

      // Zugriffsrichtlinie in derselben admin-policy.json speichern
      const policyRes = await service.updateAccessPolicy({
        enabled: true,
        applyToAdmin: false,
        scopeMode: 'shared',
        shared: {
          listType: 'whitelist',
          defaultExecutionMode: 'silent-only',
          entries: [{ matchType: 'packageId', value: '7zip.7zip', label: '7-Zip', executionMode: 'inherit' }],
        },
      });
      assert.equal(policyRes.success, true);
      assert.equal(policyRes.status.integrityValid, true);
      assert.equal(policyRes.accessPolicy.enabled, true);

      // Datei auf Platte enthaelt gueltiges Document mit Auth + accessPolicy + SHA-256
      const diskDoc = JSON.parse(fs.readFileSync(policyRes.status.policyPath, 'utf-8'));
      assert.equal(verifyPolicyIntegrity(diskDoc).valid, true);
      assert.equal(diskDoc.accessPolicy.shared.listType, 'whitelist');

      // Auth-Konfiguration neu speichern darf accessPolicy nicht verlieren
      const authUpdateRes = await service.updateAuthConfig({
        enabled: true,
        username: 'PolicyAdmin',
        sessionTimeoutMinutes: 45,
      });
      assert.equal(authUpdateRes.success, true);
      assert.equal(authUpdateRes.status.accessPolicy.enabled, true);
      assert.equal(authUpdateRes.status.accessPolicy.shared.entries[0].value, '7zip.7zip');

      // Admin ist aktuell eingeloggt -> Admin-Bypass aktiv
      const adminDecision = service.evaluatePackageAccess(
        { packageManager: 'winget', packageId: 'Evil.Adware', name: 'Adware', installMode: 'interactive-required' },
        'install'
      );
      assert.equal(adminDecision.allowed, true);
      assert.equal(adminDecision.reason, 'admin-bypass');

      // Nach Logout greifen Whitelist + silent-only fuer normalen Nutzer
      service.logout();
      const allowedPkg = service.evaluatePackageAccess(
        { packageManager: 'winget', packageId: '7zip.7zip', name: '7-Zip', installMode: 'interactive' },
        'install'
      );
      assert.equal(allowedPkg.allowed, true);
      assert.equal(allowedPkg.silentOnly, true);

      const blockedPkg = service.evaluatePackageAccess(
        { packageManager: 'winget', packageId: 'Other.App', name: 'Other', installMode: 'interactive' },
        'install'
      );
      assert.equal(blockedPkg.allowed, false);
      assert.equal(blockedPkg.reason, 'not-in-whitelist');

      // Schreibschutz blockiert Aenderungen
      writableOverride = false;
      const roRes = await service.updateAccessPolicy({ enabled: false });
      assert.equal(roRes.success, false);
      assert.equal(roRes.readOnly, true);
      writableOverride = null;

      // Manipulation an accessPolicy in admin-policy.json -> Integrity-Warnung & Fail-Closed!
      const rawTampered = JSON.parse(fs.readFileSync(policyRes.status.policyPath, 'utf-8'));
      rawTampered.accessPolicy.enabled = false;
      fs.writeFileSync(policyRes.status.policyPath, JSON.stringify(rawTampered, null, 2), 'utf-8');

      const tamperedStatus = service.getStatus();
      assert.equal(tamperedStatus.integrityValid, false);
      const failClosedDecision = service.evaluatePackageAccess(
        { packageManager: 'winget', packageId: '7zip.7zip', name: '7-Zip' },
        'install'
      );
      assert.equal(failClosedDecision.allowed, false);

      // Geschuetzte IPC-Kanaele fuer Policy-Aenderungen pruefen
      for (const ch of ['policy-update', 'policy-export', 'policy-import']) {
        assert.equal(isProtectedAdminChannel(ch), true);
        assert.equal(evaluateAdminAccess({ channel: ch, authEnabled: true, isAuthenticated: false }).allowed, false);
      }
      assert.equal(isProtectedAdminChannel('policy-get'), false);
    } finally {
      service.dispose();
    }
  });

  it('bewahrt Abwaertskompatibilitaet fuer P6 Policy-Dokumente ohne accessPolicy', async () => {
    const hash = await hashPassword('LegacyPass#1');
    const legacyDoc = createPolicyDocument({
      enabled: true,
      username: 'legacyadmin',
      passwordHash: hash,
      sessionTimeoutMinutes: 15,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal('accessPolicy' in legacyDoc, false);
    assert.equal(verifyPolicyIntegrity(legacyDoc).valid, true);
  });
});
