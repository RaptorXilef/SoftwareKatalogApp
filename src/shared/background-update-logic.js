import { getIgnorePackageKey, isUpdateIgnored, versionsMatchExact } from './ignore-logic.js';
import { detectAdwareSignals, normalizeInstallMode } from './installer-logic.js';
import { evaluatePackagePolicy, getPolicyEntryKey, matchesPolicyEntry, POLICY_MATCH_TYPES } from './policy-logic.js';

export const AUTOSTART_TASK_NAME = 'SoftwareKatalog_AdminAutostart';
const BACKGROUND_CHECK_INTERVALS = Object.freeze([60, 180, 360, 720, 1440]);
const AUTO_UPDATE_LIST_TYPES = Object.freeze(['all', 'whitelist', 'blacklist']);

const MATCH_TYPE_SET = new Set(POLICY_MATCH_TYPES);
const INTERVAL_SET = new Set(BACKGROUND_CHECK_INTERVALS);
const AUTO_UPDATE_LIST_TYPE_SET = new Set(AUTO_UPDATE_LIST_TYPES);

/**
 * @typedef {'normal' | 'admin'} AutostartMode
 * @typedef {'all' | 'whitelist' | 'blacklist'} AutoUpdateListType
 * @typedef {{
 *   matchType: import('./policy-logic.js').PolicyMatchType,
 *   value: string,
 *   label: string,
 * }} AutoUpdateEntry
 * @typedef {{
 *   minimizeToTrayOnClose: boolean,
 *   autostartEnabled: boolean,
 *   autostartMode: AutostartMode,
 *   backgroundCheckEnabled: boolean,
 *   backgroundCheckIntervalMinutes: number,
 *   notifyOnUpdates: boolean,
 *   autoUpdateEnabled: boolean,
 *   autoUpdateListType: AutoUpdateListType,
 *   autoUpdateEntries: AutoUpdateEntry[],
 * }} BackgroundSettings
 */

/** @type {BackgroundSettings} */
export const DEFAULT_BACKGROUND_SETTINGS = Object.freeze({
  minimizeToTrayOnClose: false,
  autostartEnabled: false,
  autostartMode: 'normal',
  backgroundCheckEnabled: false,
  backgroundCheckIntervalMinutes: 360,
  notifyOnUpdates: true,
  autoUpdateEnabled: false,
  autoUpdateListType: 'all',
  autoUpdateEntries: [],
});

/**
 * Normalisiert den Autostart-Modus auf 'normal' oder 'admin'.
 * @param {unknown} raw
 * @returns {AutostartMode}
 */
export function normalizeAutostartMode(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase() === 'admin'
    ? 'admin'
    : 'normal';
}

/**
 * Normalisiert das Pruefintervall in Minuten auf einen der erlaubten Werte (Standard: 360).
 * @param {unknown} raw
 * @returns {number}
 */
function normalizeBackgroundCheckInterval(raw) {
  if (raw === null || raw === undefined || raw === '') return 360;
  const parsed = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed)) return 360;
  return INTERVAL_SET.has(parsed) ? parsed : 360;
}

/**
 * Normalisiert den Listenmodus fuer Silent-Auto-Updates auf 'all', 'whitelist' oder 'blacklist'.
 * @param {unknown} raw
 * @returns {AutoUpdateListType}
 */
function normalizeAutoUpdateListType(raw) {
  const clean = String(raw || '')
    .trim()
    .toLowerCase();
  return AUTO_UPDATE_LIST_TYPE_SET.has(/** @type {AutoUpdateListType} */ (clean))
    ? /** @type {AutoUpdateListType} */ (clean)
    : 'all';
}

/**
 * Normalisiert einen einzelnen Auto-Update-Listeneintrag.
 * @param {unknown} raw
 * @returns {AutoUpdateEntry | null}
 */
function normalizeAutoUpdateEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = /** @type {Record<string, any>} */ (raw);
  const rawMatchType = String(obj.matchType || '').trim();
  if (!MATCH_TYPE_SET.has(/** @type {import('./policy-logic.js').PolicyMatchType} */ (rawMatchType))) {
    return null;
  }
  const matchType = /** @type {import('./policy-logic.js').PolicyMatchType} */ (rawMatchType);

  let value = String(obj.value || '').trim();
  if (!value) return null;
  if (matchType === 'provider') {
    value = value.toLowerCase();
  }

  const label = String(obj.label || '').trim() || value;
  return {
    matchType,
    value,
    label,
  };
}

/**
 * Normalisiert und dedupliziert eine Auto-Update-Paketliste anhand von matchType und value.
 * @param {unknown} rawList
 * @returns {AutoUpdateEntry[]}
 */
function normalizeAutoUpdateEntries(rawList) {
  if (!Array.isArray(rawList)) return [];
  /** @type {AutoUpdateEntry[]} */
  const entries = [];
  const indexByKey = new Map();

  for (const rawEntry of rawList) {
    const normalized = normalizeAutoUpdateEntry(rawEntry);
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

  return entries;
}

/**
 * Fuegt einen Auto-Update-Eintrag hinzu oder aktualisiert ihn unveraenderlich.
 * @param {unknown[]} entries
 * @param {unknown} rawEntry
 * @returns {AutoUpdateEntry[]}
 */
export function upsertAutoUpdateEntry(entries, rawEntry) {
  const normalizedList = normalizeAutoUpdateEntries(entries);
  const normalizedEntry = normalizeAutoUpdateEntry(rawEntry);
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
 * Entfernt einen Auto-Update-Eintrag anhand von matchType und value.
 * @param {unknown[]} entries
 * @param {unknown} matchType
 * @param {unknown} value
 * @returns {AutoUpdateEntry[]}
 */
export function removeAutoUpdateEntry(entries, matchType, value) {
  const normalizedList = normalizeAutoUpdateEntries(entries);
  const targetKey = getPolicyEntryKey({ matchType, value });
  if (!targetKey) return normalizedList;
  return normalizedList.filter((item) => getPolicyEntryKey(item) !== targetKey);
}

/**
 * Normalisiert alle Einstellungen fuer Tray, Autostart, Hintergrund-Check und Silent-Auto-Update.
 * @param {Record<string, any> | null | undefined} [raw]
 * @returns {BackgroundSettings}
 */
export function normalizeBackgroundSettings(raw = {}) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    minimizeToTrayOnClose: Boolean(src.minimizeToTrayOnClose),
    autostartEnabled: Boolean(src.autostartEnabled),
    autostartMode: normalizeAutostartMode(src.autostartMode),
    backgroundCheckEnabled: Boolean(src.backgroundCheckEnabled),
    backgroundCheckIntervalMinutes: normalizeBackgroundCheckInterval(src.backgroundCheckIntervalMinutes),
    notifyOnUpdates: src.notifyOnUpdates !== false,
    autoUpdateEnabled: Boolean(src.autoUpdateEnabled),
    autoUpdateListType: normalizeAutoUpdateListType(src.autoUpdateListType),
    autoUpdateEntries: normalizeAutoUpdateEntries(src.autoUpdateEntries),
  };
}

/**
 * Prueft, ob die App ueber --tray oder --minimized direkt ins System-Tray gestartet wurde.
 * @param {unknown} [argv]
 * @returns {boolean}
 */
export function hasTrayStartupArg(argv = []) {
  if (!Array.isArray(argv)) return false;
  return argv.some((arg) => {
    const clean = String(arg || '')
      .trim()
      .toLowerCase();
    return clean === '--tray' || clean === '--minimized';
  });
}

/**
 * Formatiert den dynamischen Tooltip fuer das Windows-Tray-Icon (ausschliesslich ASCII-Bindestriche).
 * @param {{
 *   updateCount?: number,
 *   isChecking?: boolean,
 *   autoUpdateEnabled?: boolean,
 *   autoUpdatePaused?: boolean,
 *   isElevated?: boolean,
 * }} [options]
 * @returns {string}
 */
