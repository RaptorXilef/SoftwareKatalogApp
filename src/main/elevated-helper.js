import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const PIPE_PREFIX = 'SoftwareKatalog_Elev_';

const VALID_ACTIONS = new Set(['ping', 'exec', 'powershell', 'start-process', 'shutdown']);

function stripBom(text) {
  return typeof text === 'string' && text.startsWith('\uFEFF') ? text.slice(1) : String(text || '');
}

function escapeSingleQuotedPs(value) {
  return String(value || '').replace(/'/g, "''");
}

function killProcessTree(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // Ignorieren
    }
  }
  if (!child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Ignorieren
    }
  }
}

/**
 * Erzeugt einen zufaelligen Named-Pipe-Namen fuer die aktuelle Admin-Sitzung.
 * @param {(size: number) => Buffer} [randomBytesFn]
 * @returns {string}
 */
export function generatePipeName(randomBytesFn = crypto.randomBytes) {
  const bytes = randomBytesFn(16);
  return `${PIPE_PREFIX}${Buffer.from(bytes).toString('hex')}`;
}

/**
 * Erzeugt ein zufaelliges 256-Bit-Sitzungs-Token (64 Hex-Zeichen).
 * @param {(size: number) => Buffer} [randomBytesFn]
 * @returns {string}
 */
export function generateSessionToken(randomBytesFn = crypto.randomBytes) {
  const bytes = randomBytesFn(32);
  return Buffer.from(bytes).toString('hex');
}

/**
 * Ermittelt den Plattform-spezifischen Pipe-/Socket-Pfad.
 * @param {string} pipeName
 * @param {string} [platform]
 * @returns {string}
 */
export function getPipePath(pipeName, platform = process.platform) {
  const cleanName = String(pipeName || '').trim();
  if (!cleanName) {
    throw new Error('Pipe-Name darf nicht leer sein.');
  }
  if (platform === 'win32') {
    return `\\\\.\\pipe\\${cleanName}`;
  }
  return path.join(os.tmpdir(), `${cleanName}.sock`);
}

/**
 * Vergleicht zwei Sitzungs-Tokens in konstanter Zeit via `crypto.timingSafeEqual`.
 * @param {unknown} expectedToken
 * @param {unknown} providedToken
 * @returns {boolean}
 */
export function validateSessionToken(expectedToken, providedToken) {
  if (typeof expectedToken !== 'string' || typeof providedToken !== 'string') {
    return false;
  }
  if (!expectedToken || !providedToken) {
    return false;
  }
  const expectedBuf = Buffer.from(expectedToken, 'utf8');
  const providedBuf = Buffer.from(providedToken, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Validiert und erstellt das kanonische Befehls-Payload fuer die Pipe-Uebertragung.
 * @param {{
 *   id?: string,
 *   token?: string,
 *   action?: string,
 *   command?: string,
 *   args?: string[],
 *   script?: string,
 *   filePath?: string,
 *   argumentList?: string,
 *   cwd?: string,
 *   timeoutMs?: number,
 *   windowsHide?: boolean,
 *   shell?: boolean,
 * }} [params]
 */
export function buildElevatedCommandPayload({
  id = '',
  token = '',
  action = '',
  command = '',
  args = [],
  script = '',
  filePath = '',
  argumentList = '',
  cwd = '',
  timeoutMs = 0,
  windowsHide = true,
  shell = false,
} = {}) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) {
    throw new Error('Sitzungs-Token darf nicht leer sein.');
  }
  const cleanAction = String(action || '').trim();
  if (!VALID_ACTIONS.has(cleanAction)) {
    throw new Error(`Ungueltige Aktion: "${cleanAction}".`);
  }

  const reqId = String(id || crypto.randomUUID()).trim();
  const normalizedTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 0;

  /** @type {Record<string, any>} */
  const payload = {
    id: reqId,
    token: cleanToken,
    action: cleanAction,
    timeoutMs: normalizedTimeout,
  };

  if (cleanAction === 'exec') {
    const cleanCommand = String(command || '').trim();
    if (!cleanCommand) {
      throw new Error('Fuer Aktion "exec" ist ein Kommando erforderlich.');
    }
    payload.command = cleanCommand;
    payload.args = Array.isArray(args) ? args.map((a) => String(a ?? '')) : [];
    payload.cwd = cwd ? String(cwd) : '';
    payload.windowsHide = windowsHide !== false;
    payload.shell = Boolean(shell);
  } else if (cleanAction === 'powershell') {
    const cleanScript = String(script || '');
    if (!cleanScript.trim()) {
      throw new Error('Fuer Aktion "powershell" ist ein Skript erforderlich.');
    }
    payload.script = cleanScript;
    payload.cwd = cwd ? String(cwd) : '';
  } else if (cleanAction === 'start-process') {
    const cleanFilePath = String(filePath || '').trim();
    if (!cleanFilePath) {
      throw new Error('Fuer Aktion "start-process" ist ein Dateipfad erforderlich.');
    }
    payload.filePath = cleanFilePath;
    payload.argumentList = String(argumentList || '');
    payload.cwd = cwd ? String(cwd) : '';
  }

  return payload;
}

