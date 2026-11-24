import crypto from 'node:crypto';
import path from 'node:path';
import { normalizeAccessPolicy } from './policy-logic.js';

export const HKLM_POLICY_REGISTRY_PATH = 'HKLM\\SOFTWARE\\Policies\\SoftwareKatalog';
export const HKLM_POLICY_VALUE_NAME = 'PolicyFilePath';
export const DEFAULT_POLICY_FILENAME = 'admin-policy.json';
export const POLICY_SCHEMA_VERSION = 1;
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_SESSION_TIMEOUT_MINUTES = 1440;

export const SCRYPT_PARAMS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keylen: 64,
  saltBytes: 16,
});

export const PROTECTED_ADMIN_IPC_CHANNELS = new Set([
  'save-settings',
  'save-meta-json',
  'add-software',
  'add-software-from-path',
  'add-media',
  'add-icon',
  'delete-media',
  'extract-exe-icon',
  'record-inno-inf',
  'providers-set-enabled',
  'providers-install-manager',
  'providers-uninstall-manager',
  'providers-add-source',
  'providers-remove-source',
  'providers-cache-clear',
  'archive-link-package',
  'winget-matcher-apply',
  'archive-cleanup-set-keep',
  'archive-cleanup-execute',
  'bundles-save',
  'bundles-delete',
  'bundles-duplicate',
  'bundles-import',
  'open-visual-scraper',
  'open-visual-link-picker',
  'reset-paths',
  'reset-local-versions',
  'create-backup',
  'restore-backup',
  'install-app-update',
  'auto-detect-all',
  'auth-update-config',
  'auth-set-policy-path',
  'auth-lock-hklm',
  'auth-unlock-hklm',
  'policy-update',
  'policy-export',
  'policy-import',
  'autostart-apply',
  'background-set-auto-update-paused',
]);

Object.freeze(PROTECTED_ADMIN_IPC_CHANNELS);

const HEX_RE = /^[0-9a-f]+$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;

function hasControlChars(str) {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

function scryptAsync(password, salt, keylen, options) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

function normalizePasswordHashRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.algorithm !== 'scrypt') return null;
  if (typeof raw.salt !== 'string' || typeof raw.hash !== 'string') return null;
  if (!HEX_RE.test(raw.salt) || raw.salt.length % 2 !== 0) return null;
  if (!HEX_RE.test(raw.hash) || raw.hash.length % 2 !== 0) return null;

  const params = raw.params && typeof raw.params === 'object' ? raw.params : {};
  const N = Number(params.N);
  const r = Number(params.r);
  const p = Number(params.p);
  const keylen = Number(params.keylen);

  if (!isPowerOfTwo(N) || N < 1024 || N > 131072) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  if (!Number.isInteger(keylen) || keylen < 32 || keylen > 128) return null;

  const saltBuf = Buffer.from(raw.salt, 'hex');
  const hashBuf = Buffer.from(raw.hash, 'hex');
  if (saltBuf.length < SCRYPT_PARAMS.saltBytes) return null;
  if (hashBuf.length !== keylen) return null;

  return {
    algorithm: 'scrypt',
    salt: raw.salt.toLowerCase(),
    hash: raw.hash.toLowerCase(),
    params: { N, r, p, keylen },
  };
}

/**
 * Hasht ein Passwort sicher mit Node `crypto.scrypt` und einem 16-Byte Zufalls-Salt.
 * @param {string} password
 * @param {{ salt?: Buffer | string }} [opts]
 * @returns {Promise<{ algorithm: 'scrypt', salt: string, hash: string, params: { N: number, r: number, p: number, keylen: number } }>}
 */
export async function hashPassword(password, opts = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Passwort darf nicht leer sein.');
  }

  let saltBuf;
  if (opts?.salt !== undefined) {
    if (Buffer.isBuffer(opts.salt)) {
      saltBuf = opts.salt;
    } else if (typeof opts.salt === 'string' && HEX_RE.test(opts.salt) && opts.salt.length % 2 === 0) {
      saltBuf = Buffer.from(opts.salt, 'hex');
    } else {
      throw new Error('Ungueltiges Salt-Format.');
    }
    if (saltBuf.length < SCRYPT_PARAMS.saltBytes) {
      throw new Error(`Salt muss mindestens ${SCRYPT_PARAMS.saltBytes} Bytes lang sein.`);
    }
  } else {
    saltBuf = crypto.randomBytes(SCRYPT_PARAMS.saltBytes);
  }

  const { N, r, p, keylen } = SCRYPT_PARAMS;
  const maxmem = 128 * N * r * 2;
  const derivedKey = await scryptAsync(password, saltBuf, keylen, { N, r, p, maxmem });

  return {
    algorithm: 'scrypt',
    salt: saltBuf.toString('hex'),
    hash: derivedKey.toString('hex'),
    params: { N, r, p, keylen },
  };
}