export function formatTrayTooltip({
  updateCount = 0,
  isChecking = false,
  autoUpdateEnabled = false,
  autoUpdatePaused = false,
} = {}) {
  const count = Number.isFinite(updateCount) && updateCount > 0 ? Math.trunc(updateCount) : 0;
  let base;
  if (isChecking) {
    base = 'Software Katalog - Pruefe auf Updates...';
  } else if (count === 1) {
    base = 'Software Katalog - 1 Update verfuegbar';
  } else if (count > 1) {
    base = `Software Katalog - ${count} Updates verfuegbar`;
  } else {
    base = 'Software Katalog - Alle Programme aktuell';
  }

  if (autoUpdateEnabled && autoUpdatePaused) {
    return `${base} (Auto-Update pausiert)`;
  }
  return base;
}

/**
 * Ermittelt neue, noch nicht gemeldete Update-Versionen (Anti-Notification-Spam)
 * und bereinigt behobene Eintraege aus der Merkliste.
 * @param {Array<{ item?: Record<string, any>, targetVersion?: string } | Record<string, any>>} updateEntries
 * @param {Record<string, string> | null | undefined} [notifiedVersions]
 * @returns {{
 *   newUpdates: Array<{ item: Record<string, any>, targetVersion: string, key: string }>,
 *   nextNotifiedVersions: Record<string, string>,
 *   changed: boolean,
 * }}
 */
export function computeNotificationDelta(updateEntries = [], notifiedVersions = {}) {
  const prevMap =
    notifiedVersions && typeof notifiedVersions === 'object' && !Array.isArray(notifiedVersions)
      ? notifiedVersions
      : {};
  /** @type {Record<string, string>} */
  const nextNotifiedVersions = {};
  /** @type {Array<{ item: Record<string, any>, targetVersion: string, key: string }>} */
  const newUpdates = [];

  for (const rawEntry of Array.isArray(updateEntries) ? updateEntries : []) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const item = rawEntry.item && typeof rawEntry.item === 'object' ? rawEntry.item : rawEntry;
    const rawVersion =
      rawEntry.item && rawEntry.targetVersion !== undefined
        ? rawEntry.targetVersion
        : item.targetUpdateVersion || item.webVersion || item.archiveVersion || '';
    const targetVersion = String(rawVersion || '').trim();
    const key =
      getIgnorePackageKey(item) ||
      String(item.id || '')
        .trim()
        .toLowerCase();
    if (!key) continue;

    const versionToken = targetVersion || '__unknown__';
    nextNotifiedVersions[key] = versionToken;

    const prevToken = typeof prevMap[key] === 'string' ? prevMap[key].trim() : '';
    const isAlreadyNotified =
      Boolean(prevToken) &&
      (prevToken === versionToken ||
        (versionToken !== '__unknown__' && prevToken !== '__unknown__' && versionsMatchExact(versionToken, prevToken)));

    if (!isAlreadyNotified) {
      newUpdates.push({ item, targetVersion, key });
    }
  }

  const prevKeys = Object.keys(prevMap);
  const nextKeys = Object.keys(nextNotifiedVersions);
  let changed = prevKeys.length !== nextKeys.length;
  if (!changed) {
    for (const k of nextKeys) {
      if (prevMap[k] !== nextNotifiedVersions[k]) {
        changed = true;
        break;
      }
    }
  }

  return {
    newUpdates,
    nextNotifiedVersions,
    changed,
  };
}

/**
 * Bewertet, ob ein einzelnes Update-Paket fuer das stille Auto-Update zugelassen ist.
 * Prueft Admin-Pflicht, Pausenstatus, strikten Adware-Schutz (interactive-required),
 * Ignorierliste, Nutzer-Zugriffsrichtlinie sowie die eigene Auto-Update-Whitelist/Blacklist.
 * @param {Record<string, any> | null | undefined} item
 * @param {{
 *   targetVersion?: string,
 *   isElevated?: boolean,
 *   autoUpdateEnabled?: boolean,
 *   autoUpdatePaused?: boolean,
 *   autoUpdateListType?: AutoUpdateListType | string,
 *   autoUpdateEntries?: unknown[],
 *   ignoredUpdates?: Array<Record<string, any>>,
 *   accessPolicy?: unknown,
 *   isAdminAuthenticated?: boolean,
 * }} [options]
 */
