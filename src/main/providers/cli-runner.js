import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isAdminSessionActive,
  isProcessElevated,
  runCommandElevated,
  runPowerShellElevated,
} from '../elevated-helper.js';

export const DEFAULT_CLI_TIMEOUT_MS = 45000;

function stripBom(text) {
  return text.startsWith('\uFEFF') ? text.slice(1) : text;
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
 * Führt ein CLI-Kommando mit sauberem UTF-8-Output, Timeout, AbortSignal und windowsHide: true aus.
 * Wirft niemals bei fehlenden Binaries oder Exit-Codes != 0.
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ signal?: AbortSignal | null, timeoutMs?: number, cwd?: string, env?: NodeJS.ProcessEnv, shell?: boolean, windowsHide?: boolean, preferElevated?: boolean, onStdout?: ((chunk: string) => void) | null, onStderr?: ((chunk: string) => void) | null }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean, aborted: boolean, notFound: boolean, error: string | null, errorCode: string | null }>}
 */
export async function runCli(
  command,
  args = [],
  {
    signal = null,
    timeoutMs = DEFAULT_CLI_TIMEOUT_MS,
    cwd = undefined,
    env = undefined,
    shell = undefined,
    windowsHide = true,
    preferElevated = false,
    onStdout = null,
    onStderr = null,
  } = {}
) {
  const cleanCommand = String(command || '').trim();
  if (!cleanCommand) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      notFound: true,
      error: 'Kein Kommando angegeben.',
      errorCode: 'EINVAL',
    };
  }

  if (signal?.aborted) {
    return {
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: true,
      notFound: false,
      error: 'Abgebrochen.',
      errorCode: 'ABORT_ERR',
    };
  }

  const useShell = shell ?? (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cleanCommand));
  if (preferElevated === true && isAdminSessionActive() && !(await isProcessElevated())) {
    const elevatedRes = await runCommandElevated(cleanCommand, Array.isArray(args) ? args : [], {
      signal,
      timeoutMs,
      cwd,
      windowsHide,
      shell: useShell,
    });
    if (!elevatedRes.notElevated) {
      if (elevatedRes.stdout && typeof onStdout === 'function') onStdout(elevatedRes.stdout);
      if (elevatedRes.stderr && typeof onStderr === 'function') onStderr(elevatedRes.stderr);
      return {
        code: elevatedRes.code ?? -1,
        stdout: stripBom(elevatedRes.stdout ?? ''),
        stderr: stripBom(elevatedRes.stderr ?? ''),
        timedOut: Boolean(elevatedRes.timedOut),
        aborted: Boolean(elevatedRes.aborted),
        notFound: Boolean(elevatedRes.notFound),
        error: elevatedRes.error || null,
        errorCode: elevatedRes.errorCode || null,
      };
    }
  }

  return new Promise((resolve) => {
    /** @type {any} */
    let child = null;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
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
      finish({
        code: -1,
        aborted: true,
        error: 'Vorgang abgebrochen.',
        errorCode: 'ABORT_ERR',
      });
    };

    try {
      child = spawn(cleanCommand, Array.isArray(args) ? args : [], {
        windowsHide,
        cwd,
        env,
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
          stderr: stderr || `Zeitüberschreitung nach ${timeoutMs} ms.`,
          error: `Zeitüberschreitung nach ${timeoutMs} ms.`,
          errorCode: 'ETIMEDOUT',
        });
      }, timeoutMs);
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      if (typeof onStdout === 'function') onStdout(text);
    });

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (typeof onStderr === 'function') onStderr(text);
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

    // 'close' garantiert vollständig geleerte stdout/stderr-Streams
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

/**
 * Sucht den vollständigen Pfad einer ausführbaren Datei (inkl. optionaler Zusatzpfade).
 * @param {string} binaryName
 * @param {{ signal?: AbortSignal | null, timeoutMs?: number, extraPaths?: string[] }} [options]
 * @returns {Promise<string | null>}
 */
