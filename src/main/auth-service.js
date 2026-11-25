import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  compareUsernames,
  createPolicyDocument,
  DEFAULT_POLICY_FILENAME,
  evaluateAdminAccess,
  HKLM_POLICY_REGISTRY_PATH,
  HKLM_POLICY_VALUE_NAME,
  hashPassword,
  isProtectedAdminChannel,
  isSessionExpired,
  normalizeSessionTimeoutMinutes,
  normalizeUsername,
  resolvePolicyFileLocation,
  validateCredentialsInput,
  verifyPassword,
  verifyPolicyIntegrity,
} from '../shared/auth-logic.js';
import {
  cloneAccessPolicy,
  createDefaultAccessPolicy,
  createFailClosedAccessPolicy,
  evaluatePackagePolicy,
  normalizeAccessPolicy,
} from '../shared/policy-logic.js';
import {
  isAdminSessionActive,
  isProcessElevated,
  runPowerShellElevated,
  startAdminSession,
} from './elevated-helper.js';

const READ_ONLY_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS']);
const MAX_FAILED_ATTEMPTS = 5;
const BRUTEFORCE_LOCKOUT_MS = 10_000;
const TIMEOUT_CHECK_INTERVAL_MS = 30_000;

function stripBom(text) {
  return typeof text === 'string' && text.startsWith('\uFEFF') ? text.slice(1) : String(text || '');
}

function escapeSingleQuotedPs(value) {
  return String(value || '').replace(/'/g, "''");
}

function defaultReadHklmPolicyPath(platform = process.platform) {
  if (platform !== 'win32') {
    return Promise.resolve('');
  }
  const psScript = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    `$regPath = 'Registry::${HKLM_POLICY_REGISTRY_PATH}'`,
    `if (Test-Path -LiteralPath $regPath) {`,
    `  $props = Get-ItemProperty -LiteralPath $regPath -Name '${HKLM_POLICY_VALUE_NAME}' -ErrorAction SilentlyContinue`,
    `  if ($null -ne $props -and $null -ne $props.${HKLM_POLICY_VALUE_NAME}) {`,
    `    Write-Output ([string]$props.${HKLM_POLICY_VALUE_NAME})`,
    '  }',
    '}',
  ].join('\n');

  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', psScript],
      { windowsHide: true, timeout: 6000 },
      (err, stdout) => {
        if (err) {
          resolve('');
          return;
        }
        const cleaned = stripBom(stdout).trim();
        resolve(cleaned);
      }
    );
  });
}

async function ensureElevationForHklm(platform = process.platform) {
  if (platform !== 'win32') {
    return { ok: false, canceled: false, error: 'HKLM-Policy-Sperre wird nur unter Windows unterstuetzt.' };
  }
  if ((await isProcessElevated()) || isAdminSessionActive()) {
    return { ok: true };
  }
  const res = await startAdminSession();
  if (res?.success || res?.alreadyElevated || res?.alreadyActive) {
    return { ok: true };
  }
  return {
    ok: false,
    canceled: Boolean(res?.canceled),
    error: res?.canceled
      ? 'UAC-Abfrage wurde abgebrochen.'
      : res?.error || 'Administratorrechte fuer HKLM-Registry-Zugriff erforderlich.',
  };
}

async function defaultWriteHklmPolicyPath(policyPath, platform = process.platform) {
  const cleanPath = String(policyPath || '').trim();
  if (!cleanPath || /[\r\n\0]/.test(cleanPath)) {
    return { success: false, error: 'Ungueltiger Policy-Pfad fuer HKLM.' };
  }

  const elev = await ensureElevationForHklm(platform);
  if (!elev.ok) {
    return { success: false, canceled: elev.canceled, error: elev.error };
  }

  const safePath = escapeSingleQuotedPs(cleanPath);
  const psScript = `
    $ErrorActionPreference = 'Stop'
    $regPath = 'Registry::${HKLM_POLICY_REGISTRY_PATH}'
    if (-not (Test-Path -LiteralPath $regPath)) {
      New-Item -Path $regPath -Force | Out-Null
    }
    New-ItemProperty -LiteralPath $regPath -Name '${HKLM_POLICY_VALUE_NAME}' -Value '${safePath}' -PropertyType String -Force | Out-Null
    Write-Output 'HKLM_OK'
  `;

  const res = await runPowerShellElevated(psScript, { timeoutMs: 20000 });
  if (res.canceled) {
    return { success: false, canceled: true, error: 'Vorgang abgebrochen.' };
  }
  if (res.code === 0 && String(res.stdout || '').includes('HKLM_OK')) {
    return { success: true };
  }
  return {
    success: false,
    error: res.error || res.stderr || 'HKLM-Policy-Wert konnte nicht in die Registry geschrieben werden.',
  };
}

