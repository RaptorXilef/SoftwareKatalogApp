import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildElevatedCommandPayload,
  buildWorkerLaunchArgString,
  createElevatedHelperService,
  generatePipeName,
  generateSessionToken,
  getPipePath,
  isUacCanceledError,
  PIPE_PREFIX,
  parsePipeMessage,
  resolveDefaultWorkerPath,
  serializePipeMessage,
  validateSessionToken,
} from '../src/main/elevated-helper.js';

describe('elevated-helper: Token-Generierung & -Validierung', () => {
  it('erzeugt eindeutige 256-Bit-Tokens und Pipe-Namen mit Praefix', () => {
    const t1 = generateSessionToken();
    const t2 = generateSessionToken();
    assert.match(t1, /^[0-9a-f]{64}$/);
    assert.match(t2, /^[0-9a-f]{64}$/);
    assert.notEqual(t1, t2);

    const p1 = generatePipeName();
    const p2 = generatePipeName();
    assert.ok(p1.startsWith(PIPE_PREFIX));
    assert.ok(p2.startsWith(PIPE_PREFIX));
    assert.notEqual(p1, p2);

    assert.equal(getPipePath('SoftwareKatalog_Elev_abc', 'win32'), '\\\\.\\pipe\\SoftwareKatalog_Elev_abc');
    assert.ok(getPipePath('SoftwareKatalog_Elev_abc', 'linux').endsWith('SoftwareKatalog_Elev_abc.sock'));
  });

  it('validiert Tokens konstant-zeitig und lehnt fehlerhafte Eingaben ab', () => {
    const token = generateSessionToken();
    assert.equal(validateSessionToken(token, token), true);

    const wrongSameLen = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    assert.equal(validateSessionToken(token, wrongSameLen), false);
    assert.equal(validateSessionToken(token, `${token}a`), false);
    assert.equal(validateSessionToken(token, ''), false);
    assert.equal(validateSessionToken('', ''), false);
    assert.equal(validateSessionToken(token, null), false);
    assert.equal(validateSessionToken(token, undefined), false);
    assert.equal(validateSessionToken(1234, 1234), false);
  });

  it('erkennt UAC-Abbruch anhand von ExitCodes und Fehlermeldungen', () => {
    assert.equal(isUacCanceledError('', 1223), true);
    assert.equal(isUacCanceledError('', 1602), true);
    assert.equal(isUacCanceledError('Der Vorgang wurde durch den Benutzer abgebrochen.'), true);
    assert.equal(isUacCanceledError('The operation was canceled by the user.'), true);
    assert.equal(isUacCanceledError('Access denied', 5), false);
  });
});

describe('elevated-helper: Befehls-Serialisierung & NDJSON-Framing', () => {
  it('baut valide Payloads fuer alle Aktionen und serialisiert als einzeiliges NDJSON', () => {
    const token = generateSessionToken();

    const execPayload = buildElevatedCommandPayload({
      id: 'req-1',
      token,
      action: 'exec',
      command: 'winget',
      args: ['upgrade', '--id', '7zip.7zip'],
      cwd: 'C:\\Temp',
      timeoutMs: 30000,
    });
    assert.equal(execPayload.action, 'exec');
    assert.deepEqual(execPayload.args, ['upgrade', '--id', '7zip.7zip']);

    const psPayload = buildElevatedCommandPayload({
      id: 'req-2',
      token,
      action: 'powershell',
      script: 'Write-Output "Zeile 1"\nWrite-Output "Zeile 2"',
    });
    const line = serializePipeMessage(psPayload);
    assert.ok(line.endsWith('\n'));
    assert.equal(line.slice(0, -1).includes('\n'), false);

    const parsed = parsePipeMessage(`\uFEFF${line}`);
    assert.equal(parsed.valid, true);
    if (parsed.valid) {
      assert.equal(parsed.message.id, 'req-2');
      assert.equal(parsed.message.script, 'Write-Output "Zeile 1"\nWrite-Output "Zeile 2"');
    }

    const startProc = buildElevatedCommandPayload({
      token,
      action: 'start-process',
      filePath: 'msiexec.exe',
      argumentList: '/i "C:\\setup.msi" /qn',
    });
    assert.equal(startProc.action, 'start-process');
    assert.equal(startProc.filePath, 'msiexec.exe');
    assert.equal(buildElevatedCommandPayload({ token, action: 'ping' }).action, 'ping');
    assert.equal(buildElevatedCommandPayload({ token, action: 'shutdown' }).action, 'shutdown');
  });

  it('weist ungueltige Payloads und defektes JSON sauber ab', () => {
    const token = generateSessionToken();
    assert.throws(() => buildElevatedCommandPayload({ token: '', action: 'ping' }));
    assert.throws(() => buildElevatedCommandPayload({ token, action: 'invalid' }));
    assert.throws(() => buildElevatedCommandPayload({ token, action: 'exec', command: '' }));
    assert.throws(() => buildElevatedCommandPayload({ token, action: 'powershell', script: '   ' }));
    assert.throws(() => buildElevatedCommandPayload({ token, action: 'start-process', filePath: '' }));

    assert.equal(parsePipeMessage('').valid, false);
    assert.equal(parsePipeMessage('{kaputt').valid, false);
    assert.equal(parsePipeMessage('[1,2,3]').valid, false);
  });
});

