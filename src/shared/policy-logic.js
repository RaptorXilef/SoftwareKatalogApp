import { normalizeInstallMode } from './installer-logic.js';

const POLICY_SCOPE_MODES = Object.freeze(['shared', 'separate']);
const POLICY_LIST_TYPES = Object.freeze(['none', 'whitelist', 'blacklist']);
const POLICY_EXECUTION_MODES = Object.freeze(['allow-interactive', 'silent-only']);
const POLICY_ENTRY_EXECUTION_MODES = Object.freeze(['inherit', 'silent-only', 'allow-interactive']);
export const POLICY_MATCH_TYPES = Object.freeze(['packageId', 'archiveId', 'name', 'provider']);
export const POLICY_EXPORT_FORMAT = 'software-katalog-access-policy';

const MATCH_SPECIFICITY_RANK = Object.freeze({
  packageId: 4,
  archiveId: 3,
  name: 2,
  provider: 1,
});

const SCOPE_MODE_SET = new Set(POLICY_SCOPE_MODES);
const LIST_TYPE_SET = new Set(POLICY_LIST_TYPES);
const EXEC_MODE_SET = new Set(POLICY_EXECUTION_MODES);
const ENTRY_EXEC_MODE_SET = new Set(POLICY_ENTRY_EXECUTION_MODES);
const MATCH_TYPE_SET = new Set(POLICY_MATCH_TYPES);

/**
 * @typedef {'packageId' | 'archiveId' | 'name' | 'provider'} PolicyMatchType
 * @typedef {'inherit' | 'silent-only' | 'allow-interactive'} PolicyEntryExecutionMode
 * @typedef {'allow-interactive' | 'silent-only'} PolicyExecutionMode
 * @typedef {'none' | 'whitelist' | 'blacklist'} PolicyListType
 * @typedef {'shared' | 'separate'} PolicyScopeMode
 *
 * @typedef {{
 *   matchType: PolicyMatchType,
 *   value: string,
 *   label: string,
 *   executionMode: PolicyEntryExecutionMode,
 * }} PolicyEntry
 *
 * @typedef {{
 *   listType: PolicyListType,
 *   defaultExecutionMode: PolicyExecutionMode,
 *   entries: PolicyEntry[],
 * }} PolicyRuleSet
 *
 * @typedef {{
 *   enabled: boolean,
 *   applyToAdmin: boolean,
 *   scopeMode: PolicyScopeMode,
 *   shared: PolicyRuleSet,
 *   updates: PolicyRuleSet,
 *   install: PolicyRuleSet,
 * }} AccessPolicy
 */

/**
 * Erzeugt ein leeres Standard-Regelset.
 * @returns {PolicyRuleSet}
 */
function createDefaultRuleSet() {
  return {
    listType: 'none',
    defaultExecutionMode: 'allow-interactive',
    entries: [],
  };
}

/**
 * Erzeugt die Standard-Zugriffsrichtlinie (deaktiviert, keine Einschraenkungen).
 * @returns {AccessPolicy}
 */
export function createDefaultAccessPolicy() {
  return {
    enabled: false,
    applyToAdmin: false,
    scopeMode: 'shared',
    shared: createDefaultRuleSet(),
    updates: createDefaultRuleSet(),
    install: createDefaultRuleSet(),
  };
}

/**
 * Erzeugt eine Fail-Closed-Policy (alles gesperrt) fuer manipulierte oder fehlende HKLM-Policies.
 * @returns {AccessPolicy}
 */
export function createFailClosedAccessPolicy() {
  return {
    enabled: true,
    applyToAdmin: false,
    scopeMode: 'shared',
    shared: { listType: 'whitelist', defaultExecutionMode: 'silent-only', entries: [] },
    updates: { listType: 'whitelist', defaultExecutionMode: 'silent-only', entries: [] },
    install: { listType: 'whitelist', defaultExecutionMode: 'silent-only', entries: [] },
  };
}

