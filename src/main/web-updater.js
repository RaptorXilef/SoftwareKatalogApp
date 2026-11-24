import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog, session } from 'electron';
import { resolveBestArchivePath } from '../shared/multi-archive-logic.js';
import { buildArchiveFilename, extractVersion } from '../shared/version.js';
import { persistWebVersion, writeCatalogAtomic } from './catalog-service.js';
import { getConfig } from './config.js';
import { createJob } from './jobs.js';
import { getProvider } from './providers/registry.js';
import { wingetProvider } from './providers/winget-provider.js';
import { scanSingleFolder } from './scanner-bridge.js';
import { getFileVersion } from './windows-tools.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const DIRECT_EXTS = new Set(['exe', 'msi', 'msix', 'zip', '7z', 'rar', 'tar', 'gz']);

// ==========================================
// HTML PRÄFIX/SUFFIX EXTRAKTION
// ==========================================
function extractBetween(html, prefix, suffix) {
  if (!html || !prefix) return null;

  const buildFlexRegex = (str, wildcardNumbers = false) => {
    let escaped = str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (wildcardNumbers) {
      escaped = escaped.replace(/\d+(?:\\.\d+)+|\b\d+\b|(?<=_|-|\/)\d+/g, '\\d+(?:\\.\\d+)*');
    }
    return escaped
      .replace(/["']/g, '["\']')
      .replace(/<br\s*\\?\/?>/gi, '<br\\s*\\/?>')
      .replace(/\s+/g, '\\s+');
  };

  if (suffix) {
    let searchFrom = 0;
    while (searchFrom < html.length) {
      const preIdx = html.indexOf(prefix, searchFrom);
      if (preIdx === -1) break;
      const startIdx = preIdx + prefix.length;
      const sufIdx = html.indexOf(suffix, startIdx);
      if (sufIdx === -1) break;

      const closerPreIdx = html.lastIndexOf(prefix, sufIdx);
      const actualStart = closerPreIdx !== -1 && closerPreIdx >= preIdx ? closerPreIdx + prefix.length : startIdx;

      if (sufIdx - actualStart <= 500) {
        return html.substring(actualStart, sufIdx).trim();
      }
      searchFrom = actualStart;
    }
  } else {
    const preIdx = html.indexOf(prefix);
    if (preIdx !== -1) {
      return html.substring(preIdx + prefix.length, preIdx + prefix.length + 40).trim();
    }
  }

  for (const useWildcard of [false, true]) {
    try {
      const prePat = buildFlexRegex(prefix, useWildcard);
      const sufPat = suffix ? buildFlexRegex(suffix, useWildcard) : '';
      const fullRegex = suffix
        ? new RegExp(`${prePat}([\\s\\S]{1,500}?)${sufPat}`, 'i')
        : new RegExp(`${prePat}([\\s\\S]{1,40})`, 'i');
      const match = html.match(fullRegex);
      if (match?.[1]) return match[1].trim();
    } catch {
      // Ignorieren
    }
  }

  return null;
}

// ==========================================
// WINGET INTEGRATION (über Winget-Provider)
// ==========================================
function getEffectiveWingetId(item) {
  if (!item) return '';
  if (item.packageManager === 'winget' && item.packageId) return item.packageId.trim();
  return String(item.wingetId || '').trim();
}

export async function searchWinget(query, opts = {}) {
  return wingetProvider.search(query, opts);
}

async function fetchWingetInfo(wingetId, signal = null) {
  const res = await wingetProvider.show(wingetId, { preferGerman: true, signal });
  if (!res.success || !res.package) {
    return { success: false, error: res.error || `Winget-Paket "${wingetId}" nicht gefunden.` };
  }
  return {
    success: true,
    version: res.package.version,
    downloadUrl: res.package.downloadUrl,
    sha256: res.package.sha256,
    package: res.package,
    fromCache: res.fromCache,
    isStale: res.isStale,
  };
}

// ==========================================
// GITHUB HELPER
// ==========================================
async function fetchGitHubRelease(url, assetPattern = '', signal = null) {
  const repoMatch = url.match(/github\.com\/([^/]+\/[^/?#]+)/i);
  if (!repoMatch) return { success: false, error: 'Ungültige GitHub-Repository-URL.' };

  const repo = repoMatch[1].replace(/\.git$/i, '');
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { 'User-Agent': 'SoftwareKatalogApp' },
    signal,
  });

  if (!res.ok) return { success: false, error: `GitHub API Fehler (${res.status})` };

  const data = await res.json();
  const version = extractVersion(data.tag_name || data.name || '');
  if (!version) return { success: false, error: 'Keine Versionsnummer im GitHub-Release gefunden.' };

  // Direktes Asset suchen, falls Pattern angegeben oder eindeutige Windows-Setup-Datei vorhanden
  let directUrl = '';
  const assets = Array.isArray(data.assets) ? data.assets : [];

  if (assetPattern) {
    const patternLower = assetPattern.toLowerCase();
    const matched = assets.find((a) => a.name.toLowerCase().includes(patternLower));
    if (matched) directUrl = matched.browser_download_url;
  } else {
    const winSetup = assets.find((a) => /\.(exe|msi)$/i.test(a.name) && !/arm64/i.test(a.name));
    if (winSetup) directUrl = winSetup.browser_download_url;
  }

  return {
    success: true,
    version,
    downloadUrl: directUrl || data.html_url || '',
    isDirectAsset: Boolean(directUrl),
  };
}

// ==========================================
// EINZELNE & GLOBALE ONLINE-PRÜFUNG
// ==========================================
export async function checkSingleWebSource(
  {
    itemId = null,
    sourceType = '',
    packageManager = '',
    packageId = '',
    wingetId = '',
    githubAssetPattern = '',
    url = '',
    prefix = '',
    suffix = '',
    persist = false,
  },
  signal = null
) {
  try {
    const resolvedPm = String(packageManager || '')
      .trim()
      .toLowerCase();
    const resolvedPkgId = String(packageId || '').trim();
    const resolvedWingetId = getEffectiveWingetId({ packageManager, packageId, wingetId });
    const hasProviderSource = Boolean(
      !sourceType &&
        resolvedPm &&
        resolvedPm !== 'winget' &&
        resolvedPm !== 'archive' &&
        resolvedPkgId &&
        getProvider(resolvedPm)?.capabilities?.show
    );
    const effectiveType =
      sourceType ||
      (resolvedWingetId
        ? 'winget'
        : hasProviderSource
          ? 'provider'
          : url?.toLowerCase().includes('github.com')
            ? 'github'
            : url
              ? 'web'
              : 'none');

    /** @type {any} */
    let result = { success: false, error: 'Keine Online-Quelle konfiguriert.' };

    if (effectiveType === 'winget') {
      if (!resolvedWingetId) return { success: false, error: 'Keine Winget-ID angegeben.' };
      result = await fetchWingetInfo(resolvedWingetId, signal);
    } else if (effectiveType === 'provider') {
      const prov = getProvider(resolvedPm);
      if (!prov?.capabilities?.show || !resolvedPkgId) {
        return { success: false, error: 'Provider unterstützt keine Online-Versionsprüfung.' };
      }
      const res = await prov.show(resolvedPkgId, { forceRefresh: true, signal });
      result =
        res.success && res.package?.version
          ? { success: true, version: res.package.version, package: res.package }
          : { success: false, error: res.error || `Paket "${resolvedPkgId}" nicht gefunden.` };
    } else if (effectiveType === 'github') {
      if (!url) return { success: false, error: 'Keine GitHub-URL angegeben.' };
      result = await fetchGitHubRelease(url, githubAssetPattern, signal);
    } else if (effectiveType === 'web') {
      if (!url) return { success: false, error: 'Keine Prüf-URL angegeben.' };
      if (!prefix)
        return { success: false, error: 'Bitte nutze "Version auf Seite markieren" oder gib ein Präfix an.' };

      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal });
      if (!res.ok) return { success: false, error: `HTTP Fehler ${res.status}` };
      const html = await res.text();
      const raw = extractBetween(html, prefix, suffix);
      const version = extractVersion(raw || '');
      result = version
        ? { success: true, version }
        : { success: false, error: 'Keine Versionsnummer an dieser Stelle gefunden.' };
    }

    if (result.success && persist && itemId) {
      persistWebVersion(itemId, result.version);
    }
    return result;
  } catch (e) {
    if (e.name === 'AbortError') return { success: false, canceled: true };
    return { success: false, error: e.message };
  }
}