describe('elevated-helper: Fallback bei bereits erhoehtem Prozess & UAC-Abbruch', () => {
  it('fuehrt Befehle direkt ohne Helper aus, wenn der Prozess bereits als Administrator laeuft', async () => {
    let workerLaunched = false;
    const directCalls = [];

    const service = createElevatedHelperService({
      platform: 'win32',
      checkElevationFn: async () => true,
      launchWorkerFn: async () => {
        workerLaunched = true;
        return { success: true, workerPid: 9999 };
      },
      directExecFn: async (cmd, args) => {
        directCalls.push({ type: 'exec', cmd, args });
        return {
          code: 0,
          stdout: 'ok',
          stderr: '',
          timedOut: false,
          aborted: false,
          notFound: false,
          error: null,
          errorCode: null,
        };
      },
      directPowerShellFn: async (script) => {
        directCalls.push({ type: 'ps', script });
        return { code: 0, stdout: 'ps-ok', stderr: '', timedOut: false, aborted: false, error: null };
      },
      directStartProcessFn: async (filePath, argumentList) => {
        directCalls.push({ type: 'start', filePath, argumentList });
        return { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, canceled: false, error: null };
      },
    });

    assert.equal(await service.isProcessElevated(), true);
    const status = service.getStatus();
    assert.equal(status.mode, 'elevated');
    assert.equal(status.isProcessElevated, true);
    assert.equal(status.isSessionActive, false);
    assert.equal(status.canUseAdmin, true);

    const startRes = await service.startSession();
    assert.equal(startRes.success, true);
    assert.equal(startRes.alreadyElevated, true);
    assert.equal(workerLaunched, false);

    const execRes = await service.runCommandElevated('winget', ['--version']);
    const psRes = await service.runPowerShellElevated('Get-Date');
    const spRes = await service.runStartProcessElevated('msiexec.exe', '/i test.msi');
    assert.equal(execRes.code, 0);
    assert.equal(psRes.stdout, 'ps-ok');
    assert.equal(spRes.code, 0);
    assert.equal(directCalls.length, 3);
  });

  it('behandelt UAC-Abbruch sauber und bleibt im Modus "off"', async () => {
    const statuses = [];
    const service = createElevatedHelperService({
      platform: 'win32',
      checkElevationFn: async () => false,
      onStatusChange: (st) => statuses.push(st.mode),
      launchWorkerFn: async () => ({
        success: false,
        canceled: true,
        error: 'UAC-Abfrage wurde abgebrochen.',
      }),
    });

    const startRes = await service.startSession();
    assert.equal(startRes.success, false);
    assert.equal(startRes.canceled, true);
    assert.equal(service.isSessionActive(), false);
    assert.equal(service.getStatus().mode, 'off');
    assert.equal(service.getStatus().canUseAdmin, false);
    assert.ok(statuses.every((m) => m === 'off'));

    const notElevExec = await service.runCommandElevated('winget', ['upgrade']);
    assert.equal(notElevExec.notElevated, true);
  });
});

