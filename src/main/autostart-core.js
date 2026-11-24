import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { AUTOSTART_TASK_NAME, normalizeAutostartMode } from '../shared/background-update-logic.js';

function escapePsSingleQuoted(value) {
  return String(value || '').replace(/'/g, "''");
}

function defaultQueryScheduledTask(platform = process.platform) {
  if (platform !== 'win32') {
    return Promise.resolve({ exists: false, accessDenied: false });
  }
  const schtasksBin = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'schtasks.exe');
  return new Promise((resolve) => {
    execFile(
      schtasksBin,
      ['/Query', '/TN', AUTOSTART_TASK_NAME],
      { shell: false, windowsHide: true, timeout: 6000 },
      (err, _stdout, stderr) => {
        if (!err) {
          resolve({ exists: true, accessDenied: false });
          return;
        }
        const errText = `${err?.message || ''}\n${stderr || ''}`;
        const accessDenied = /access is denied|zugriff verweigert/i.test(errText);
        resolve({ exists: accessDenied, accessDenied });
      }
    );
  });
}

/**
 * Erzeugt den Windows-Autostart-Service (Normal via LoginItem vs. Admin via Windows-Aufgabenplanung).
 * @param {Record<string, any>} [deps]
 */
export function createAutostartService(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const getExecPath = typeof deps.execPath === 'function' ? deps.execPath : () => deps.execPath || process.execPath;
  const getIsPackaged = typeof deps.isPackaged === 'function' ? deps.isPackaged : () => Boolean(deps.isPackaged);
  const getAppPath = typeof deps.appPath === 'function' ? deps.appPath : () => deps.appPath || process.cwd();
  const getUsername =
    typeof deps.username === 'function'
      ? deps.username
      : () => deps.username || process.env.USERNAME || os.userInfo().username || '';
  const getUserDomain =
    typeof deps.userDomain === 'function' ? deps.userDomain : () => deps.userDomain || process.env.USERDOMAIN || '';

  const getLoginItemSettingsFn =
    typeof deps.getLoginItemSettingsFn === 'function' ? deps.getLoginItemSettingsFn : () => ({ openAtLogin: false });
  const setLoginItemSettingsFn =
    typeof deps.setLoginItemSettingsFn === 'function' ? deps.setLoginItemSettingsFn : () => {};
  const queryScheduledTaskFn =
    typeof deps.queryScheduledTaskFn === 'function'
      ? deps.queryScheduledTaskFn
      : () => defaultQueryScheduledTask(platform);
  const isProcessElevatedFn =
    typeof deps.isProcessElevatedFn === 'function' ? deps.isProcessElevatedFn : async () => false;
  const isAdminSessionActiveFn =
    typeof deps.isAdminSessionActiveFn === 'function' ? deps.isAdminSessionActiveFn : () => false;
  const startAdminSessionFn =
    typeof deps.startAdminSessionFn === 'function'
      ? deps.startAdminSessionFn
      : async () => ({ success: false, error: 'Kein Admin-Helper verfuegbar.' });
  const runPowerShellElevatedFn =
    typeof deps.runPowerShellElevatedFn === 'function'
      ? deps.runPowerShellElevatedFn
      : async () => ({ code: -1, stdout: '', stderr: 'Kein Elevated-PowerShell verfuegbar.' });

  function getNormalLoginItemParams() {
    const execPath = String(getExecPath() || '').trim();
    const isPackaged = Boolean(getIsPackaged());
    const appPath = String(getAppPath() || '').trim();
    const args = isPackaged ? ['--tray'] : [appPath, '--tray'].filter(Boolean);
    return { execPath, isPackaged, appPath, args };
  }

  function readNormalLoginItemEnabled() {
    if (platform !== 'win32') return false;
    const { execPath, args } = getNormalLoginItemParams();
    try {
      const specific = getLoginItemSettingsFn({ path: execPath, args });
      if (specific?.openAtLogin) return true;
      const general = getLoginItemSettingsFn();
      return Boolean(general?.openAtLogin);
    } catch {
      return false;
    }
  }

  function setNormalLoginItem(enabled) {
    if (platform !== 'win32') return;
    const { execPath, args } = getNormalLoginItemParams();
    if (enabled) {
      setLoginItemSettingsFn({
        openAtLogin: true,
        path: execPath,
        args,
      });
    } else {
      setLoginItemSettingsFn({
        openAtLogin: false,
        path: execPath,
        args,
      });
      try {
        setLoginItemSettingsFn({ openAtLogin: false });
      } catch {
        // Ignorieren
      }
    }
  }

  async function ensureElevation() {
    if (platform !== 'win32') {
      return { ok: false, canceled: false, error: 'Autostart im Admin-Modus wird nur unter Windows unterstuetzt.' };
    }
    if ((await isProcessElevatedFn()) || isAdminSessionActiveFn()) {
      return { ok: true };
    }
    const res = await startAdminSessionFn();
    if (res?.success || res?.alreadyElevated || res?.alreadyActive) {
      return { ok: true };
    }
    return {
      ok: false,
      canceled: Boolean(res?.canceled),
      error: res?.canceled
        ? 'UAC-Abfrage wurde abgebrochen.'
        : res?.error || 'Administratorrechte fuer die Windows-Aufgabenplanung erforderlich.',
    };
  }

  async function removeAdminTaskIfPresent() {
    const query = await queryScheduledTaskFn();
    if (!query?.exists) {
      return { success: true, removed: false };
    }

    const elev = await ensureElevation();
    if (!elev.ok) {
      return { success: false, canceled: elev.canceled, error: elev.error };
    }

    const safeTaskName = escapePsSingleQuoted(AUTOSTART_TASK_NAME);
    const psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $OutputEncoding = [System.Text.Encoding]::UTF8
      $ErrorActionPreference = 'Stop'
      Unregister-ScheduledTask -TaskName '${safeTaskName}' -Confirm:$false -ErrorAction SilentlyContinue
      Write-Output 'TASK_REMOVED'
    `;

    const res = await runPowerShellElevatedFn(psScript, { timeoutMs: 25000 });
    if (res?.canceled) {
      return { success: false, canceled: true, error: 'UAC-Abfrage abgebrochen.' };
    }
    if (res?.code === 0 && String(res.stdout || '').includes('TASK_REMOVED')) {
      return { success: true, removed: true };
    }
    return {
      success: false,
      error: res?.error || res?.stderr || 'Scheduled Task konnte nicht geloescht werden.',
    };
  }

  async function upsertAdminTask() {
    const elev = await ensureElevation();
    if (!elev.ok) {
      return { success: false, canceled: elev.canceled, error: elev.error };
    }

    const { execPath, isPackaged, appPath } = getNormalLoginItemParams();
    if (!execPath || /[\r\n\0]/.test(execPath)) {
      return { success: false, error: 'Ungueltiger Anwendungspfad fuer den Autostart-Task.' };
    }

    const taskArg = isPackaged ? '--tray' : `"${appPath.replace(/"/g, '')}" --tray`;
    const workDir = isPackaged ? path.dirname(execPath) : appPath || path.dirname(execPath);
    const rawUser = String(getUsername() || '').trim();
    const rawDomain = String(getUserDomain() || '').trim();
    const fullUser = rawUser ? (rawDomain ? `${rawDomain}\\${rawUser}` : rawUser) : '';

    const safeTaskName = escapePsSingleQuoted(AUTOSTART_TASK_NAME);
    const safeExec = escapePsSingleQuoted(execPath);
    const safeArg = escapePsSingleQuoted(taskArg);
    const safeWorkDir = escapePsSingleQuoted(workDir);
    const safeUser = escapePsSingleQuoted(fullUser);

    const psScript = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $OutputEncoding = [System.Text.Encoding]::UTF8
      $ErrorActionPreference = 'Stop'
      $taskName = '${safeTaskName}'
      $exePath = '${safeExec}'
      $argStr = '${safeArg}'
      $workDir = '${safeWorkDir}'
      $targetUser = '${safeUser}'
      if ([string]::IsNullOrWhiteSpace($targetUser)) {
        $targetUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      }
      $action = New-ScheduledTaskAction -Execute $exePath -Argument $argStr -WorkingDirectory $workDir
      $trigger = New-ScheduledTaskTrigger -AtLogOn -User $targetUser
      $principal = New-ScheduledTaskPrincipal -UserId $targetUser -LogonType Interactive -RunLevel Highest
      $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Startet Software Katalog mit Administratorrechten im Infobereich' -Force | Out-Null
      Write-Output 'TASK_OK'
    `;

    const res = await runPowerShellElevatedFn(psScript, { timeoutMs: 25000 });
    if (res?.canceled) {
      return { success: false, canceled: true, error: 'UAC-Abfrage wurde abgebrochen.' };
    }
    if (res?.code === 0 && String(res.stdout || '').includes('TASK_OK')) {
      return { success: true };
    }
    return {
      success: false,
      error: res?.error || res?.stderr || 'Windows-Aufgabenplanung konnte nicht erstellt werden.',
    };
  }

  async function getStatus() {
    if (platform !== 'win32') {
      return {
        supported: false,
        enabled: false,
        mode: 'normal',
        normalEnabled: false,
        adminTaskExists: false,
        taskName: AUTOSTART_TASK_NAME,
        execPath: '',
      };
    }

    const normalEnabled = readNormalLoginItemEnabled();
    const taskQuery = await queryScheduledTaskFn();
    const adminTaskExists = Boolean(taskQuery?.exists);
    const { execPath } = getNormalLoginItemParams();

    return {
      supported: true,
      enabled: adminTaskExists || normalEnabled,
      mode: adminTaskExists ? 'admin' : 'normal',
      normalEnabled,
      adminTaskExists,
      taskName: AUTOSTART_TASK_NAME,
      execPath,
    };
  }

  async function applySettings({ enabled = false, mode = 'normal' } = {}) {
    if (platform !== 'win32') {
      return {
        success: false,
        error: 'Autostart wird nur unter Windows unterstuetzt.',
        status: await getStatus(),
      };
    }

    const targetEnabled = Boolean(enabled);
    const targetMode = normalizeAutostartMode(mode);

    if (!targetEnabled) {
      setNormalLoginItem(false);
      const rmRes = await removeAdminTaskIfPresent();
      if (!rmRes.success) {
        return {
          success: false,
          canceled: Boolean(rmRes.canceled),
          error: rmRes.error,
          status: await getStatus(),
        };
      }
      return { success: true, status: await getStatus() };
    }

    if (targetMode === 'normal') {
      const rmRes = await removeAdminTaskIfPresent();
      if (!rmRes.success) {
        return {
          success: false,
          canceled: Boolean(rmRes.canceled),
          error: rmRes.error,
          status: await getStatus(),
        };
      }
      setNormalLoginItem(true);
      return { success: true, status: await getStatus() };
    }

    setNormalLoginItem(false);
    const taskRes = await upsertAdminTask();
    if (!taskRes.success) {
      return {
        success: false,
        canceled: Boolean(taskRes.canceled),
        error: taskRes.error,
        status: await getStatus(),
      };
    }

    return { success: true, status: await getStatus() };
  }

  return {
    getStatus,
    applySettings,
  };
}
