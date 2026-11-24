import { canDownloadOnline, getPackageStatus } from '../shared/unified-packages.js';
import { extractVersion } from '../shared/version.js';
import { checkArchiveTargetCollision, linkPackageToArchive } from './archive-linker.js';
import { loadCatalogWithLiveStatus } from './catalog-service.js';
import { getConfig } from './config.js';
import { isAdminSessionActive, isProcessElevated, startAdminSession } from './elevated-helper.js';
import { createJob } from './jobs.js';
import { getProvider } from './providers/registry.js';
import { downloadWebUpdate } from './web-updater.js';
import { executeAndVerifyInstaller } from './windows-tools.js';

/**
 * Lädt alle ausstehenden Online-Updates für Archiv-Programme nacheinander
 * über einen abbrechbaren Job ins Archiv.
 */
export async function batchDownloadArchiveUpdates(itemIds = null) {
  const job = createJob({
    type: 'batch-download',
    title: 'Online-Updates ins Archiv laden',
    dedupeKey: 'batch-download',
    cancelable: true,
  });
  if (!job) {
    return { success: false, alreadyRunning: true, error: 'Ein Massen-Download läuft bereits.' };
  }

  try {
    const cfg = getConfig();
    const depth = cfg.versionCompareDepth ?? 3;
    const catalog = loadCatalogWithLiveStatus();
    const byId = new Map(catalog.map((i) => [i.id, i]));

    let queue;
    if (Array.isArray(itemIds) && itemIds.length > 0) {
      queue = itemIds.map((id) => byId.get(id)).filter(Boolean);
    } else {
      queue = catalog.filter((item) => {
        const st = getPackageStatus({ ...item, inArchive: true }, { versionCompareDepth: depth });
        return st.hasWebUpdate && canDownloadOnline({ ...item, inArchive: true });
      });
    }

    queue = queue.filter((item) => canDownloadOnline({ ...item, inArchive: true }));

    if (queue.length === 0) {
      job.finish('done', 'Keine herunterladbaren Archiv-Updates vorhanden.');
      return { success: true, completed: 0, failed: 0, skipped: 0, canceled: false, results: [] };
    }

    let completed = 0;
    let failed = 0;
    let skipped = 0;
    const results = [];

    for (let i = 0; i < queue.length; i++) {
      if (job.signal.aborted) break;

      const item = queue[i];
      const basePct = (i / queue.length) * 100;
      job.update(basePct, `[${i + 1}/${queue.length}] Lade ${item.name}...`);

      const dlRes = await downloadWebUpdate(item, {
        saveIntoLastFolder: false,
        useJob: false,
        signal: job.signal,
        onProgress: (pct, detail) => {
          const itemPct = pct === null ? 0 : (pct / 100) * (100 / queue.length);
          job.update(basePct + itemPct, `[${i + 1}/${queue.length}] ${detail}`);
        },
      });

      if (job.signal.aborted || dlRes?.canceled) {
        results.push({ id: item.id, name: item.name, status: 'canceled' });
        if (job.signal.aborted) break;
        skipped++;
        continue;
      }

      if (dlRes?.success) {
        completed++;
        results.push({ id: item.id, name: item.name, status: 'done', filePath: dlRes.filePath });
      } else {
        failed++;
        results.push({
          id: item.id,
          name: item.name,
          status: 'error',
          error: dlRes?.error || 'Download fehlgeschlagen',
        });
      }
    }

    if (job.signal.aborted) {
      return { success: false, canceled: true, completed, failed, skipped, results };
    }

    const summary =
      failed > 0
        ? `${completed} geladen, ${failed} fehlgeschlagen`
        : `${completed} Online-Update(s) ins Archiv geladen.`;
    job.finish(failed > 0 && completed === 0 ? 'error' : 'done', summary, { autoRemoveMs: 4500 });
    return { success: true, completed, failed, skipped, canceled: false, results };
  } catch (e) {
    if (e.name === 'AbortError' || job.signal.aborted) {
      return { success: false, canceled: true, completed: 0, failed: 0, skipped: 0, results: [] };
    }
    job.finish('error', e.message, { autoRemoveMs: 6000 });
    return { success: false, error: e.message };
  }
}

