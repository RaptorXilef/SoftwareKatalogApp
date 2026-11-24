import fs from 'node:fs';
import path from 'node:path';
import {
  buildStage2Entry,
  buildWingetSearchQuery,
  getUnmatchedArchiveItems,
  matchArchiveWithInstalledWinget,
} from '../shared/archive-matcher-logic.js';
import { getI18nLocale } from '../shared/i18n.js';
import { mergeInstalledSoftware } from '../shared/installed-merger.js';
import { loadCatalogWithLiveStatus } from './catalog-service.js';
import { isInsideTargetDir } from './config.js';
import { createJob } from './jobs.js';
import { wingetProvider } from './providers/winget-provider.js';
import { scanSingleFolder } from './scanner-bridge.js';
import { readRegistryUninstallEntries } from './windows-tools.js';

/**
 * @param {number} ms
 * @param {AbortSignal | null} [signal]
 * @returns {Promise<void>}
 */
function delay(ms, signal = null) {
  return new Promise(
    /** @param {(value?: void) => void} resolve */
    (resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }
  );
}

function buildInstalledWingetPool(wingetExports, registryEntries, catalogItems) {
  const merged = mergeInstalledSoftware({
    wingetExports,
    wingetUpgrades: [],
    registryEntries,
    catalogItems,
    includeSystemComponents: false,
  });

  const byId = new Map();
  for (const app of merged) {
    if (app.packageManager === 'winget' && app.packageId) {
      byId.set(app.packageId.toLowerCase(), app);
    }
  }

  for (const exp of wingetExports || []) {
    const pid = String(exp?.packageId || '').trim();
    if (!pid) continue;
    const key = pid.toLowerCase();
    if (!byId.has(key)) {
      byId.set(key, {
        packageManager: 'winget',
        packageId: pid,
        name: pid,
        installedVersion: exp.version || '',
      });
    }
  }

  return [...byId.values()];
}

function sortChecklistEntries(entries) {
  const stageOrder = { installed: 0, search: 1, none: 2 };
  const locale = getI18nLocale() || 'en';
  return [...entries].sort((a, b) => {
    const diff = (stageOrder[a.stage] ?? 9) - (stageOrder[b.stage] ?? 9);
    if (diff !== 0) return diff;
    return String(a.itemName || '').localeCompare(String(b.itemName || ''), locale, { sensitivity: 'base' });
  });
}

/**
 * Startet den zweistufigen Winget-Zuordnungs-Assistenten als abbrechbaren Job:
 * Stufe 1: Sicherer Abgleich über `winget export` (installierte PC-Programme).
 * Stufe 2: Gedrosselte `winget search`-Abfragen für verbleibende Archiv-Ordner.
 */
export async function runWingetMatcherScan({ includeStage2 = true } = {}) {
  const job = createJob({
    type: 'winget-matcher',
    title: 'Winget-IDs zuordnen',
    dedupeKey: 'winget-matcher',
    cancelable: true,
  });
  if (!job) {
    return { success: false, alreadyRunning: true, error: 'Winget-Zuordnung läuft bereits.' };
  }

  try {
    const catalog = loadCatalogWithLiveStatus();
    const unmatched = getUnmatchedArchiveItems(catalog);
    const alreadyLinked = catalog.length - unmatched.length;

    if (unmatched.length === 0) {
      job.finish('done', 'Alle Archiv-Ordner haben bereits eine Paket-ID.');
      return {
        success: true,
        totalArchive: catalog.length,
        alreadyLinked,
        entries: [],
        stats: { stage1: 0, stage2: 0, unmatched: 0 },
      };
    }

    job.update(8, 'Stufe 1: Lese installierte Winget-Pakete (winget export)...');
    const [exportRes, registryEntries] = await Promise.all([
      wingetProvider.listInstalled({ signal: job.signal }),
      readRegistryUninstallEntries(job.signal),
    ]);

    if (job.signal.aborted) {
      return {
        success: true,
        canceled: true,
        partial: true,
        totalArchive: catalog.length,
        alreadyLinked,
        entries: [],
        stats: { stage1: 0, stage2: 0, unmatched: unmatched.length },
      };
    }

    if (!exportRes.success) {
      const avail = await wingetProvider.isAvailable();
      if (!avail.available) {
        const msg = avail.error || 'Winget ist auf diesem PC nicht verfügbar.';
        job.finish('error', msg, { autoRemoveMs: 6000 });
        return { success: false, error: msg };
      }
    }

    const installedWingetApps = buildInstalledWingetPool(
      exportRes.success ? exportRes.packages : [],
      registryEntries,
      catalog
    );
    const { matched, remaining } = matchArchiveWithInstalledWinget(unmatched, installedWingetApps);

    job.update(25, `Stufe 1: ${matched.length} sichere Treffer erkannt. Prüfe übrige Ordner...`);

    const stage2Entries = [];
    if (includeStage2 && remaining.length > 0 && !job.signal.aborted) {
      let processed = 0;
      const concurrency = 2;
      let cursor = 0;

      const worker = async () => {
        while (cursor < remaining.length && !job.signal.aborted) {
          const idx = cursor++;
          const item = remaining[idx];
          const query = buildWingetSearchQuery(item);

          let searchResults = [];
          if (query.length >= 2) {
            const searchRes = await wingetProvider.search(query, { limit: 10, signal: job.signal });
            if (searchRes?.success && Array.isArray(searchRes.results)) {
              searchResults = searchRes.results;
            }
          }

          if (job.signal.aborted) break;

          stage2Entries.push(buildStage2Entry(item, searchResults, { query, locale: getI18nLocale() || 'en' }));
          processed++;
          const pct = 25 + (processed / remaining.length) * 73;
          job.update(pct, `Stufe 2: Suche "${query || item.name}" (${processed}/${remaining.length})...`);

          if (cursor < remaining.length && !job.signal.aborted) {
            await delay(150, job.signal);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(concurrency, remaining.length) }, () => worker()));
    } else if (!includeStage2) {
      const locale = getI18nLocale() || 'en';
      for (const item of remaining) {
        stage2Entries.push(buildStage2Entry(item, [], { query: buildWingetSearchQuery(item), locale }));
      }
    }

    const entries = sortChecklistEntries([...matched, ...stage2Entries]);
    const stage2WithHits = stage2Entries.filter((e) => e.candidates.length > 0).length;
    const withoutHits = entries.filter((e) => e.candidates.length === 0).length;

    if (job.signal.aborted) {
      return {
        success: true,
        canceled: true,
        partial: true,
        totalArchive: catalog.length,
        alreadyLinked,
        entries,
        stats: {
          stage1: matched.length,
          stage2: stage2WithHits,
          unmatched: withoutHits,
        },
      };
    }

    job.finish('done', `${matched.length} sichere Treffer, ${stage2WithHits} Vorschläge gefunden.`);
    return {
      success: true,
      canceled: false,
      partial: false,
      totalArchive: catalog.length,
      alreadyLinked,
      entries,
      stats: {
        stage1: matched.length,
        stage2: stage2WithHits,
        unmatched: withoutHits,
      },
    };
  } catch (e) {
    if (e.name === 'AbortError' || job.signal.aborted) {
      return { success: false, canceled: true };
    }
    job.finish('error', e.message, { autoRemoveMs: 6000 });
    return { success: false, error: e.message };
  }
}