async function defaultRemoveHklmPolicyPath(platform = process.platform) {
  const elev = await ensureElevationForHklm(platform);
  if (!elev.ok) {
    return { success: false, canceled: elev.canceled, error: elev.error };
  }

  const psScript = `
    $ErrorActionPreference = 'Stop'
    $regPath = 'Registry::${HKLM_POLICY_REGISTRY_PATH}'
    if (Test-Path -LiteralPath $regPath) {
      Remove-ItemProperty -LiteralPath $regPath -Name '${HKLM_POLICY_VALUE_NAME}' -ErrorAction SilentlyContinue
    }
    Write-Output 'HKLM_REMOVED'
  `;

  const res = await runPowerShellElevated(psScript, { timeoutMs: 20000 });
  if (res.canceled) {
    return { success: false, canceled: true, error: 'Vorgang abgebrochen.' };
  }
  if (res.code === 0 && String(res.stdout || '').includes('HKLM_REMOVED')) {
    return { success: true };
  }
  return {
    success: false,
    error: res.error || res.stderr || 'HKLM-Policy-Wert konnte nicht aus der Registry entfernt werden.',
  };
}

function defaultCheckWritable(filePath) {
  const target = String(filePath || '').trim();
  if (!target) return false;

  try {
    if (fs.existsSync(target)) {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) return false;
      fs.accessSync(target, fs.constants.W_OK);
      const fd = fs.openSync(target, fs.constants.O_RDWR);
      fs.closeSync(fd);
      return true;
    }

    // Datei existiert noch nicht: naechsten existierenden Elternordner pruefen
    let dir = path.dirname(target);
    let prev = '';
    while (dir && dir !== prev && !fs.existsSync(dir)) {
      prev = dir;
      dir = path.dirname(dir);
    }
    if (!dir || !fs.existsSync(dir)) return false;

    fs.accessSync(dir, fs.constants.W_OK);
    const probePath = path.join(dir, `.sk_write_probe_${process.pid}_${crypto.randomBytes(4).toString('hex')}.tmp`);
    const fd = fs.openSync(probePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.closeSync(fd);
    fs.unlinkSync(probePath);
    return true;
  } catch {
    return false;
  }
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`
  );
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignorieren
    }
    throw err;
  }
}

function isReadOnlyFsError(err) {
  const code = String(err?.code || '').toUpperCase();
  return READ_ONLY_ERROR_CODES.has(code);
}

/**
 * Erzeugt eine isolierte Instanz des Auth- & Policy-Services fuer den Main-Prozess.
 * @param {Record<string, any>} [deps]
 */
export function createAuthService(deps = {}) {
  const platform = deps.platform ?? process.platform;
  let getConfigFn = typeof deps.getConfigFn === 'function' ? deps.getConfigFn : () => ({});
  let saveConfigFn = typeof deps.saveConfigFn === 'function' ? deps.saveConfigFn : () => {};
  let getAppFolderFn = typeof deps.getAppFolderFn === 'function' ? deps.getAppFolderFn : () => process.cwd();
  let getDataFolderFn =
    typeof deps.getDataFolderFn === 'function' ? deps.getDataFolderFn : () => path.join(getAppFolderFn(), 'data');
  const nowFn = typeof deps.nowFn === 'function' ? deps.nowFn : () => Date.now();
  const readHklmFn =
    typeof deps.readHklmFn === 'function' ? deps.readHklmFn : () => defaultReadHklmPolicyPath(platform);
  const writeHklmFn =
    typeof deps.writeHklmFn === 'function' ? deps.writeHklmFn : (p) => defaultWriteHklmPolicyPath(p, platform);
  const removeHklmFn =
    typeof deps.removeHklmFn === 'function' ? deps.removeHklmFn : () => defaultRemoveHklmPolicyPath(platform);
  const checkWritableFn = typeof deps.checkWritableFn === 'function' ? deps.checkWritableFn : defaultCheckWritable;
  const enableTimer = deps.enableTimer !== false;

  let cachedHklmPolicyPath = '';
  let isAuthenticated = false;
  let authenticatedUser = '';
  let lastActivityAt = null;
  let failedAttempts = 0;
  let lockedUntil = 0;
  let timeoutTimer = null;
  let lastNotifiedSignature = '';
  const statusListeners = new Set();

  if (typeof deps.onStatusChange === 'function') {
    statusListeners.add(deps.onStatusChange);
  }

  let policyState = {
    policyPath: '',
    configuredPolicyPath: '',
    defaultPolicyPath: '',
    pathSource: 'default',
    isHklmLocked: false,
    hklmPolicyPath: '',
    isReadOnlyPolicy: false,
    policyExists: false,
    effectiveEnabled: false,
    rawEnabled: false,
    username: '',
    passwordHash: null,
    sessionTimeoutMinutes: 0,
    integrityValid: true,
    integrityWarning: '',
    integrityChecksum: '',
    hasStoredAccessPolicy: false,
    accessPolicy: createDefaultAccessPolicy(),
  };

  function loadPolicyState() {
    const cfg = getConfigFn() || {};
    const appFolder = getAppFolderFn();
    const dataDir = getDataFolderFn();
    const defaultPolicyPath = path.join(dataDir, DEFAULT_POLICY_FILENAME);
    const configuredPolicyPath = typeof cfg.authFilePath === 'string' ? cfg.authFilePath.trim() : '';

    const loc = resolvePolicyFileLocation({
      hklmPolicyPath: cachedHklmPolicyPath,
      configuredPolicyPath,
      defaultPolicyPath,
      appFolder,
    });

    const policyExists = Boolean(loc.policyPath && fs.existsSync(loc.policyPath));
    const isReadOnlyPolicy = !checkWritableFn(loc.policyPath);

    let effectiveEnabled = false;
    let rawEnabled = false;
    let username = '';
    let passwordHash = null;
    let sessionTimeoutMinutes = 0;
    let integrityValid = true;
    let integrityWarning = '';
    let integrityChecksum = '';
    let hasStoredAccessPolicy = false;
    let accessPolicy = createDefaultAccessPolicy();

    if (!policyExists) {
      if (loc.isHklmLocked) {
        // Fail-Closed bei fehlender HKLM-Policy-Datei
        effectiveEnabled = true;
        integrityValid = false;
        integrityWarning =
          'Die per HKLM-Policy festgelegte Datei wurde nicht gefunden. Administrative Aktionen bleiben gesperrt.';
        accessPolicy = createFailClosedAccessPolicy();
      }
    } else {
      try {
        const rawText = stripBom(fs.readFileSync(loc.policyPath, 'utf-8'));
        const parsed = JSON.parse(rawText);
        const integrity = verifyPolicyIntegrity(parsed);
        integrityChecksum = integrity.actualChecksum || integrity.expectedChecksum || '';

        if (!integrity.valid) {
          // Fail-Closed bei Manipulationsverdacht oder beschaedigter Pruefsumme
          effectiveEnabled = true;
          rawEnabled = Boolean(parsed?.auth?.enabled);
          username = normalizeUsername(parsed?.auth?.username);
          sessionTimeoutMinutes = normalizeSessionTimeoutMinutes(parsed?.auth?.sessionTimeoutMinutes);
          integrityValid = false;
          integrityWarning =
            'Integritaetspruefung der Policy-Datei fehlgeschlagen (moegliche Manipulation). Administrative Aktionen bleiben gesperrt.';
          accessPolicy = createFailClosedAccessPolicy();
        } else {
          rawEnabled = Boolean(parsed.auth.enabled);
          effectiveEnabled = rawEnabled;
          username = normalizeUsername(parsed.auth.username);
          passwordHash = parsed.auth.passwordHash || null;
          sessionTimeoutMinutes = normalizeSessionTimeoutMinutes(parsed.auth.sessionTimeoutMinutes);
          integrityValid = true;
          integrityWarning = '';
          hasStoredAccessPolicy = parsed.accessPolicy !== undefined;
          accessPolicy =
            parsed.accessPolicy !== undefined
              ? normalizeAccessPolicy(parsed.accessPolicy)
              : createDefaultAccessPolicy();
        }
      } catch {
        // Fail-Closed bei Lesefehlern / ungueltigem JSON
        effectiveEnabled = true;
        integrityValid = false;
        integrityWarning =
          'Policy-Datei konnte nicht gelesen werden oder ist beschaedigt. Administrative Aktionen bleiben gesperrt.';
        accessPolicy = createFailClosedAccessPolicy();
      }
    }

    policyState = {
      policyPath: loc.policyPath,
      configuredPolicyPath,
      defaultPolicyPath,
      pathSource: loc.pathSource,
      isHklmLocked: loc.isHklmLocked,
      hklmPolicyPath: cachedHklmPolicyPath,
      isReadOnlyPolicy,
      policyExists,
      effectiveEnabled,
      rawEnabled,
      username,
      passwordHash,
      sessionTimeoutMinutes,
      integrityValid,
      integrityWarning,
      integrityChecksum,
      hasStoredAccessPolicy,
      accessPolicy,
    };

    if (!policyState.effectiveEnabled && isAuthenticated) {
      isAuthenticated = false;
      authenticatedUser = '';
      lastActivityAt = null;
    }

    return policyState;
  }

  function buildPublicStatus() {
    return {
      enabled: policyState.effectiveEnabled,
      isAuthenticated: policyState.effectiveEnabled ? isAuthenticated : false,
      username: policyState.username,
      authenticatedUser: policyState.effectiveEnabled && isAuthenticated ? authenticatedUser : '',
      sessionTimeoutMinutes: policyState.sessionTimeoutMinutes,
      lastActivityAt: policyState.effectiveEnabled && isAuthenticated ? lastActivityAt : null,
      policyPath: policyState.policyPath,
      configuredPolicyPath: policyState.configuredPolicyPath,
      defaultPolicyPath: policyState.defaultPolicyPath,
      pathSource: policyState.pathSource,
      isHklmLocked: policyState.isHklmLocked,
      hklmPolicyPath: policyState.hklmPolicyPath,
      isReadOnlyPolicy: policyState.isReadOnlyPolicy,
      policyExists: policyState.policyExists,
      integrityValid: policyState.integrityValid,
      integrityWarning: policyState.integrityWarning,
      integrityChecksum: policyState.integrityChecksum,
      platformSupportedForHklm: platform === 'win32',
      accessPolicy: cloneAccessPolicy(policyState.accessPolicy),
    };
  }

  function notifyStatusChange() {
    const status = buildPublicStatus();
    const signature = JSON.stringify([
      status.enabled,
      status.isAuthenticated,
      status.username,
      status.authenticatedUser,
      status.sessionTimeoutMinutes,
      status.policyPath,
      status.pathSource,
      status.isHklmLocked,
      status.isReadOnlyPolicy,
      status.policyExists,
      status.integrityValid,
      status.integrityWarning,
      status.accessPolicy,
    ]);
    if (signature === lastNotifiedSignature) return;
    lastNotifiedSignature = signature;
    for (const listener of statusListeners) {
      try {
        listener(status);
      } catch {
        // Listener-Fehler isolieren
      }
    }
  }

  function enforceTimeoutIfNeeded() {
    if (!policyState.effectiveEnabled || !isAuthenticated) return false;
    if (
      isSessionExpired({
        isAuthenticated,
        lastActivityAt,
        sessionTimeoutMinutes: policyState.sessionTimeoutMinutes,
        now: nowFn(),
      })
    ) {
      isAuthenticated = false;
      authenticatedUser = '';
      lastActivityAt = null;
      notifyStatusChange();
      return true;
    }
    return false;
  }

  function configure(options = {}) {
    if (typeof options.getConfigFn === 'function') {
      getConfigFn = options.getConfigFn;
    }
    if (typeof options.saveConfigFn === 'function') {
      saveConfigFn = options.saveConfigFn;
    }
    if (typeof options.getAppFolderFn === 'function') {
      getAppFolderFn = options.getAppFolderFn;
    }
    if (typeof options.getDataFolderFn === 'function') {
      getDataFolderFn = options.getDataFolderFn;
    }
    if (typeof options.onStatusChange === 'function') {
      statusListeners.add(options.onStatusChange);
    }
  }

  async function init() {
    try {
      cachedHklmPolicyPath = String((await readHklmFn()) || '').trim();
    } catch {
      cachedHklmPolicyPath = '';
    }
    loadPolicyState();

    if (enableTimer && !timeoutTimer) {
      timeoutTimer = setInterval(() => {
        enforceTimeoutIfNeeded();
      }, TIMEOUT_CHECK_INTERVAL_MS);
      timeoutTimer.unref();
    }

    notifyStatusChange();
    return buildPublicStatus();
  }

  async function refreshHklmAndPolicy() {
    try {
      cachedHklmPolicyPath = String((await readHklmFn()) || '').trim();
    } catch {
      cachedHklmPolicyPath = '';
    }
    loadPolicyState();
    enforceTimeoutIfNeeded();
    notifyStatusChange();
    return buildPublicStatus();
  }

  function getStatus({ refreshDisk = true } = {}) {
    if (refreshDisk) {
      loadPolicyState();
    }
    enforceTimeoutIfNeeded();
    return buildPublicStatus();
  }

  function checkAdminIpcAccess(channel) {
    loadPolicyState();
    const now = nowFn();
    const access = evaluateAdminAccess({
      channel,
      authEnabled: policyState.effectiveEnabled,
      isAuthenticated,
      lastActivityAt,
      sessionTimeoutMinutes: policyState.sessionTimeoutMinutes,
      now,
    });

    if (access.expired && isAuthenticated) {
      isAuthenticated = false;
      authenticatedUser = '';
      lastActivityAt = null;
      notifyStatusChange();
    } else if (access.allowed && isAuthenticated && isProtectedAdminChannel(channel)) {
      lastActivityAt = now;
    }

    return access;
  }

  async function login(username, password) {
    loadPolicyState();

    const now = nowFn();
    if (lockedUntil > now) {
      const waitSec = Math.max(1, Math.ceil((lockedUntil - now) / 1000));
      return {
        success: false,
        throttled: true,
        error: `Zu viele Fehlversuche. Bitte ${waitSec} Sekunden warten.`,
        status: buildPublicStatus(),
      };
    }

    if (!policyState.effectiveEnabled) {
      return {
        success: true,
        alreadyOpen: true,
        status: buildPublicStatus(),
      };
    }

    if (!policyState.integrityValid || !policyState.passwordHash) {
      return {
        success: false,
        error:
          policyState.integrityWarning ||
          'Keine gueltigen Zugangsdaten in der Policy-Datei gefunden. Pruefe die Datei auf Manipulation.',
        status: buildPublicStatus(),
      };
    }

    const userMatch = compareUsernames(policyState.username, username);
    const passMatch = await verifyPassword(password, policyState.passwordHash);

    if (!userMatch || !passMatch) {
      failedAttempts += 1;
      if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
        lockedUntil = nowFn() + BRUTEFORCE_LOCKOUT_MS;
      }
      return {
        success: false,
        error: 'Benutzername oder Passwort ist falsch.',
        status: buildPublicStatus(),
      };
    }

    failedAttempts = 0;
    lockedUntil = 0;
    isAuthenticated = true;
    authenticatedUser = policyState.username;
    lastActivityAt = nowFn();
    notifyStatusChange();

    return {
      success: true,
      status: buildPublicStatus(),
    };
  }

  function logout() {
    isAuthenticated = false;
    authenticatedUser = '';
    lastActivityAt = null;
    loadPolicyState();
    notifyStatusChange();
    return {
      success: true,
      status: buildPublicStatus(),
    };
  }

  /**
   * @param {{ enabled?: boolean, username?: string, password?: string, sessionTimeoutMinutes?: number }} [options]
   */
  async function updateAuthConfig(options = {}) {
    const { enabled, username, password, sessionTimeoutMinutes } = options;
    loadPolicyState();

    if (policyState.isReadOnlyPolicy) {
      return {
        success: false,
        readOnly: true,
        error:
          'Die Policy-Datei ist schreibgeschuetzt (Nur-Lese-Zugriff). Aenderungen muessen vom Administrator direkt am geschuetzten Speicherort vorgenommen werden.',
        status: buildPublicStatus(),
      };
    }

    const nextEnabled = Boolean(enabled);
    const nextTimeout = normalizeSessionTimeoutMinutes(
      sessionTimeoutMinutes !== undefined ? sessionTimeoutMinutes : policyState.sessionTimeoutMinutes
    );

    if (nextEnabled) {
      const hasExistingValidHash = Boolean(policyState.integrityValid && policyState.passwordHash);
      const hasNewPassword = typeof password === 'string' && password.length > 0;
      const check = validateCredentialsInput({
        username: username !== undefined ? username : policyState.username,
        password: hasNewPassword ? password : '',
        requirePassword: !hasExistingValidHash,
      });
      if (!check.valid) {
        return {
          success: false,
          error: 'error' in check ? check.error : 'Ungueltige Zugangsdaten.',
          status: buildPublicStatus(),
        };
      }

      const preservedAccessPolicy =
        policyState.hasStoredAccessPolicy || policyState.accessPolicy.enabled ? policyState.accessPolicy : undefined;
      const nextHash = hasNewPassword ? await hashPassword(password) : policyState.passwordHash;
      const doc = createPolicyDocument({
        enabled: true,
        username: check.username,
        passwordHash: nextHash,
        sessionTimeoutMinutes: nextTimeout,
        accessPolicy: preservedAccessPolicy,
        updatedAt: new Date(nowFn()).toISOString(),
      });

      try {
        writeFileAtomic(policyState.policyPath, JSON.stringify(doc, null, 2));
      } catch (err) {
        return {
          success: false,
          readOnly: isReadOnlyFsError(err),
          error: isReadOnlyFsError(err)
            ? 'Policy-Datei konnte nicht ueberschrieben werden (Schreibschutz / fehlende Berechtigung).'
            : `Policy-Datei konnte nicht gespeichert werden: ${err.message}`,
          status: buildPublicStatus(),
        };
      }

      isAuthenticated = true;
      authenticatedUser = check.username;
      lastActivityAt = nowFn();
    } else {
      const preservedAccessPolicy =
        policyState.hasStoredAccessPolicy || policyState.accessPolicy.enabled ? policyState.accessPolicy : undefined;
      const keptUsername = normalizeUsername(username !== undefined ? username : policyState.username);
      const doc = createPolicyDocument({
        enabled: false,
        username: keptUsername,
        passwordHash: null,
        sessionTimeoutMinutes: nextTimeout,
        accessPolicy: preservedAccessPolicy,
        updatedAt: new Date(nowFn()).toISOString(),
      });

      try {
        writeFileAtomic(policyState.policyPath, JSON.stringify(doc, null, 2));
      } catch (err) {
        return {
          success: false,
          readOnly: isReadOnlyFsError(err),
          error: isReadOnlyFsError(err)
            ? 'Policy-Datei konnte nicht ueberschrieben werden (Schreibschutz / fehlende Berechtigung).'
            : `Policy-Datei konnte nicht gespeichert werden: ${err.message}`,
          status: buildPublicStatus(),
        };
      }

      isAuthenticated = false;
      authenticatedUser = '';
      lastActivityAt = null;
    }

    loadPolicyState();
    notifyStatusChange();
    return {
      success: true,
      status: buildPublicStatus(),
    };
  }

  async function setPolicyPath(rawPath, { copyCurrentPolicy = true } = {}) {
    try {
      cachedHklmPolicyPath = String((await readHklmFn()) || '').trim();
    } catch {
      cachedHklmPolicyPath = '';
    }
    loadPolicyState();

    if (policyState.isHklmLocked) {
      return {
        success: false,
        hklmLocked: true,
        error:
          'Der Speicherort der Policy-Datei ist per Windows-Registry (HKLM) gesperrt und kann hier nicht umgestellt werden.',
        status: buildPublicStatus(),
      };
    }

    let cleanPath = String(rawPath || '').trim();
    if (/[\r\n\0]/.test(cleanPath)) {
      return {
        success: false,
        error: 'Der angegebene Pfad enthaelt unzulaessige Zeichen.',
        status: buildPublicStatus(),
      };
    }

    const appFolder = getAppFolderFn();
    const dataDir = getDataFolderFn();
    const defaultPath = path.join(dataDir, DEFAULT_POLICY_FILENAME);

    if (cleanPath) {
      const candidateResolved = resolvePolicyFileLocation({
        configuredPolicyPath: cleanPath,
        defaultPolicyPath: defaultPath,
        appFolder,
      }).policyPath;

      try {
        if (fs.existsSync(candidateResolved) && fs.statSync(candidateResolved).isDirectory()) {
          cleanPath = path.join(cleanPath, DEFAULT_POLICY_FILENAME);
        }
      } catch {
        // Ignorieren
      }
    }

    const nextLoc = resolvePolicyFileLocation({
      configuredPolicyPath: cleanPath,
      defaultPolicyPath: defaultPath,
      appFolder,
    });

    const prevPath = policyState.policyPath;
    if (
      copyCurrentPolicy &&
      prevPath &&
      nextLoc.policyPath &&
      path.resolve(prevPath).toLowerCase() !== path.resolve(nextLoc.policyPath).toLowerCase() &&
      fs.existsSync(prevPath) &&
      !fs.existsSync(nextLoc.policyPath)
    ) {
      try {
        const content = fs.readFileSync(prevPath, 'utf-8');
        writeFileAtomic(nextLoc.policyPath, content);
      } catch (err) {
        return {
          success: false,
          readOnly: isReadOnlyFsError(err),
          error: isReadOnlyFsError(err)
            ? `Keine Schreibberechtigung fuer den neuen Speicherort (${nextLoc.policyPath}).`
            : `Policy-Datei konnte nicht an den neuen Speicherort kopiert werden: ${err.message}`,
          status: buildPublicStatus(),
        };
      }
    }

    try {
      saveConfigFn({ authFilePath: cleanPath });
    } catch (err) {
      return {
        success: false,
        error: `Konfiguration konnte nicht gespeichert werden: ${err.message}`,
        status: buildPublicStatus(),
      };
    }

    loadPolicyState();
    notifyStatusChange();
    return {
      success: true,
      status: buildPublicStatus(),
    };
  }

  async function lockPolicyPathInHklm(targetPath = '') {
    if (platform !== 'win32') {
      return {
        success: false,
        error: 'HKLM-Policy-Sperre wird nur unter Windows unterstuetzt.',
        status: buildPublicStatus(),
      };
    }

    loadPolicyState();
    const cleanTarget = String(targetPath || '').trim();
    const resolvedTarget = cleanTarget
      ? resolvePolicyFileLocation({
          configuredPolicyPath: cleanTarget,
          defaultPolicyPath: policyState.defaultPolicyPath,
          appFolder: getAppFolderFn(),
        }).policyPath
      : policyState.policyPath;

    if (!resolvedTarget || !fs.existsSync(resolvedTarget)) {
      return {
        success: false,
        error: 'Bitte zuerst Admin-Schutz oder Zugriffsrichtlinien speichern, bevor der Pfad per HKLM gesperrt wird.',
        status: buildPublicStatus(),
      };
    }

    const writeRes = await writeHklmFn(resolvedTarget);
    if (!writeRes?.success) {
      return {
        success: false,
        canceled: Boolean(writeRes?.canceled),
        error: writeRes?.error || 'HKLM-Sperre konnte nicht gesetzt werden.',
        status: buildPublicStatus(),
      };
    }

    await refreshHklmAndPolicy();
    return {
      success: true,
      status: buildPublicStatus(),
    };
  }

  async function unlockPolicyPathInHklm() {
    if (platform !== 'win32') {
      return {
        success: false,
        error: 'HKLM-Policy-Sperre wird nur unter Windows unterstuetzt.',
        status: buildPublicStatus(),
      };
    }

    const remRes = await removeHklmFn();
    if (!remRes?.success) {
      return {
        success: false,
        canceled: Boolean(remRes?.canceled),
        error: remRes?.error || 'HKLM-Sperre konnte nicht entfernt werden.',
        status: buildPublicStatus(),
      };
    }

    await refreshHklmAndPolicy();
    return {
      success: true,
      status: buildPublicStatus(),
    };
  }

  function isCurrentAdmin() {
    enforceTimeoutIfNeeded();
    return Boolean(policyState.effectiveEnabled && isAuthenticated);
  }

  function getAccessPolicy({ refreshDisk = true } = {}) {
    if (refreshDisk) {
      loadPolicyState();
    }
    const admin = isCurrentAdmin();
    return {
      success: true,
      accessPolicy: cloneAccessPolicy(policyState.accessPolicy),
      isAdmin: admin,
      isReadOnlyPolicy: policyState.isReadOnlyPolicy,
      integrityValid: policyState.integrityValid,
    };
  }

  /**
   * @param {Record<string, any> | null | undefined} pkg
   * @param {'update' | 'install' | 'view'} [action]
   * @param {{ refreshDisk?: boolean }} [opts]
   */
  function evaluatePackageAccess(pkg, action = 'install', { refreshDisk = true } = {}) {
    if (refreshDisk) {
      loadPolicyState();
    }
    const admin = isCurrentAdmin();
    return evaluatePackagePolicy(pkg, action, policyState.accessPolicy, admin);
  }

  async function updateAccessPolicy(nextPolicyInput) {
    loadPolicyState();

    if (policyState.isReadOnlyPolicy) {
      return {
        success: false,
        readOnly: true,
        error:
          'Die Policy-Datei ist schreibgeschuetzt (Nur-Lese-Zugriff). Aenderungen muessen vom Administrator direkt am geschuetzten Speicherort vorgenommen werden.',
        status: buildPublicStatus(),
      };
    }

    if (policyState.policyExists && !policyState.integrityValid) {
      return {
        success: false,
        error:
          policyState.integrityWarning ||
          'Policy-Datei ist beschaedigt oder manipuliert. Bitte zuerst Integritaet wiederherstellen.',
        status: buildPublicStatus(),
      };
    }

    const nextPolicy = normalizeAccessPolicy(nextPolicyInput);
    const doc = createPolicyDocument({
      enabled: policyState.rawEnabled,
      username: policyState.username,
      passwordHash: policyState.rawEnabled ? policyState.passwordHash : null,
      sessionTimeoutMinutes: policyState.sessionTimeoutMinutes,
      accessPolicy: nextPolicy,
      updatedAt: new Date(nowFn()).toISOString(),
    });

    try {
      writeFileAtomic(policyState.policyPath, JSON.stringify(doc, null, 2));
    } catch (err) {
      return {
        success: false,
        readOnly: isReadOnlyFsError(err),
        error: isReadOnlyFsError(err)
          ? 'Policy-Datei konnte nicht ueberschrieben werden (Schreibschutz / fehlende Berechtigung).'
          : `Zugriffsrichtlinien konnten nicht gespeichert werden: ${err.message}`,
        status: buildPublicStatus(),
      };
    }

    loadPolicyState();
    notifyStatusChange();
    return {
      success: true,
      accessPolicy: cloneAccessPolicy(policyState.accessPolicy),
      status: buildPublicStatus(),
    };
  }

  function dispose() {
    if (timeoutTimer) {
      clearInterval(timeoutTimer);
      timeoutTimer = null;
    }
  }

  return {
    configure,
    init,
    refreshHklmAndPolicy,
    getStatus,
    checkAdminIpcAccess,
    login,
    logout,
    updateAuthConfig,
    setPolicyPath,
    lockPolicyPathInHklm,
    unlockPolicyPathInHklm,
    getAccessPolicy,
    evaluatePackageAccess,
    updateAccessPolicy,
    dispose,
  };
}

const defaultAuthService = createAuthService();

export const configureAuthService = (options) => defaultAuthService.configure(options);
export const initAuthService = () => defaultAuthService.init();
export const getAuthStatus = (opts) => defaultAuthService.getStatus(opts);
export const checkAdminIpcAccess = (channel) => defaultAuthService.checkAdminIpcAccess(channel);
export const loginAuth = (username, password) => defaultAuthService.login(username, password);
export const logoutAuth = () => defaultAuthService.logout();
export const updateAuthConfig = (payload) => defaultAuthService.updateAuthConfig(payload);
export const setAuthPolicyPath = (policyPath, opts) => defaultAuthService.setPolicyPath(policyPath, opts);
export const lockAuthPolicyInHklm = (policyPath) => defaultAuthService.lockPolicyPathInHklm(policyPath);
export const unlockAuthPolicyInHklm = () => defaultAuthService.unlockPolicyPathInHklm();
export const getAccessPolicy = (opts) => defaultAuthService.getAccessPolicy(opts);
/** @param {Record<string, any> | null | undefined} pkg @param {'update' | 'install' | 'view'} [action] @param {{ refreshDisk?: boolean }} [opts] */
export const evaluatePackageAccess = (pkg, action, opts) => defaultAuthService.evaluatePackageAccess(pkg, action, opts);
export const updateAccessPolicy = (policy) => defaultAuthService.updateAccessPolicy(policy);