export function evaluateAutoUpdateEligibility(
  item,
  {
    targetVersion = '',
    isElevated = false,
    autoUpdateEnabled = false,
    autoUpdatePaused = false,
    autoUpdateListType = 'all',
    autoUpdateEntries = [],
    ignoredUpdates = [],
    accessPolicy = null,
    isAdminAuthenticated = false,
  } = {}
) {
  if (!item || typeof item !== 'object') {
    return { eligible: false, reason: 'invalid-item', matchedEntry: null };
  }
  if (autoUpdateEnabled !== true) {
    return { eligible: false, reason: 'auto-update-disabled', matchedEntry: null };
  }
  if (autoUpdatePaused === true) {
    return { eligible: false, reason: 'auto-update-paused', matchedEntry: null };
  }
  if (isElevated !== true) {
    return { eligible: false, reason: 'not-elevated', matchedEntry: null };
  }

  const mode = normalizeInstallMode(item.installMode);
  const adwareSignal = detectAdwareSignals({
    name: item.name || '',
    packageId: item.packageId || item.wingetId || '',
    publisher: item.publisher || '',
  });
  if (
    mode === 'interactive-required' ||
    item.interactiveRequired ||
    item.adwareProtected ||
    (mode !== 'silent' && adwareSignal.flagged)
  ) {
    return { eligible: false, reason: 'interactive-required', matchedEntry: null };
  }

  const effectiveVersion = String(
    targetVersion || item.targetUpdateVersion || item.webVersion || item.archiveVersion || ''
  ).trim();
  if (isUpdateIgnored(item, effectiveVersion, ignoredUpdates)) {
    return { eligible: false, reason: 'ignored', matchedEntry: null };
  }

  const policyDecision = evaluatePackagePolicy(item, 'update', accessPolicy, isAdminAuthenticated);
  if (!policyDecision.allowed) {
    return {
      eligible: false,
      reason: 'policy-blocked',
      policyReason: policyDecision.reason,
      matchedEntry: null,
    };
  }

  const listType = normalizeAutoUpdateListType(autoUpdateListType);
  const normalizedEntries = normalizeAutoUpdateEntries(autoUpdateEntries);
  const matchedEntry =
    normalizedEntries.find((entry) => matchesPolicyEntry(item, { ...entry, executionMode: 'inherit' })) || null;

  if (listType === 'whitelist' && !matchedEntry) {
    return { eligible: false, reason: 'not-in-auto-update-whitelist', matchedEntry: null };
  }
  if (listType === 'blacklist' && matchedEntry) {
    return { eligible: false, reason: 'in-auto-update-blacklist', matchedEntry };
  }

  return { eligible: true, reason: 'eligible', matchedEntry };
}

/**
 * Filtert eine Liste von Update-Kandidaten fuer das automatische Silent-Update.
 * @param {Array<{ item?: Record<string, any>, targetVersion?: string } | Record<string, any>>} updateEntries
 * @param {Parameters<typeof evaluateAutoUpdateEligibility>[1]} [options]
 */
export function filterAutoUpdateCandidates(updateEntries = [], options = {}) {
  const eligible = [];
  const skipped = [];

  for (const rawEntry of Array.isArray(updateEntries) ? updateEntries : []) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const item = rawEntry.item && typeof rawEntry.item === 'object' ? rawEntry.item : rawEntry;
    const targetVersion =
      rawEntry.item && rawEntry.targetVersion !== undefined
        ? rawEntry.targetVersion
        : item.targetUpdateVersion || item.webVersion || item.archiveVersion || '';

    const decision = evaluateAutoUpdateEligibility(item, { ...options, targetVersion });
    if (decision.eligible) {
      eligible.push({ item, targetVersion: String(targetVersion || '').trim(), decision });
    } else {
      skipped.push({ item, targetVersion: String(targetVersion || '').trim(), decision });
    }
  }

  return { eligible, skipped };
}