/**
 * Speichert bestätigte Winget-Zuordnungen sauber in die jeweilige `_metadata/meta.json`
 * und aktualisiert `catalog.json` via Einzelordner-Rescan.
 */
export async function applyWingetMatches(assignments = []) {
  const validItems = (Array.isArray(assignments) ? assignments : []).filter(
    (entry) => entry?.itemPath && String(entry?.packageId || '').trim()
  );

  if (validItems.length === 0) {
    return { success: true, savedCount: 0, errors: [] };
  }

  const job = createJob({
    type: 'winget-matcher-apply',
    title: 'Winget-IDs speichern',
    dedupeKey: 'winget-matcher-apply',
    cancelable: false,
  });

  let savedCount = 0;
  const errors = [];

  try {
    for (let i = 0; i < validItems.length; i++) {
      const entry = validItems[i];
      const resolvedPath = path.resolve(entry.itemPath);
      const cleanPm = String(entry.packageManager || 'winget')
        .trim()
        .toLowerCase();
      const cleanPid = String(entry.packageId || '').trim();

      job?.update((i / validItems.length) * 100, `Speichere ${entry.itemName || path.basename(resolvedPath)}...`);

      if (!isInsideTargetDir(resolvedPath)) {
        errors.push(`${entry.itemName || resolvedPath}: Pfad liegt außerhalb des Archivs.`);
        continue;
      }

      try {
        const metaDir = path.join(resolvedPath, '_metadata');
        const metaFile = path.join(metaDir, 'meta.json');
        if (!fs.existsSync(metaDir)) {
          fs.mkdirSync(metaDir, { recursive: true });
        }

        let meta = { name: entry.itemName || path.basename(resolvedPath) };
        if (fs.existsSync(metaFile)) {
          try {
            meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
          } catch {
            meta = { name: entry.itemName || path.basename(resolvedPath) };
          }
        }

        meta.packageManager = cleanPm;
        meta.packageId = cleanPid;
        if (cleanPm === 'winget') {
          meta.wingetId = cleanPid;
          if (!meta.webSourceType || meta.webSourceType === 'none') {
            meta.webSourceType = 'winget';
          }
        }

        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2), 'utf-8');
        const scanRes = await scanSingleFolder(resolvedPath);
        if (!scanRes.success) {
          errors.push(`${entry.itemName || path.basename(resolvedPath)}: ${scanRes.error || 'Rescan fehlgeschlagen'}`);
        } else {
          savedCount++;
        }
      } catch (err) {
        errors.push(`${entry.itemName || path.basename(resolvedPath)}: ${err.message}`);
      }
    }

    job?.finish(
      errors.length > 0 && savedCount === 0 ? 'error' : 'done',
      `${savedCount} Winget-ID(s) gespeichert${errors.length > 0 ? ` (${errors.length} Fehler)` : ''}.`
    );
    return { success: savedCount > 0 || errors.length === 0, savedCount, errors };
  } catch (e) {
    job?.finish('error', e.message, { autoRemoveMs: 6000 });
    return { success: false, savedCount, errors: [e.message] };
  }
}