/**
 * Verifiziert ein Passwort in konstanter Zeit gegen einen gespeicherten scrypt-Datensatz.
 * @param {unknown} password
 * @param {unknown} passwordHashRecord
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, passwordHashRecord) {
  if (typeof password !== 'string' || password.length === 0) {
    return false;
  }
  const normalized = normalizePasswordHashRecord(passwordHashRecord);
  if (!normalized) {
    return false;
  }

  try {
    const saltBuf = Buffer.from(normalized.salt, 'hex');
    const expectedBuf = Buffer.from(normalized.hash, 'hex');
    const { N, r, p, keylen } = normalized.params;
    const maxmem = Math.max(32 * 1024 * 1024, 128 * N * r * 2);
    const derivedBuf = await scryptAsync(password, saltBuf, keylen, { N, r, p, maxmem });
    if (derivedBuf.length !== expectedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(derivedBuf, expectedBuf);
  } catch {
    return false;
  }
}

/**
 * Normalisiert einen Benutzernamen (Trim).
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeUsername(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Vergleicht zwei Benutzernamen (Gross-/Kleinschreibung ignoriert) zeitkonstant via SHA-256 + timingSafeEqual.
 * @param {unknown} expected
 * @param {unknown} provided
 * @returns {boolean}
 */
export function compareUsernames(expected, provided) {
  const normExpected = normalizeUsername(expected).toLowerCase();
  const normProvided = normalizeUsername(provided).toLowerCase();
  if (!normExpected || !normProvided) {
    return false;
  }
  const digestExpected = crypto.createHash('sha256').update(normExpected, 'utf8').digest();
  const digestProvided = crypto.createHash('sha256').update(normProvided, 'utf8').digest();
  return crypto.timingSafeEqual(digestExpected, digestProvided);
}

/**
 * Begrenzt das Inaktivitaets-Timeout in Minuten auf [0, MAX_SESSION_TIMEOUT_MINUTES].
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizeSessionTimeoutMinutes(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const parsed = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_SESSION_TIMEOUT_MINUTES, parsed);
}

/**
 * Validiert Benutzername und optional Passwort fuer die Admin-Konfiguration.
 * @param {{ username?: unknown, password?: unknown, requirePassword?: boolean }} [input]
 * @returns {{ valid: true, username: string } | { valid: false, error: string }}
 */
export function validateCredentialsInput({ username, password, requirePassword = true } = {}) {
  const cleanUser = normalizeUsername(username);
  if (cleanUser.length < 2 || cleanUser.length > 64) {
    return { valid: false, error: 'Der Benutzername muss zwischen 2 und 64 Zeichen lang sein.' };
  }
  if (hasControlChars(cleanUser)) {
    return { valid: false, error: 'Der Benutzername enthaelt unzulaessige Steuerzeichen.' };
  }

  const hasPassword = typeof password === 'string' && password.length > 0;
  if (requirePassword && !hasPassword) {
    return { valid: false, error: 'Bitte ein Admin-Passwort eingeben.' };
  }
  if (password !== undefined && password !== null && password !== '') {
    if (typeof password !== 'string') {
      return { valid: false, error: 'Ungueltiges Passwort-Format.' };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return { valid: false, error: `Das Passwort muss mindestens ${MIN_PASSWORD_LENGTH} Zeichen lang sein.` };
    }
    if (password.length > 256) {
      return { valid: false, error: 'Das Passwort darf maximal 256 Zeichen lang sein.' };
    }
  }

  return { valid: true, username: cleanUser };
}

/**
 * @param {Record<string, any>} policyDoc
 * @returns {{
 *   schemaVersion: number,
 *   updatedAt: string,
 *   auth: {
 *     enabled: boolean,
 *     username: string,
 *     passwordHash: Record<string, any> | null,
 *     sessionTimeoutMinutes: number,
 *   },
 *   accessPolicy?: ReturnType<typeof normalizeAccessPolicy>,
 * }}
 */
