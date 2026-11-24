import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createAuthService } from '../src/main/auth-service.js';
import {
  compareUsernames,
  createPolicyDocument,
  evaluateAdminAccess,
  hashPassword,
  isProtectedAdminChannel,
  isSessionExpired,
  PROTECTED_ADMIN_IPC_CHANNELS,
  resolvePolicyFileLocation,
  validateCredentialsInput,
  verifyPassword,
  verifyPolicyIntegrity,
} from '../src/shared/auth-logic.js';

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-auth-test-'));
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

describe('auth-logic: scrypt Passwort-Hashing & timingSafeEqual Verifikation', () => {
  it('erzeugt 16-Byte Zufalls-Salts und verifiziert richtiges vs. falsches Passwort', async () => {
    const hashA = await hashPassword('SicheresPasswort!2026');
    const hashB = await hashPassword('SicheresPasswort!2026');

    assert.equal(hashA.algorithm, 'scrypt');
    assert.equal(Buffer.from(hashA.salt, 'hex').length, 16);
    assert.equal(Buffer.from(hashA.hash, 'hex').length, 64);
    assert.notEqual(hashA.salt, hashB.salt);
    assert.notEqual(hashA.hash, hashB.hash);

    assert.equal(await verifyPassword('SicheresPasswort!2026', hashA), true);
    assert.equal(await verifyPassword('SicheresPasswort!2026', hashB), true);
    assert.equal(await verifyPassword('FalschesPasswort', hashA), false);
    assert.equal(await verifyPassword('', hashA), false);
    assert.equal(await verifyPassword(null, hashA), false);
  });

  it('lehnt manipulierte oder unsichere scrypt-Hash-Datensaetze sicher ab', async () => {
    const valid = await hashPassword('Geheim123!');
    assert.equal(await verifyPassword('Geheim123!', { ...valid, algorithm: 'sha256' }), false);
    assert.equal(await verifyPassword('Geheim123!', { ...valid, salt: 'abcd' }), false);
    assert.equal(
      await verifyPassword('Geheim123!', {
        ...valid,
        params: { ...valid.params, N: 128 },
      }),
      false
    );
    assert.equal(await verifyPassword('Geheim123!', null), false);
  });

  it('vergleicht Benutzernamen case-insensitive und zeitkonstant und validiert Eingaben', () => {
    assert.equal(compareUsernames('AdminUser', '  adminuser  '), true);
    assert.equal(compareUsernames('AdminUser', 'other'), false);
    assert.equal(compareUsernames('', 'admin'), false);

    assert.equal(validateCredentialsInput({ username: 'a', password: 'secret123' }).valid, false);
    assert.equal(validateCredentialsInput({ username: 'admin', password: '123' }).valid, false);
    assert.equal(validateCredentialsInput({ username: 'admin', password: '', requirePassword: true }).valid, false);
    assert.equal(validateCredentialsInput({ username: 'admin', password: '', requirePassword: false }).valid, true);
  });
});

