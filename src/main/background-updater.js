import { Notification } from 'electron';
import { t } from '../shared/i18n.js';
import { getAccessPolicy } from './auth-service.js';
import { createBackgroundUpdater } from './background-updater-core.js';
import { loadCatalogWithLiveStatus } from './catalog-service.js';
import { getConfig, saveConfig } from './config.js';
import { isProcessElevated } from './elevated-helper.js';
import { loadIgnoredUpdates } from './ignore-service.js';
import { resolveTrayIconPath } from './tray-service.js';
import { enqueueUpdates, getQueueState, waitForQueueIdle } from './update-queue.js';
import { checkAllWebVersions } from './web-updater.js';
import { scanInstalledSoftware } from './windows-tools.js';

const defaultBackgroundUpdater = createBackgroundUpdater({
  getConfigFn: getConfig,
  saveConfigFn: saveConfig,
  loadCatalogFn: loadCatalogWithLiveStatus,
  scanInstalledFn: () => scanInstalledSoftware({ silent: true }),
  checkWebVersionsFn: () => checkAllWebVersions({ silent: true }),
  loadIgnoredFn: loadIgnoredUpdates,
  getAccessPolicyFn: getAccessPolicy,
  isProcessElevatedFn: () => isProcessElevated(),
  enqueueUpdatesFn: enqueueUpdates,
  getQueueStateFn: getQueueState,
  waitForQueueIdleFn: waitForQueueIdle,
  resolveIconPathFn: resolveTrayIconPath,
  NotificationClass: Notification,
  tFn: t,
});

export const configureBackgroundUpdater = (options) => defaultBackgroundUpdater.configure(options);
export const initBackgroundUpdater = (opts) => defaultBackgroundUpdater.init(opts);
export const reloadBackgroundUpdaterSchedule = (opts) => defaultBackgroundUpdater.reloadSchedule(opts);
export const runBackgroundUpdateCheck = (opts) => defaultBackgroundUpdater.runCheck(opts);
export const getBackgroundUpdaterStatus = () => defaultBackgroundUpdater.getStatus();
export const setAutoUpdatePaused = (paused) => defaultBackgroundUpdater.setAutoUpdatePaused(paused);
export const toggleAutoUpdatePaused = () => defaultBackgroundUpdater.toggleAutoUpdatePaused();
export const stopBackgroundUpdater = () => defaultBackgroundUpdater.stop();
