import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBinaryPath, runCli } from '../providers/cli-runner.js';

const DEFAULT_TIMEOUT_MS = 60000;

function getNpmExtraPaths() {
  const candidates = [];
  if (process.env.NVM_SYMLINK) {
    candidates.push(path.join(process.env.NVM_SYMLINK, 'npm.cmd'));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'npm.cmd'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'npm.cmd'));
  }
  return candidates;
}

function getPnpmExtraPaths() {
  const candidates = [];
  if (process.env.PNPM_HOME) {
    candidates.push(path.join(process.env.PNPM_HOME, 'pnpm.exe'));
    candidates.push(path.join(process.env.PNPM_HOME, 'pnpm.cmd'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'pnpm', 'pnpm.exe'));
  }
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'pnpm.cmd'));
  }
  return candidates;
}

function getBunExtraPaths() {
  const root = process.env.BUN_INSTALL ? path.resolve(process.env.BUN_INSTALL) : path.join(os.homedir(), '.bun');
  return [path.join(root, 'bin', 'bun.exe')];
}

function getYarnExtraPaths() {
  const candidates = [];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'yarn.cmd'));
  }
  if (process.env.NVM_SYMLINK) {
    candidates.push(path.join(process.env.NVM_SYMLINK, 'yarn.cmd'));
  }
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'nodejs', 'yarn.cmd'));
  }
  return candidates;
}

function getComposerExtraPaths() {
  const candidates = ['C:\\ProgramData\\ComposerSetup\\bin\\composer.bat'];
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Composer', 'vendor', 'bin', 'composer.bat'));
  }
  return candidates;
}

function getUvExtraPaths() {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'uv.exe'),
    path.join(os.homedir(), '.cargo', 'bin', 'uv.exe'),
  ];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'uv', 'uv.exe'));
  }
  return candidates;
}

function getPythonExtraPaths() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    const pyRoot = path.join(process.env.LOCALAPPDATA, 'Programs', 'Python');
    try {
      if (fs.existsSync(pyRoot)) {
        const dirs = fs.readdirSync(pyRoot).sort().reverse();
        for (const dir of dirs) {
          candidates.push(path.join(pyRoot, dir, 'python.exe'));
        }
      }
    } catch {
      // Ignorieren
    }
  }
  return candidates;
}

function getCargoExtraPaths() {
  const candidates = [];
  if (process.env.CARGO_HOME) {
    candidates.push(path.join(process.env.CARGO_HOME, 'bin', 'cargo.exe'));
  }
  candidates.push(path.join(os.homedir(), '.cargo', 'bin', 'cargo.exe'));
  return candidates;
}

function getDotnetExtraPaths() {
  const candidates = [];
  if (process.env.ProgramFiles) {
    candidates.push(path.join(process.env.ProgramFiles, 'dotnet', 'dotnet.exe'));
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'dotnet', 'dotnet.exe'));
  }
  return candidates;
}

function findProjectVenvPython(projectPath) {
  if (!projectPath) return '';
  const candidates = [
    path.join(projectPath, '.venv', 'Scripts', 'python.exe'),
    path.join(projectPath, 'venv', 'Scripts', 'python.exe'),
    path.join(projectPath, '.venv', 'bin', 'python'),
    path.join(projectPath, 'venv', 'bin', 'python'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Weiter pruefen
    }
  }
  return '';
}

function buildPythonEnv() {
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
}

/**
 * Erzeugt einen sicheren projekt-lokalen CLI-Runner fuer alle DEV-Paketmanager.
 * Nutzt `cli-runner.js` (`shell: false`, `windowsHide: true`, kein `DEP0190`).
 * @param {{
 *   getConfigFn?: () => Record<string, any>,
 *   runCliFn?: typeof runCli,
 *   findBinaryPathFn?: typeof findBinaryPath,
 * }} [deps]
 */