describe('elevated-helper: End-to-End Pipe-Protokoll & Abbruch-Handling', () => {
  it('kommuniziert ueber Pipe mit Token-Pruefung, verarbeitet Befehle und beendet sauber', async (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-elev-test-'));
    const sockPath = path.join(tempDir, 'mock-pipe.sock');
    if (process.platform === 'win32') {
      // Unter Windows Named Pipes verwenden, damit net.createServer & net.createConnection kompatibel sind
    }
    let expectedToken = '';
    const receivedRequests = [];
    const statusEvents = [];
    let killedPid = null;

    const getServerEndpoint = (pipeName) =>
      process.platform === 'win32' ? `\\\\.\\pipe\\${pipeName}` : path.join(tempDir, `${pipeName}.sock`);

    let currentServer = null;
    let activeEndpoint = '';

    const service = createElevatedHelperService({
      platform: 'win32',
      tempDir,
      pingTimeoutMs: 3000,
      pingIntervalMs: 30,
      pipePathResolver: (pipeName) => getServerEndpoint(pipeName),
      checkElevationFn: async () => false,
      onStatusChange: (st) => statusEvents.push(st.mode),
      killPidFn: (pid) => {
        killedPid = pid;
      },
      launchWorkerFn: async ({ pipeName, token }) => {
        expectedToken = token;
        const endpoint = getServerEndpoint(pipeName);
        activeEndpoint = endpoint;
        currentServer = net.createServer((socket) => {
          let buf = '';
          socket.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl === -1) return;
            const parsed = parsePipeMessage(buf.slice(0, nl));
            if (!parsed.valid) {
              socket.end(serializePipeMessage({ id: '', ok: false, code: -1, error: 'INVALID_JSON' }));
              return;
            }
            const req = parsed.message;
            if (!validateSessionToken(expectedToken, req.token)) {
              socket.end(serializePipeMessage({ id: req.id, ok: false, code: -1, error: 'UNAUTHORIZED' }));
              return;
            }
            receivedRequests.push(req);
            if (req.action === 'ping') {
              socket.end(
                serializePipeMessage({ id: req.id, ok: true, code: 0, stdout: 'PONG', stderr: '', pid: 4242 })
              );
            } else if (req.action === 'exec') {
              socket.end(
                serializePipeMessage({
                  id: req.id,
                  ok: true,
                  code: 0,
                  stdout: `executed:${req.command}:${req.args.join(' ')}`,
                  stderr: '',
                })
              );
            } else if (req.action === 'powershell') {
              if (req.script.includes('SLOW_CANCEL')) {
                setTimeout(() => {
                  if (!socket.destroyed) {
                    socket.end(serializePipeMessage({ id: req.id, ok: true, code: 0, stdout: 'late', stderr: '' }));
                  }
                }, 400);
                return;
              }
              socket.end(serializePipeMessage({ id: req.id, ok: true, code: 0, stdout: 'ps-elevated', stderr: '' }));
            } else if (req.action === 'start-process') {
              socket.end(serializePipeMessage({ id: req.id, ok: true, code: 3010, stdout: '', stderr: '' }));
            } else if (req.action === 'shutdown') {
              socket.end(serializePipeMessage({ id: req.id, ok: true, code: 0, stdout: 'BYE', stderr: '' }));
              setTimeout(() => currentServer?.close(), 10);
            }
          });
        });

        await new Promise((resolve) => currentServer.listen(endpoint, resolve));
        return { success: true, workerPid: 4242 };
      },
    });

    t.after(async () => {
      try {
        currentServer?.close();
      } catch {
        // Ignorieren
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const startRes = await service.startSession();
    assert.equal(startRes.success, true);
    assert.equal(service.isSessionActive(), true);
    assert.equal(service.getStatus().mode, 'active');
    assert.equal(service.getStatus().workerPid, 4242);

    // Falscher Token-Client muss abgelehnt werden
    const badRes = await new Promise((resolve, reject) => {
      const client = net.createConnection(activeEndpoint, () => {
        const badPayload = buildElevatedCommandPayload({ token: generateSessionToken(), action: 'ping' });
        client.write(serializePipeMessage(badPayload));
      });
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('\n')) {
          const parsed = parsePipeMessage(buf);
          client.destroy();
          resolve(parsed);
        }
      });
      client.on('error', reject);
    });
    assert.equal(badRes.valid, true);
    if (badRes.valid) {
      assert.equal(badRes.message.ok, false);
      assert.equal(badRes.message.error, 'UNAUTHORIZED');
    }

    const execRes = await service.runCommandElevated('winget', ['upgrade', '--id', 'Git.Git']);
    assert.equal(execRes.code, 0);
    assert.equal(execRes.stdout, 'executed:winget:upgrade --id Git.Git');

    const psRes = await service.runPowerShellElevated('Write-Output "hi"');
    assert.equal(psRes.code, 0);
    assert.equal(psRes.stdout, 'ps-elevated');

    const msiRes = await service.runStartProcessElevated('msiexec.exe', '/i app.msi /qn');
    assert.equal(msiRes.code, 3010);

    // AbortSignal waehrend laufender Pipe-Anfrage
    const ac = new AbortController();
    const slowPromise = service.runPowerShellElevated('SLOW_CANCEL', { signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const canceledRes = await slowPromise;
    assert.equal(canceledRes.aborted, true);
    assert.equal(canceledRes.canceled, true);

    const stopRes = await service.stopSession();
    assert.equal(stopRes.success, true);
    assert.equal(service.isSessionActive(), false);
    assert.equal(service.getStatus().mode, 'off');
    assert.equal(killedPid, 4242);
    assert.ok(statusEvents.includes('active'));
    assert.ok(statusEvents.includes('off'));
    assert.ok(receivedRequests.some((r) => r.action === 'shutdown'));
    assert.ok(sockPath.endsWith('.sock'));
  });
});

