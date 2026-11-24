import {
  computeNotificationDelta,
  filterAutoUpdateCandidates,
  normalizeBackgroundSettings,
} from '../shared/background-update-logic.js';
import { evaluatePackagePolicy } from '../shared/policy-logic.js';
import { buildUnifiedPackages, getPackageStatus, isPackageVisible } from '../shared/unified-packages.js';

const INITIAL_STARTUP_CHECK_DELAY_MS = 90_000;

function defaultSendNotification({ title, body, iconPath = '', onClick = null, NotificationClass = null }) {
  if (!NotificationClass) return null;
  if (typeof NotificationClass.isSupported === 'function' && !NotificationClass.isSupported()) {
    return null;
  }
  try {
    const notif = new NotificationClass({
      title,
      body,
      ...(iconPath ? { icon: iconPath } : {}),
    });
    if (typeof onClick === 'function' && typeof notif.on === 'function') {
      notif.on('click', () => {
        try {
          onClick();
        } catch {
          // Ignorieren
        }
      });
    }
    notif.show();
    return notif;
  } catch {
    return null;
  }
}

/**
 * Erzeugt den Service fuer periodische Hintergrund-Update-Checks, Benachrichtigungen
 * und den erhoehten Silent-Auto-Update-Modus.
 * @param {Record<string, any>} [deps]
 */
