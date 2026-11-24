import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CMD_METACHAR_RE = /[&|<>^()]/;

function stripBom(text) {
  return typeof text === 'string' && text.startsWith('\uFEFF') ? text.slice(1) : String(text || '');
}

function escapeSingleQuotedPs(value) {
  return String(value || '').replace(/'/g, "''");
}

function isParentAlive(targetPid) {
  if (!Number.isInteger(targetPid) || targetPid <= 0) return false;
  try {
    process.kill(targetPid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function validateToken(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  if (!expected || !provided) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function escapeCmdExeArg(arg) {
  const raw = String(arg ?? '').replace(/[\r\n\0]/g, '');
  if (raw.length === 0) return '""';
  if (/^[A-Za-z0-9._:/@=+,-]+$/.test(raw)) return raw;

  let out = '"';
  let backslashes = 0;
  let inQuotes = true;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      backslashes++;
    } else if (ch === '"') {
      if (backslashes > 0) {
        out += '\\'.repeat(backslashes * 2);
        backslashes = 0;
      }
      out += '\\"';
      inQuotes = !inQuotes;
    } else {
      if (backslashes > 0) {
        out += '\\'.repeat(backslashes);
        backslashes = 0;
      }
      if (!inQuotes && CMD_METACHAR_RE.test(ch)) {
        out += `^${ch}`;
      } else {
        out += ch;
      }
    }
  }

  if (backslashes > 0) {
    out += '\\'.repeat(backslashes * 2);
  }
  out += '"';
  return out;
}

function buildCmdExeCommandLine(command, args = []) {
  const cleanCommand = String(command || '')
    .replace(/[\r\n\0"]/g, '')
    .trim();
  const quotedCmd = /[\s&|<>^()%]/.test(cleanCommand) ? `"${cleanCommand}"` : cleanCommand;
  const escapedArgs = Array.isArray(args) ? args.map((a) => escapeCmdExeArg(a)) : [];
  const inner = escapedArgs.length > 0 ? `${quotedCmd} ${escapedArgs.join(' ')}` : quotedCmd;
  return `"${inner}"`;
}

function buildSafeExecSpec(command, args = [], useShell = false) {
  const cleanCommand = String(command || '').trim();
  const cleanArgs = Array.isArray(args) ? args.map((a) => String(a ?? '')) : [];
  const isBatch = /\.(cmd|bat)$/i.test(cleanCommand);
  const needsCmdWrapper = process.platform === 'win32' && (isBatch || Boolean(useShell));

  if (needsCmdWrapper) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', buildCmdExeCommandLine(cleanCommand, cleanArgs)],
      spawnOptions: {
        shell: false,
        windowsVerbatimArguments: true,
      },
    };
  }

  return {
    command: cleanCommand,
    args: cleanArgs,
    spawnOptions: {
      shell: false,
    },
  };
}

function killProcessTree(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
      });
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

const configPath = String(process.argv[2] || '').trim();
if (!configPath || !fs.existsSync(configPath)) {
  process.exit(2);
}

let config = null;
try {
  const raw = stripBom(fs.readFileSync(configPath, 'utf8'));
  config = JSON.parse(raw);
} catch {
  process.exit(2);
} finally {
  try {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  } catch {
    // Ignorieren
  }
}

const pipeName = String(config?.pipeName || '').trim();
const token = String(config?.token || '').trim();
const parentPid = Number.parseInt(String(config?.parentPid || '0'), 10);
const cancelDir = String(config?.cancelDir || os.tmpdir()).trim() || os.tmpdir();

if (!pipeName || !token || !Number.isInteger(parentPid) || parentPid <= 0) {
  process.exit(3);
}

const activeChildren = new Set();
let server = null;
let shuttingDown = false;

function shutdownWorker(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of activeChildren) {
    killProcessTree(child);
  }
  activeChildren.clear();
  if (server) {
    try {
      server.close(() => process.exit(exitCode));
      setTimeout(() => process.exit(exitCode), 250).unref();
      return;
    } catch {
      // Fallback unten
    }
  }
  process.exit(exitCode);
}

const parentWatchdog = setInterval(() => {
  if (!isParentAlive(parentPid)) {
    shutdownWorker(0);
  }
}, 1000);
parentWatchdog.unref();

function getCancelFlagPath(reqId) {
  const safeId = String(reqId || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(cancelDir, `sk_elev_cancel_${pipeName}_${safeId}.flag`);
}

function runExec(req) {
  const reqId = String(req?.id || '');
  const cleanCommand = String(req?.command || '').trim();
  const args = Array.isArray(req?.args) ? req.args.map((a) => String(a ?? '')) : [];
  const cwd = req?.cwd ? String(req.cwd) : undefined;
  const timeoutMs = Number.isFinite(req?.timeoutMs) && req.timeoutMs > 0 ? Math.trunc(req.timeoutMs) : 0;
  const windowsHide = req?.windowsHide !== false;
  const useShell = Boolean(req?.shell);

  if (!cleanCommand) {
    return Promise.resolve({
      id: reqId,
      ok: false,
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      canceled: false,
      notFound: true,
      error: 'Kein Kommando angegeben.',
    });
  }

  return new Promise((resolve) => {
    const spec = buildSafeExecSpec(cleanCommand, args, useShell);
    const cancelFile = getCancelFlagPath(reqId);
    /** @type {any} */
    let child = null;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer = null;
    let pollTimer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearInterval(pollTimer);
      if (child) activeChildren.delete(child);
      resolve({
        id: reqId,
        ok: Boolean(payload.ok),
        code: payload.code ?? -1,
        stdout: stripBom(payload.stdout ?? stdout),
        stderr: stripBom(payload.stderr ?? stderr),
        timedOut: Boolean(payload.timedOut),
        aborted: Boolean(payload.aborted),
        canceled: Boolean(payload.canceled),
        notFound: Boolean(payload.notFound),
        error: payload.error || null,
      });
    };

    try {
      child = spawn(spec.command, spec.args, {
        windowsHide,
        cwd: cwd && fs.existsSync(cwd) ? cwd : undefined,
        ...spec.spawnOptions,
      });
      activeChildren.add(child);
    } catch (err) {
      const errCode = err?.code || null;
      finish({
        ok: false,
        code: -1,
        notFound: errCode === 'ENOENT',
        error: err?.message || 'Prozess konnte nicht gestartet werden.',
      });
      return;
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        finish({
          ok: false,
          code: -1,
          timedOut: true,
          stderr: stderr || `Zeitueberschreitung nach ${timeoutMs} ms.`,
          error: `Zeitueberschreitung nach ${timeoutMs} ms.`,
        });
      }, timeoutMs);
    }

    pollTimer = setInterval(() => {
      if (!isParentAlive(parentPid)) {
        killProcessTree(child);
        shutdownWorker(0);
        return;
      }
      try {
        if (fs.existsSync(cancelFile)) {
          aborted = true;
          try {
            fs.unlinkSync(cancelFile);
          } catch {
            // Ignorieren
          }
          killProcessTree(child);
          finish({
            ok: false,
            code: -1,
            aborted: true,
            canceled: true,
            error: 'Vorgang abgebrochen.',
          });
        }
      } catch {
        // Ignorieren
      }
    }, 150);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      const errCode = err?.code || null;
      finish({
        ok: false,
        code: -1,
        notFound: errCode === 'ENOENT',
        stderr: stderr || err?.message || '',
        error: err?.message || 'Prozessfehler.',
      });
    });
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      finish({
        ok: exitCode === 0,
        code: exitCode,
        timedOut,
        aborted,
        canceled: aborted,
        error: exitCode === 0 ? null : (stderr || '').trim() || null,
      });
    });
  });
}