/**
 * Erzeugt den eindeutigen Schluessel eines Policy-Eintrags.
 * @param {{ matchType?: unknown, value?: unknown } | null | undefined} entry
 * @returns {string}
 */
export function getPolicyEntryKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const matchType = MATCH_TYPE_SET.has(/** @type {PolicyMatchType} */ (entry.matchType)) ? entry.matchType : '';
  const value = String(entry.value || '')
    .trim()
    .toLowerCase();
  if (!matchType || !value) return '';
  return `${matchType}:${value}`;
}

/**
 * Normalisiert einen einzelnen Policy-Eintrag.
 * @param {unknown} raw
 * @returns {PolicyEntry | null}
 */
function normalizePolicyEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = /** @type {Record<string, any>} */ (raw);
  const rawMatchType = String(obj.matchType || '').trim();
  if (!MATCH_TYPE_SET.has(/** @type {PolicyMatchType} */ (rawMatchType))) return null;
  const matchType = /** @type {PolicyMatchType} */ (rawMatchType);

  let value = String(obj.value || '').trim();
  if (!value) return null;
  if (matchType === 'provider') {
    value = value.toLowerCase();
  }

  const label = String(obj.label || '').trim() || value;
  const rawExecMode = String(obj.executionMode || 'inherit').trim();
  const executionMode = ENTRY_EXEC_MODE_SET.has(/** @type {PolicyEntryExecutionMode} */ (rawExecMode))
    ? /** @type {PolicyEntryExecutionMode} */ (rawExecMode)
    : 'inherit';

  return {
    matchType,
    value,
    label,
    executionMode,
  };
}

/**
 * Normalisiert ein Regelset und entfernt doppelte Eintraege unter Beibehaltung der Reihenfolge.
 * @param {unknown} raw
 * @returns {PolicyRuleSet}
 */
function normalizePolicyRuleSet(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const rawListType = String(obj.listType || 'none').trim();
  const listType = LIST_TYPE_SET.has(/** @type {PolicyListType} */ (rawListType))
    ? /** @type {PolicyListType} */ (rawListType)
    : 'none';

  const rawDefaultMode = String(obj.defaultExecutionMode || 'allow-interactive').trim();
  const defaultExecutionMode = EXEC_MODE_SET.has(/** @type {PolicyExecutionMode} */ (rawDefaultMode))
    ? /** @type {PolicyExecutionMode} */ (rawDefaultMode)
    : 'allow-interactive';

  const rawEntries = Array.isArray(obj.entries) ? obj.entries : [];
  const entries = [];
  const indexByKey = new Map();

  for (const rawEntry of rawEntries) {
    const normalized = normalizePolicyEntry(rawEntry);
    if (!normalized) continue;
    const key = getPolicyEntryKey(normalized);
    if (!key) continue;
    if (indexByKey.has(key)) {
      entries[indexByKey.get(key)] = normalized;
    } else {
      indexByKey.set(key, entries.length);
      entries.push(normalized);
    }
  }

  return {
    listType,
    defaultExecutionMode,
    entries,
  };
}

/**
 * Normalisiert eine vollstaendige Zugriffsrichtlinie in eine kanonische Form.
 * @param {unknown} raw
 * @returns {AccessPolicy}
 */
export function normalizeAccessPolicy(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const rawScope = String(obj.scopeMode || 'shared').trim();
  const scopeMode = SCOPE_MODE_SET.has(/** @type {PolicyScopeMode} */ (rawScope))
    ? /** @type {PolicyScopeMode} */ (rawScope)
    : 'shared';

  return {
    enabled: Boolean(obj.enabled),
    applyToAdmin: Boolean(obj.applyToAdmin),
    scopeMode,
    shared: normalizePolicyRuleSet(obj.shared),
    updates: normalizePolicyRuleSet(obj.updates),
    install: normalizePolicyRuleSet(obj.install),
  };
}

