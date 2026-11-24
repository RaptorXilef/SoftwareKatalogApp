import { normalizeProviderVersion } from '../../shared/provider-lifecycle-logic.js';
import { createJob } from '../jobs.js';
import { findBinaryPath, runCli, runElevatedPowerShell, runPowerShellScript } from './cli-runner.js';
import { checkProviderAvailability, getProvider } from './registry.js';

function extractDefaultVersion(stdout) {
  const clean = String(stdout || '').trim();
  if (!clean) return null;
  const firstLine = clean.split(/\r?\n/)[0]?.trim() || '';
  const semverMatch = firstLine.match(/v?(\d+\.\d+(?:\.\d+)*(?:[-+._a-z0-9]*)?)/i);
  return normalizeProviderVersion(semverMatch ? semverMatch[1] : firstLine);
}

/**
 * Erzeugt einen standardisierten checkAvailability()-Hook für CLI-basierte Paketmanager.
 * Wirft niemals bei fehlender Binary, sondern liefert { available, version, binaryPath, error }.
 * @param {{ binary: string, versionArgs?: string[], parseVersion?: ((stdout: string, stderr: string) => string | null) | null, extraPaths?: string[] | (() => string[]), timeoutMs?: number, notFoundMessage?: string }} config
 */
export function createCliAvailabilityChecker({
  binary,
  versionArgs = ['--version'],
  parseVersion = null,
  extraPaths = [],
  timeoutMs = 8000,
  notFoundMessage = '',
}) {
  return async function checkAvailability({ signal = null } = {}) {
    try {
      const resolvedExtra = typeof extraPaths === 'function' ? extraPaths() : extraPaths;
      const binaryPath = await findBinaryPath(binary, { signal, timeoutMs, extraPaths: resolvedExtra });
      const executable = binaryPath || binary;

      const res = await runCli(executable, versionArgs, { signal, timeoutMs });
      if (res.notFound || (res.code !== 0 && !binaryPath)) {
        return {
          available: false,
          version: null,
          binaryPath: null,
          error: notFoundMessage || `${binary} ist auf diesem PC nicht installiert.`,
        };
      }

      if (res.code !== 0) {
        return {
          available: false,
          version: null,
          binaryPath: binaryPath || null,
          error: res.error || res.stderr || `${binary} konnte nicht ausgeführt werden (Code ${res.code}).`,
        };
      }

      const rawVersion = typeof parseVersion === 'function' ? parseVersion(res.stdout, res.stderr) : null;
      const version = normalizeProviderVersion(rawVersion ?? extractDefaultVersion(res.stdout));
      return {
        available: true,
        version,
        binaryPath: binaryPath || executable,
        error: null,
      };
    } catch (err) {
      return {
        available: false,
        version: null,
        binaryPath: null,
        error: err?.message || `Fehler beim Prüfen von ${binary}.`,
      };
    }
  };
}

/**
 * Erzeugt einen Bootstrap-Hook (Install/Uninstall) auf Basis eines PowerShell-Skripts (optional mit UAC).
 * @param {{ script: string, requiresAdmin?: boolean, label?: string, timeoutMs?: number }} config
 */