function buildCanonicalPolicyPayload(policyDoc) {
  const rawAuth = policyDoc?.auth && typeof policyDoc.auth === 'object' ? policyDoc.auth : {};
  const normalizedHash = normalizePasswordHashRecord(rawAuth.passwordHash);
  const canonicalHash = normalizedHash
    ? {
        algorithm: normalizedHash.algorithm,
        salt: normalizedHash.salt,
        hash: normalizedHash.hash,
        params: {
          N: normalizedHash.params.N,
          r: normalizedHash.params.r,
          p: normalizedHash.params.p,
          keylen: normalizedHash.params.keylen,
        },
      }
    : null;

  const canonical = {
    schemaVersion: Number.isInteger(policyDoc?.schemaVersion) ? policyDoc.schemaVersion : POLICY_SCHEMA_VERSION,
    updatedAt: typeof policyDoc?.updatedAt === 'string' ? policyDoc.updatedAt : '',
    auth: {
      enabled: Boolean(rawAuth.enabled),
      username: normalizeUsername(rawAuth.username),
      passwordHash: canonicalHash,
      sessionTimeoutMinutes: normalizeSessionTimeoutMinutes(rawAuth.sessionTimeoutMinutes),
    },
  };

  if (policyDoc?.accessPolicy !== undefined) {
    return {
      ...canonical,
      accessPolicy: normalizeAccessPolicy(policyDoc.accessPolicy),
    };
  }

  return canonical;
}

/**
 * Berechnet die SHA-256 Integritaets-Pruefsumme fuer ein Policy-Dokument.
 * @param {Record<string, any>} policyDoc
 * @returns {string}
 */
export function computePolicyIntegrity(policyDoc) {
  const canonical = buildCanonicalPolicyPayload(policyDoc);
  const serialized = `SoftwareKatalog.AdminPolicy.v1:${JSON.stringify(canonical)}`;
  return crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/**
 * Erstellt ein signiertes/integritaetsgeschuetztes Policy-Dokument.
 * @param {{
 *   enabled?: boolean,
 *   username?: string,
 *   passwordHash?: Record<string, any> | null,
 *   sessionTimeoutMinutes?: number,
 *   accessPolicy?: Record<string, any>,
 *   updatedAt?: string,
 * }} [params]
 */
export function createPolicyDocument({
  enabled = false,
  username = '',
  passwordHash = null,
  sessionTimeoutMinutes = 0,
  accessPolicy = undefined,
  updatedAt = new Date().toISOString(),
} = {}) {
  const docInput = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    updatedAt,
    auth: {
      enabled: Boolean(enabled),
      username: normalizeUsername(username),
      passwordHash: enabled ? passwordHash : null,
      sessionTimeoutMinutes: normalizeSessionTimeoutMinutes(sessionTimeoutMinutes),
    },
  };
  if (accessPolicy !== undefined) {
    docInput.accessPolicy = accessPolicy;
  }

  const canonical = buildCanonicalPolicyPayload(docInput);
  const checksum = computePolicyIntegrity(canonical);

  return {
    ...canonical,
    integrity: {
      algorithm: 'sha256',
      checksum,
    },
  };
}

/**
 * Prueft Struktur und SHA-256 Integritaets-Pruefsumme eines Policy-Dokuments.
 * @param {unknown} rawDoc
 * @returns {{ valid: boolean, expectedChecksum: string, actualChecksum: string, reason: string }}
 */
export function verifyPolicyIntegrity(rawDoc) {
  if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) {
    return { valid: false, expectedChecksum: '', actualChecksum: '', reason: 'invalid-document' };
  }
  const doc = /** @type {Record<string, any>} */ (rawDoc);
  if (!doc.auth || typeof doc.auth !== 'object' || Array.isArray(doc.auth)) {
    return { valid: false, expectedChecksum: '', actualChecksum: '', reason: 'missing-auth' };
  }
  if (doc.auth.enabled && !normalizePasswordHashRecord(doc.auth.passwordHash)) {
    return { valid: false, expectedChecksum: '', actualChecksum: '', reason: 'invalid-password-hash' };
  }

  const integrity = doc.integrity && typeof doc.integrity === 'object' ? doc.integrity : null;
  if (integrity?.algorithm !== 'sha256' || typeof integrity?.checksum !== 'string') {
    return { valid: false, expectedChecksum: '', actualChecksum: '', reason: 'missing-integrity' };
  }

  const actualChecksum = integrity.checksum.trim().toLowerCase();
  if (!SHA256_HEX_RE.test(actualChecksum)) {
    return { valid: false, expectedChecksum: '', actualChecksum, reason: 'malformed-checksum' };
  }

  const expectedChecksum = computePolicyIntegrity(doc);
  const actualBuf = Buffer.from(actualChecksum, 'hex');
  const expectedBuf = Buffer.from(expectedChecksum, 'hex');
  if (actualBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(actualBuf, expectedBuf)) {
    return { valid: false, expectedChecksum, actualChecksum, reason: 'checksum-mismatch' };
  }

  return { valid: true, expectedChecksum, actualChecksum, reason: 'ok' };
}