describe('elevated-helper: Worker-Pfadaufloesung, Quoting & echter Node-Worker', () => {
  it('loest elevated-worker.mjs im Dev- und Packaged-Modus auf und quotet Pfade mit Leerzeichen', () => {
    const devWorker = resolveDefaultWorkerPath({ isPackaged: false, appPath: process.cwd() });
    assert.equal(devWorker, path.join(process.cwd(), 'src', 'main', 'elevated-worker.mjs'));
    assert.equal(fs.existsSync(devWorker), true);

    const packagedWorker = resolveDefaultWorkerPath({
      isPackaged: true,
      resourcesPath: 'C:\\Program Files\\Software Katalog\\resources',
    });
    assert.equal(packagedWorker, path.join('C:\\Program Files\\Software Katalog\\resources', 'elevated-worker.mjs'));

    const cmdArgStr = buildWorkerLaunchArgString(
      'C:\\Program Files\\Software Katalog\\Software Katalog.exe',
      'C:\\Program Files\\Software Katalog\\resources\\elevated-worker.mjs',
      'C:\\Users\\Max Mustermann\\AppData\\Local\\Temp\\sk_elev_cfg.json'
    );
    assert.equal(
      cmdArgStr,
      '/d /s /c "set "ELECTRON_RUN_AS_NODE=1"&&"C:\\Program Files\\Software Katalog\\Software Katalog.exe" "C:\\Program Files\\Software Katalog\\resources\\elevated-worker.mjs" "C:\\Users\\Max Mustermann\\AppData\\Local\\Temp\\sk_elev_cfg.json""'
    );
  });

  it('startet den echten elevated-worker.mjs Prozess und prueft ping, UNAUTHORIZED, exec & shutdown', async (t) => {
    const workerPath = resolveDefaultWorkerPath({ isPackaged: false, appPath: process.cwd() });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-real-worker-'));
    const cfgPath = path.join(tempDir, 'worker cfg.json');
    let workerProc = null;
    let activePipeName = '';

    t.after(() => {
      if (workerProc && !workerProc.killed) {
        try {
          workerProc.kill('SIGKILL');
        } catch {
          // Ignorieren
        }
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    const service = createElevatedHelperService({
      platform: process.platform,
      tempDir,
      pingTimeoutMs: 5000,
      pingIntervalMs: 50,
      checkElevationFn: async () => false,
      killPidFn: () => {},
      resolveWorkerPath: () => workerPath,
      launchWorkerFn: async ({ pipeName, token, workerPath: resolvedWorker }) => {
        activePipeName = pipeName;
        fs.writeFileSync(
          cfgPath,
          JSON.stringify({
            pipeName,
            token,
            parentPid: process.pid,
            cancelDir: tempDir,
          }),
          'utf8'
        );
        workerProc = spawn(process.execPath, [resolvedWorker, cfgPath], {
          shell: false,
          windowsHide: true,
        });
        return { success: true, workerPid: workerProc.pid };
      },
    });

    if (process.platform !== 'win32') return;

    const startRes = await service.startSession();
    assert.equal(startRes.success, true);
    assert.equal(service.isSessionActive(), true);
    assert.equal(fs.existsSync(cfgPath), false);

    // Falscher Token an echte Pipe -> UNAUTHORIZED
    const unauthRes = await new Promise((resolve, reject) => {
      const client = net.createConnection(getPipePath(activePipeName, process.platform), () => {
        client.write(
          serializePipeMessage(buildElevatedCommandPayload({ token: generateSessionToken(), action: 'ping' }))
        );
      });
      let buf = '';
      client.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (buf.includes('\n')) {
          const parsed = parsePipeMessage(buf);
          client.destroy();
          resolve(parsed);
        }
      });
      client.on('error', reject);
    });
    assert.equal(unauthRes.valid, true);
    if (unauthRes.valid) {
      assert.equal(unauthRes.message.ok, false);
      assert.equal(unauthRes.message.error, 'UNAUTHORIZED');
    }

    const execRes = await service.runCommandElevated(process.execPath, ['-e', "console.log('WORKER_OK')"], {
      timeoutMs: 10000,
    });
    assert.equal(execRes.code, 0);
    assert.equal(execRes.stdout.trim(), 'WORKER_OK');

    const exitPromise = new Promise((resolve) => {
      workerProc.once('exit', (code) => resolve(code));
    });
    const stopRes = await service.stopSession();
    assert.equal(stopRes.success, true);
    assert.equal(service.isSessionActive(), false);
    const workerExitCode = await exitPromise;
    assert.equal(workerExitCode, 0);
  });
});