export function createDevCliRunner(deps = {}) {
  let getConfigFn = typeof deps.getConfigFn === 'function' ? deps.getConfigFn : () => ({});
  let runCliFn = typeof deps.runCliFn === 'function' ? deps.runCliFn : runCli;
  let findBinaryPathFn = typeof deps.findBinaryPathFn === 'function' ? deps.findBinaryPathFn : findBinaryPath;

  function configure(options = {}) {
    if (typeof options.getConfigFn === 'function') getConfigFn = options.getConfigFn;
    if (typeof options.runCliFn === 'function') runCliFn = options.runCliFn;
    if (typeof options.findBinaryPathFn === 'function') findBinaryPathFn = options.findBinaryPathFn;
  }

  async function resolveVcpkg(signal) {
    const cfgRoot = String(getConfigFn()?.providerSettings?.vcpkgRoot || '').trim();
    const envRoot = String(process.env.VCPKG_ROOT || '').trim();
    const exeName = process.platform === 'win32' ? 'vcpkg.exe' : 'vcpkg';

    for (const root of [cfgRoot, envRoot]) {
      if (!root) continue;
      const resolvedRoot = path.resolve(root);
      const bin = path.join(resolvedRoot, exeName);
      try {
        if (fs.existsSync(bin) && fs.statSync(bin).isFile()) {
          return { binary: bin, rootDir: resolvedRoot };
        }
      } catch {
        // Ignorieren
      }
    }

    const fromPath = await findBinaryPathFn(exeName, { signal, timeoutMs: 5000 });
    if (fromPath) {
      return { binary: fromPath, rootDir: path.dirname(fromPath) };
    }
    return { binary: '', rootDir: cfgRoot || envRoot || '' };
  }

  /**
   * Fuehrt ein Paketmanager-Kommando im Projektverzeichnis `projectPath` aus.
   * @param {string} manager
   * @param {string[]} args
   * @param {{ projectPath?: string, signal?: AbortSignal | null, timeoutMs?: number }} [options]
   */
  async function runManagerCli(
    manager,
    args = [],
    { projectPath = '', signal = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
  ) {
    const mgr = String(manager || '')
      .trim()
      .toLowerCase();
    const cleanArgs = Array.isArray(args) ? args : [];

    if (mgr === 'pip') {
      const venvPython = findProjectVenvPython(projectPath);
      if (venvPython) {
        const res = await runCliFn(venvPython, ['-m', 'pip', ...cleanArgs], {
          cwd: projectPath,
          signal,
          timeoutMs,
          env: buildPythonEnv(),
          windowsHide: true,
        });
        return { ...res, usingProjectVenv: true };
      }

      const pyExe = await findBinaryPathFn(process.platform === 'win32' ? 'python.exe' : 'python', {
        signal,
        timeoutMs: 5000,
        extraPaths: getPythonExtraPaths(),
      });
      if (pyExe || process.platform !== 'win32') {
        const res = await runCliFn(pyExe || 'python', ['-m', 'pip', ...cleanArgs], {
          cwd: projectPath,
          signal,
          timeoutMs,
          env: buildPythonEnv(),
          windowsHide: true,
        });
        if (!res.notFound) {
          return { ...res, usingProjectVenv: false };
        }
      }

      if (process.platform === 'win32') {
        const pyLauncher = await findBinaryPathFn('py.exe', {
          signal,
          timeoutMs: 5000,
          extraPaths: [path.join(process.env.SystemRoot || 'C:\\Windows', 'py.exe')],
        });
        if (pyLauncher) {
          const res = await runCliFn(pyLauncher, ['-m', 'pip', ...cleanArgs], {
            cwd: projectPath,
            signal,
            timeoutMs,
            env: buildPythonEnv(),
            windowsHide: true,
          });
          return { ...res, usingProjectVenv: false };
        }
      }

      return {
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: Boolean(signal?.aborted),
        notFound: true,
        usingProjectVenv: false,
        error: 'Python / pip ist auf diesem PC nicht verfuegbar.',
        errorCode: 'ENOENT',
      };
    }

    if (mgr === 'vcpkg') {
      const { binary, rootDir } = await resolveVcpkg(signal);
      if (!binary) {
        return {
          code: -1,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: Boolean(signal?.aborted),
          notFound: true,
          error: 'vcpkg ist auf diesem PC nicht verfuegbar.',
          errorCode: 'ENOENT',
        };
      }
      const env = rootDir ? { ...process.env, VCPKG_ROOT: rootDir } : process.env;
      return runCliFn(binary, cleanArgs, { cwd: projectPath, signal, timeoutMs, env, windowsHide: true });
    }

    const specMap = {
      npm: { bin: process.platform === 'win32' ? 'npm.cmd' : 'npm', extra: getNpmExtraPaths() },
      pnpm: { bin: 'pnpm', extra: getPnpmExtraPaths() },
      bun: { bin: process.platform === 'win32' ? 'bun.exe' : 'bun', extra: getBunExtraPaths() },
      yarn: { bin: process.platform === 'win32' ? 'yarn.cmd' : 'yarn', extra: getYarnExtraPaths() },
      composer: { bin: process.platform === 'win32' ? 'composer.bat' : 'composer', extra: getComposerExtraPaths() },
      uv: { bin: process.platform === 'win32' ? 'uv.exe' : 'uv', extra: getUvExtraPaths() },
      cargo: { bin: process.platform === 'win32' ? 'cargo.exe' : 'cargo', extra: getCargoExtraPaths() },
      dotnet: { bin: process.platform === 'win32' ? 'dotnet.exe' : 'dotnet', extra: getDotnetExtraPaths() },
    };

    const spec = specMap[mgr];
    if (!spec) {
      return {
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        notFound: true,
        error: `Unbekannter Paketmanager: ${mgr}`,
        errorCode: 'EINVAL',
      };
    }

    const binPath = await findBinaryPathFn(spec.bin, {
      signal,
      timeoutMs: 5000,
      extraPaths: spec.extra,
    });

    if (process.platform === 'win32' && !binPath) {
      return {
        code: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: Boolean(signal?.aborted),
        notFound: true,
        error: `${mgr} ist auf diesem PC nicht verfuegbar.`,
        errorCode: 'ENOENT',
      };
    }

    return runCliFn(binPath || mgr, cleanArgs, {
      cwd: projectPath,
      signal,
      timeoutMs,
      windowsHide: true,
    });
  }

  return {
    configure,
    runManagerCli,
  };
}

const defaultCliRunner = createDevCliRunner();

export const configureDevCli = (options) => defaultCliRunner.configure(options);
export const runDevManagerCli = (manager, args, options) => defaultCliRunner.runManagerCli(manager, args, options);