function resolvePathForLocation(rawPath, appFolder) {
  const clean = String(rawPath || '').trim();
  if (!clean) return '';
  if (/^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith('\\\\') || path.isAbsolute(clean)) {
    return path.normalize(clean);
  }
  return path.resolve(appFolder || process.cwd(), clean);
}

/**
 * Loest den Speicherort der Auth-/Policy-Datei in strenger Prioritaet auf:
 * 1. HKLM-Registry-Policy (PolicyFilePath)
 * 2. Konfigurierter Pfad (authFilePath aus config.json)
 * 3. Standardpfad (data/admin-policy.json)
 * @param {{
 *   hklmPolicyPath?: string,
 *   configuredPolicyPath?: string,
 *   defaultPolicyPath?: string,
 *   appFolder?: string,
 * }} [options]
 * @returns {{ policyPath: string, pathSource: 'hklm' | 'config' | 'default', isHklmLocked: boolean }}
 */
export function resolvePolicyFileLocation({
  hklmPolicyPath = '',
  configuredPolicyPath = '',
  defaultPolicyPath = '',
  appFolder = '',
} = {}) {
  const cleanHklm = String(hklmPolicyPath || '').trim();
  if (cleanHklm) {
    return {
      policyPath: resolvePathForLocation(cleanHklm, appFolder),
      pathSource: 'hklm',
      isHklmLocked: true,
    };
  }

  const cleanConfigured = String(configuredPolicyPath || '').trim();
  if (cleanConfigured) {
    return {
      policyPath: resolvePathForLocation(cleanConfigured, appFolder),
      pathSource: 'config',
      isHklmLocked: false,
    };
  }

  return {
    policyPath: resolvePathForLocation(defaultPolicyPath, appFolder),
    pathSource: 'default',
    isHklmLocked: false,
  };
}

/**
 * Prueft, ob ein IPC-Kanal durch die Admin-Session geschuetzt ist.
 * @param {unknown} channel
 * @returns {boolean}
 */
export function isProtectedAdminChannel(channel) {
  return PROTECTED_ADMIN_IPC_CHANNELS.has(String(channel || '').trim());
}

/**
 * Prueft, ob die aktuelle Admin-Session abgelaufen ist.
 * @param {{
 *   isAuthenticated?: boolean,
 *   lastActivityAt?: number | null,
 *   sessionTimeoutMinutes?: number,
 *   now?: number,
 * }} [params]
 * @returns {boolean}
 */
export function isSessionExpired({
  isAuthenticated = false,
  lastActivityAt = null,
  sessionTimeoutMinutes = 0,
  now = Date.now(),
} = {}) {
  if (!isAuthenticated) return true;
  const timeoutMin = normalizeSessionTimeoutMinutes(sessionTimeoutMinutes);
  if (timeoutMin <= 0) return false;
  if (!Number.isFinite(lastActivityAt) || !lastActivityAt) return true;
  return now - lastActivityAt >= timeoutMin * 60_000;
}

/**
 * Trifft die serverseitige Zugriffsentscheidung fuer einen IPC-Aufruf im Main-Prozess.
 * @param {{
 *   channel?: string,
 *   authEnabled?: boolean,
 *   isAuthenticated?: boolean,
 *   lastActivityAt?: number | null,
 *   sessionTimeoutMinutes?: number,
 *   now?: number,
 * }} [params]
 * @returns {{
 *   allowed: boolean,
 *   reason: string,
 *   expired: boolean,
 *   code?: string,
 *   error?: string,
 * }}
 */
export function evaluateAdminAccess({
  channel = '',
  authEnabled = false,
  isAuthenticated = false,
  lastActivityAt = null,
  sessionTimeoutMinutes = 0,
  now = Date.now(),
} = {}) {
  if (!isProtectedAdminChannel(channel)) {
    return { allowed: true, reason: 'public-channel', expired: false };
  }
  if (!authEnabled) {
    return { allowed: true, reason: 'auth-disabled', expired: false };
  }
  if (!isAuthenticated) {
    return {
      allowed: false,
      reason: 'unauthenticated',
      expired: false,
      code: 'AUTH_REQUIRED',
      error: 'Admin-Anmeldung erforderlich.',
    };
  }
  if (isSessionExpired({ isAuthenticated, lastActivityAt, sessionTimeoutMinutes, now })) {
    return {
      allowed: false,
      reason: 'session-expired',
      expired: true,
      code: 'AUTH_REQUIRED',
      error: 'Admin-Sitzung abgelaufen. Bitte erneut anmelden.',
    };
  }
  return { allowed: true, reason: 'authenticated', expired: false };
}