export async function findBinaryPath(binaryName, { signal = null, timeoutMs = 5000, extraPaths = [] } = {}) {
  for (const candidate of extraPaths || []) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Ignorieren
    }
  }

  const cleanName = String(binaryName || '').trim();
  if (!cleanName) return null;

  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const res = await runCli(locator, [cleanName], { signal, timeoutMs });
  if (res.code !== 0 || !res.stdout) return null;

  const lines = res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    try {
      if (fs.existsSync(line) && fs.statSync(line).isFile()) {
        return line;
      }
    } catch {
      // Weiter prüfen
    }
  }
  return lines[0] || null;
}

/**
 * Führt ein PowerShell-Skript mit UTF-8-Output aus (als EncodedCommand oder Temp-.ps1).
 * @param {string} script
 * @param {{ signal?: AbortSignal | null, timeoutMs?: number, asTempFile?: boolean, cwd?: string, env?: NodeJS.ProcessEnv, onStdout?: ((chunk: string) => void) | null, onStderr?: ((chunk: string) => void) | null }} [options]
 */
export async function runPowerShellScript(
  script,
  {
    signal = null,
    timeoutMs = DEFAULT_CLI_TIMEOUT_MS,
    asTempFile = false,
    cwd = undefined,
    env = undefined,
    onStdout = null,
    onStderr = null,
  } = {}
) {
  const fullScript = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    String(script || ''),
  ].join('\n');

  if (!asTempFile) {
    const encoded = Buffer.from(fullScript, 'utf16le').toString('base64');
    return runCli('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      signal,
      timeoutMs,
      cwd,
      env,
      onStdout,
      onStderr,
    });
  }

  const tempFile = path.join(os.tmpdir(), `sk_ps_${Date.now()}_${Math.random().toString(36).slice(2)}.ps1`);
  try {
    await fs.promises.writeFile(tempFile, `\uFEFF${fullScript}`, 'utf-8');
    return await runCli(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempFile],
      {
        signal,
        timeoutMs,
        cwd,
        env,
        onStdout,
        onStderr,
      }
    );
  } finally {
    try {
      if (fs.existsSync(tempFile)) await fs.promises.unlink(tempFile);
    } catch {
      // Ignorieren
    }
  }
}

function escapeSingleQuotedPs(value) {
  return String(value || '').replace(/'/g, "''");
}

async function readOptionalFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      return stripBom(await fs.promises.readFile(filePath, 'utf-8'));
    }
  } catch {
    // Ignorieren
  }
  return '';
}

/**
 * Startet ein PowerShell-Skript mit Administratorrechten via UAC (Start-Process -Verb RunAs -Wait -PassThru).
 * @param {string} script
 * @param {{ signal?: AbortSignal | null, timeoutMs?: number, onProgress?: ((pct: number | null, detail: string) => void) | null }} [options]
 */