/**
 * Erstellt eine tiefe Kopie einer Zugriffsrichtlinie.
 * @param {unknown} policy
 * @returns {AccessPolicy}
 */
export function cloneAccessPolicy(policy) {
  return normalizeAccessPolicy(policy);
}

/**
 * Fuegt einen Eintrag hinzu oder aktualisiert ihn unveraenderlich anhand seines Schluessels.
 * @param {unknown[]} entries
 * @param {unknown} rawEntry
 * @returns {PolicyEntry[]}
 */
export function upsertPolicyEntry(entries, rawEntry) {
  const normalizedList = normalizePolicyRuleSet({ entries }).entries;
  const normalizedEntry = normalizePolicyEntry(rawEntry);
  if (!normalizedEntry) return normalizedList;

  const targetKey = getPolicyEntryKey(normalizedEntry);
  const idx = normalizedList.findIndex((item) => getPolicyEntryKey(item) === targetKey);
  if (idx !== -1) {
    const next = [...normalizedList];
    next[idx] = normalizedEntry;
    return next;
  }
  return [...normalizedList, normalizedEntry];
}

/**
 * Entfernt einen Eintrag anhand von matchType und value.
 * @param {unknown[]} entries
 * @param {unknown} matchType
 * @param {unknown} value
 * @returns {PolicyEntry[]}
 */
export function removePolicyEntry(entries, matchType, value) {
  const normalizedList = normalizePolicyRuleSet({ entries }).entries;
  const targetKey = getPolicyEntryKey({ matchType, value });
  if (!targetKey) return normalizedList;
  return normalizedList.filter((item) => getPolicyEntryKey(item) !== targetKey);
}

/**
 * Aktualisiert den Ausfuehrungsmodus eines vorhandenen Policy-Eintrags.
 * @param {unknown[]} entries
 * @param {unknown} matchType
 * @param {unknown} value
 * @param {unknown} executionMode
 * @returns {PolicyEntry[]}
 */
export function updatePolicyEntryExecutionMode(entries, matchType, value, executionMode) {
  const normalizedList = normalizePolicyRuleSet({ entries }).entries;
  const targetKey = getPolicyEntryKey({ matchType, value });
  if (!targetKey) return normalizedList;

  const cleanMode = ENTRY_EXEC_MODE_SET.has(/** @type {PolicyEntryExecutionMode} */ (executionMode))
    ? /** @type {PolicyEntryExecutionMode} */ (executionMode)
    : 'inherit';

  return normalizedList.map((item) =>
    getPolicyEntryKey(item) === targetKey ? { ...item, executionMode: cleanMode } : item
  );
}

/**
 * Erstellt die JSON-Export-Struktur fuer Zugriffsrichtlinien.
 * @param {unknown} accessPolicy
 */
export function buildExportPolicyPayload(accessPolicy) {
  return {
    format: POLICY_EXPORT_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    accessPolicy: normalizeAccessPolicy(accessPolicy),
  };
}

/**
 * Validiert ein importiertes Policy-JSON (Export-Format, admin-policy.json oder direktes Policy-Objekt).
 * @param {unknown} raw
 * @returns {{ valid: true, accessPolicy: AccessPolicy } | { valid: false, error: string }}
 */