async function runPowerShell(req) {
  const reqId = String(req?.id || '');
  const timeoutMs = Number.isFinite(req?.timeoutMs) && req.timeoutMs > 0 ? Math.trunc(req.timeoutMs) : 0;
  const cwd = req?.cwd ? String(req.cwd) : undefined;
  const scriptBody = String(req?.script || '');
  const fullScript = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    scriptBody,
  ].join('\r\n');

  const tempFile = path.join(os.tmpdir(), `sk_elev_ps_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.ps1`);
  try {
    await fs.promises.writeFile(tempFile, `\uFEFF${fullScript}`, 'utf8');
    return await runExec({
      id: reqId,
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempFile],
      cwd,
      timeoutMs,
      windowsHide: true,
      shell: false,
    });
  } finally {
    try {
      if (fs.existsSync(tempFile)) {
        await fs.promises.unlink(tempFile);
      }
    } catch {
      // Ignorieren
    }
  }
}

async function runStartProcess(req) {
  const reqId = String(req?.id || '');
  const filePath = String(req?.filePath || '').trim();
  const argumentList = String(req?.argumentList || '');
  const timeoutMs = Number.isFinite(req?.timeoutMs) && req.timeoutMs > 0 ? Math.trunc(req.timeoutMs) : 0;
  const cwd = req?.cwd ? String(req.cwd) : undefined;

  if (!filePath) {
    return {
      id: reqId,
      ok: false,
      code: -1,
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
      canceled: false,
      error: 'Kein Dateipfad fuer start-process angegeben.',
    };
  }

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

  const res = await runPowerShell({
    id: reqId,
    script: psScript,
    cwd,
    timeoutMs,
  });

  if (res.aborted || res.canceled) {
    return {
      id: reqId,
      ok: false,
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
      id: reqId,
      ok: false,
      code: -1,
      stdout: res.stdout,
      stderr: res.stderr,
      timedOut: true,
      aborted: false,
      canceled: false,
      error: res.error || 'Zeitueberschreitung bei Start-Process.',
    };
  }

  const out = String(res.stdout || '').trim();
  const errLine = out.split(/\r?\n/).find((line) => line.startsWith('ERR:'));
  if (errLine) {
    const msg = errLine.slice(4).trim();
    const isCanceled = /abgebrochen|canceled|cancelled|1223/i.test(msg);
    return {
      id: reqId,
      ok: false,
      code: isCanceled ? 1223 : -1,
      stdout: out,
      stderr: msg,
      timedOut: false,
      aborted: false,
      canceled: isCanceled,
      error: msg,
    };
  }

  const exitMatch = out.match(/EXIT:(-?\d+)/);
  const exitCode = exitMatch ? Number.parseInt(exitMatch[1], 10) : res.code;
  const isCanceled = exitCode === 1602 || exitCode === 1223;
  const isSuccess = exitCode === 0 || exitCode === 3010;

  return {
    id: reqId,
    ok: isSuccess,
    code: exitCode,
    stdout: out,
    stderr: res.stderr || '',
    timedOut: false,
    aborted: false,
    canceled: isCanceled,
    error: isSuccess ? null : res.stderr || `ExitCode ${exitCode}`,
  };
}