export async function runElevatedPowerShell(
  script,
  { signal = null, timeoutMs = 15 * 60 * 1000, onProgress = null } = {}
) {
  if (await isProcessElevated()) {
    onProgress?.(null, 'Fuehre mit bestehenden Administratorrechten aus...');
    const directRes = await runPowerShellScript(script, { signal, timeoutMs, asTempFile: true });
    return {
      code: directRes.code,
      canceled: Boolean(directRes.aborted),
      stdout: directRes.stdout,
      stderr: directRes.stderr,
      timedOut: Boolean(directRes.timedOut),
      aborted: Boolean(directRes.aborted),
      error: directRes.aborted
        ? 'Vorgang abgebrochen.'
        : directRes.error ||
          (directRes.code === 0
            ? null
            : (directRes.stderr || directRes.stdout || `Fehlercode ${directRes.code}`).trim()),
    };
  }

  if (isAdminSessionActive()) {
    onProgress?.(null, 'Fuehre ueber aktive Admin-Sitzung aus...');
    const helperRes = await runPowerShellElevated(script, { signal, timeoutMs });
    if (!helperRes.notElevated) {
      return {
        code: helperRes.code,
        canceled: Boolean(helperRes.canceled || helperRes.aborted),
        stdout: stripBom(helperRes.stdout || ''),
        stderr: stripBom(helperRes.stderr || ''),
        timedOut: Boolean(helperRes.timedOut),
        aborted: Boolean(helperRes.aborted),
        error:
          helperRes.error ||
          (helperRes.code === 0
            ? null
            : (helperRes.stderr || helperRes.stdout || `Fehlercode ${helperRes.code}`).trim()),
      };
    }
  }

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const innerPs1 = path.join(os.tmpdir(), `sk_uac_inner_${stamp}.ps1`);
  const outLog = path.join(os.tmpdir(), `sk_uac_out_${stamp}.log`);
  const errLog = path.join(os.tmpdir(), `sk_uac_err_${stamp}.log`);

  const innerContent = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    '$exitCode = 0',
    'try {',
    `  & {`,
    String(script || ''),
    `  } *> '${escapeSingleQuotedPs(outLog)}'`,
    '  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $exitCode = [int]$LASTEXITCODE }',
    '} catch {',
    `  $_.Exception.Message | Out-File -FilePath '${escapeSingleQuotedPs(errLog)}' -Encoding utf8`,
    '  $exitCode = 1',
    '}',
    'exit $exitCode',
  ].join('\n');

  const launcherScript = [
    'try {',
    `  $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '${escapeSingleQuotedPs(innerPs1)}') -Verb RunAs -Wait -PassThru -ErrorAction Stop`,
    '  Write-Output "SK_UAC_EXIT:$($p.ExitCode)"',
    '} catch {',
    '  Write-Output "SK_UAC_ERR:$($_.Exception.Message)"',
    '}',
  ].join('\n');

  try {
    await fs.promises.writeFile(innerPs1, `\uFEFF${innerContent}`, 'utf-8');
    onProgress?.(null, 'Warte auf Administrator-Bestätigung (UAC) und Ausführung...');

    const res = await runPowerShellScript(launcherScript, {
      signal,
      timeoutMs,
      asTempFile: true,
    });

    const stdoutLog = await readOptionalFile(outLog);
    const stderrLog = await readOptionalFile(errLog);

    if (res.aborted) {
      return {
        code: -1,
        canceled: true,
        stdout: stdoutLog,
        stderr: stderrLog,
        timedOut: false,
        aborted: true,
        error: 'Vorgang abgebrochen.',
      };
    }

    if (res.timedOut) {
      return {
        code: -1,
        canceled: false,
        stdout: stdoutLog,
        stderr: stderrLog,
        timedOut: true,
        aborted: false,
        error: res.error || 'Zeitüberschreitung bei Administrator-Ausführung.',
      };
    }

    const uacErrMatch = res.stdout.match(/SK_UAC_ERR:(.*)/);
    if (uacErrMatch) {
      const msg = uacErrMatch[1].trim();
      const canceled = /abgebrochen|canceled|cancelled|1223/i.test(msg);
      return {
        code: canceled ? 1223 : -1,
        canceled,
        stdout: stdoutLog,
        stderr: stderrLog || msg,
        timedOut: false,
        aborted: false,
        error: canceled ? 'Administrator-Bestätigung (UAC) wurde abgebrochen.' : msg,
      };
    }

    const exitMatch = res.stdout.match(/SK_UAC_EXIT:(-?\d+)/);
    const exitCode = exitMatch ? parseInt(exitMatch[1], 10) : res.code;
    if (exitCode === 1223) {
      return {
        code: 1223,
        canceled: true,
        stdout: stdoutLog,
        stderr: stderrLog,
        timedOut: false,
        aborted: false,
        error: 'Administrator-Bestätigung (UAC) wurde abgebrochen.',
      };
    }

    return {
      code: exitCode,
      canceled: false,
      stdout: stdoutLog,
      stderr: stderrLog || res.stderr,
      timedOut: false,
      aborted: false,
      error: exitCode === 0 ? null : (stderrLog || stdoutLog || res.stderr || `Fehlercode ${exitCode}`).trim(),
    };
  } finally {
    for (const tempPath of [innerPs1, outLog, errLog]) {
      try {
        if (fs.existsSync(tempPath)) await fs.promises.unlink(tempPath);
      } catch {
        // Ignorieren
      }
    }
  }
}