export function validateImportPolicyPayload(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, error: 'Ungueltiges JSON-Format: Policy-Objekt erwartet.' };
  }

  const obj = /** @type {Record<string, any>} */ (raw);
  if (obj.format !== undefined && obj.format !== POLICY_EXPORT_FORMAT) {
    return { valid: false, error: 'Unbekanntes Policy-Exportformat.' };
  }

  let candidate = null;
  if (obj.accessPolicy !== undefined) {
    if (!obj.accessPolicy || typeof obj.accessPolicy !== 'object' || Array.isArray(obj.accessPolicy)) {
      return { valid: false, error: 'Feld "accessPolicy" ist ungueltig.' };
    }
    candidate = obj.accessPolicy;
  } else if (
    obj.scopeMode !== undefined ||
    obj.shared !== undefined ||
    obj.updates !== undefined ||
    obj.install !== undefined ||
    typeof obj.enabled === 'boolean'
  ) {
    candidate = obj;
  } else {
    return { valid: false, error: 'Keine gueltige Zugriffsrichtlinie in der JSON-Datei gefunden.' };
  }

  return {
    valid: true,
    accessPolicy: normalizeAccessPolicy(candidate),
  };
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchGlobCaseInsensitive(pattern, candidate) {
  const cleanPattern = String(pattern || '').trim();
  const cleanCandidate = String(candidate || '').trim();
  if (!cleanPattern || !cleanCandidate) return false;
  const regexBody = cleanPattern.split('*').map(escapeRegExp).join('.*');
  const re = new RegExp(`^${regexBody}$`, 'i');
  return re.test(cleanCandidate);
}

function collectPackageIds(pkg) {
  const ids = new Set();
  const addId = (val) => {
    const clean = String(val || '')
      .trim()
      .toLowerCase();
    if (clean) ids.add(clean);
  };

  addId(pkg.packageId);
  addId(pkg.wingetId);
  addId(pkg.linkedPackageId);

  const rawId = String(pkg.id || '').trim();
  const prefixedMatch = rawId.match(/^(?:remote:)?([a-z0-9_-]+):(.+)$/i);
  if (prefixedMatch && prefixedMatch[1].toLowerCase() !== 'archive') {
    addId(prefixedMatch[2]);
  }

  return ids;
}

function collectArchiveIds(pkg) {
  const ids = new Set();
  const addId = (val) => {
    const clean = String(val || '')
      .trim()
      .toLowerCase();
    if (clean) ids.add(clean);
  };

  addId(pkg.archiveItemId);
  addId(pkg.matchedArchiveItem?.id);

  const pm = String(pkg.packageManager || pkg.providerId || pkg.source || '')
    .trim()
    .toLowerCase();
  if (pkg.inArchive || pm === 'archive') {
    addId(pkg.refId);
    addId(pkg.id);
    addId(pkg.itemId);
  }

  return ids;
}

function collectProviders(pkg) {
  const providers = new Set();
  const addProvider = (val) => {
    const clean = String(val || '')
      .trim()
      .toLowerCase();
    if (clean) providers.add(clean);
  };

  addProvider(pkg.providerId);
  addProvider(pkg.source);
  addProvider(pkg.packageManager);

  if (pkg.inArchive === true) {
    providers.add('archive');
  }
  if (!pkg.packageManager && pkg.wingetId) {
    providers.add('winget');
  }

  return providers;
}

/**
 * Prueft, ob ein Paket auf einen Policy-Eintrag zutrifft.
 * @param {Record<string, any> | null | undefined} pkg
 * @param {PolicyEntry | null | undefined} entry
 * @returns {boolean}
 */
export function matchesPolicyEntry(pkg, entry) {
  if (!pkg || typeof pkg !== 'object' || !entry || typeof entry !== 'object') return false;
  const cleanValue = String(entry.value || '').trim();
  if (!cleanValue) return false;
  const lowerValue = cleanValue.toLowerCase();

  if (entry.matchType === 'packageId') {
    return collectPackageIds(pkg).has(lowerValue);
  }

  if (entry.matchType === 'archiveId') {
    return collectArchiveIds(pkg).has(lowerValue);
  }

  if (entry.matchType === 'name') {
    const candidates = [pkg.name, pkg.itemName].map((v) => String(v || '').trim()).filter(Boolean);
    if (candidates.length === 0) return false;
    if (cleanValue.includes('*')) {
      return candidates.some((c) => matchGlobCaseInsensitive(cleanValue, c));
    }
    return candidates.some((c) => c.toLowerCase() === lowerValue);
  }

  if (entry.matchType === 'provider') {
    return collectProviders(pkg).has(lowerValue);
  }

  return false;
}