export async function checkAllWebVersions() {
  const { absJsonPath, appFolder } = getConfig();
  if (!fs.existsSync(absJsonPath)) return { success: false, error: 'Katalog nicht gefunden.' };

  const job = createJob({
    type: 'web-versions',
    title: 'Online-Updates prüfen',
    dedupeKey: 'web-versions',
    cancelable: true,
  });
  if (!job) return { success: false, alreadyRunning: true };

  try {
    const catData = JSON.parse(fs.readFileSync(absJsonPath, 'utf-8'));
    const itemsToCheck = catData.filter((i) => {
      if ((i.webSourceType && i.webSourceType !== 'none') || getEffectiveWingetId(i) || i.webVersionUrl) {
        return true;
      }
      const pm = String(i.packageManager || '')
        .trim()
        .toLowerCase();
      return Boolean(pm && pm !== 'archive' && i.packageId && getProvider(pm)?.capabilities?.show);
    });

    if (itemsToCheck.length === 0) {
      job.finish('done', 'Keine Programme mit Online-Prüfung konfiguriert.');
      return { success: true, count: 0 };
    }

    let checked = 0;
    let updatedCount = 0;
    const wingetItems = [];
    const httpItems = [];

    for (const item of itemsToCheck) {
      const isWinget = item.webSourceType === 'winget' || (!item.webSourceType && Boolean(getEffectiveWingetId(item)));
      if (isWinget) wingetItems.push(item);
      else httpItems.push(item);
    }

    const processItem = async (item) => {
      if (job.signal.aborted) return;
      const res = await checkSingleWebSource(
        {
          sourceType: item.webSourceType,
          packageManager: item.packageManager,
          packageId: item.packageId,
          wingetId: item.wingetId,
          githubAssetPattern: item.githubAssetPattern,
          url: item.webVersionUrl,
          prefix: item.webVersionPrefix,
          suffix: item.webVersionSuffix,
          persist: false,
        },
        job.signal
      );

      checked++;
      job.update((checked / itemsToCheck.length) * 100, `Prüfe ${item.name} (${checked}/${itemsToCheck.length})...`);

      if (res.success && res.version && item.webVersion !== res.version) {
        item.webVersion = res.version;
        updatedCount++;

        const metaPath = path.join(appFolder, item.path, '_metadata', 'meta.json');
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
            meta.webVersion = res.version;
            fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
          } catch (e) {
            console.warn(`meta.json Update fehlgeschlagen für ${item.name}:`, e);
          }
        }
      }
    };

    const runPool = async (list, concurrency) => {
      const executing = new Set();
      for (const item of list) {
        if (job.signal.aborted) break;
        const p = Promise.resolve().then(() => processItem(item));
        executing.add(p);
        p.then(() => executing.delete(p));
        if (executing.size >= concurrency) await Promise.race(executing);
      }
      await Promise.all(executing);
    };

    // HTTP/GitHub schneller (6 parallel), Winget gedrosselt (2 parallel gegen Cache-Locks)
    await Promise.all([runPool(httpItems, 6), runPool(wingetItems, 2)]);

    if (job.signal.aborted) {
      if (updatedCount > 0) writeCatalogAtomic(catData);
      return { success: false, canceled: true };
    }

    if (updatedCount > 0) {
      writeCatalogAtomic(catData);
    }

    job.finish('done', updatedCount > 0 ? `${updatedCount} neue Online-Versionen gefunden.` : 'Alles aktuell.');
    return { success: true, count: updatedCount };
  } catch (e) {
    job.finish('error', e.message, { autoRemoveMs: 5000 });
    return { success: false, error: e.message };
  }
}