export function createBackgroundUpdater(deps = {}) {
  const getConfigFn = typeof deps.getConfigFn === 'function' ? deps.getConfigFn : () => ({});
  const saveConfigFn = typeof deps.saveConfigFn === 'function' ? deps.saveConfigFn : () => {};
  const loadCatalogFn = typeof deps.loadCatalogFn === 'function' ? deps.loadCatalogFn : () => [];
  const scanInstalledFn =
    typeof deps.scanInstalledFn === 'function' ? deps.scanInstalledFn : async () => ({ success: true, programs: [] });
  const checkWebVersionsFn =
    typeof deps.checkWebVersionsFn === 'function' ? deps.checkWebVersionsFn : async () => ({ success: true, count: 0 });
  const loadIgnoredFn = typeof deps.loadIgnoredFn === 'function' ? deps.loadIgnoredFn : () => ({ entries: [] });
  const getAccessPolicyFn =
    typeof deps.getAccessPolicyFn === 'function'
      ? deps.getAccessPolicyFn
      : () => ({ accessPolicy: null, isAdmin: false });
  const isProcessElevatedFn =
    typeof deps.isProcessElevatedFn === 'function' ? deps.isProcessElevatedFn : async () => false;
  const enqueueUpdatesFn =
    typeof deps.enqueueUpdatesFn === 'function' ? deps.enqueueUpdatesFn : async () => ({ success: true, added: 0 });
  const getQueueStateFn =
    typeof deps.getQueueStateFn === 'function' ? deps.getQueueStateFn : () => ({ isRunning: false });
  const waitForQueueIdleFn =
    typeof deps.waitForQueueIdleFn === 'function'
      ? deps.waitForQueueIdleFn
      : async () => ({ completedCount: 0, failedCount: 0, history: [] });
  const resolveIconPathFn = typeof deps.resolveIconPathFn === 'function' ? deps.resolveIconPathFn : () => '';
  const NotificationClass = deps.NotificationClass ?? null;
  const sendNotificationFn =
    typeof deps.sendNotificationFn === 'function'
      ? deps.sendNotificationFn
      : (opts) => defaultSendNotification({ ...opts, NotificationClass });
  const nowFn = typeof deps.nowFn === 'function' ? deps.nowFn : () => Date.now();
  const setIntervalFn = typeof deps.setIntervalFn === 'function' ? deps.setIntervalFn : setInterval;
  const clearIntervalFn = typeof deps.clearIntervalFn === 'function' ? deps.clearIntervalFn : clearInterval;
  const setTimeoutFn = typeof deps.setTimeoutFn === 'function' ? deps.setTimeoutFn : setTimeout;
  const clearTimeoutFn = typeof deps.clearTimeoutFn === 'function' ? deps.clearTimeoutFn : clearTimeout;
  const tFn = typeof deps.tFn === 'function' ? deps.tFn : null;

  function tr(key, params, fallback) {
    if (tFn) {
      const translated = tFn(key, params);
      if (typeof translated === 'string' && translated && translated !== key) {
        return translated;
      }
    }
    return fallback;
  }

  let onStatusChange = typeof deps.onStatusChange === 'function' ? deps.onStatusChange : null;
  let onOpenUpdatesTab = typeof deps.onOpenUpdatesTab === 'function' ? deps.onOpenUpdatesTab : null;

  let isChecking = false;
  let autoUpdatePaused = false;
  let lastCheckAt = 0;
  let nextCheckAt = 0;
  let availableUpdateCount = 0;
  let lastError = '';
  let lastAutoUpdatedCount = 0;
  let lastElevatedState = false;
  let intervalTimer = null;
  let startupTimer = null;

  function readNormalizedConfig() {
    const raw = getConfigFn() || {};
    return {
      raw,
      bg: normalizeBackgroundSettings(raw),
    };
  }

  function getStatus() {
    const { bg } = readNormalizedConfig();
    return {
      isChecking,
      autoUpdateEnabled: bg.autoUpdateEnabled,
      autoUpdatePaused,
      autoUpdateActive: bg.autoUpdateEnabled && !autoUpdatePaused && lastElevatedState,
      isElevated: lastElevatedState,
      backgroundCheckEnabled: bg.backgroundCheckEnabled,
      backgroundCheckIntervalMinutes: bg.backgroundCheckIntervalMinutes,
      lastCheckAt,
      nextCheckAt,
      availableUpdateCount,
      lastAutoUpdatedCount,
      lastError,
    };
  }

  function emitStatus() {
    if (typeof onStatusChange === 'function') {
      try {
        onStatusChange(getStatus());
      } catch {
        // Listener-Fehler isolieren
      }
    }
  }

  function clearTimers() {
    if (intervalTimer) {
      clearIntervalFn(intervalTimer);
      intervalTimer = null;
    }
    if (startupTimer) {
      clearTimeoutFn(startupTimer);
      startupTimer = null;
    }
    nextCheckAt = 0;
  }

  function reloadSchedule({ runInitialDelay = false } = {}) {
    clearTimers();
    const { bg } = readNormalizedConfig();
    if (bg.backgroundCheckEnabled) {
      const intervalMs = bg.backgroundCheckIntervalMinutes * 60_000;
      nextCheckAt = nowFn() + intervalMs;
      intervalTimer = setIntervalFn(() => {
        nextCheckAt = nowFn() + intervalMs;
        void runCheck({ manual: false });
      }, intervalMs);
      intervalTimer?.unref?.();

      if (runInitialDelay) {
        startupTimer = setTimeoutFn(() => {
          startupTimer = null;
          void runCheck({ manual: false });
        }, INITIAL_STARTUP_CHECK_DELAY_MS);
        startupTimer?.unref?.();
      }
    }
    emitStatus();
  }

  function configure(options = {}) {
    if (typeof options.onStatusChange === 'function') {
      onStatusChange = options.onStatusChange;
    }
    if (typeof options.onOpenUpdatesTab === 'function') {
      onOpenUpdatesTab = options.onOpenUpdatesTab;
    }
  }

  function setAutoUpdatePaused(paused) {
    autoUpdatePaused = Boolean(paused);
    emitStatus();
    return getStatus();
  }

  function toggleAutoUpdatePaused() {
    return setAutoUpdatePaused(!autoUpdatePaused);
  }

  function buildQueuePayload(item, statusObj, targetVersion, archiveSaveMode) {
    return {
      id: item.id,
      itemId: item.id,
      name: item.name,
      icon: item.icon || null,
      fromVersion: statusObj.localVersion || item.installedVersion || '',
      toVersion: targetVersion || statusObj.webVersion || statusObj.archiveVersion || '',
      source: item.inArchive ? 'archive' : item.packageManager || 'winget',
      inArchive: Boolean(item.inArchive),
      isInstalled: Boolean(item.isInstalled),
      packageManager: item.packageManager || (item.wingetId ? 'winget' : ''),
      packageId: item.packageId || item.wingetId || '',
      wingetId: item.wingetId || '',
      publisher: item.publisher || '',
      hasWebUpdate: Boolean(statusObj.hasWebUpdate),
      hasArchiveUpdate: Boolean(statusObj.hasArchiveUpdate),
      installMode: item.installMode || 'interactive',
      archiveSaveSpec: !item.inArchive ? { saveMode: archiveSaveMode === 'auto-id' ? 'auto-id' : 'none' } : null,
    };
  }

  function formatUpdatesAvailableBody(newUpdates) {
    const count = newUpdates.length;
    const fallbackName = tr('notifications.fallbackProgramName', {}, 'Program');
    const previewNames = newUpdates
      .slice(0, 3)
      .map((u) => {
        const name = String(u.item?.name || u.item?.packageId || fallbackName).trim();
        return u.targetVersion ? `${name} (v${u.targetVersion})` : name;
      })
      .join(', ');
    if (count === 1) {
      return tr(
        'notifications.updatesAvailableOne',
        { items: previewNames },
        `1 new update available: ${previewNames}`
      );
    }
    const suffix =
      count > 3 ? tr('notifications.updatesAvailableMoreSuffix', { count: count - 3 }, ` + ${count - 3} more`) : '';
    return tr(
      'notifications.updatesAvailableMany',
      { count, items: previewNames, suffix },
      `${count} new updates available: ${previewNames}${suffix}`
    );
  }

  async function runCheck({ manual = false } = {}) {
    if (isChecking) {
      return { success: false, alreadyRunning: true, status: getStatus() };
    }

    isChecking = true;
    lastError = '';
    lastAutoUpdatedCount = 0;
    emitStatus();

    try {
      const [pcRes] = await Promise.all([
        Promise.resolve()
          .then(() => scanInstalledFn())
          .catch((err) => ({ success: false, programs: [], error: err?.message })),
        Promise.resolve()
          .then(() => checkWebVersionsFn())
          .catch((err) => ({ success: false, error: err?.message })),
      ]);

      const { raw: cfg, bg } = readNormalizedConfig();
      const catalogItems = loadCatalogFn() || [];
      const installedApps = Array.isArray(pcRes?.programs) ? pcRes.programs : [];
      const packages = buildUnifiedPackages({ catalogItems, installedApps });

      const ignoredRes = loadIgnoredFn() || {};
      const ignoredUpdates = Array.isArray(ignoredRes.entries) ? ignoredRes.entries : [];
      const policyRes = getAccessPolicyFn() || {};
      const accessPolicy = policyRes.accessPolicy || null;
      const isAdminAuthenticated = Boolean(policyRes.isAdmin);
      const depth = cfg.versionCompareDepth ?? 3;
      const visibleHiddenCats = Array.isArray(cfg.visibleHiddenCats) ? cfg.visibleHiddenCats : [];

      const visibleUpdates = [];
      for (const item of packages) {
        if (!isPackageVisible(item, visibleHiddenCats)) continue;
        const st = getPackageStatus(item, { versionCompareDepth: depth, ignoredUpdates });
        if (!st.hasVisibleUpdate) continue;
        if (!evaluatePackagePolicy(item, 'update', accessPolicy, isAdminAuthenticated).visible) continue;
        visibleUpdates.push({
          item,
          status: st,
          targetVersion: st.targetUpdateVersion || st.webVersion || st.archiveVersion || '',
        });
      }

      lastElevatedState = Boolean(await isProcessElevatedFn());
      let remainingUpdates = [...visibleUpdates];
      let autoUpdatedCount = 0;
      let autoFailedCount = 0;

      if (bg.autoUpdateEnabled && !autoUpdatePaused && lastElevatedState && visibleUpdates.length > 0) {
        const queueState = getQueueStateFn();
        if (!queueState?.isRunning) {
          const { eligible } = filterAutoUpdateCandidates(visibleUpdates, {
            isElevated: lastElevatedState,
            autoUpdateEnabled: bg.autoUpdateEnabled,
            autoUpdatePaused,
            autoUpdateListType: bg.autoUpdateListType,
            autoUpdateEntries: bg.autoUpdateEntries,
            ignoredUpdates,
            accessPolicy,
            isAdminAuthenticated,
          });

          if (eligible.length > 0) {
            const eligibleById = new Map(visibleUpdates.map((u) => [u.item.id, u]));
            const queueItems = eligible.map(({ item, targetVersion }) => {
              const full = eligibleById.get(item.id);
              const st = full?.status || getPackageStatus(item, { versionCompareDepth: depth, ignoredUpdates });
              return buildQueuePayload(item, st, targetVersion, cfg.archiveSaveMode);
            });

            const enqRes = await enqueueUpdatesFn(queueItems, {
              silent: true,
              skipAutoAdminPrompt: true,
            });

            if (enqRes?.added > 0) {
              const finalState = await waitForQueueIdleFn();
              autoUpdatedCount = Number(finalState?.completedCount) || 0;
              autoFailedCount = Number(finalState?.failedCount) || 0;
              lastAutoUpdatedCount = autoUpdatedCount;

              const doneItemIds = new Set(
                (Array.isArray(finalState?.history) ? finalState.history : [])
                  .filter((h) => h?.status === 'done' && h.itemId)
                  .map((h) => h.itemId)
              );
              remainingUpdates = remainingUpdates.filter((u) => !doneItemIds.has(u.item.id));

              if (autoUpdatedCount > 0) {
                const countLabel =
                  autoUpdatedCount === 1
                    ? tr('notifications.autoUpdateBodyOne', {}, '1 program updated automatically.')
                    : tr(
                        'notifications.autoUpdateBodyMany',
                        { count: autoUpdatedCount },
                        `${autoUpdatedCount} programs updated automatically.`
                      );
                const failSuffix =
                  autoFailedCount > 0
                    ? tr(
                        'notifications.autoUpdateFailedSuffix',
                        { count: autoFailedCount },
                        ` (${autoFailedCount} failed)`
                      )
                    : '';
                sendNotificationFn({
                  title: tr('notifications.autoUpdateTitle', {}, 'Software Catalog - Auto-Update'),
                  body: `${countLabel}${failSuffix}`,
                  iconPath: resolveIconPathFn(),
                  onClick: () => onOpenUpdatesTab?.(),
                });
              }
            }
          }
        }
      }

      availableUpdateCount = remainingUpdates.length;

      if (bg.notifyOnUpdates) {
        const delta = computeNotificationDelta(remainingUpdates, cfg.notifiedUpdateVersions || {});
        if (delta.changed) {
          saveConfigFn({ notifiedUpdateVersions: delta.nextNotifiedVersions });
        }
        if (delta.newUpdates.length > 0) {
          sendNotificationFn({
            title: tr('notifications.updatesAvailableTitle', {}, 'Software Catalog - Updates available'),
            body: formatUpdatesAvailableBody(delta.newUpdates),
            iconPath: resolveIconPathFn(),
            onClick: () => onOpenUpdatesTab?.(),
          });
        }
      }

      lastCheckAt = nowFn();
      return {
        success: true,
        manual,
        updateCount: availableUpdateCount,
        autoUpdatedCount,
        autoFailedCount,
        status: getStatus(),
      };
    } catch (err) {
      lastError = err?.message || tr('notifications.backgroundCheckFailed', {}, 'Background update check failed.');
      return { success: false, error: lastError, status: getStatus() };
    } finally {
      isChecking = false;
      emitStatus();
    }
  }

  async function init({ startedInTray = false } = {}) {
    lastElevatedState = Boolean(await isProcessElevatedFn());
    const { bg } = readNormalizedConfig();
    reloadSchedule({ runInitialDelay: bg.backgroundCheckEnabled || startedInTray });
    return getStatus();
  }

  function stop() {
    clearTimers();
  }

  return {
    configure,
    init,
    reloadSchedule,
    runCheck,
    getStatus,
    setAutoUpdatePaused,
    toggleAutoUpdatePaused,
    stop,
  };
}