/**
 * Serialisiert eine Pipe-Nachricht als einzeiliges NDJSON (`\n`).
 * @param {Record<string, any>} payload
 * @returns {string}
 */
export function serializePipeMessage(payload) {
  return `${JSON.stringify(payload)}\n`;
}

/**
 * Parst eine empfangene NDJSON-Zeile aus der Pipe.
 * @param {string} rawLine
 * @returns {{ valid: true, message: Record<string, any> } | { valid: false, error: string }}
 */
export function parsePipeMessage(rawLine) {
  const clean = stripBom(String(rawLine || '')).trim();
  if (!clean) {
    return { valid: false, error: 'Leere Pipe-Nachricht.' };
  }
  try {
    const parsed = JSON.parse(clean);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { valid: false, error: 'Pipe-Nachricht ist kein JSON-Objekt.' };
    }
    return { valid: true, message: parsed };
  } catch (err) {
    return { valid: false, error: err?.message || 'Ungueltiges JSON in Pipe-Nachricht.' };
  }
}

/**
 * Erkennt einen abgebrochenen UAC- oder Setup-Dialog anhand von Fehlermeldung oder ExitCode.
 * @param {unknown} message
 * @param {number | null | undefined} [exitCode]
 * @returns {boolean}
 */
export function isUacCanceledError(message, exitCode = null) {
  if (exitCode === 1223 || exitCode === 1602) {
    return true;
  }
  const text = String(message || '');
  return /abgebrochen|canceled|cancelled|1223/i.test(text);
}

function defaultCheckElevation(platform) {
  if (platform !== 'win32') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const cmd =
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(
          String(stdout || '')
            .trim()
            .toLowerCase() === 'true'
        );
      }
    );
  });
}

function defaultDirectExec(
  command,
  args = [],
  { signal = null, timeoutMs = 45000, cwd = undefined, windowsHide = true, shell = undefined } = {}
) {
  const cleanCommand = String(command || '').trim();
  if (!cleanCommand) {
    return Promise.resolve({
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      notFound: true,
      error: 'Kein Kommando angegeben.',
      errorCode: 'EINVAL',
    });
  }
  if (signal?.aborted) {
    return Promise.resolve({
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
      notFound: false,
      error: 'Abgebrochen.',
      errorCode: 'ABORT_ERR',
    });
  }

  return new Promise((resolve) => {
    const useShell = shell ?? (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cleanCommand));
    /** @type {any} */
    let child = null;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        code: payload.code ?? -1,
        stdout: stripBom(payload.stdout ?? stdout),
        stderr: stripBom(payload.stderr ?? stderr),
        timedOut: Boolean(payload.timedOut),
        aborted: Boolean(payload.aborted),
        notFound: Boolean(payload.notFound),
        error: payload.error || null,
        errorCode: payload.errorCode || null,
      });
    };

    const onAbort = () => {
      aborted = true;
      killProcessTree(child);
      finish({ code: -1, aborted: true, error: 'Vorgang abgebrochen.', errorCode: 'ABORT_ERR' });
    };

    try {
      child = spawn(cleanCommand, Array.isArray(args) ? args : [], {
        windowsHide,
        cwd,
        shell: useShell,
      });
    } catch (err) {
      const errCode = err?.code || null;
      finish({
        code: -1,
        notFound: errCode === 'ENOENT',
        error: err?.message || 'Prozess konnte nicht gestartet werden.',
        errorCode: errCode,
      });
      return;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        finish({
          code: -1,
          timedOut: true,
          stderr: stderr || `Zeitueberschreitung nach ${timeoutMs} ms.`,
          error: `Zeitueberschreitung nach ${timeoutMs} ms.`,
          errorCode: 'ETIMEDOUT',
        });
      }, timeoutMs);
    }

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      const errCode = err?.code || null;
      finish({
        code: -1,
        notFound: errCode === 'ENOENT',
        stderr: stderr || err?.message || '',
        error: err?.message || 'Prozessfehler.',
        errorCode: errCode,
      });
    });
    child.on('close', (code) => {
      finish({
        code: code ?? -1,
        timedOut,
        aborted,
        error: code === 0 ? null : (stderr || '').trim() || null,
      });
    });
  });
}