function findBestMatchingEntry(pkg, entries) {
  let best = null;
  let bestRank = -1;

  for (const entry of entries || []) {
    if (!matchesPolicyEntry(pkg, entry)) continue;
    const rank = MATCH_SPECIFICITY_RANK[entry.matchType] || 0;
    if (rank > bestRank) {
      best = entry;
      bestRank = rank;
    }
  }

  return best;
}

function tr(translateFn, key, params, fallback) {
  if (typeof translateFn === 'function') {
    const translated = translateFn(key, params);
    if (typeof translated === 'string' && translated && translated !== key) {
      return translated;
    }
  }
  return fallback;
}

/**
 * @param {Record<string, any> | null | undefined} pkg
 * @param {'update' | 'install' | 'view'} effectiveAction
 * @param {PolicyRuleSet} ruleSet
 * @param {string} ruleSetKey
 * @param {(key: string, params?: Record<string, unknown>) => string} [t]
 * @returns {{
 *   allowed: boolean,
 *   visible: boolean,
 *   executionMode: PolicyExecutionMode,
 *   silentOnly: boolean,
 *   adwareConflict: boolean,
 *   blockedByAdwareConflict: boolean,
 *   matchedEntry: PolicyEntry | null,
 *   ruleSetKey: string | null,
 *   listType: PolicyListType,
 *   reason: string,
 *   error: string,
 * }}
 */
function evaluateRuleSet(pkg, effectiveAction, ruleSet, ruleSetKey, t = undefined) {
  const matchedEntry = findBestMatchingEntry(pkg, ruleSet.entries);

  if (ruleSet.listType === 'whitelist' && !matchedEntry) {
    return {
      allowed: false,
      visible: false,
      executionMode: ruleSet.defaultExecutionMode,
      silentOnly: ruleSet.defaultExecutionMode === 'silent-only',
      adwareConflict: false,
      blockedByAdwareConflict: false,
      matchedEntry: null,
      ruleSetKey,
      listType: 'whitelist',
      reason: 'not-in-whitelist',
      error: tr(
        t,
        'policy.errorNotInWhitelist',
        {},
        'Durch Zugriffsrichtlinie blockiert: Dieses Programm steht nicht auf der Whitelist.'
      ),
    };
  }

  if (ruleSet.listType === 'blacklist' && matchedEntry) {
    return {
      allowed: false,
      visible: false,
      executionMode: ruleSet.defaultExecutionMode,
      silentOnly: ruleSet.defaultExecutionMode === 'silent-only',
      adwareConflict: false,
      blockedByAdwareConflict: false,
      matchedEntry,
      ruleSetKey,
      listType: 'blacklist',
      reason: 'in-blacklist',
      error: tr(
        t,
        'policy.errorInBlacklist',
        {},
        'Durch Zugriffsrichtlinie blockiert: Dieses Programm steht auf der Blacklist.'
      ),
    };
  }

  /** @type {PolicyExecutionMode} */
  const executionMode =
    matchedEntry && matchedEntry.executionMode !== 'inherit'
      ? matchedEntry.executionMode
      : ruleSet.defaultExecutionMode;
  const silentOnly = executionMode === 'silent-only';

  const isInteractiveRequired =
    normalizeInstallMode(pkg?.installMode) === 'interactive-required' ||
    Boolean(pkg?.interactiveRequired) ||
    Boolean(pkg?.adwareProtected);
  const adwareConflict = Boolean(silentOnly && isInteractiveRequired);

  if (adwareConflict) {
    const error = tr(
      t,
      'policy.errorAdwareConflict',
      {},
      'Ausführung blockiert: Richtlinie erzwingt "Nur Silent", aber dieses Programm ist durch den Adware-Schutz (Immer Interaktiv) geschützt. Eine stille Installation wird aus Sicherheitsgründen verhindert.'
    );
    return {
      allowed: effectiveAction === 'view',
      visible: true,
      executionMode: 'silent-only',
      silentOnly: true,
      adwareConflict: true,
      blockedByAdwareConflict: true,
      matchedEntry,
      ruleSetKey,
      listType: ruleSet.listType,
      reason: 'adware-silent-conflict',
      error,
    };
  }

  return {
    allowed: true,
    visible: true,
    executionMode,
    silentOnly,
    adwareConflict: false,
    blockedByAdwareConflict: false,
    matchedEntry,
    ruleSetKey,
    listType: ruleSet.listType,
    reason: 'allowed',
    error: '',
  };
}