async function saveUpdatedPackageToArchive(task, saveSpec, signal) {
  const cfg = getConfig();
  const mode = saveSpec?.saveMode || cfg.archiveSaveMode || 'none';
  if (mode === 'none') return { skipped: true };

  const pkgPm = String(task.packageManager || 'winget')
    .trim()
    .toLowerCase();
  const provider = getProvider(pkgPm);
  const canDownloadSetup = Boolean(provider?.capabilities?.supportsArchiveDownload);

  let targetDir = saveSpec?.targetDir || '';
  let collisionMode = saveSpec?.collisionMode || 'create';

  if (mode === 'auto-id' && !targetDir) {
    const check = await linkPackageToArchive({
      packageManager: pkgPm,
      packageId: task.packageId,
      softwareName: task.name,
      saveMode: 'auto-id',
      collisionMode: 'create',
      downloadSetup: false,
      metadata: task,
    });

    if (check?.collision && check.targetDir) {
      const col = checkArchiveTargetCollision(check.targetDir);
      targetDir = check.targetDir;
      collisionMode = col.hasMetadata ? 'link' : 'create';
    } else if (check?.success && check.item) {
      return canDownloadSetup ? downloadWebUpdate(check.item, { useJob: false, signal }) : check;
    } else {
      return check;
    }
  }

  if (!targetDir && mode !== 'auto-id') {
    return { skipped: true };
  }

  return linkPackageToArchive({
    packageManager: pkgPm,
    packageId: task.packageId,
    softwareName: task.name,
    targetDir,
    saveMode: targetDir ? 'ask' : mode,
    collisionMode,
    downloadSetup: canDownloadSetup,
    downloadUseJob: false,
    signal,
    metadata: task,
  });
}

/**
 * Aktualisiert ausgewählte Pakete aus dem Updates-Tab der Reihe nach über eine abbrechbare Job-Queue.
 * Respektiert für Nicht-Archiv-Programme den konfigurierten / gewählten Archiv-Speichermodus.
 */
