import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runCli } from '../src/main/providers/cli-runner.js';
import {
  buildCmdExeCommandLine,
  buildSafeSpawnSpec,
  escapeCmdExeArg,
  isWindowsBatchCommand,
  pickBestWindowsExecutable,
} from '../src/shared/cli-spawn-logic.js';

describe('cli-spawn-logic: Batch-Erkennung, Quoting & sichere Spawn-Specs', () => {
  it('erkennt .cmd und .bat zuverlaessig', () => {
    assert.equal(isWindowsBatchCommand('npm.cmd'), true);
    assert.equal(isWindowsBatchCommand('C:\\Program Files\\Composer\\composer.BAT'), true);
    assert.equal(isWindowsBatchCommand('winget.exe'), false);
    assert.equal(isWindowsBatchCommand('node'), false);
    assert.equal(isWindowsBatchCommand(''), false);
  });

  it('escapet Argumente fuer cmd.exe sicher inkl. Leerzeichen, Steuerzeichen und Backslashes', () => {
    assert.equal(escapeCmdExeArg(''), '""');
    assert.equal(escapeCmdExeArg('--version'), '--version');
    assert.equal(escapeCmdExeArg('C:\\Program Files\\App Name'), '"C:\\Program Files\\App Name"');
    assert.equal(escapeCmdExeArg('line1\r\nline2\0'), 'line1line2');
    assert.equal(escapeCmdExeArg('a & calc.exe'), '"a & calc.exe"');
    assert.equal(escapeCmdExeArg('foo"bar&baz'), '"foo\\"bar^&baz"');
  });

  it('baut einheitliche cmd.exe-Kommandozeilen und vermeidet shell: true immer', () => {
    const line = buildCmdExeCommandLine('C:\\Program Files\\nodejs\\npm.cmd', ['install', '-g', 'my pkg']);
    assert.equal(line, '""C:\\Program Files\\nodejs\\npm.cmd" install -g "my pkg""');

    const winCmdSpec = buildSafeSpawnSpec('C:\\Program Files\\nodejs\\npm.cmd', ['--version'], { platform: 'win32' });
    assert.equal(winCmdSpec.useCmdWrapper, true);
    assert.equal(winCmdSpec.spawnOptions.shell, false);
    assert.equal(winCmdSpec.spawnOptions.windowsVerbatimArguments, true);
    assert.equal(winCmdSpec.args[0], '/d');
    assert.equal(winCmdSpec.args[1], '/s');
    assert.equal(winCmdSpec.args[2], '/c');

    const winExeSpec = buildSafeSpawnSpec('winget.exe', ['upgrade', '--id', 'Git.Git'], { platform: 'win32' });
    assert.equal(winExeSpec.useCmdWrapper, false);
    assert.equal(winExeSpec.command, 'winget.exe');
    assert.deepEqual(winExeSpec.args, ['upgrade', '--id', 'Git.Git']);
    assert.equal(winExeSpec.spawnOptions.shell, false);

    const linuxSpec = buildSafeSpawnSpec('npm.cmd', ['--version'], { platform: 'linux', shell: true });
    assert.equal(linuxSpec.useCmdWrapper, false);
    assert.equal(linuxSpec.spawnOptions.shell, false);
  });

  it('waehlt bei where.exe-Treffern die beste Windows-Erweiterung (.exe > .com > .cmd > .bat > shim)', () => {
    const picked = pickBestWindowsExecutable([
      'C:\\Users\\demo\\AppData\\Roaming\\npm\\pnpm',
      'C:\\Users\\demo\\AppData\\Roaming\\npm\\pnpm.cmd',
    ]);
    assert.equal(picked, 'C:\\Users\\demo\\AppData\\Roaming\\npm\\pnpm.cmd');

    const pickedExe = pickBestWindowsExecutable(['C:\\tools\\app.cmd', 'C:\\tools\\app.exe', 'C:\\tools\\app.bat']);
    assert.equal(pickedExe, 'C:\\tools\\app.exe');
    assert.equal(pickBestWindowsExecutable([]), null);
  });
});

describe('cli-spawn-logic: Ausfuehrung ohne DEP0190-Warnung', () => {
  it('fuehrt eine .cmd-Datei mit Leerzeichen im Pfad und Argumenten ohne DEP0190 aus', async (t) => {
    if (process.platform !== 'win32') return;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk dep0190 test '));
    const cmdPath = path.join(tempDir, 'echo test.cmd');
    const warnings = [];
    const onWarning = (w) => warnings.push(`${w.code || ''}:${w.message || ''}`);
    process.on('warning', onWarning);

    t.after(() => {
      process.off('warning', onWarning);
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    fs.writeFileSync(cmdPath, '@echo off\r\necho ARG1=%1 ARG2=%2\r\n', 'utf8');
    const res = await runCli(cmdPath, ['hello world', 'a&b'], { timeoutMs: 10000 });
    assert.equal(res.code, 0, `stderr=${res.stderr} stdout=${res.stdout} err=${res.error}`);
    assert.match(res.stdout, /ARG1="hello world" ARG2="a&b"/);
    assert.equal(
      warnings.some((w) => w.includes('DEP0190')),
      false,
      `Unerwartete DEP0190-Warnung: ${warnings.join('; ')}`
    );
  });
});