// ==========================================
// VISUELLER VERSION-HIGHLIGHTER (ISOLIERTE SESSION)
// ==========================================
export function openVisualScraper(url) {
  return new Promise((resolve) => {
    const partition = `scraper-${Date.now()}`;
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: 'Version auf Webseite markieren',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition },
    });

    let isResolved = false;
    win.loadURL(url);

    win.webContents.on('dom-ready', async () => {
      if (isResolved) return;
      try {
        const code = `
          if (!document.getElementById('sk-overlay-box')) {
            new Promise((resolveJS) => {
              const div = document.createElement('div');
              div.id = 'sk-overlay-box';
              div.style.cssText = 'position:fixed; top:16px; left:50%; transform:translateX(-50%); background:#1e1e2e; color:#cdd6f4; padding:12px 18px; border:2px solid #cba6f7; border-radius:10px; z-index:2147483647; font-family:system-ui,sans-serif; box-shadow:0 10px 30px rgba(0,0,0,0.8); display:flex; align-items:center; gap:14px;';
              div.innerHTML = '<span style="font-size:14px; line-height:1.4;"><b>1.</b> Versionsnummer mit der Maus markieren &nbsp; <b>2.</b> Übernehmen klicken</span><button id="sk-save-btn" style="background:#a6e3a1; color:#1e1e2e; border:none; padding:8px 16px; border-radius:6px; font-weight:bold; cursor:pointer;">Übernehmen</button>';
              document.body.appendChild(div);

              document.getElementById('sk-save-btn').onclick = () => {
                const sel = window.getSelection();
                const text = sel.toString().trim();
                if (!text) return alert('Bitte markiere zuerst eine Versionsnummer (z. B. 4.2.1) mit der Maus.');

                const range = sel.getRangeAt(0);
                const marker = document.createElement('span');
                marker.id = 'sk-temp-marker-42';
                marker.appendChild(range.extractContents());
                range.insertNode(marker);

                const markerOuter = marker.outerHTML;
                const fullHtml = document.body.innerHTML;
                const mIdx = fullHtml.indexOf(markerOuter);

                let prefix = '';
                let suffix = '';
                if (mIdx !== -1) {
                  prefix = fullHtml.substring(Math.max(0, mIdx - 35), mIdx);
                  suffix = fullHtml.substring(mIdx + markerOuter.length, mIdx + markerOuter.length + 25);
                }

                marker.replaceWith(...marker.childNodes);
                div.remove();

                const cleanedVer = text.replace(/,\\s*/g, '.').match(/(\\d+(?:\\.\\d+)+)/);
                resolveJS({ success: true, prefix, suffix, version: cleanedVer ? cleanedVer[1] : text });
              };
            });
          }
        `;
        const result = await win.webContents.executeJavaScript(code);
        if (result?.success && !isResolved) {
          isResolved = true;
          win.close();
          resolve(result);
        }
      } catch {
        // Navigation läuft
      }
    });

    win.on('closed', () => {
      if (!isResolved) {
        isResolved = true;
        resolve({ success: false, canceled: true });
      }
    });
  });
}