export async function batchUpdatePackages(tasks = [], { allowSilent = true, skipAutoAdminPrompt = false } = {}) {
  const validTasks = Array.isArray(tasks) ? tasks.filter((t) => t?.id) : [];
  if (validTasks.length === 0) {
    return { success: true, completed: 0, failed: 0, skipped: 0, canceled: false, results: [] };
  }

  if (
    !skipAutoAdminPrompt &&
    process.platform === 'win32' &&
    validTasks.length >= 2 &&
    getConfig().autoRequestAdminForBatch === true &&
    !(await isProcessElevated()) &&
    !isAdminSessionActive()
  ) {
    await startAdminSession().catch(() => null);
  }

  const job = createJob({
    type: 'batch-update',
    title: 'Ausgewählte Pakete aktualisieren',
    dedupeKey: 'batch-update',
    cancelable: true,
  });
  if (!job) {
    return { success: false, alreadyRunning: true, error: 'Eine Massenaktualisierung läuft bereits.' };
  }

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const results = [];

  try {
    for (let i = 0; i < validTasks.length; i++) {
      if (job.signal.aborted) break;

      const task = validTasks[i];
      const basePct = (i / validTasks.length) * 100;
      const prefix = `[${i + 1}/${validTasks.length}] ${task.name}`;

      if (task.inArchive) {
        let catItem = loadCatalogWithLiveStatus().find((c) => c.id === task.id);
        if (!catItem) {
          failed++;
          results.push({ id: task.id, name: task.name, status: 'error', error: 'Archiv-Eintrag nicht gefunden.' });
          continue;
        }

        let setupFile = catItem.lastFiles?.[0] || '';
        let targetVersion = setupFile ? extractVersion(setupFile) : null;

        if (task.hasWebUpdate && canDownloadOnline({ ...catItem, inArchive: true })) {
          job.update(basePct, `${prefix}: Lade Online-Update ins Archiv...`);
          const dlRes = await downloadWebUpdate(catItem, {
            useJob: false,
            signal: job.signal,
            onProgress: (_pct, detail) => job.update(basePct, `${prefix}: ${detail}`),
          });

          if (job.signal.aborted) break;
          if (!dlRes?.success) {
            if (dlRes?.canceled) {
              skipped++;
              results.push({ id: task.id, name: task.name, status: 'canceled' });
            } else {
              failed++;
              results.push({
                id: task.id,
                name: task.name,
                status: 'error',
                error: dlRes?.error || 'Download fehlgeschlagen',
              });
            }
            continue;
          }

          setupFile = dlRes.filePath || setupFile;
          targetVersion = dlRes.version || targetVersion;
          catItem = loadCatalogWithLiveStatus().find((c) => c.id === task.id) || catItem;
          if (!setupFile && catItem.lastFiles?.[0]) {
            setupFile = catItem.lastFiles[0];
          }
        }

        if (task.isInstalled || catItem.isInstalled) {
          let instRes = null;
          if (!setupFile) {
            const archivePm = String(catItem.packageManager || '')
              .trim()
              .toLowerCase();
            const archivePkgId = String(catItem.packageId || catItem.wingetId || '').trim();
            const archiveProv = archivePm ? getProvider(archivePm) : null;
            if (archiveProv?.capabilities?.install && archivePkgId) {
              job.update(basePct + 50 / validTasks.length, `${prefix}: Aktualisiere via ${archiveProv.name}...`);
              instRes =
                typeof archiveProv.upgrade === 'function'
                  ? await archiveProv.upgrade(archivePkgId, {
                      silent: false,
                      targetVersion: task.toVersion || catItem.webVersion || '',
                      itemName: catItem.name,
                      signal: job.signal,
                      useJob: false,
                    })
                  : await archiveProv.install(archivePkgId, {
                      upgrade: true,
                      silent: false,
                      targetVersion: task.toVersion || catItem.webVersion || '',
                      itemName: catItem.name,
                      signal: job.signal,
                      useJob: false,
                    });
            } else {
              failed++;
              results.push({ id: task.id, name: task.name, status: 'error', error: 'Keine Setup-Datei im Archiv.' });
              continue;
            }
          } else {
            job.update(basePct + 50 / validTasks.length, `${prefix}: Starte Installation...`);
            instRes = await executeAndVerifyInstaller({
              itemId: catItem.id,
              itemName: catItem.name,
              sourcePath: setupFile,
              targetVersion: targetVersion || catItem.webVersion || null,
              useJob: false,
              allowSilent: Boolean(allowSilent),
              onProgress: (_pct, detail) => job.update(basePct + 50 / validTasks.length, `${prefix}: ${detail}`),
            });
          }

          if (instRes?.success) {
            completed++;
            results.push({ id: task.id, name: task.name, status: 'done' });
          } else if (instRes?.canceled) {
            skipped++;
            results.push({ id: task.id, name: task.name, status: 'canceled' });
          } else {
            failed++;
            results.push({
              id: task.id,
              name: task.name,
              status: 'error',
              error: instRes?.error || 'Setup fehlgeschlagen',
            });
          }
        } else {
          // Nicht auf PC installiert, aber Web-Update erfolgreich ins Archiv geladen
          completed++;
          results.push({ id: task.id, name: task.name, status: 'done' });
        }
        continue;
      }

      // Nicht-Archiv-Programm -> Provider Update (Silent bleibt strikt opt-in, Standard interaktiv)
      const taskPm = String(task.packageManager || '')
        .trim()
        .toLowerCase();
      const provider = taskPm ? getProvider(taskPm) : null;
      if (provider?.capabilities?.install && task.packageId) {
        job.update(basePct, `${prefix}: Aktualisiere via ${provider.name}...`);
        const provRes =
          typeof provider.upgrade === 'function'
            ? await provider.upgrade(task.packageId, {
                silent: false,
                targetVersion: task.toVersion || '',
                itemName: task.name,
                signal: job.signal,
                useJob: false,
              })
            : await provider.install(task.packageId, {
                upgrade: true,
                silent: false,
                targetVersion: task.toVersion || '',
                itemName: task.name,
                signal: job.signal,
                useJob: false,
              });

        if (job.signal.aborted) break;

        if (!provRes?.success) {
          if (provRes?.canceled) {
            skipped++;
            results.push({ id: task.id, name: task.name, status: 'canceled' });
          } else {
            failed++;
            results.push({
              id: task.id,
              name: task.name,
              status: 'error',
              error: provRes?.error || `${provider.name} fehlgeschlagen`,
            });
          }
          continue;
        }

        if (provider.capabilities.supportsArchiveDownload) {
          const saveMode = task.archiveSaveSpec?.saveMode || getConfig().archiveSaveMode || 'none';
          if (saveMode !== 'none') {
            job.update(basePct + 60 / validTasks.length, `${prefix}: Speichere Setup im Archiv...`);
            await saveUpdatedPackageToArchive(task, task.archiveSaveSpec, job.signal);
            if (job.signal.aborted) break;
          }
        }

        completed++;
        results.push({ id: task.id, name: task.name, status: 'done' });
      } else {
        skipped++;
        results.push({ id: task.id, name: task.name, status: 'skipped', error: 'Keine unterstützte Update-Quelle' });
      }
    }

    if (job.signal.aborted) {
      return { success: false, canceled: true, completed, failed, skipped, results };
    }

    const parts = [`${completed} aktualisiert`];
    if (skipped > 0) parts.push(`${skipped} übersprungen`);
    if (failed > 0) parts.push(`${failed} fehlgeschlagen`);
    job.finish(failed > 0 && completed === 0 ? 'error' : 'done', parts.join(' · '), { autoRemoveMs: 5000 });
    return { success: true, completed, failed, skipped, canceled: false, results };
  } catch (e) {
    if (e.name === 'AbortError' || job.signal.aborted) {
      return { success: false, canceled: true, completed, failed, skipped, results };
    }
    job.finish('error', e.message, { autoRemoveMs: 6000 });
    return { success: false, error: e.message };
  }
}
