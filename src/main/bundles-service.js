import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dialog } from 'electron';
import {
  buildExportAllBundlesPayload,
  buildExportBundlePayload,
  evaluateBundleStatus,
  matchesSelectedItemId,
  normalizeBundle,
  planBundleExecution,
  resolveImportedBundleId,
  validateImportBundlesPayload,
} from '../shared/bundles-logic.js';
import { buildUnifiedPackages, canDownloadOnline } from '../shared/unified-packages.js';
import { extractVersion, sanitizeFileName } from '../shared/version.js';
import { checkArchiveTargetCollision, findExistingArchiveLink, linkPackageToArchive } from './archive-linker.js';
import { evaluatePackageAccess } from './auth-service.js';
import { loadCatalogWithLiveStatus } from './catalog-service.js';
import { getConfig, getDataFolder } from './config.js';
import { createJob } from './jobs.js';
import { getProvider } from './providers/registry.js';
import { downloadWebUpdate } from './web-updater.js';
import { executeAndVerifyInstaller, scanInstalledSoftware, scanLocalVersions } from './windows-tools.js';

function getBundlesFilePath() {
  return path.join(getDataFolder(), 'bundles.json');
}

function writeBundlesAtomic(bundles) {
  const filePath = getBundlesFilePath();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(bundles, null, 2);
  try {
    fs.writeFileSync(tmpPath, payload, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // Temp-Datei konnte nicht bereinigt werden
    }
  }
}

function readBundlesFromDisk() {
  const filePath = getBundlesFilePath();
  if (!fs.existsSync(filePath)) return [];

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.bundles) ? raw.bundles : [];
    return list.map((b) => normalizeBundle(b)).filter((b) => b.id);
  } catch (e) {
    console.error('Fehler beim Lesen der data/bundles.json:', e);
    return [];
  }
}

export function loadBundles() {
  try {
    const bundles = readBundlesFromDisk();
    return { success: true, bundles };
  } catch (e) {
    return { success: false, bundles: [], error: e.message };
  }
}