export function createPowerShellBootstrapRunner({
  script,
  requiresAdmin = false,
  label = '',
  timeoutMs = 15 * 60 * 1000,
}) {
  return async function runBootstrap({ signal = null, onProgress = null } = {}) {
    onProgress?.(null, label || 'Führe PowerShell-Aktion aus...');
    const res = requiresAdmin
      ? await runElevatedPowerShell(script, { signal, timeoutMs, onProgress })
      : await runPowerShellScript(script, { signal, timeoutMs, asTempFile: true });

    const isCanceled = ('canceled' in res && res.canceled) || res.aborted;
    if (isCanceled) {
      return {
        success: false,
        canceled: true,
        exitCode: res.code,
        stdout: res.stdout,
        stderr: res.stderr,
        error: res.error || 'Aktion wurde abgebrochen.',
      };
    }

    if (res.code !== 0) {
      return {
        success: false,
        exitCode: res.code,
        stdout: res.stdout,
        stderr: res.stderr,
        error: res.error || res.stderr || res.stdout || `Fehlercode ${res.code}`,
      };
    }

    return {
      success: true,
      exitCode: res.code,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  };
}

/**
 * Erzeugt einen Bootstrap-Hook (Install/Uninstall) über Winget.
 * @param {{ wingetId: string, action?: 'install' | 'uninstall', name?: string, scope?: 'user' | 'machine' | '' }} config
 */
export function createWingetBootstrapRunner({ wingetId, action = 'install', name = '', scope = '' }) {
  return async function runWingetBootstrap({ signal = null, onProgress = null } = {}) {
    const cleanId = String(wingetId || '').trim();
    if (!cleanId) {
      return { success: false, error: 'Keine Winget-ID für Manager-Bootstrap konfiguriert.' };
    }

    const args =
      action === 'uninstall'
        ? ['uninstall', '--id', cleanId, '--exact', '--accept-source-agreements', '--silent']
        : [
            'install',
            '--id',
            cleanId,
            '--exact',
            '--source',
            'winget',
            '--accept-package-agreements',
            '--accept-source-agreements',
            '--silent',
          ];
    if (action === 'install' && (scope === 'user' || scope === 'machine')) {
      args.push('--scope', scope);
    }

    onProgress?.(
      null,
      action === 'uninstall'
        ? `Deinstalliere ${name || cleanId} über Winget...`
        : `Installiere ${name || cleanId} über Winget...`
    );

    const res = await runCli('winget', args, { signal, timeoutMs: 30 * 60 * 1000 });
    if (res.aborted || res.code === 1602 || res.code === 1223) {
      return { success: false, canceled: true, exitCode: res.code };
    }

    if (res.notFound) {
      return { success: false, exitCode: -1, error: 'Winget ist auf diesem System nicht verfügbar.' };
    }

    const alreadyUpToDate = action === 'install' && res.code === -1978335189;
    if (res.code === 0 || res.code === 3010 || alreadyUpToDate) {
      return {
        success: true,
        exitCode: res.code,
        rebootRequired: res.code === 3010,
      };
    }

    return {
      success: false,
      exitCode: res.code,
      error: (res.stderr || res.stdout || res.error || `Winget-Fehlercode ${res.code}`).trim(),
    };
  };
}

/**
 * Installiert einen registrierten Paketmanager über den Job-Manager und prüft danach automatisch die Verfügbarkeit.
 * @param {string} providerId
 * @param {{ getProviderFn?: (id: string) => any, checkAvailabilityFn?: (id: string) => Promise<any>, createJobFn?: (opts: any) => any }} [deps]
 */
export async function installProviderManager(providerId, deps = {}) {
  const resolveProvider = deps.getProviderFn || getProvider;
  const verifyAvailability = deps.checkAvailabilityFn || checkProviderAvailability;
  const startJob = deps.createJobFn || createJob;

  const provider = resolveProvider(providerId);
  if (!provider) {
    return { success: false, providerId: String(providerId || ''), error: `Unbekannter Provider "${providerId}".` };
  }
  if (!provider.canInstallManager || typeof provider.installManager !== 'function') {
    return {
      success: false,
      providerId: provider.id,
      error: `${provider.name} unterstützt keine automatische Installation.`,
    };
  }

  const job = startJob({
    type: 'provider-install',
    title: `Paketmanager installieren: ${provider.name}`,
    dedupeKey: `provider-manager:${provider.id}`,
    cancelable: true,
  });
  if (!job) {
    return {
      success: false,
      providerId: provider.id,
      alreadyRunning: true,
      error: `Für ${provider.name} läuft bereits eine Installation oder Deinstallation.`,
    };
  }

  try {
    job.update(10, `Starte Installation von ${provider.name}...`);
    const res = await provider.installManager({
      signal: job.signal,
      onProgress: (pct, detail) => job.update(pct, detail),
    });

    if (job.signal.aborted || res?.canceled) {
      const availability = await verifyAvailability(provider.id);
      job.finish('canceled', `${provider.name}-Installation abgebrochen.`, { autoRemoveMs: 3500 });
      return {
        success: false,
        providerId: provider.id,
        canceled: true,
        availability,
      };
    }

    job.update(85, `Prüfe Verfügbarkeit von ${provider.name}...`);
    const availability = await verifyAvailability(provider.id);

    if (res?.success) {
      const msg = availability?.version
        ? `${provider.name} v${availability.version} einsatzbereit.`
        : `${provider.name} installiert.`;
      job.finish('done', msg, { autoRemoveMs: 4000 });
      return {
        success: true,
        providerId: provider.id,
        availability,
        rebootRequired: Boolean(res.rebootRequired),
      };
    }

    const errMsg = res?.error || `${provider.name} konnte nicht installiert werden.`;
    job.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return {
      success: false,
      providerId: provider.id,
      availability,
      error: errMsg,
    };
  } catch (err) {
    const availability = await verifyAvailability(provider.id).catch(() => null);
    const errMsg = err?.message || `Fehler bei der Installation von ${provider.name}.`;
    job.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return {
      success: false,
      providerId: provider.id,
      availability,
      error: errMsg,
    };
  }
}

/**
 * Deinstalliert einen registrierten Paketmanager über den Job-Manager und prüft danach automatisch die Verfügbarkeit.
 * @param {string} providerId
 * @param {{ getProviderFn?: (id: string) => any, checkAvailabilityFn?: (id: string) => Promise<any>, createJobFn?: (opts: any) => any }} [deps]
 */
export async function uninstallProviderManager(providerId, deps = {}) {
  const resolveProvider = deps.getProviderFn || getProvider;
  const verifyAvailability = deps.checkAvailabilityFn || checkProviderAvailability;
  const startJob = deps.createJobFn || createJob;

  const provider = resolveProvider(providerId);
  if (!provider) {
    return { success: false, providerId: String(providerId || ''), error: `Unbekannter Provider "${providerId}".` };
  }
  if (!provider.canUninstallManager || typeof provider.uninstallManager !== 'function') {
    return {
      success: false,
      providerId: provider.id,
      error: `${provider.name} unterstützt keine automatische Deinstallation.`,
    };
  }

  const job = startJob({
    type: 'provider-uninstall',
    title: `Paketmanager deinstallieren: ${provider.name}`,
    dedupeKey: `provider-manager:${provider.id}`,
    cancelable: true,
  });
  if (!job) {
    return {
      success: false,
      providerId: provider.id,
      alreadyRunning: true,
      error: `Für ${provider.name} läuft bereits eine Installation oder Deinstallation.`,
    };
  }

  try {
    job.update(10, `Starte Deinstallation von ${provider.name}...`);
    const res = await provider.uninstallManager({
      signal: job.signal,
      onProgress: (pct, detail) => job.update(pct, detail),
    });

    if (job.signal.aborted || res?.canceled) {
      const availability = await verifyAvailability(provider.id);
      job.finish('canceled', `${provider.name}-Deinstallation abgebrochen.`, { autoRemoveMs: 3500 });
      return {
        success: false,
        providerId: provider.id,
        canceled: true,
        availability,
      };
    }

    job.update(85, `Prüfe Status von ${provider.name}...`);
    const availability = await verifyAvailability(provider.id);

    if (res?.success) {
      job.finish('done', `${provider.name} deinstalliert.`, { autoRemoveMs: 4000 });
      return {
        success: true,
        providerId: provider.id,
        availability,
        rebootRequired: Boolean(res.rebootRequired),
      };
    }

    const errMsg = res?.error || `${provider.name} konnte nicht deinstalliert werden.`;
    job.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return {
      success: false,
      providerId: provider.id,
      availability,
      error: errMsg,
    };
  } catch (err) {
    const availability = await verifyAvailability(provider.id).catch(() => null);
    const errMsg = err?.message || `Fehler bei der Deinstallation von ${provider.name}.`;
    job.finish('error', errMsg.slice(0, 180), { autoRemoveMs: 6000 });
    return {
      success: false,
      providerId: provider.id,
      availability,
      error: errMsg,
    };
  }
}