// ==========================================
// VISUELLER LINK-PICKER (MIT NAVIGIEREN-MODUS & WILL-DOWNLOAD-ABFANGNETZ)
// ==========================================
export function openVisualLinkPicker(url, knownVersion = '') {
  return new Promise((resolve) => {
    const partition = `picker-${Date.now()}`;
    const pickerSession = session.fromPartition(partition);

    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      title: 'Download-Button auswählen',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, partition },
    });

    let isResolved = false;

    const finish = (payload) => {
      if (isResolved) return;
      isResolved = true;
      if (!win.isDestroyed()) win.close();
      resolve(payload);
    };

    // Abfangnetz: Wenn ein JS-Button trotz Blockade einen Download startet,
    // brechen wir den Download SOFORT ab und übernehmen die echte Ziel-URL!
    const onWillDownload = (_dlEvent, item) => {
      const interceptedUrl = item.getURL();
      item.cancel();

      let suggestedUrl = interceptedUrl;
      let usedTemplate = false;
      if (knownVersion && interceptedUrl.includes(knownVersion)) {
        suggestedUrl = interceptedUrl.split(knownVersion).join('{version}');
        usedTemplate = true;
      }

      finish({
        success: true,
        mode: usedTemplate ? 'template' : 'direct-intercept',
        url: suggestedUrl,
        prefix: '',
        suffix: '',
        interceptedOriginal: interceptedUrl,
      });
    };

    pickerSession.on('will-download', onWillDownload);
    win.loadURL(url);

    win.webContents.on('dom-ready', async () => {
      if (isResolved) return;
      try {
        const code = `
          if (!document.getElementById('sk-link-overlay-box')) {
            new Promise((resolveJS) => {
              let pickMode = true;

              const div = document.createElement('div');
              div.id = 'sk-link-overlay-box';
              div.style.cssText = 'position:fixed; top:16px; left:50%; transform:translateX(-50%); background:#1e1e2e; color:#cdd6f4; padding:12px 18px; border:2px solid #89b4fa; border-radius:10px; z-index:2147483647; font-family:system-ui,sans-serif; box-shadow:0 10px 30px rgba(0,0,0,0.8); display:flex; align-items:center; gap:14px;';
              div.innerHTML = \`
                <span id="sk-picker-hint" style="font-size:14px; font-weight:600;">🎯 Klicke jetzt auf den Download-Button / Link</span>
                <button id="sk-toggle-mode" style="background:#313244; color:#cdd6f4; border:1px solid #585b70; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:13px;">🖱️ Navigieren (z.B. Cookie-Banner)</button>
              \`;
              document.body.appendChild(div);

              const toggleBtn = document.getElementById('sk-toggle-mode');
              const hint = document.getElementById('sk-picker-hint');

              toggleBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                pickMode = !pickMode;
                if (pickMode) {
                  hint.textContent = '🎯 Klicke jetzt auf den Download-Button / Link';
                  toggleBtn.textContent = '🖱️ Navigieren (z.B. Cookie-Banner)';
                  div.style.borderColor = '#89b4fa';
                } else {
                  hint.textContent = '🖱️ Navigations-Modus aktiv (Cookie-Banner wegklicken etc.)';
                  toggleBtn.textContent = '🎯 Wieder Button erfassen';
                  div.style.borderColor = '#f9e2af';
                }
              });

              const blockEarly = (e) => {
                if (!pickMode || e.target.closest('#sk-link-overlay-box')) return;
                const link = e.target.closest('a[href]');
                if (link) {
                  e.preventDefault();
                  e.stopImmediatePropagation();
                }
              };

              document.addEventListener('pointerdown', blockEarly, { capture: true });
              document.addEventListener('mousedown', blockEarly, { capture: true });

              document.addEventListener('click', (e) => {
                if (!pickMode || e.target.closest('#sk-link-overlay-box')) return;
                const link = e.target.closest('a[href]');
                const href = link ? link.getAttribute('href') : null;

                // Normales <a href="..."> -> dynamisches Prefix/Suffix extrahieren
                if (link && href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  e.stopImmediatePropagation();

                  const markerStr = 'SK_TEMP_HREF_MARKER';
                  link.setAttribute('href', markerStr);
                  const fullHtml = document.body.innerHTML;
                  const mIdx = fullHtml.indexOf(markerStr);

                  let prefix = '';
                  let suffix = '';
                  if (mIdx !== -1) {
                    prefix = fullHtml.substring(Math.max(0, mIdx - 40), mIdx);
                    suffix = fullHtml.substring(mIdx + markerStr.length, mIdx + markerStr.length + 20);
                  }

                  link.setAttribute('href', href);
                  div.remove();
                  resolveJS({ success: true, mode: 'html-link', url: window.location.href, prefix, suffix });
                }
                // Wenn es ein <button> ohne href ist, lassen wir das Klick-Event durch ->
                // Electrons will-download Abfangnetz fängt die echte URL sauber ab!
              }, { capture: true });
            });
          }
        `;
        const result = await win.webContents.executeJavaScript(code);
        if (result?.success) {
          finish(result);
        }
      } catch {
        // Navigation läuft
      }
    });

    win.on('closed', () => {
      pickerSession.off('will-download', onWillDownload);
      if (!isResolved) {
        isResolved = true;
        resolve({ success: false, canceled: true });
      }
    });
  });
}