export function saveBundle(bundleInput) {
  try {
    const now = Date.now();
    const bundles = readBundlesFromDisk();
    const requestedId = String(bundleInput?.id || '').trim();
    const existingIdx = requestedId ? bundles.findIndex((b) => b.id === requestedId) : -1;

    let saved;
    if (existingIdx !== -1) {
      const existing = bundles[existingIdx];
      saved = normalizeBundle(
        {
          ...existing,
          ...bundleInput,
          id: existing.id,
          createdAt: existing.createdAt,
          updatedAt: now,
        },
        { now }
      );
      bundles[existingIdx] = saved;
    } else {
      const newId = requestedId || crypto.randomUUID();
      saved = normalizeBundle(
        {
          ...bundleInput,
          id: newId,
          createdAt: now,
          updatedAt: now,
        },
        { now, fallbackId: newId }
      );
      bundles.push(saved);
    }

    writeBundlesAtomic(bundles);
    return { success: true, bundle: saved, bundles };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function deleteBundle(bundleId) {
  try {
    const cleanId = String(bundleId || '').trim();
    if (!cleanId) return { success: false, error: 'Keine Bündel-ID angegeben.' };

    const bundles = readBundlesFromDisk();
    const next = bundles.filter((b) => b.id !== cleanId);
    if (next.length === bundles.length) {
      return { success: false, error: 'Bündel nicht gefunden.' };
    }

    writeBundlesAtomic(next);
    return { success: true, bundles: next };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function duplicateBundle(bundleId) {
  try {
    const cleanId = String(bundleId || '').trim();
    const bundles = readBundlesFromDisk();
    const srcIdx = bundles.findIndex((b) => b.id === cleanId);
    if (srcIdx === -1) {
      return { success: false, error: 'Bündel nicht gefunden.' };
    }

    const src = bundles[srcIdx];
    const now = Date.now();
    const newId = crypto.randomUUID();
    const copy = normalizeBundle(
      {
        ...src,
        id: newId,
        name: `${src.name} (Kopie)`,
        createdAt: now,
        updatedAt: now,
      },
      { now, fallbackId: newId }
    );

    bundles.splice(srcIdx + 1, 0, copy);
    writeBundlesAtomic(bundles);
    return { success: true, bundle: copy, bundles };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function exportBundle(bundleId) {
  try {
    const cleanId = String(bundleId || '').trim();
    const bundles = readBundlesFromDisk();
    const bundle = bundles.find((b) => b.id === cleanId);
    if (!bundle) {
      return { success: false, error: 'Bündel nicht gefunden.' };
    }

    const defaultName = `${sanitizeFileName(bundle.name)}_Bundle.json`;
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Bündel als JSON exportieren',
      defaultPath: defaultName,
      filters: [{ name: 'Software-Katalog Bündel (JSON)', extensions: ['json'] }],
    });
    if (canceled || !filePath) {
      return { success: false, canceled: true };
    }

    const payload = buildExportBundlePayload(bundle);
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function exportAllBundles() {
  try {
    const bundles = readBundlesFromDisk();
    if (bundles.length === 0) {
      return { success: false, error: 'Es sind keine Bündel zum Exportieren vorhanden.' };
    }

    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Alle Bündel als JSON exportieren',
      defaultPath: 'SoftwareKatalog_Alle_Buendel.json',
      filters: [{ name: 'Software-Katalog Bündel (JSON)', extensions: ['json'] }],
    });
    if (canceled || !filePath) {
      return { success: false, canceled: true };
    }

    const payload = buildExportAllBundlesPayload(bundles);
    await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    return { success: true, filePath, count: bundles.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function importBundle() {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: 'Bündel aus JSON importieren',
      properties: ['openFile'],
      filters: [{ name: 'Software-Katalog Bündel (JSON)', extensions: ['json'] }],
    });
    if (canceled || filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    const rawText = await fs.promises.readFile(filePaths[0], 'utf-8');
    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return { success: false, error: 'Ungültige JSON-Datei.' };
    }

    const validation = validateImportBundlesPayload(parsed);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const now = Date.now();
    const bundles = readBundlesFromDisk();
    const existingIds = new Set(bundles.map((b) => b.id));
    const imported = [];

    for (const candidate of validation.bundles) {
      const resolvedId = resolveImportedBundleId(candidate.id, existingIds, () => crypto.randomUUID());
      existingIds.add(resolvedId);
      const normalized = normalizeBundle(
        {
          ...candidate,
          id: resolvedId,
          createdAt: now,
          updatedAt: now,
        },
        { now, fallbackId: resolvedId }
      );
      bundles.push(normalized);
      imported.push(normalized);
    }

    writeBundlesAtomic(bundles);
    return {
      success: true,
      bundle: imported[0],
      importedBundles: imported,
      importedCount: imported.length,
      bundles,
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function saveBundleWingetPackageToArchive(entry, saveSpec, signal) {
  const cfg = getConfig();
  const mode = saveSpec?.saveMode || cfg.archiveSaveMode || 'none';
  if (mode === 'none') return { skipped: true };

  let targetDir = saveSpec?.targetDir || '';
  let collisionMode = saveSpec?.collisionMode || 'create';

  if (mode === 'auto-id' && !targetDir) {
    const check = await linkPackageToArchive({
      packageManager: 'winget',
      packageId: entry.packageId,
      softwareName: entry.name,
      saveMode: 'auto-id',
      collisionMode: 'create',
      downloadSetup: false,
    });

    if (check?.collision && check.targetDir) {
      const col = checkArchiveTargetCollision(check.targetDir);
      targetDir = check.targetDir;
      collisionMode = col.hasMetadata ? 'link' : 'create';
    } else if (check?.success && check.item) {
      return downloadWebUpdate(check.item, { useJob: false, signal });
    } else {
      return check;
    }
  }

  if (!targetDir && mode !== 'auto-id') {
    return { skipped: true };
  }

  return linkPackageToArchive({
    packageManager: 'winget',
    packageId: entry.packageId,
    softwareName: entry.name,
    targetDir,
    saveMode: targetDir ? 'ask' : mode,
    collisionMode,
    downloadSetup: true,
    downloadUseJob: false,
    signal,
  });
}

/**
 * Führt die Installation / Aktualisierung eines Paketbündels über den Job-Manager aus:
 * 1. Live-Abgleich gegen aktuellen PC-Status
 * 2. Stille Pakete zuerst in definierter Reihenfolge
 * 3. Interaktive & Adware-geschützte Pakete sauber am Ende mit Hinweis
 */
export async function runBundleInstall(bundleId, selectedItemIds = null, options = {}) {
  const cleanId = String(bundleId || '').trim();
  const bundles = readBundlesFromDisk();
  const bundle = bundles.find((b) => b.id === cleanId);
  if (!bundle) {
    return { success: false, error: 'Bündel nicht gefunden.' };
  }

  const job = createJob({
    type: 'bundle-install',
    title: `Bündel: ${bundle.name}`,
    dedupeKey: 'bundle-install',
    cancelable: true,
  });
  if (!job) {
    return { success: false, alreadyRunning: true, error: 'Eine Bündel-Installation läuft bereits.' };
  }

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const results = [];

  try {
    job.update(5, 'Prüfe aktuellen PC-Status...');
    const cfg = getConfig();
    const depth = cfg.versionCompareDepth ?? 3;
    const catalogItems = loadCatalogWithLiveStatus();

    let installedApps = Array.isArray(options.installedApps) ? options.installedApps : null;
    if (!installedApps) {
      const scanRes = await scanInstalledSoftware({ silent: true });
      if (job.signal.aborted) {
        return { success: false, canceled: true, completed, failed, skipped, results };
      }
      installedApps = Array.isArray(scanRes?.programs) ? scanRes.programs : [];
    }

    const packages = buildUnifiedPackages({ catalogItems, installedApps });
    const evaluation = evaluateBundleStatus(bundle, { packages, versionCompareDepth: depth });

    const hasExplicitSelection = Array.isArray(selectedItemIds);
    const selectedSet = hasExplicitSelection ? new Set(selectedItemIds) : null;

    const selectedEntries = [];
    for (const entry of evaluation.items) {
      const isSelected = hasExplicitSelection ? matchesSelectedItemId(entry, selectedSet) : entry.defaultSelected;
      if (!isSelected) {
        skipped++;
        results.push({
          key: entry.key,
          name: entry.name,
          source: entry.source,
          status: 'skipped',
          reason: entry.status === 'up-to-date' ? 'Bereits aktuell' : 'Abgewählt',
        });
        continue;
      }
      selectedEntries.push(entry);
    }

    const allowedEntries = [];
    for (const entry of selectedEntries) {
      const matched = entry.matchedPackage || {};
      const policyPkg = {
        id: matched.id || entry.refId || entry.packageId || entry.key,
        archiveItemId: matched.archiveItemId || (entry.source === 'archive' ? entry.refId : null),
        inArchive: Boolean(entry.source === 'archive' || matched.inArchive),
        source: entry.source,
        packageManager: matched.packageManager || (entry.source === 'archive' ? 'archive' : entry.source),
        packageId: entry.packageId || matched.packageId || matched.wingetId || '',
        wingetId: matched.wingetId || '',
        name: entry.name || matched.name || '',
        installMode: entry.installMode || matched.installMode || 'interactive',
        adwareProtected: Boolean(entry.adwareProtected),
      };
      const decision = evaluatePackageAccess(policyPkg, entry.action === 'update' ? 'update' : 'install');
      if (!decision.allowed) {
        failed++;
        results.push({
          key: entry.key,
          name: entry.name,
          source: entry.source,
          status: 'error',
          policyBlocked: true,
          adwareConflict: decision.adwareConflict,
          error: decision.error,
        });
        continue;
      }
      allowedEntries.push({
        ...entry,
        policySilentOnly: decision.silentOnly,
      });
    }

    const plan = planBundleExecution(allowedEntries, {
      allowSilent: options.allowSilent !== false,
      silentWinget: Boolean(options.silentWinget),
    });

    if (plan.orderedQueue.length === 0) {
      if (failed > 0) {
        const firstErr = results.find((r) => r.policyBlocked)?.error || 'Durch Zugriffsrichtlinie blockiert.';
        job.finish('error', firstErr, { autoRemoveMs: 5500 });
        return {
          success: false,
          policyBlocked: true,
          completed: 0,
          failed,
          skipped,
          canceled: false,
          error: firstErr,
          phaseSummary: plan.stats,
          results,
        };
      }
      job.finish('done', 'Alle ausgewählten Pakete sind bereits aktuell oder übersprungen.', { autoRemoveMs: 4000 });
      return {
        success: true,
        completed: 0,
        failed: 0,
        skipped,
        canceled: false,
        phaseSummary: plan.stats,
        results,
      };
    }

    let interactivePhaseAnnounced = false;
    const queue = plan.orderedQueue;

    for (let i = 0; i < queue.length; i++) {
      if (job.signal.aborted) break;

      const entry = queue[i];
      const basePct = 10 + (i / queue.length) * 85;
      const stepSpan = 85 / queue.length;

      if (entry.executionPhase === 'interactive' && !interactivePhaseAnnounced) {
        interactivePhaseAnnounced = true;
        const protectedPart =
          plan.stats.adwareProtectedCount > 0 ? `, davon ${plan.stats.adwareProtectedCount} mit 🛡️ Adware-Schutz` : '';
        job.update(
          basePct,
          `🖱️ Interaktive Phase (${plan.stats.interactiveCount} Paket(e)${protectedPart}) - bitte Setups abschließen...`
        );
      }

      const modeTag = entry.adwareProtected ? '🛡️ Adware-Schutz' : entry.willRunSilent ? '⚡ Still' : '🖱️ Interaktiv';
      const prefix = `[${i + 1}/${queue.length}] ${entry.name} (${modeTag})`;
      job.update(basePct, `${prefix}: Wird vorbereitet...`);

      if (entry.source === 'archive') {
        let catItem = loadCatalogWithLiveStatus().find((c) => c.id === entry.refId);
        if (!catItem) {
          failed++;
          results.push({
            key: entry.key,
            name: entry.name,
            source: entry.source,
            status: 'error',
            error: 'Archiv-Eintrag nicht gefunden.',
          });
          continue;
        }

        let setupFile = catItem.lastFiles?.[0] || '';
        let targetVersion = setupFile ? extractVersion(path.basename(setupFile)) : null;

        const needsDownload = !setupFile || (entry.hasWebUpdate && options.updateFromWeb !== false);
        if (needsDownload && canDownloadOnline({ ...catItem, inArchive: true })) {
          job.update(basePct, `${prefix}: Lade Setup aus Online-Quelle ins Archiv...`);
          const dlRes = await downloadWebUpdate(catItem, {
            useJob: false,
            signal: job.signal,
            onProgress: (pct, detail) => {
              const subPct = pct === null ? 0 : (pct / 100) * (stepSpan * 0.45);
              job.update(basePct + subPct, `${prefix}: ${detail}`);
            },
          });

          if (job.signal.aborted) break;
          if (!dlRes?.success) {
            if (dlRes?.canceled) {
              skipped++;
              results.push({ key: entry.key, name: entry.name, source: entry.source, status: 'canceled' });
              continue;
            }
            if (!setupFile) {
              failed++;
              results.push({
                key: entry.key,
                name: entry.name,
                source: entry.source,
                status: 'error',
                error: dlRes?.error || 'Download fehlgeschlagen',
              });
              continue;
            }
          } else {
            setupFile = dlRes.filePath || setupFile;
            targetVersion = dlRes.version || targetVersion;
            catItem = loadCatalogWithLiveStatus().find((c) => c.id === entry.refId) || catItem;
            if (!setupFile && catItem.lastFiles?.[0]) {
              setupFile = catItem.lastFiles[0];
            }
          }
        }

        if (!setupFile || !fs.existsSync(setupFile)) {
          failed++;
          results.push({
            key: entry.key,
            name: entry.name,
            source: entry.source,
            status: 'error',
            error: 'Keine ausführbare Setup-Datei im Archiv vorhanden.',
          });
          continue;
        }

        job.update(basePct + stepSpan * 0.45, `${prefix}: Starte Setup...`);
        const instRes = await executeAndVerifyInstaller({
          itemId: catItem.id,
          itemName: catItem.name,
          sourcePath: setupFile,
          targetVersion: targetVersion || catItem.webVersion || null,
          useJob: false,
          allowSilent: entry.willRunSilent || Boolean(entry.policySilentOnly),
          silent: entry.policySilentOnly ? true : null,
          action: entry.action === 'update' ? 'update' : 'install',
          onProgress: (_pct, detail) => {
            job.update(basePct + stepSpan * 0.6, `${prefix}: ${detail}`);
          },
        });

        if (instRes?.success) {
          completed++;
          results.push({
            key: entry.key,
            name: entry.name,
            source: entry.source,
            status: 'done',
            executionPhase: entry.executionPhase,
          });
        } else if (instRes?.canceled) {
          skipped++;
          results.push({ key: entry.key, name: entry.name, source: entry.source, status: 'canceled' });
        } else {
          failed++;
          results.push({
            key: entry.key,
            name: entry.name,
            source: entry.source,
            status: 'error',
            error: instRes?.error || 'Setup fehlgeschlagen',
          });
        }
        continue;
      }

      // Paketmanager-Paket (Winget, Scoop, Chocolatey, MS Store)
      const provider = getProvider(entry.source);
      if (!provider?.capabilities?.install || !entry.packageId) {
        failed++;
        results.push({
          key: entry.key,
          name: entry.name,
          source: entry.source,
          status: 'error',
          error: `Paketquelle "${entry.source}" unterstützt keine Bündel-Installation.`,
        });
        continue;
      }

      const existingArchiveLink = findExistingArchiveLink(entry.source, entry.packageId);
      const isUpgradeAction = entry.action === 'update' && typeof provider.upgrade === 'function';
      const forceSilentProvider = entry.willRunSilent || Boolean(entry.policySilentOnly);
      job.update(basePct, `${prefix}: ${isUpgradeAction ? 'Aktualisiere' : 'Installiere'} über ${provider.name}...`);
      const provRes = isUpgradeAction
        ? await provider.upgrade(entry.packageId, {
            silent: forceSilentProvider,
            itemName: entry.name,
            signal: job.signal,
            useJob: false,
          })
        : await provider.install(entry.packageId, {
            silent: forceSilentProvider,
            itemName: entry.name,
            signal: job.signal,
            useJob: false,
          });

      if (job.signal.aborted) break;

      if (!provRes?.success) {
        if (provRes?.canceled) {
          skipped++;
          results.push({ key: entry.key, name: entry.name, source: entry.source, status: 'canceled' });
        } else {
          failed++;
          results.push({
            key: entry.key,
            name: entry.name,
            source: entry.source,
            status: 'error',
            error: provRes?.error || `${provider.name}-Installation fehlgeschlagen`,
          });
        }
        continue;
      }

      if (!existingArchiveLink && provider.capabilities.supportsArchiveDownload) {
        const saveSpec = options.archiveSaveSpecs?.[entry.key] || null;
        const saveMode = saveSpec?.saveMode || getConfig().archiveSaveMode || 'none';
        if (saveMode !== 'none') {
          job.update(basePct + stepSpan * 0.7, `${prefix}: Speichere Setup im Archiv...`);
          await saveBundleWingetPackageToArchive(entry, saveSpec, job.signal);
          if (job.signal.aborted) break;
        }
      }

      completed++;
      results.push({
        key: entry.key,
        name: entry.name,
        source: entry.source,
        status: 'done',
        executionPhase: entry.executionPhase,
      });
    }

    if (job.signal.aborted) {
      return {
        success: false,
        canceled: true,
        completed,
        failed,
        skipped,
        phaseSummary: plan.stats,
        results,
      };
    }

    job.update(97, 'Aktualisiere lokalen PC-Status...');
    try {
      await scanLocalVersions({ silent: true });
    } catch {
      // Lokale Versionsprüfung ist nachgelagert und darf Ergebnis nicht verwerfen
    }

    const parts = [`${completed} installiert/aktualisiert`];
    if (skipped > 0) parts.push(`${skipped} übersprungen`);
    if (failed > 0) parts.push(`${failed} fehlgeschlagen`);
    job.finish(failed > 0 && completed === 0 ? 'error' : 'done', parts.join(' · '), { autoRemoveMs: 5500 });

    return {
      success: true,
      completed,
      failed,
      skipped,
      canceled: false,
      phaseSummary: plan.stats,
      results,
    };
  } catch (e) {
    if (e.name === 'AbortError' || job.signal.aborted) {
      return {
        success: false,
        canceled: true,
        completed,
        failed,
        skipped,
        results,
      };
    }
    job.finish('error', e.message, { autoRemoveMs: 6000 });
    return { success: false, error: e.message };
  }
}