async function defaultDirectPowerShell(
  script,
  { signal = null, timeoutMs = 45000, cwd = undefined, tempDir = os.tmpdir() } = {}
) {
  const fullScript = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    String(script || ''),
  ].join('\n');
  const tempFile = path.join(tempDir, `sk_elev_direct_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  try {
    await fs.promises.writeFile(tempFile, `\uFEFF${fullScript}`, 'utf-8');
    return await defaultDirectExec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempFile],
      { signal, timeoutMs, cwd, windowsHide: true, shell: false }
    );
  } finally {
    try {
      if (fs.existsSync(tempFile)) await fs.promises.unlink(tempFile);
    } catch {
      // Ignorieren
    }
  }
}

async function defaultDirectStartProcess(
  filePath,
  argumentList = '',
  { signal = null, timeoutMs = 30 * 60 * 1000, cwd = undefined, tempDir = os.tmpdir() } = {}
) {
  const safeFile = escapeSingleQuotedPs(filePath);
  const safeArgs = escapeSingleQuotedPs(argumentList);
  const argClause = safeArgs ? `-ArgumentList '${safeArgs}'` : '';
  const psScript = `
    $ErrorActionPreference = 'Stop'
    try {
      $p = Start-Process -FilePath '${safeFile}' ${argClause} -Wait -PassThru
      Write-Output "EXIT:$($p.ExitCode)"
    } catch {
      Write-Output "ERR:$($_.Exception.Message)"
    }
  `;

  const res = await defaultDirectPowerShell(psScript, { signal, timeoutMs, cwd, tempDir });
  if (res.aborted) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
      canceled: true,
      error: 'Vorgang abgebrochen.',
    };
  }
  if (res.timedOut) {
    return {
      code: -1,
      stdout: res.stdout,
      stderr: res.stderr,
      timedOut: true,
      aborted: false,
      canceled: false,
      error: res.error,
    };
  }
  const out = String(res.stdout || '').trim();
  const errLine = out.split(/\r?\n/).find((line) => line.startsWith('ERR:'));
  if (errLine) {
    const msg = errLine.slice(4).trim();
    const canceled = isUacCanceledError(msg);
    return {
      code: canceled ? 1223 : -1,
      stdout: out,
      stderr: msg,
      timedOut: false,
      aborted: false,
      canceled,
      error: msg,
    };
  }
  const exitMatch = out.match(/EXIT:(-?\d+)/);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : res.code;
  const canceled = exitCode === 1602 || exitCode === 1223;
  return {
    code: exitCode,
    stdout: out,
    stderr: res.stderr || '',
    timedOut: false,
    aborted: false,
    canceled,
    error: exitCode === 0 || exitCode === 3010 ? null : res.stderr || `ExitCode ${exitCode}`,
  };
}

async function defaultLaunchWorker({ pipeName, token, workerPath, tempDir }) {
  if (!workerPath || !fs.existsSync(workerPath)) {
    return { success: false, error: `Elevated-Worker-Skript nicht gefunden: ${workerPath}` };
  }

  const cfgPath = path.join(tempDir, `sk_elev_cfg_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.json`);
  const cfgPayload = {
    pipeName,
    token,
    parentPid: process.pid,
    cancelDir: tempDir,
  };

  try {
    await fs.promises.writeFile(cfgPath, JSON.stringify(cfgPayload), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    return { success: false, error: `Konfigurationsdatei konnte nicht geschrieben werden: ${err.message}` };
  }

  const safeCfgPath = escapeSingleQuotedPs(cfgPath);
  const safeWorkerPath = escapeSingleQuotedPs(workerPath);
  const launcherScript = `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
    $ErrorActionPreference = 'Stop'
    try {
      $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      if ($sid -and (Test-Path -LiteralPath '${safeCfgPath}')) {
        $raw = Get-Content -LiteralPath '${safeCfgPath}' -Raw -Encoding UTF8 | ConvertFrom-Json
        $raw | Add-Member -NotePropertyName 'parentSid' -NotePropertyValue $sid -Force
        [System.IO.File]::WriteAllText('${safeCfgPath}', ($raw | ConvertTo-Json -Depth 3 -Compress), (New-Object System.Text.UTF8Encoding($false)))
      }
      $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', '${safeWorkerPath}', '-ConfigPath', '${safeCfgPath}') -Verb RunAs -PassThru -ErrorAction Stop
      Write-Output "SK_ELEV_PID:$($p.Id)"
    } catch {
      Write-Output "SK_ELEV_ERR:$($_.Exception.Message)"
    }
  `;

  const encoded = Buffer.from(launcherScript, 'utf16le').toString('base64');
  const res = await defaultDirectExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    timeoutMs: 120000,
    windowsHide: true,
    shell: false,
  });

  const combined = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  const errMatch = combined.match(/SK_ELEV_ERR:(.*)/);
  if (errMatch) {
    try {
      if (fs.existsSync(cfgPath)) await fs.promises.unlink(cfgPath);
    } catch {
      // Ignorieren
    }
    const msg = errMatch[1].trim();
    const canceled = isUacCanceledError(msg, res.code);
    return {
      success: false,
      canceled,
      error: canceled ? 'UAC-Abfrage wurde abgebrochen.' : msg,
    };
  }

  const pidMatch = combined.match(/SK_ELEV_PID:(\d+)/);
  if (pidMatch) {
    return {
      success: true,
      workerPid: Number.parseInt(pidMatch[1], 10),
    };
  }

  try {
    if (fs.existsSync(cfgPath)) await fs.promises.unlink(cfgPath);
  } catch {
    // Ignorieren
  }

  const canceled = isUacCanceledError(combined, res.code);
  return {
    success: false,
    canceled,
    error: canceled ? 'UAC-Abfrage wurde abgebrochen.' : combined || 'Admin-Worker konnte nicht gestartet werden.',
  };
}

/**
 * Erzeugt eine isolierte Instanz des sitzungsbasierten Admin-Helper-Services.
 * @param {Record<string, any>} [deps]
 */
export function createElevatedHelperService(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const tempDir = deps.tempDir || os.tmpdir();
  let resolveWorkerPath =
    typeof deps.resolveWorkerPath === 'function'
      ? deps.resolveWorkerPath
      : () => path.resolve(process.cwd(), 'src', 'main', 'elevated-worker.ps1');

  const checkElevationFn =
    typeof deps.checkElevationFn === 'function' ? deps.checkElevationFn : () => defaultCheckElevation(platform);
  const launchWorkerFn = typeof deps.launchWorkerFn === 'function' ? deps.launchWorkerFn : defaultLaunchWorker;
  const connectPipeFn =
    typeof deps.connectPipeFn === 'function' ? deps.connectPipeFn : (pipePath) => net.createConnection(pipePath);
  const pipePathResolver =
    typeof deps.pipePathResolver === 'function' ? deps.pipePathResolver : (pipeName) => getPipePath(pipeName, platform);
  const directExecFn = typeof deps.directExecFn === 'function' ? deps.directExecFn : defaultDirectExec;
  const directPowerShellFn =
    typeof deps.directPowerShellFn === 'function'
      ? deps.directPowerShellFn
      : (script, opts) => defaultDirectPowerShell(script, { ...opts, tempDir });
  const directStartProcessFn =
    typeof deps.directStartProcessFn === 'function'
      ? deps.directStartProcessFn
      : (filePath, argumentList, opts) => defaultDirectStartProcess(filePath, argumentList, { ...opts, tempDir });
  const killPidFn =
    typeof deps.killPidFn === 'function'
      ? deps.killPidFn
      : (pid) => {
          if (platform === 'win32' && pid > 0) {
            try {
              spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
            } catch {
              // Ignorieren
            }
          }
        };

  const pingTimeoutMs = Number.isFinite(deps.pingTimeoutMs) ? deps.pingTimeoutMs : 10000;
  const pingIntervalMs = Number.isFinite(deps.pingIntervalMs) ? deps.pingIntervalMs : 150;
  const randomBytesFn = typeof deps.randomBytesFn === 'function' ? deps.randomBytesFn : crypto.randomBytes;

  let cachedProcessElevated = null;
  let elevationPromise = null;
  let sessionActive = false;
  let activePipeName = '';
  let activeToken = '';
  let workerPid = null;
  let startedAt = null;
  let startPromise = null;
  let lastNotifiedSignature = '';
  const statusListeners = new Set();
  if (typeof deps.onStatusChange === 'function') {
    statusListeners.add(deps.onStatusChange);
  }

  function getStatus() {
    const elevated = cachedProcessElevated === true;
    const mode = elevated ? 'elevated' : sessionActive ? 'active' : 'off';
    return {
      mode,
      isProcessElevated: elevated,
      isSessionActive: !elevated && sessionActive,
      canUseAdmin: elevated || sessionActive,
      workerPid: !elevated && sessionActive ? workerPid : null,
      startedAt: !elevated && sessionActive ? startedAt : null,
      supported: platform === 'win32',
    };
  }

  function notifyStatusChange() {
    const status = getStatus();
    const signature = JSON.stringify([status.mode, status.workerPid, status.supported]);
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

  function resetSessionState() {
    const wasActive = sessionActive;
    sessionActive = false;
    activePipeName = '';
    activeToken = '';
    workerPid = null;
    startedAt = null;
    if (wasActive) {
      notifyStatusChange();
    }
  }

  function configure(options = {}) {
    if (typeof options.resolveWorkerPath === 'function') {
      resolveWorkerPath = options.resolveWorkerPath;
    }
    if (typeof options.onStatusChange === 'function') {
      statusListeners.add(options.onStatusChange);
    }
  }

  function subscribeStatus(listener) {
    if (typeof listener !== 'function') return () => {};
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  }

  async function isProcessElevated({ forceRefresh = false } = {}) {
    if (platform !== 'win32') {
      cachedProcessElevated = false;
      return false;
    }
    if (!forceRefresh && cachedProcessElevated !== null) {
      return cachedProcessElevated;
    }
    if (!forceRefresh && elevationPromise) {
      return elevationPromise;
    }
    elevationPromise = Promise.resolve(checkElevationFn())
      .then((val) => {
        cachedProcessElevated = Boolean(val);
        notifyStatusChange();
        return cachedProcessElevated;
      })
      .catch(() => {
        cachedProcessElevated = false;
        return false;
      })
      .finally(() => {
        elevationPromise = null;
      });
    return elevationPromise;
  }

  function isSessionActive() {
    return (
      platform === 'win32' && cachedProcessElevated !== true && sessionActive && Boolean(activePipeName && activeToken)
    );
  }

  function getCancelFlagPath(pipeName, reqId) {
    const safeId = String(reqId || '').replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(tempDir, `sk_elev_cancel_${pipeName}_${safeId}.flag`);
  }

  function sendPipeRaw(pipeName, token, payloadParams, { signal = null, timeoutMs = 0 } = {}) {
    const payload = buildElevatedCommandPayload({ ...payloadParams, token });
    const serialized = serializePipeMessage(payload);
    const pipePath = pipePathResolver(pipeName);

    if (signal?.aborted) {
      return Promise.resolve({
        ok: false,
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: true,
        canceled: true,
        notFound: false,
        error: 'Vorgang abgebrochen.',
      });
    }

    return new Promise((resolve) => {
      let settled = false;
      let buffer = '';
      let timer = null;
      let socket = null;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
          socket?.destroy();
        } catch {
          // Ignorieren
        }
        resolve(result);
      };

      const onAbort = () => {
        try {
          const flagPath = getCancelFlagPath(pipeName, payload.id);
          fs.writeFileSync(flagPath, '1', 'utf8');
        } catch {
          // Ignorieren
        }
        finish({
          ok: false,
          code: -1,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: true,
          canceled: true,
          notFound: false,
          error: 'Vorgang abgebrochen.',
        });
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          finish({
            ok: false,
            code: -1,
            stdout: '',
            stderr: '',
            timedOut: true,
            aborted: false,
            canceled: false,
            notFound: false,
            error: `Zeitueberschreitung nach ${timeoutMs} ms.`,
          });
        }, timeoutMs);
      }

      try {
        socket = connectPipeFn(pipePath);
      } catch (err) {
        finish({
          ok: false,
          code: -1,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: false,
          canceled: false,
          notFound: false,
          pipeErrorCode: err?.code || 'EPIPE',
          error: err?.message || 'Pipe-Verbindung fehlgeschlagen.',
        });
        return;
      }

      socket.on('connect', () => {
        try {
          socket.write(serialized, 'utf8');
        } catch (err) {
          finish({
            ok: false,
            code: -1,
            stdout: '',
            stderr: '',
            timedOut: false,
            aborted: false,
            canceled: false,
            notFound: false,
            pipeErrorCode: err?.code || 'EPIPE',
            error: err?.message || 'Pipe-Schreibfehler.',
          });
        }
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const nlIndex = buffer.indexOf('\n');
        if (nlIndex === -1) return;
        const line = buffer.slice(0, nlIndex);
        const parsed = parsePipeMessage(line);
        if (!parsed.valid) {
          finish({
            ok: false,
            code: -1,
            stdout: '',
            stderr: '',
            timedOut: false,
            aborted: false,
            canceled: false,
            notFound: false,
            error: 'error' in parsed ? parsed.error : 'Ungueltige Pipe-Nachricht.',
          });
          return;
        }
        const msg = 'message' in parsed ? parsed.message : {};
        finish({
          ok: Boolean(msg.ok),
          code: Number.isFinite(msg.code) ? msg.code : msg.ok ? 0 : -1,
          stdout: stripBom(typeof msg.stdout === 'string' ? msg.stdout : ''),
          stderr: stripBom(typeof msg.stderr === 'string' ? msg.stderr : ''),
          timedOut: Boolean(msg.timedOut),
          aborted: Boolean(msg.aborted),
          canceled: Boolean(msg.canceled),
          notFound: Boolean(msg.notFound),
          pid: msg.pid ?? null,
          error: msg.error || null,
        });
      });

      socket.on('error', (err) => {
        finish({
          ok: false,
          code: -1,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: false,
          canceled: false,
          notFound: false,
          pipeErrorCode: err?.code || 'EPIPE',
          error: err?.message || 'Pipe-Verbindungsfehler.',
        });
      });

      socket.on('close', () => {
        if (settled) return;
        if (buffer.trim()) {
          const parsed = parsePipeMessage(buffer);
          if (parsed.valid) {
            const msg = parsed.message;
            finish({
              ok: Boolean(msg.ok),
              code: Number.isFinite(msg.code) ? msg.code : msg.ok ? 0 : -1,
              stdout: stripBom(typeof msg.stdout === 'string' ? msg.stdout : ''),
              stderr: stripBom(typeof msg.stderr === 'string' ? msg.stderr : ''),
              timedOut: Boolean(msg.timedOut),
              aborted: Boolean(msg.aborted),
              canceled: Boolean(msg.canceled),
              notFound: Boolean(msg.notFound),
              pid: msg.pid ?? null,
              error: msg.error || null,
            });
            return;
          }
        }
        finish({
          ok: false,
          code: -1,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: false,
          canceled: false,
          notFound: false,
          pipeErrorCode: 'EPIPE',
          error: 'Pipe-Verbindung unerwartet geschlossen.',
        });
      });
    });
  }

  async function waitForPipeReady(pipeName, token) {
    const deadline = Date.now() + pingTimeoutMs;
    while (Date.now() < deadline) {
      const res = await sendPipeRaw(pipeName, token, { action: 'ping' }, { timeoutMs: 1500 });
      if (res.ok && res.stdout.trim() === 'PONG') {
        return res;
      }
      if (res.error === 'UNAUTHORIZED') {
        return res;
      }
      await new Promise((r) => setTimeout(r, pingIntervalMs));
    }
    return { ok: false, error: 'Admin-Helper-Pipe hat nicht rechtzeitig geantwortet.' };
  }

  async function sendRequest(payloadParams, { signal = null, timeoutMs = 0 } = {}) {
    if (!isSessionActive()) {
      return {
        ok: false,
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        canceled: false,
        notFound: false,
        notElevated: true,
        error: 'Keine aktive Admin-Sitzung.',
      };
    }

    const res = await sendPipeRaw(activePipeName, activeToken, payloadParams, { signal, timeoutMs });
    if (res.pipeErrorCode === 'ENOENT' || res.pipeErrorCode === 'EPIPE' || res.pipeErrorCode === 'ECONNREFUSED') {
      resetSessionState();
      return {
        ...res,
        notElevated: true,
      };
    }
    return res;
  }

  async function startSession() {
    if (platform !== 'win32') {
      return {
        success: false,
        error: 'Admin-Sitzung wird nur unter Windows unterstuetzt.',
        status: getStatus(),
      };
    }

    if (await isProcessElevated()) {
      return {
        success: true,
        alreadyElevated: true,
        status: getStatus(),
      };
    }

    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      if (isSessionActive()) {
        const pingRes = await sendPipeRaw(activePipeName, activeToken, { action: 'ping' }, { timeoutMs: 2000 });
        if (pingRes.ok) {
          return { success: true, alreadyActive: true, status: getStatus() };
        }
        resetSessionState();
      }

      const pipeName = generatePipeName(randomBytesFn);
      const token = generateSessionToken(randomBytesFn);
      const workerPath = resolveWorkerPath();

      const launchRes = await launchWorkerFn({ pipeName, token, workerPath, tempDir });
      if (!launchRes?.success) {
        resetSessionState();
        return {
          success: false,
          canceled: Boolean(launchRes?.canceled),
          error: launchRes?.error || 'Admin-Sitzung konnte nicht gestartet werden.',
          status: getStatus(),
        };
      }

      const readyRes = await waitForPipeReady(pipeName, token);
      if (!readyRes.ok) {
        if (launchRes.workerPid) {
          killPidFn(launchRes.workerPid);
        }
        resetSessionState();
        return {
          success: false,
          error: readyRes.error || 'Verbindung zum Admin-Helper fehlgeschlagen.',
          status: getStatus(),
        };
      }

      sessionActive = true;
      activePipeName = pipeName;
      activeToken = token;
      workerPid = launchRes.workerPid || readyRes.pid || null;
      startedAt = Date.now();
      notifyStatusChange();

      return {
        success: true,
        status: getStatus(),
      };
    })().finally(() => {
      startPromise = null;
    });

    return startPromise;
  }

  async function stopSession() {
    if (!sessionActive) {
      return { success: true, alreadyStopped: true, status: getStatus() };
    }

    const prevPipeName = activePipeName;
    const prevToken = activeToken;
    const prevPid = workerPid;

    try {
      if (prevPipeName && prevToken) {
        await sendPipeRaw(prevPipeName, prevToken, { action: 'shutdown' }, { timeoutMs: 3000 });
      }
    } catch {
      // Fallback ueber PID
    } finally {
      resetSessionState();
    }

    if (prevPid) {
      killPidFn(prevPid);
    }

    return { success: true, status: getStatus() };
  }

  async function runCommandElevated(command, args = [], opts = {}) {
    if (await isProcessElevated()) {
      return directExecFn(command, args, opts);
    }
    if (!isSessionActive()) {
      return {
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: Boolean(opts?.signal?.aborted),
        notFound: false,
        notElevated: true,
        error: 'Keine aktive Admin-Sitzung.',
        errorCode: null,
      };
    }

    const res = await sendRequest(
      {
        action: 'exec',
        command,
        args,
        cwd: opts?.cwd || '',
        timeoutMs: opts?.timeoutMs ?? 45000,
        windowsHide: opts?.windowsHide ?? true,
        shell: Boolean(opts?.shell),
      },
      { signal: opts?.signal || null, timeoutMs: opts?.timeoutMs ? opts.timeoutMs + 5000 : 0 }
    );

    return {
      code: res.code ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      timedOut: Boolean(res.timedOut),
      aborted: Boolean(res.aborted),
      notFound: Boolean(res.notFound),
      notElevated: Boolean(res.notElevated),
      error: res.error || null,
      errorCode: res.notFound ? 'ENOENT' : res.timedOut ? 'ETIMEDOUT' : res.aborted ? 'ABORT_ERR' : null,
    };
  }

  async function runPowerShellElevated(script, opts = {}) {
    if (await isProcessElevated()) {
      return directPowerShellFn(script, opts);
    }
    if (!isSessionActive()) {
      return {
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: Boolean(opts?.signal?.aborted),
        canceled: false,
        notElevated: true,
        error: 'Keine aktive Admin-Sitzung.',
      };
    }

    const res = await sendRequest(
      {
        action: 'powershell',
        script,
        cwd: opts?.cwd || '',
        timeoutMs: opts?.timeoutMs ?? 15 * 60 * 1000,
      },
      { signal: opts?.signal || null, timeoutMs: opts?.timeoutMs ? opts.timeoutMs + 5000 : 0 }
    );

    return {
      code: res.code ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      timedOut: Boolean(res.timedOut),
      aborted: Boolean(res.aborted),
      canceled: Boolean(res.canceled),
      notElevated: Boolean(res.notElevated),
      error: res.error || null,
    };
  }

  async function runStartProcessElevated(filePath, argumentList = '', opts = {}) {
    if (await isProcessElevated()) {
      return directStartProcessFn(filePath, argumentList, opts);
    }
    if (!isSessionActive()) {
      return {
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: Boolean(opts?.signal?.aborted),
        canceled: false,
        notElevated: true,
        error: 'Keine aktive Admin-Sitzung.',
      };
    }

    const res = await sendRequest(
      {
        action: 'start-process',
        filePath,
        argumentList,
        cwd: opts?.cwd || '',
        timeoutMs: opts?.timeoutMs ?? 30 * 60 * 1000,
      },
      { signal: opts?.signal || null, timeoutMs: opts?.timeoutMs ? opts.timeoutMs + 5000 : 0 }
    );

    return {
      code: res.code ?? -1,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      timedOut: Boolean(res.timedOut),
      aborted: Boolean(res.aborted),
      canceled: Boolean(res.canceled),
      notElevated: Boolean(res.notElevated),
      error: res.error || null,
    };
  }

  return {
    configure,
    subscribeStatus,
    isProcessElevated,
    getStatus,
    isSessionActive,
    startSession,
    stopSession,
    sendRequest,
    runCommandElevated,
    runPowerShellElevated,
    runStartProcessElevated,
  };
}

const defaultService = createElevatedHelperService();

export const configureElevatedHelper = (options) => defaultService.configure(options);
export const subscribeAdminStatus = (listener) => defaultService.subscribeStatus(listener);
export const isProcessElevated = (opts) => defaultService.isProcessElevated(opts);
export const getAdminSessionStatus = () => defaultService.getStatus();
export const isAdminSessionActive = () => defaultService.isSessionActive();
export const startAdminSession = () => defaultService.startSession();
export const stopAdminSession = () => defaultService.stopSession();
export const runCommandElevated = (command, args, opts) => defaultService.runCommandElevated(command, args, opts);
export const runPowerShellElevated = (script, opts) => defaultService.runPowerShellElevated(script, opts);
export const runStartProcessElevated = (filePath, argumentList, opts) =>
  defaultService.runStartProcessElevated(filePath, argumentList, opts);