/**
 * Bewertet Sichtbarkeit, Ausfuehrbarkeit und Silent-Zwang eines Pakets anhand der Zugriffsrichtlinie.
 * @param {Record<string, any> | null | undefined} pkg
 * @param {'update' | 'install' | 'view'} [action]
 * @param {unknown} [policy]
 * @param {boolean} [isAdmin]
 * @param {{ t?: (key: string, params?: Record<string, unknown>) => string }} [options]
 * @returns {{
 *   allowed: boolean,
 *   visible: boolean,
 *   executionMode: PolicyExecutionMode,
 *   silentOnly: boolean,
 *   adwareConflict: boolean,
 *   blockedByAdwareConflict: boolean,
 *   matchedEntry: PolicyEntry | null,
 *   ruleSetKey: string | null,
 *   listType: PolicyListType,
 *   reason: string,
 *   error: string,
 * }}
 */
export function evaluatePackagePolicy(pkg, action = 'view', policy = null, isAdmin = false, { t = undefined } = {}) {
  const normalizedPolicy = normalizeAccessPolicy(policy);

  if (!normalizedPolicy.enabled) {
    return {
      allowed: true,
      visible: true,
      executionMode: 'allow-interactive',
      silentOnly: false,
      adwareConflict: false,
      blockedByAdwareConflict: false,
      matchedEntry: null,
      ruleSetKey: null,
      listType: 'none',
      reason: 'policy-disabled',
      error: '',
    };
  }

  if (isAdmin && !normalizedPolicy.applyToAdmin) {
    return {
      allowed: true,
      visible: true,
      executionMode: 'allow-interactive',
      silentOnly: false,
      adwareConflict: false,
      blockedByAdwareConflict: false,
      matchedEntry: null,
      ruleSetKey: null,
      listType: 'none',
      reason: 'admin-bypass',
      error: '',
    };
  }

  const effectiveAction = action === 'update' || action === 'install' ? action : 'view';

  if (normalizedPolicy.scopeMode === 'shared') {
    return evaluateRuleSet(pkg, effectiveAction, normalizedPolicy.shared, 'shared', t);
  }

  if (effectiveAction === 'update') {
    return evaluateRuleSet(pkg, 'update', normalizedPolicy.updates, 'updates', t);
  }

  if (effectiveAction === 'install') {
    return evaluateRuleSet(pkg, 'install', normalizedPolicy.install, 'install', t);
  }

  const upd = evaluateRuleSet(pkg, 'update', normalizedPolicy.updates, 'updates', t);
  const inst = evaluateRuleSet(pkg, 'install', normalizedPolicy.install, 'install', t);

  if (!upd.visible && !inst.visible) {
    return {
      ...upd,
      allowed: false,
      visible: false,
      ruleSetKey: 'separate',
    };
  }

  const primary = pkg?.isInstalled && upd.visible ? upd : inst.visible ? inst : upd;
  return {
    ...primary,
    visible: true,
    allowed: true,
  };
}

/**
 * Prueft, ob sich zwei Zugriffsrichtlinien nach Normalisierung inhaltlich unterscheiden.
 * @param {unknown} savedPolicy
 * @param {unknown} draftPolicy
 * @returns {boolean}
 */
export function hasAccessPolicyChanges(savedPolicy, draftPolicy) {
  return JSON.stringify(normalizeAccessPolicy(savedPolicy)) !== JSON.stringify(normalizeAccessPolicy(draftPolicy));
}