describe('auth-logic: Integritaet & Pfad-Prioritaet', () => {
  it('erkennt Manipulationen an der Policy-Datei anhand der SHA-256 Pruefsumme', async () => {
    const hash = await hashPassword('AdminPass#99');
    const doc = createPolicyDocument({
      enabled: true,
      username: 'admin',
      passwordHash: hash,
      sessionTimeoutMinutes: 30,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    assert.equal(verifyPolicyIntegrity(doc).valid, true);

    const tamperedDisabled = {
      ...doc,
      auth: { ...doc.auth, enabled: false },
    };
    const res1 = verifyPolicyIntegrity(tamperedDisabled);
    assert.equal(res1.valid, false);
    assert.equal(res1.reason, 'checksum-mismatch');

    const tamperedUser = {
      ...doc,
      auth: { ...doc.auth, username: 'attacker' },
    };
    assert.equal(verifyPolicyIntegrity(tamperedUser).valid, false);
  });

  it('loest den Policy-Pfad streng nach Prioritaet HKLM > Config > Standard auf', () => {
    const locHklm = resolvePolicyFileLocation({
      hklmPolicyPath: '\\\\fileserver\\policies\\admin-policy.json',
      configuredPolicyPath: 'D:\\custom\\policy.json',
      defaultPolicyPath: 'C:\\App\\data\\admin-policy.json',
      appFolder: 'C:\\App',
    });
    assert.equal(locHklm.pathSource, 'hklm');
    assert.equal(locHklm.isHklmLocked, true);
    assert.equal(locHklm.policyPath, path.normalize('\\\\fileserver\\policies\\admin-policy.json'));

    const locConfig = resolvePolicyFileLocation({
      hklmPolicyPath: '',
      configuredPolicyPath: 'policies/custom.json',
      defaultPolicyPath: 'C:\\App\\data\\admin-policy.json',
      appFolder: 'C:\\App',
    });
    assert.equal(locConfig.pathSource, 'config');
    assert.equal(locConfig.isHklmLocked, false);
    assert.equal(locConfig.policyPath, path.resolve('C:\\App', 'policies/custom.json'));

    const locDefault = resolvePolicyFileLocation({
      hklmPolicyPath: '',
      configuredPolicyPath: '',
      defaultPolicyPath: 'C:\\App\\data\\admin-policy.json',
      appFolder: 'C:\\App',
    });
    assert.equal(locDefault.pathSource, 'default');
    assert.equal(locDefault.isHklmLocked, false);
    assert.equal(locDefault.policyPath, path.normalize('C:\\App\\data\\admin-policy.json'));
  });
});

describe('auth-logic: Serverseitige Zugriffsentscheidungen & Timeout', () => {
  it('erlaubt bei deaktiviertem Schutz alle Admin-Kanaele', () => {
    for (const channel of PROTECTED_ADMIN_IPC_CHANNELS) {
      const decision = evaluateAdminAccess({
        channel,
        authEnabled: false,
        isAuthenticated: false,
      });
      assert.equal(decision.allowed, true, `Kanal ${channel} muss bei deaktiviertem Schutz frei sein`);
      assert.equal(decision.reason, 'auth-disabled');
    }
  });

  it('blockiert alle Admin-Kanaele bei aktivem Schutz ohne Anmeldung, erlaubt aber Lese-/Login-Kanaele', () => {
    const mustBlock = [
      'save-settings',
      'save-meta-json',
      'providers-set-enabled',
      'providers-install-manager',
      'providers-uninstall-manager',
      'providers-add-source',
      'providers-remove-source',
      'reset-paths',
      'archive-cleanup-execute',
      'bundles-save',
      'bundles-delete',
      'auth-update-config',
    ];

    for (const channel of mustBlock) {
      assert.equal(isProtectedAdminChannel(channel), true);
      const decision = evaluateAdminAccess({
        channel,
        authEnabled: true,
        isAuthenticated: false,
      });
      assert.equal(decision.allowed, false);
      assert.equal(decision.code, 'AUTH_REQUIRED');
    }

    const publicChannels = [
      'load-catalog',
      'get-settings',
      'auth-get-status',
      'auth-login',
      'save-favorites',
      'bundles-load',
    ];
    for (const channel of publicChannels) {
      const decision = evaluateAdminAccess({
        channel,
        authEnabled: true,
        isAuthenticated: false,
      });
      assert.equal(decision.allowed, true);
    }
  });

  it('prueft Inaktivitaets-Timeout korrekt', () => {
    const t0 = 1_000_000;
    assert.equal(
      isSessionExpired({ isAuthenticated: true, lastActivityAt: t0, sessionTimeoutMinutes: 0, now: t0 + 999_999_999 }),
      false
    );
    assert.equal(
      isSessionExpired({ isAuthenticated: true, lastActivityAt: t0, sessionTimeoutMinutes: 15, now: t0 + 14 * 60_000 }),
      false
    );
    assert.equal(
      isSessionExpired({ isAuthenticated: true, lastActivityAt: t0, sessionTimeoutMinutes: 15, now: t0 + 15 * 60_000 }),
      true
    );

    const expiredDecision = evaluateAdminAccess({
      channel: 'save-settings',
      authEnabled: true,
      isAuthenticated: true,
      lastActivityAt: t0,
      sessionTimeoutMinutes: 15,
      now: t0 + 16 * 60_000,
    });
    assert.equal(expiredDecision.allowed, false);
    assert.equal(expiredDecision.expired, true);
    assert.equal(expiredDecision.code, 'AUTH_REQUIRED');
  });
});

describe('auth-service: Integration ohne Host-Seiteneffekte', () => {
  it('verifiziert Login, Logout, Fail-Closed Manipulationserkennung, Read-Only Schutz & HKLM-Sperre', async () => {
    const root = makeTempDir();
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });

    const configState = { authFilePath: '' };
    let fakeHklmPath = '';
    let writableOverride = null;
    let fakeNow = 10_000;

    const service = createAuthService({
      platform: 'win32',
      enableTimer: false,
      getConfigFn: () => ({ ...configState }),
      saveConfigFn: (patch) => {
        Object.assign(configState, patch);
      },
      getAppFolderFn: () => root,
      getDataFolderFn: () => dataDir,
      nowFn: () => fakeNow,
      readHklmFn: async () => fakeHklmPath,
      writeHklmFn: async (p) => {
        fakeHklmPath = p;
        return { success: true };
      },
      removeHklmFn: async () => {
        fakeHklmPath = '';
        return { success: true };
      },
      checkWritableFn: (p) => (writableOverride !== null ? writableOverride : fs.existsSync(path.dirname(p))),
    });

    try {
      const initial = await service.init();
      assert.equal(initial.enabled, false);
      assert.equal(service.checkAdminIpcAccess('save-settings').allowed, true);

      // Schutz aktivieren
      const setupRes = await service.updateAuthConfig({
        enabled: true,
        username: 'CatalogAdmin',
        password: 'StrongPassword#1',
        sessionTimeoutMinutes: 10,
      });
      assert.equal(setupRes.success, true);
      assert.equal(setupRes.status.enabled, true);
      assert.equal(setupRes.status.isAuthenticated, true);
      assert.equal(fs.existsSync(path.join(dataDir, 'admin-policy.json')), true);

      // Nach Logout ist save-settings blockiert
      service.logout();
      assert.equal(service.checkAdminIpcAccess('save-settings').allowed, false);

      // Falsches Passwort abgelehnt
      const badLogin = await service.login('CatalogAdmin', 'WrongPassword');
      assert.equal(badLogin.success, false);
      assert.equal(service.checkAdminIpcAccess('save-settings').allowed, false);

      // Richtiges Passwort schaltet Session frei
      const okLogin = await service.login('catalogadmin', 'StrongPassword#1');
      assert.equal(okLogin.success, true);
      assert.equal(service.checkAdminIpcAccess('save-settings').allowed, true);

      // Timeout nach 11 Minuten sperrt automatisch
      fakeNow += 11 * 60_000;
      const afterTimeout = service.checkAdminIpcAccess('save-settings');
      assert.equal(afterTimeout.allowed, false);
      assert.equal(afterTimeout.expired, true);

      // Schreibgeschuetzte Policy-Datei verhindert lokale Aenderungen
      writableOverride = false;
      const roRes = await service.updateAuthConfig({ enabled: false });
      assert.equal(roRes.success, false);
      assert.equal(roRes.readOnly, true);
      writableOverride = null;

      // HKLM-Sperre setzen und Umstellung ueber config blockieren
      const lockRes = await service.lockPolicyPathInHklm();
      assert.equal(lockRes.success, true);
      assert.equal(lockRes.status.isHklmLocked, true);
      const blockedPathChange = await service.setPolicyPath(path.join(root, 'evil-policy.json'));
      assert.equal(blockedPathChange.success, false);
      assert.equal(blockedPathChange.hklmLocked, true);

      // Manipulation der Policy-Datei (enabled: false ohne gueltige Pruefsumme) -> Fail-Closed!
      const rawDoc = JSON.parse(fs.readFileSync(lockRes.status.policyPath, 'utf-8'));
      rawDoc.auth.enabled = false;
      fs.writeFileSync(lockRes.status.policyPath, JSON.stringify(rawDoc, null, 2), 'utf-8');
      const tamperedStatus = service.getStatus();
      assert.equal(tamperedStatus.integrityValid, false);
      assert.equal(tamperedStatus.enabled, true);
      assert.equal(service.checkAdminIpcAccess('save-settings').allowed, false);
    } finally {
      service.dispose();
    }
  });
});
