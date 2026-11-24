import { app } from 'electron';
import { createAutostartService } from './autostart-core.js';
import {
  isAdminSessionActive,
  isProcessElevated,
  runPowerShellElevated,
  startAdminSession,
} from './elevated-helper.js';

const defaultAutostartService = createAutostartService({
  execPath: () => process.execPath,
  isPackaged: () => app.isPackaged,
  appPath: () => app.getAppPath(),
  getLoginItemSettingsFn: (options) => app.getLoginItemSettings(options),
  setLoginItemSettingsFn: (settings) => app.setLoginItemSettings(settings),
  isProcessElevatedFn: () => isProcessElevated(),
  isAdminSessionActiveFn: () => isAdminSessionActive(),
  startAdminSessionFn: () => startAdminSession(),
  runPowerShellElevatedFn: runPowerShellElevated,
});

export const getAutostartStatus = () => defaultAutostartService.getStatus();
export const applyAutostartSettings = (opts) => defaultAutostartService.applySettings(opts);