async function handleRequestLine(rawLine, socket) {
  let req = null;
  try {
    req = JSON.parse(stripBom(rawLine).trim());
  } catch {
    socket.end(`${JSON.stringify({ id: '', ok: false, code: -1, error: 'INVALID_JSON' })}\n`);
    return;
  }

  const reqId = String(req?.id || '');
  const reqToken = String(req?.token || '');
  if (!validateToken(token, reqToken)) {
    socket.end(`${JSON.stringify({ id: reqId, ok: false, code: -1, error: 'UNAUTHORIZED' })}\n`);
    return;
  }

  const action = String(req?.action || '');
  if (action === 'ping') {
    socket.end(`${JSON.stringify({ id: reqId, ok: true, code: 0, stdout: 'PONG', stderr: '', pid: process.pid })}\n`);
    return;
  }

  if (action === 'shutdown') {
    socket.end(`${JSON.stringify({ id: reqId, ok: true, code: 0, stdout: 'BYE', stderr: '' })}\n`, () => {
      shutdownWorker(0);
    });
    return;
  }

  let response;
  if (action === 'exec') {
    response = await runExec(req);
  } else if (action === 'powershell') {
    response = await runPowerShell(req);
  } else if (action === 'start-process') {
    response = await runStartProcess(req);
  } else {
    response = { id: reqId, ok: false, code: -1, error: `UNKNOWN_ACTION:${action}` };
  }

  if (!socket.destroyed) {
    socket.end(`${JSON.stringify(response)}\n`);
  }
}

const pipePath = process.platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : path.join(cancelDir, `${pipeName}.sock`);

server = net.createServer((socket) => {
  let buf = '';
  let handled = false;
  socket.on('data', (chunk) => {
    if (handled) return;
    buf += chunk.toString('utf8');
    const nl = buf.indexOf('\n');
    if (nl === -1) return;
    handled = true;
    const line = buf.slice(0, nl);
    void handleRequestLine(line, socket);
  });
  socket.on('error', () => {
    // Client-Abbruch ignorieren
  });
});

server.on('error', () => {
  shutdownWorker(1);
});

server.listen({ path: pipePath, readableAll: true, writableAll: true });