// ==========================================
// DOWNLOAD INS ARCHIV (AUTO-BENENNUNG, SHA256, ABBRECHBAR)
// ==========================================
async function resolveDownloadUrl(item, signal) {
  // 1. Winget liefert immer die frischeste direkte Installer-URL + SHA256
  const resolvedWingetId = getEffectiveWingetId(item);
  if ((item.webSourceType === 'winget' || item.packageManager === 'winget') && resolvedWingetId) {
    const wg = await fetchWingetInfo(resolvedWingetId, signal);
    if (!wg.success || !wg.downloadUrl) {
      throw new Error(wg.error || 'Winget liefert keine direkte Download-URL.');
    }
    return { url: wg.downloadUrl, version: wg.version, sha256: wg.sha256 };
  }

  // 2. GitHub ohne manuelle Download-URL (oder mit Release-Link): Asset direkt ermitteln
  if (
    item.webSourceType === 'github' &&
    item.webVersionUrl &&
    (!item.downloadUrl || item.downloadUrl.includes('/releases'))
  ) {
    const gh = await fetchGitHubRelease(item.webVersionUrl, item.githubAssetPattern, signal);
    if (gh.success && gh.downloadUrl) {
      return { url: gh.downloadUrl, version: gh.version, sha256: '' };
    }
  }

  let finalUrl = item.downloadUrl || '';
  if (!finalUrl) throw new Error('Keine Download-URL hinterlegt.');

  // 3. URL-Vorlage mit {version} auflösen
  if (finalUrl.includes('{version}') && item.webVersion) {
    finalUrl = finalUrl.split('{version}').join(item.webVersion);
  }

  // 4. Dynamische Link-Extraktion per Prefix/Suffix
  if (item.dlPrefix) {
    const res = await fetch(finalUrl, { headers: { 'User-Agent': USER_AGENT }, signal });
    if (!res.ok) throw new Error(`Download-Seite nicht erreichbar (HTTP ${res.status})`);
    const html = await res.text();
    const extracted = extractBetween(html, item.dlPrefix, item.dlSuffix);
    if (!extracted) {
      throw new Error('Download-Link konnte auf der Webseite nicht mehr gefunden werden.');
    }
    const cleanHref = extracted.split(/["'\s>]/)[0];
    finalUrl = new URL(cleanHref, finalUrl).href;
  }

  return { url: finalUrl, version: item.webVersion || '', sha256: '' };
}

async function computeSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

export async function downloadWebUpdate(
  item,
  { saveIntoLastFolder = false, useJob = true, signal = null, onProgress = null } = {}
) {
  const cfg = getConfig();
  const targetSoftwareDir = resolveBestArchivePath(item, {
    archiveRoots: cfg.absArchivePaths,
    pathExists: (p) => fs.existsSync(p),
  });
  if (!targetSoftwareDir) {
    return {
      success: false,
      error: 'Kein erreichbarer Archiv-Pfad für diese Software verfügbar (Archiv-Quelle offline).',
    };
  }
  const baseTargetDir = saveIntoLastFolder ? path.join(targetSoftwareDir, '_last') : targetSoftwareDir;
  if (!fs.existsSync(baseTargetDir)) fs.mkdirSync(baseTargetDir, { recursive: true });

  let partFilePath = null;
  let activeDownloadItem = null;
  let activeBrowserWin = null;

  const cleanupOnAbort = () => {
    if (activeDownloadItem) {
      try {
        activeDownloadItem.cancel();
      } catch {
        // Ignorieren
      }
    }
    if (activeBrowserWin && !activeBrowserWin.isDestroyed()) {
      try {
        activeBrowserWin.close();
      } catch {
        // Ignorieren
      }
    }
    if (partFilePath && fs.existsSync(partFilePath)) {
      try {
        fs.unlinkSync(partFilePath);
      } catch {
        // Ignorieren
      }
    }
  };

  let job = null;
  if (useJob) {
    job = createJob({
      type: 'web-download',
      title: `Download: ${item.name}`,
      dedupeKey: `dl:${item.id}`,
      cancelable: true,
      onCancel: cleanupOnAbort,
    });
    if (!job) return { success: false, alreadyRunning: true };
  }

  const activeSignal = job ? job.signal : signal;
  const reportProgress = (pct, detail) => {
    job?.update(pct, detail);
    onProgress?.(pct, detail);
  };

  const onExternalAbort = !useJob && activeSignal ? () => cleanupOnAbort() : null;
  if (onExternalAbort && activeSignal) {
    if (activeSignal.aborted) {
      cleanupOnAbort();
      return { success: false, canceled: true };
    }
    activeSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    reportProgress(2, 'Ermittle Download-Link...');
    const resolved = await resolveDownloadUrl(item, activeSignal);
    const finalUrl = resolved.url;
    const knownVersion = resolved.version || item.webVersion || '';

    const urlExt = finalUrl.split('?')[0].toLowerCase().split('.').pop();
    const isDirect = DIRECT_EXTS.has(urlExt) || item.webSourceType === 'winget' || item.packageManager === 'winget';

    if (isDirect) {
      const rawName = decodeURIComponent(finalUrl.split('/').pop().split('?')[0] || 'setup.exe');
      const suggestedName = buildArchiveFilename({
        softwareName: item.name,
        version: knownVersion,
        originalFilename: rawName,
        pattern: cfg.filenamePattern,
        keepIfVersionPresent: cfg.keepOriginalNameIfVersioned,
      });

      let finalPath = path.join(baseTargetDir, suggestedName);

      // Nur fragen, wenn der Nutzer explizit den Speichern-Dialog aktiviert hat
      if (cfg.askSaveDialog || !cfg.autoSaveDownloads) {
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: 'Update im Archiv speichern',
          defaultPath: finalPath,
        });
        if (canceled || !filePath) {
          job?.finish('canceled', 'Speichern abgebrochen.', { autoRemoveMs: 1500 });
          return { success: false, canceled: true };
        }
        finalPath = filePath;
      }

      partFilePath = `${finalPath}.part`;
      reportProgress(5, `Lade ${path.basename(finalPath)}...`);

      const res = await fetch(finalUrl, {
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT },
        signal: activeSignal,
      });
      if (!res.ok) throw new Error(`HTTP Fehler ${res.status}`);

      const total = parseInt(res.headers.get('content-length') || '0', 10);
      let received = 0;

      const fileStream = fs.createWriteStream(partFilePath);
      try {
        for await (const chunk of res.body) {
          if (activeSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
          fileStream.write(chunk);
          received += chunk.length;
          const pct = total > 0 ? Math.round((received / total) * 100) : null;
          reportProgress(pct, `Lade ${path.basename(finalPath)} (${(received / 1024 / 1024).toFixed(1)} MB)...`);
        }
        await new Promise((r) => fileStream.end(r));
      } catch (streamErr) {
        fileStream.destroy();
        if (fs.existsSync(partFilePath)) fs.unlinkSync(partFilePath);
        throw streamErr;
      }

      // Optional: SHA-256 Prüfung (bei Winget)
      if (resolved.sha256) {
        reportProgress(96, 'Prüfe SHA-256 Prüfsumme...');
        const actualHash = await computeSha256(partFilePath);
        if (actualHash !== resolved.sha256) {
          fs.unlinkSync(partFilePath);
          throw new Error('SHA-256 Prüfsumme stimmt nicht überein! Datei wurde aus Sicherheitsgründen verworfen.');
        }
      }

      // Fallback-Auto-Benennung, wenn vorher keine Version bekannt war
      let targetFinalPath = finalPath;
      if (!knownVersion && /\.(exe|msi)$/i.test(finalPath)) {
        const detectedVer = await getFileVersion(partFilePath);
        if (detectedVer) {
          const renamed = buildArchiveFilename({
            softwareName: item.name,
            version: detectedVer,
            originalFilename: path.basename(finalPath),
            pattern: cfg.filenamePattern,
            keepIfVersionPresent: cfg.keepOriginalNameIfVersioned,
          });
          targetFinalPath = path.join(path.dirname(finalPath), renamed);
        }
      }

      if (fs.existsSync(targetFinalPath)) fs.unlinkSync(targetFinalPath);
      fs.renameSync(partFilePath, targetFinalPath);
      partFilePath = null;

      reportProgress(99, 'Aktualisiere Katalogeintrag...');
      await scanSingleFolder(targetSoftwareDir);
      job?.finish('done', `Gespeichert: ${path.basename(targetFinalPath)}`);
      return { success: true, filePath: targetFinalPath, version: knownVersion };
    }

    // Fall 2: In-App Browser (mit komplett isolierter Session -> kein Listener-Leak!)
    return await new Promise((resolve) => {
      const partition = `dl-${Date.now()}`;
      const dlSession = session.fromPartition(partition);
      const dlWin = new BrowserWindow({
        width: 1050,
        height: 760,
        title: `Download: ${item.name} (Bitte auf Herunterladen klicken)`,
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, partition },
      });
      activeBrowserWin = dlWin;

      let settled = false;
      const done = (res) => {
        if (settled) return;
        settled = true;
        dlSession.off('will-download', onWillDownload);
        activeBrowserWin = null;
        if (!dlWin.isDestroyed()) dlWin.close();
        resolve(res);
      };

      const onWillDownload = (_dlEvent, dlItem) => {
        activeDownloadItem = dlItem;
        const suggested = buildArchiveFilename({
          softwareName: item.name,
          version: knownVersion,
          originalFilename: dlItem.getFilename(),
          pattern: cfg.filenamePattern,
          keepIfVersionPresent: cfg.keepOriginalNameIfVersioned,
        });
        const targetPath = path.join(baseTargetDir, suggested);

        if (cfg.autoSaveDownloads && !cfg.askSaveDialog) {
          dlItem.setSavePath(targetPath);
        } else {
          dlItem.setSaveDialogOptions({
            title: 'Update im Archiv speichern',
            defaultPath: targetPath,
          });
        }

        dlItem.on('updated', (_ev, state) => {
          if (state === 'progressing') {
            const total = dlItem.getTotalBytes();
            const rec = dlItem.getReceivedBytes();
            const pct = total > 0 ? Math.round((rec / total) * 100) : null;
            reportProgress(pct, `Lade ${suggested}...`);
          }
        });

        dlItem.once('done', async (_ev, state) => {
          if (state === 'completed') {
            const savedPath = dlItem.getSavePath();
            reportProgress(99, 'Aktualisiere Katalogeintrag...');
            await scanSingleFolder(targetSoftwareDir);
            job?.finish('done', `Gespeichert: ${path.basename(savedPath)}`);
            done({ success: true, filePath: savedPath, version: knownVersion });
          } else {
            job?.finish('canceled', `Download abgebrochen (${state})`, { autoRemoveMs: 2500 });
            done({ success: false, canceled: state === 'cancelled', error: `Download-Status: ${state}` });
          }
        });
      };

      dlSession.on('will-download', onWillDownload);
      dlWin.loadURL(finalUrl);
      dlWin.on('closed', () => {
        if (!settled) {
          job?.finish('canceled', 'Browser-Fenster geschlossen.', { autoRemoveMs: 1500 });
          done({ success: false, canceled: true });
        }
      });
    });
  } catch (e) {
    if (e.name === 'AbortError' || activeSignal?.aborted) {
      return { success: false, canceled: true };
    }
    job?.finish('error', e.message, { autoRemoveMs: 6000 });
    return { success: false, error: e.message };
  } finally {
    if (onExternalAbort && activeSignal) {
      activeSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ==========================================
// AUTO-FILL SOFTWARE-DETAILS (WINGET / GITHUB / WEB)
// ==========================================
export async function fetchSoftwareMetadata({
  sourceType = '',
  packageManager = '',
  packageId = '',
  wingetId = '',
  url = '',
}) {
  try {
    const resolvedWingetId = getEffectiveWingetId({ packageManager, packageId, wingetId });
    const effective =
      sourceType ||
      (resolvedWingetId ? 'winget' : url?.toLowerCase().includes('github.com') ? 'github' : url ? 'web' : 'none');

    if (effective === 'winget') {
      if (!resolvedWingetId) return { success: false, error: 'Bitte zuerst eine Winget-ID auswählen.' };
      const res = await wingetProvider.show(resolvedWingetId, { preferGerman: true });
      if (!res.success || !res.package) return { success: false, error: res.error || 'Winget-Paket nicht gefunden.' };

      const p = res.package;
      const links = {};
      if (p.homepage) links.Homepage = p.homepage;
      if (p.releaseNotesUrl) links.Changelog = p.releaseNotesUrl;

      return {
        success: true,
        sourceLabel: p.locale === 'de-DE' ? 'Winget (Deutsch)' : 'Winget (Standard/EN)',
        metadata: {
          name: p.name,
          description: p.description,
          tags: (p.tags || []).slice(0, 10),
          links,
          version: p.version,
        },
      };
    }

    if (effective === 'github') {
      const repoMatch = url?.match(/github\.com\/([^/]+\/[^/?#]+)/i);
      if (!repoMatch) return { success: false, error: 'Bitte eine gültige GitHub-Repository-URL angeben.' };
      const repo = repoMatch[1].replace(/\.git$/i, '');

      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { 'User-Agent': 'SoftwareKatalogApp' },
      });
      if (!res.ok) return { success: false, error: `GitHub API Fehler (${res.status})` };

      const data = await res.json();
      const links = { GitHub: data.html_url };
      if (data.homepage) links.Homepage = data.homepage;

      return {
        success: true,
        sourceLabel: 'GitHub Repository',
        metadata: {
          name: data.name || '',
          description: data.description || '',
          tags: Array.isArray(data.topics) ? data.topics.slice(0, 10) : [],
          links,
          version: '',
        },
      };
    }

    if (effective === 'web' && url) {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) return { success: false, error: `Webseite nicht erreichbar (HTTP ${res.status})` };
      const html = await res.text();

      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1];
      const metaDesc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1];
      const desc = (ogDesc || metaDesc || '').trim();

      return {
        success: true,
        sourceLabel: 'Webseite (Meta-Tags)',
        metadata: {
          name: '',
          description: desc,
          tags: [],
          links: { Webseite: new URL(url).origin },
          version: '',
        },
      };
    }

    return {
      success: false,
      error: 'Bitte zuerst im Tab "Online-Updates" eine Quelle (Winget, GitHub oder Webseite) wählen.',
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ==========================================
// CHANGELOGS ("WAS IST NEU?") MIT RAM-CACHE
// ==========================================
const changelogCache = new Map();
const CHANGELOG_TTL_MS = 30 * 60 * 1000;

export async function fetchChangelog(item) {
  const resolvedWingetId = getEffectiveWingetId(item);
  const sourceType =
    item.webSourceType && item.webSourceType !== 'none'
      ? item.webSourceType
      : resolvedWingetId
        ? 'winget'
        : item.webVersionUrl?.toLowerCase().includes('github.com')
          ? 'github'
          : 'none';

  const cacheKey = `${item.id}:${sourceType}:${resolvedWingetId || item.webVersionUrl || ''}`;
  const cached = changelogCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CHANGELOG_TTL_MS) {
    return cached.data;
  }

  try {
    /** @type {any} */
    let payload = { success: false, error: 'Für diese Quelle sind keine Changelogs verfügbar.' };

    if (sourceType === 'github' && item.webVersionUrl) {
      const repoMatch = item.webVersionUrl.match(/github\.com\/([^/]+\/[^/?#]+)/i);
      if (repoMatch) {
        const repo = repoMatch[1].replace(/\.git$/i, '');
        const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=8`, {
          headers: { 'User-Agent': 'SoftwareKatalogApp' },
        });
        if (!res.ok) return { success: false, error: `GitHub API Fehler (${res.status})` };

        const releases = await res.json();
        const entries = (Array.isArray(releases) ? releases : [])
          .filter((r) => !r.draft)
          .map((r) => ({
            version: extractVersion(r.tag_name || r.name || '') || r.tag_name || '',
            title: r.name || r.tag_name || 'Release',
            date: r.published_at ? r.published_at.slice(0, 10) : '',
            body: (r.body || '').trim(),
            url: r.html_url || '',
            prerelease: Boolean(r.prerelease),
          }));

        payload = {
          success: true,
          source: 'GitHub Releases',
          entries,
          externalUrl: `https://github.com/${repo}/releases`,
        };
      }
    } else if (sourceType === 'winget' && resolvedWingetId) {
      const res = await wingetProvider.show(resolvedWingetId, { preferGerman: true });
      if (!res.success || !res.package) return { success: false, error: res.error || 'Winget-Paket nicht gefunden.' };

      const p = res.package;
      const entries =
        p.releaseNotes || p.releaseNotesUrl
          ? [
              {
                version: p.version,
                title: `Version ${p.version}`,
                date: '',
                body: p.releaseNotes || 'Kein direkter Text hinterlegt - nutze den externen Changelog-Link.',
                url: p.releaseNotesUrl || '',
                prerelease: false,
              },
            ]
          : [];

      payload = {
        success: true,
        source: p.locale === 'de-DE' ? 'Winget (Deutsch)' : 'Winget',
        entries,
        externalUrl: p.releaseNotesUrl || p.homepage || '',
      };
    }

    if (payload.success) {
      changelogCache.set(cacheKey, { ts: Date.now(), data: payload });
    }
    return payload;
  } catch (e) {
    return { success: false, error: e.message };
  }
}
