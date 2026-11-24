import { getInstallModeBadge, resolveDetailInstallMode } from '../../shared/installer-logic.js';
import { formatMultiRootFileLabel } from '../../shared/multi-archive-logic.js';
import { buildRemotePackageItem, canDownloadOnline, getProviderBadgeInfo } from '../../shared/unified-packages.js';
import { compareVersions } from '../../shared/version.js';
import { openLightbox } from '../components/lightbox.js';
import { showToast } from '../components/toast.js';
import { getBaseName, getItemById, getItemStatus, isItemNew, state } from '../state.js';
import { renderMarkdownSafe } from '../utils/markdown.js';
import { escapeHTML, sanitizeRichHtml, toMediaUrl } from '../utils/sanitize.js';
import { executeArchiveLink, resolveArchiveSaveTarget, savePackageToArchive } from './archive-target-modal.js';
import { closeModal, openEditModal, resetModalContent, triggerCatalogReload } from './index.js';

const SOURCE_LABELS = {
  winget: 'Winget',
  github: 'GitHub',
  web: 'Webseite',
};

const STATUS_BADGES = {
  webupdate: { label: 'Web-Update verfügbar', cls: 'is-webupdate' },
  update: { label: 'Archiv-Update verfügbar', cls: 'is-update' },
  installed: { label: 'Aktuell installiert', cls: 'is-installed' },
  newer: { label: 'PC neuer als Archiv', cls: 'is-newer' },
};

const ORIGIN_CHIPS = {
  both: { label: 'PC & Archiv', cls: '' },
  archive: { label: 'Nur im Archiv', cls: 'chip-origin-archive' },
  pc: { label: 'Nur auf diesem PC', cls: 'chip-origin-pc' },
};

let activeRenderToken = 0;

function formatCacheTimestamp(ts) {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat('de-DE', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(ts));
  } catch {
    return '';
  }
}

function getEffectivePackageManager(item) {
  if (item.packageManager) return String(item.packageManager).trim().toLowerCase();
  if (item.wingetId || item.webSourceType === 'winget' || item.packageId) return 'winget';
  return '';
}

function getEffectivePackageId(item) {
  return String(item.packageId || item.wingetId || '').trim();
}

function getProviderMeta(effectivePm) {
  const cleanPm = String(effectivePm || '')
    .trim()
    .toLowerCase();
  const prov = cleanPm ? state.providers.find((p) => p.id === cleanPm) || null : null;
  const badge = getProviderBadgeInfo(cleanPm, state.providers);
  return {
    provider: prov,
    label: badge?.label || (cleanPm === 'winget' ? 'Winget' : cleanPm),
    badge,
    canInstall: prov ? Boolean(prov.capabilities?.install) : cleanPm === 'winget',
    canShow: prov ? Boolean(prov.capabilities?.show) : cleanPm === 'winget',
    canUninstall: prov ? Boolean(prov.capabilities?.uninstall) : cleanPm === 'winget',
    supportsArchiveDownload: prov ? Boolean(prov.capabilities?.supportsArchiveDownload) : cleanPm === 'winget',
  };
}

function isCanUninstall(item, provMeta, effectivePkgId) {
  if (!item.isInstalled) return false;
  if (item.canUninstall || item.uninstallString || item.quietUninstallString) return true;
  return item.softwareType !== 'portable' && provMeta.canUninstall && Boolean(effectivePkgId);
}

function buildArchiveHeroAction(item, st) {
  const onlineReady = canDownloadOnline(item);
  const firstFile = item.lastFiles?.[0] || null;

  if (st.hasWebUpdate && onlineReady) {
    return {
      action: 'web-download',
      label: `⬇️ Update v${st.webVersion} ins Archiv laden`,
      cls: 'btn-online',
    };
  }

  if (st.hasArchiveUpdate && firstFile) {
    return {
      action: 'install-file',
      file: firstFile,
      version: st.archiveVersion,
      label: `⬆️ Jetzt aktualisieren (v${st.archiveVersion})`,
      cls: 'btn-archive',
    };
  }

  if (!item.isInstalled && firstFile) {
    return {
      action: 'install-file',
      file: firstFile,
      version: st.archiveVersion,
      label: st.archiveVersion ? `▶️ Installieren (v${st.archiveVersion})` : '▶️ Setup starten',
      cls: 'btn-primary',
    };
  }

  if (item.isInstalled && item.validInstallPath) {
    return {
      action: 'launch-local',
      label: '🚀 Programm starten',
      cls: 'btn-local',
    };
  }

  return null;
}

function buildNvmUseButtonHtml(item, { large = false } = {}) {
  if (getEffectivePackageManager(item) !== 'nvm' || !item.isInstalled) return '';
  const pkgVer = getEffectivePackageId(item);
  if (!pkgVer) return '';
  if (item.isActive) {
    return '<button type="button" class="btn btn-ghost" disabled>✅ Aktive Node-Version</button>';
  }
  const sizeCls = large ? 'btn-lg ' : '';
  return `<button type="button" class="btn ${sizeCls}btn-local" data-detail-action="nvm-use">✅ Als aktive Node-Version setzen (nvm use ${escapeHTML(pkgVer)})</button>`;
}

function buildHeroBarHtml(item, st, { provMeta, canUninstall, matchedArchive }) {
  const buttons = [];
  const provLabel = provMeta.label || 'Paketmanager';
  const canProviderInstall = provMeta.canInstall && Boolean(getEffectivePackageId(item));

  if (item.origin === 'remote') {
    const installLabel =
      item.isInstalled && st.hasWebUpdate
        ? `⬆️ Über ${provLabel} aktualisieren (v${st.webVersion})`
        : item.isInstalled
          ? `🔄 Erneut über ${provLabel} installieren`
          : '⬇️ Jetzt installieren';
    buttons.push(
      `<button type="button" class="btn btn-lg ${item.isInstalled && st.hasWebUpdate ? 'btn-online' : 'btn-primary'}" data-detail-action="provider-install">${escapeHTML(installLabel)}</button>`
    );

    const nvmBtn = buildNvmUseButtonHtml(item);
    if (nvmBtn) {
      buttons.push(nvmBtn);
    }

    if (matchedArchive) {
      buttons.push(
        '<button type="button" class="btn btn-ghost" data-detail-action="open-archive-item">📂 Im Archiv öffnen</button>'
      );
    } else if (provMeta.supportsArchiveDownload && canProviderInstall) {
      buttons.push(
        '<button type="button" class="btn btn-archive" data-detail-action="save-to-archive">📥 Ins Archiv aufnehmen</button>'
      );
    }
  } else if (item.origin === 'pc') {
    const nvmBtn = buildNvmUseButtonHtml(item, { large: true });
    if (nvmBtn) {
      buttons.push(nvmBtn);
    } else if (canProviderInstall && st.hasWebUpdate) {
      buttons.push(
        `<button type="button" class="btn btn-lg btn-online" data-detail-action="provider-install">⬆️ Über ${escapeHTML(provLabel)} aktualisieren (v${escapeHTML(st.webVersion)})</button>`
      );
    } else if (item.validInstallPath) {
      buttons.push(
        '<button type="button" class="btn btn-lg btn-local" data-detail-action="launch-local">🚀 Programm starten</button>'
      );
    }
    buttons.push(
      '<button type="button" class="btn btn-archive" data-detail-action="save-to-archive">📥 Ins Archiv aufnehmen</button>'
    );
  } else {
    const hero = buildArchiveHeroAction(item, st);
    const onlineReady = canDownloadOnline(item);

    if (hero) {
      buttons.push(
        `<button type="button" class="btn btn-lg ${hero.cls}" data-detail-action="${hero.action}" data-file="${escapeHTML(hero.file || '')}" data-version="${escapeHTML(hero.version || '')}">${escapeHTML(hero.label)}</button>`
      );
    }
    if (item.isInstalled && item.validInstallPath && hero?.action !== 'launch-local') {
      buttons.push(
        '<button type="button" class="btn btn-ghost" data-detail-action="launch-local">🚀 Programm starten</button>'
      );
    }
    if (onlineReady && hero?.action !== 'web-download') {
      buttons.push(
        '<button type="button" class="btn btn-ghost" data-detail-action="web-download">🌐 Aus Web laden</button>'
      );
    }
  }

  if (canUninstall) {
    buttons.push(
      '<button type="button" class="btn btn-danger" data-detail-action="uninstall">🗑️ Deinstallieren</button>'
    );
  }

  if (buttons.length === 0) return '';
  return `<div class="detail-hero-bar">${buttons.join('')}</div>`;
}

function buildInstallModeToggleHtml({
  item,
  st,
  canProviderInstall,
  hasFreshDownload,
  selectedMode,
  isSilentLocked,
  lockTooltip,
}) {
  const hasInstallAction =
    item.origin === 'remote' ||
    (item.origin === 'pc' && canProviderInstall && st.hasWebUpdate) ||
    (item.inArchive && (item.lastFiles?.length > 0 || hasFreshDownload || canDownloadOnline(item)));

  if (!hasInstallAction) return '';

  const isSilent = !isSilentLocked && selectedMode === 'silent';
  const silentTitle = isSilentLocked ? lockTooltip : 'Setup möglichst ohne Rückfragen im Hintergrund ausführen';

  return `
    <div class="detail-install-mode-bar" id="detailInstallModeBar">
      <span class="detail-install-mode-label">Installationsmodus:</span>
      <div class="detail-mode-toggle" role="group" aria-label="Installationsmodus">
        <button
          type="button"
          class="detail-mode-btn ${!isSilent ? 'active' : ''}"
          data-detail-install-mode="interactive"
          aria-pressed="${!isSilent ? 'true' : 'false'}"
          title="Setup mit Assistent / Fenstern ausführen"
        >
          🖱️ Interaktiv
        </button>
        <button
          type="button"
          class="detail-mode-btn ${isSilent ? 'active' : ''}"
          data-detail-install-mode="silent"
          aria-pressed="${isSilent ? 'true' : 'false'}"
          ${isSilentLocked ? 'disabled' : ''}
          title="${escapeHTML(silentTitle)}"
        >
          ⚡ Silent
        </button>
      </div>
      ${
        isSilentLocked
          ? `<span class="detail-mode-lock-hint" title="${escapeHTML(lockTooltip)}">🛡️ Adware-Schutz aktiv (nur Interaktiv)</span>`
          : ''
      }
    </div>
  `;
}

function buildArchiveSaveChoiceHtml(item, st, { effectivePkgId, canArchiveDownload, matchedArchive }) {
  const hasProviderInstallBtn = item.origin === 'remote' || (item.origin === 'pc' && st.hasWebUpdate);
  if (!hasProviderInstallBtn || !canArchiveDownload || item.inArchive || matchedArchive) return '';

  const saveMode = state.settings.archiveSaveMode || 'ask';
  const checked = saveMode === 'ask' || saveMode === 'auto-id';
  let labelText = '🗄️ Setup-Datei bei Installation/Update zusätzlich im Archiv ablegen';
  if (saveMode === 'auto-id') {
    labelText = `🗄️ Setup-Datei automatisch im Archiv speichern (Ordner: ${effectivePkgId})`;
  } else if (saveMode === 'none') {
    labelText = '🗄️ Setup-Datei zusätzlich im Archiv ablegen (Standard in Einstellungen: Aus)';
  }

  return `
    <label class="detail-archive-save-box">
      <input type="checkbox" id="detailAlsoSaveArchive" ${checked ? 'checked' : ''}>
      <span>${escapeHTML(labelText)}</span>
    </label>
  `;
}

function buildVersionGridHtml(item, st, { matchedArchive }) {
  const effectivePm = getEffectivePackageManager(item);
  const provBadge = effectivePm ? getProviderBadgeInfo(effectivePm, state.providers) : null;
  const sourceLabel = SOURCE_LABELS[item.webSourceType] || item.providerName || provBadge?.label || '';

  const archiveVersion =
    st.archiveVersion || (matchedArchive?.lastFiles?.length > 0 ? getBaseName(matchedArchive.lastFiles[0]) : '') || '';

  let archiveBoxVal = 'Nicht im Archiv';
  if (item.inArchive || matchedArchive) {
    archiveBoxVal = st.archiveVersion
      ? `v${escapeHTML(st.archiveVersion)}`
      : archiveVersion
        ? escapeHTML(archiveVersion)
        : 'Keine Setup-Datei';
  }

  const onlineVal = st.webVersion
    ? `v${escapeHTML(st.webVersion)}`
    : provBadge && item.origin === 'pc'
      ? 'Aktuell'
      : 'Nicht eingerichtet';

  return `
    <div class="detail-version-grid">
      <div class="detail-ver-box ${st.isPcNewer ? 'is-newer' : st.localVersion && !st.hasArchiveUpdate ? 'is-ok' : ''}">
        <span class="ver-box-lbl">Installiert (PC)</span>
        <strong class="ver-box-val">${st.localVersion ? `v${escapeHTML(st.localVersion)}` : item.isInstalled ? 'Installiert' : 'Nicht installiert'}</strong>
      </div>
      <div class="detail-ver-box ${st.hasArchiveUpdate ? 'is-archive-update' : ''}">
        <span class="ver-box-lbl">Archiv${item.hasPinnedLast ? ' · _last gepinnt' : ''}</span>
        <strong class="ver-box-val">${archiveBoxVal}</strong>
      </div>
      <div class="detail-ver-box ${st.hasWebUpdate ? 'is-web-update' : ''}">
        <span class="ver-box-lbl">Online${sourceLabel ? ` · ${escapeHTML(sourceLabel)}` : ''}</span>
        <strong class="ver-box-val" id="detailOnlineVerVal">${onlineVal}</strong>
      </div>
    </div>
  `;
}

function buildCustomMetaSectionHtml(item, hasPackageProfile) {
  const cleanDesc = sanitizeRichHtml(item.description);
  const hasLinks = Array.isArray(item.links) && item.links.length > 0;
  const hasMedia = Array.isArray(item.screenshots) && item.screenshots.length > 0;
  const hasFormats = Array.isArray(item.formats) && item.formats.length > 0;
  const hasOs = Array.isArray(item.os) && item.os.length > 0;
  const hasCats = Boolean(item.mainCategory || item.subCategories?.length);

  const hasAnyCustomInfo = Boolean(cleanDesc || hasLinks || hasMedia || hasFormats || hasOs || hasCats);

  if (!hasAnyCustomInfo) {
    if (hasPackageProfile) return '';
    return `
      <section class="custom-info-card">
        <div class="custom-info-head">
          <h4>📝 Eigene Archiv-Notizen &amp; Zusatzinfos</h4>
          <span class="muted"><code>_metadata/meta.json</code></span>
        </div>
        <div class="detail-description">
          <span class="muted">Keine eigenen Zusatzinfos oder Medien hinterlegt (<code>meta.json</code> ist optional).</span>
        </div>
      </section>
    `;
  }

  const infoChips = [];
  if (item.mainCategory) infoChips.push(`<span><strong>Kategorie:</strong> ${escapeHTML(item.mainCategory)}</span>`);
  if (item.subCategories?.length) {
    infoChips.push(`<span><strong>Eigene Tags:</strong> ${escapeHTML(item.subCategories.join(', '))}</span>`);
  }
  if (hasFormats) infoChips.push(`<span><strong>Dateiformate:</strong> ${escapeHTML(item.formats.join(', '))}</span>`);
  if (hasOs) infoChips.push(`<span><strong>Systeme:</strong> ${escapeHTML(item.os.join(', '))}</span>`);

  const linksHtml = hasLinks
    ? `
      <div class="detail-links">
        ${item.links
          .map(
            (l) =>
              `<button type="button" class="link-chip" data-open-url="${escapeHTML(l.url)}">🔗 ${escapeHTML(l.label)}</button>`
          )
          .join('')}
      </div>
    `
    : '';

  const mediaHtml = hasMedia
    ? `
      <div class="detail-media-strip">
        ${item.screenshots
          .map((s, idx) => {
            const url = escapeHTML(toMediaUrl(s));
            const isVid = /\.(mp4|webm|ogg|mov|avi)$/i.test(s);
            if (isVid) {
              return `
                <button type="button" class="media-thumb is-video" data-lightbox-idx="${idx}" title="Video abspielen">
                  <video src="${url}#t=1" muted preload="metadata"></video>
                  <span class="play-badge">▶</span>
                </button>
              `;
            }
            return `
              <button type="button" class="media-thumb" data-lightbox-idx="${idx}" title="Vergrößern">
                <img src="${url}" loading="lazy" alt="Screenshot">
              </button>
            `;
          })
          .join('')}
      </div>
    `
    : '';

  return `
    <section class="custom-info-card">
      <div class="custom-info-head">
        <h4>📝 Eigene Archiv-Notizen &amp; Zusatzinfos</h4>
        <span class="muted">Aus <code>_metadata/meta.json</code></span>
      </div>
      ${cleanDesc ? `<div class="detail-description">${cleanDesc}</div>` : ''}
      ${infoChips.length > 0 ? `<div class="custom-info-chips">${infoChips.join('')}</div>` : ''}
      ${linksHtml}
      ${mediaHtml}
    </section>
  `;
}

function buildArchiveTechTabHtml(item, { effectivePm, effectivePkgId, matchedArchive }) {
  const originLabel =
    item.origin === 'both'
      ? 'PC & Archiv'
      : item.origin === 'archive'
        ? 'Nur im Archiv'
        : item.origin === 'pc'
          ? 'Nur auf diesem PC'
          : 'Online-Quelle (Neu installieren)';

  let archiveSectionHtml = '';
  if (item.inArchive) {
    let filesBarHtml = '<p class="muted">Keine Setup-Datei im Archiv-Ordner gefunden.</p>';
    if (item.lastFiles?.length > 0) {
      const firstFile = item.lastFiles[0];
      const fileSourceIndices = new Set(
        Object.values(item.lastFileSources || {}).map((s) => Number(s?.rootIndex ?? 0))
      );
      const showRootPrefix = Boolean(item.hasMultipleArchiveRoots || fileSourceIndices.size > 1);
      const selectorHtml =
        item.lastFiles.length > 1
          ? `<select id="detailFileSelect" class="detail-file-select">${item.lastFiles
              .map(
                (f, idx) =>
                  `<option value="${idx}">${escapeHTML(formatMultiRootFileLabel(f, item.lastFileSources, showRootPrefix))}</option>`
              )
              .join('')}</select>`
          : `<span class="detail-file-name" title="${escapeHTML(firstFile)}">${escapeHTML(formatMultiRootFileLabel(firstFile, item.lastFileSources, showRootPrefix))}</span>`;

      filesBarHtml = `
        <div class="detail-archive-bar">
          <span class="detail-archive-label">Setup-Datei:</span>
          ${selectorHtml}
          <div class="detail-archive-btns">
            <button type="button" class="btn btn-ghost" data-detail-action="run-selected">▶️ Ausführen</button>
            <button type="button" class="btn btn-ghost" data-detail-action="copy-selected">💾 Auf PC kopieren</button>
          </div>
        </div>
      `;
    }

    const pinNoticeHtml = item.hasPinnedLast
      ? `
        <div class="archive-pin-banner">
          <strong>📌 <code>_last</code>-Ordner aktiv:</strong>
          <span>Dieses Programm nutzt einen gepinnten <code>_last</code>-Unterordner. Der Archiv-Aufräumer fasst ihn niemals an.</span>
        </div>
      `
      : '';

    const keepNoticeHtml = item.keepAllVersions
      ? `
        <div class="archive-keep-banner">
          <strong>🔒 Alle Versionen behalten:</strong>
          <span>Dieses Programm ist dauerhaft vom Archiv-Aufräumer ausgeschlossen.</span>
        </div>
      `
      : '';

    archiveSectionHtml = `
      <div class="detail-section">
        <h4>Setup-Dateien im Archiv</h4>
        ${filesBarHtml}
        ${pinNoticeHtml}
        ${keepNoticeHtml}
      </div>
    `;
  } else {
    archiveSectionHtml = `
      <div class="archive-status-card">
        <div>
          <strong>${matchedArchive ? 'Bereits im Archiv vorhanden' : 'Noch nicht im Archiv gespeichert'}</strong>
          <p class="muted">
            ${
              matchedArchive
                ? `Verknüpfter Archiv-Ordner: <code>${escapeHTML(matchedArchive.path)}</code>`
                : 'Dieses Paket liegt aktuell nicht im lokalen Software-Archiv.'
            }
          </p>
        </div>
        ${
          matchedArchive
            ? '<button type="button" class="btn btn-ghost" data-detail-action="open-archive-item">📂 Im Archiv öffnen</button>'
            : '<button type="button" class="btn btn-archive" data-detail-action="save-to-archive">📥 Ins Archiv aufnehmen</button>'
        }
      </div>
    `;
  }

  const techRows = [`<div class="tech-row"><span>Herkunft</span><strong>${escapeHTML(originLabel)}</strong></div>`];
  if (item.path) {
    const primaryRootLabel = item.archiveRootLabel
      ? ` (#${(item.archiveRootIndex ?? 0) + 1} ${item.archiveRootLabel})`
      : '';
    const offlineTag = item.archiveOffline ? ' [Offline-Cache]' : '';
    techRows.push(
      `<div class="tech-row"><span>Primärer Archiv-Ordner${escapeHTML(primaryRootLabel)}${escapeHTML(offlineTag)}</span><code>${escapeHTML(item.path)}</code></div>`
    );
  }
  if (Array.isArray(item.alternatePaths) && item.alternatePaths.length > 0) {
    const altHtml = item.alternatePaths
      .map(
        (alt) =>
          `[#${(alt.rootIndex ?? 0) + 1} ${alt.rootLabel || 'Archiv'}${alt.offline ? ' (offline)' : ''}] ${alt.path}`
      )
      .map(escapeHTML)
      .join('<br>');
    techRows.push(`<div class="tech-row"><span>Weitere Archiv-Orte</span><code>${altHtml}</code></div>`);
  }
  if (effectivePm) {
    techRows.push(`<div class="tech-row"><span>Paketmanager</span><code>${escapeHTML(effectivePm)}</code></div>`);
  }
  if (effectivePkgId) {
    techRows.push(`<div class="tech-row"><span>Paket-ID</span><code>${escapeHTML(effectivePkgId)}</code></div>`);
  }
  if (item.publisher) {
    techRows.push(`<div class="tech-row"><span>Herausgeber</span><code>${escapeHTML(item.publisher)}</code></div>`);
  }
  if (item.webVersionUrl) {
    techRows.push(
      `<div class="tech-row"><span>Versions-Quelle</span><button type="button" class="inline-link" data-open-url="${escapeHTML(item.webVersionUrl)}">${escapeHTML(item.webVersionUrl)}</button></div>`
    );
  }
  if (item.downloadUrl) {
    techRows.push(
      `<div class="tech-row"><span>Download-Quelle</span><button type="button" class="inline-link" data-open-url="${escapeHTML(item.downloadUrl)}">${escapeHTML(item.downloadUrl)}</button></div>`
    );
  }
  if (item.autoPaths?.length) {
    techRows.push(
      `<div class="tech-row"><span>PC-Pfad (Auto)</span><code>${item.autoPaths.map(escapeHTML).join('<br>')}</code></div>`
    );
  }
  if (item.installPaths?.length) {
    techRows.push(
      `<div class="tech-row"><span>PC-Pfad (Manuell)</span><code>${item.installPaths.map(escapeHTML).join('<br>')}</code></div>`
    );
  }
  if (item.installLocation) {
    techRows.push(
      `<div class="tech-row"><span>Installationsordner</span><code>${escapeHTML(item.installLocation)}</code></div>`
    );
  }
  if (item.registryKey) {
    techRows.push(`<div class="tech-row"><span>Registry-Key</span><code>${escapeHTML(item.registryKey)}</code></div>`);
  }
  if (item.searchNames?.length) {
    techRows.push(
      `<div class="tech-row"><span>Such-Namen</span><code>${escapeHTML(item.searchNames.join(', '))}</code></div>`
    );
  }
  if (item.inArchive) {
    const modeLabel =
      item.installMode === 'interactive-required'
        ? '🛡️ Immer Interaktiv (Adware-Schutz)'
        : item.installMode === 'silent'
          ? '⚡ Stille Installation (Opt-in)'
          : '🖱️ Interaktiv (Standard)';
    techRows.push(
      `<div class="tech-row"><span>Installationsmodus</span><strong>${escapeHTML(modeLabel)}</strong></div>`
    );
    if (item.silentArgs) {
      techRows.push(
        `<div class="tech-row"><span>Silent-Parameter</span><code>${escapeHTML(item.silentArgs)}</code></div>`
      );
    }
    if (item.innoInfFile) {
      const infHint = item.innoInfExists ? 'vorhanden' : 'fehlt im _metadata/-Ordner';
      techRows.push(
        `<div class="tech-row"><span>Inno Antwortdatei</span><code>${escapeHTML(item.innoInfFile)}</code> <span class="muted">(${infHint})</span></div>`
      );
    }
    techRows.push(
      `<div class="tech-row"><span>Aufräum-Schutz</span><code>${item.keepAllVersions ? 'Aktiv (Alle Versionen behalten)' : 'Standard'}</code></div>`
    );
  }

  return `
    ${archiveSectionHtml}
    <div class="detail-section">
      <h4>Technische Pfade & Kennungen</h4>
      <div class="detail-tech-list">
        ${techRows.join('')}
        <div id="detailTechInstallerRows"></div>
      </div>
    </div>
  `;
}

function renderPackageProfileBody(container, pkg, { fromCache, isStale, updatedAt, fallbackPm, fallbackPkgId }) {
  const shortDesc = String(pkg.shortDescription || '').trim();
  const fullDesc = String(pkg.description || '').trim();
  const tags = Array.isArray(pkg.tags) ? pkg.tags : [];
  const pmId = String(pkg.packageManager || fallbackPm || 'winget').toLowerCase();
  const pmLabel = getProviderBadgeInfo(pmId, state.providers)?.label || pmId;
  const pidLabel = pkg.packageId || fallbackPkgId;
  const formattedTime = formatCacheTimestamp(updatedAt);

  const staleNoticeHtml = isStale
    ? `
      <div class="pkg-stale-notice">
        ⚠️ Offline-Modus: Live-Abruf fehlgeschlagen - zeige zwischengespeicherten Steckbrief${formattedTime ? ` (Stand: ${escapeHTML(formattedTime)})` : ''}.
      </div>
    `
    : '';

  const descBlocks = [];
  if (shortDesc && fullDesc && shortDesc.toLowerCase() !== fullDesc.toLowerCase()) {
    descBlocks.push(`<p class="pkg-profile-short-desc">${escapeHTML(shortDesc)}</p>`);
    descBlocks.push(`<p class="pkg-profile-desc">${escapeHTML(fullDesc)}</p>`);
  } else if (fullDesc || shortDesc) {
    descBlocks.push(`<p class="pkg-profile-desc">${escapeHTML(fullDesc || shortDesc)}</p>`);
  } else {
    descBlocks.push('<p class="muted">Keine Beschreibung im Paket-Manifest hinterlegt.</p>');
  }

  const tagsHtml =
    tags.length > 0
      ? `
        <div class="pkg-tags-list">
          ${tags.map((t) => `<span class="pkg-tag-chip">${escapeHTML(t)}</span>`).join('')}
        </div>
      `
      : '';

  const gridItems = [];
  if (pkg.publisher) {
    const pubContent = pkg.publisherUrl
      ? `<button type="button" class="inline-link" data-open-url="${escapeHTML(pkg.publisherUrl)}">${escapeHTML(pkg.publisher)} ↗</button>`
      : escapeHTML(pkg.publisher);
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">Herausgeber</span><div class="pkg-profile-val">${pubContent}</div></div>`
    );
  }
  if (pkg.author) {
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">Autor</span><div class="pkg-profile-val">${escapeHTML(pkg.author)}</div></div>`
    );
  }
  if (pkg.license || pkg.licenseUrl) {
    const licText = pkg.license ? escapeHTML(pkg.license) : 'Lizenz';
    const licLink = pkg.licenseUrl
      ? ` <button type="button" class="inline-link" data-open-url="${escapeHTML(pkg.licenseUrl)}">(Lizenztext ↗)</button>`
      : '';
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">Lizenz</span><div class="pkg-profile-val">${licText}${licLink}</div></div>`
    );
  }
  if (pkg.homepage) {
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">Startseite</span><div class="pkg-profile-val"><button type="button" class="inline-link" data-open-url="${escapeHTML(pkg.homepage)}">${escapeHTML(pkg.homepage)} ↗</button></div></div>`
    );
  }
  if (pkg.repositoryUrl && pkg.repositoryUrl !== pkg.homepage) {
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">Repository</span><div class="pkg-profile-val"><button type="button" class="inline-link" data-open-url="${escapeHTML(pkg.repositoryUrl)}">${escapeHTML(pkg.repositoryUrl)} ↗</button></div></div>`
    );
  }
  if (pmLabel) {
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">Paketmanager</span><div class="pkg-profile-val">${escapeHTML(pmLabel)}</div></div>`
    );
  }
  if (pidLabel) {
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">Paket-ID</span><div class="pkg-profile-val"><code>${escapeHTML(pidLabel)}</code></div></div>`
    );
  }

  container.innerHTML = `
    ${staleNoticeHtml}
    ${descBlocks.join('')}
    ${tagsHtml}
    <div class="pkg-profile-grid">${gridItems.join('')}</div>
  `;

  return {
    cacheLabel: isStale
      ? `Offline-Cache (${formattedTime || 'veraltet'})`
      : fromCache
        ? `Cache: ${formattedTime || 'aktuell'}`
        : `Live aktualisiert (${formattedTime || 'gerade eben'})`,
  };
}

function renderDetailModalCore(item, { freshDownload = null, initialTab = 'overview' } = {}) {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();

  const renderToken = ++activeRenderToken;
  state.currentModalId = item.id;
  state.isEditModalOpen = false;

  const st = getItemStatus(item);
  const statusBadge = STATUS_BADGES[st.status];
  const effectivePm = getEffectivePackageManager(item);
  const effectivePkgId = getEffectivePackageId(item);
  const provMeta = getProviderMeta(effectivePm);
  const isWingetPkg = effectivePm === 'winget' && Boolean(effectivePkgId);
  const canProviderInstall = provMeta.canInstall && Boolean(effectivePkgId);
  const canArchiveDownload = provMeta.supportsArchiveDownload && Boolean(effectivePkgId);
  const hasPackageProfile = Boolean(effectivePkgId) && provMeta.canShow;
  const matchedArchive = item.matchedArchiveItem || null;
  const metaSource = item.inArchive ? item : matchedArchive || item;
  const initialModeState = resolveDetailInstallMode(metaSource.installMode || item.installMode);
  let selectedInstallMode = initialModeState.selected;
  const isSilentLocked = initialModeState.silentLocked;
  const canUninstall = isCanUninstall(item, provMeta, effectivePkgId);
  const onlineReady = canDownloadOnline(item);
  const supportsChangelog = (item.webSourceType === 'github' && Boolean(item.webVersionUrl)) || isWingetPkg;

  const fallbackEmoji = item.origin === 'pc' ? '💻' : item.origin === 'remote' ? '🛍️' : '📦';
  const iconHtml = item.icon
    ? `<img class="detail-icon" src="${escapeHTML(toMediaUrl(item.icon))}" alt="">`
    : `<div class="detail-icon-fallback">${fallbackEmoji}</div>`;

  const providerChip =
    effectivePm && provMeta.badge
      ? `<span class="provider-badge ${escapeHTML(provMeta.badge.badgeClass)}">${escapeHTML(provMeta.label)}</span>`
      : '';
  const originChip = ORIGIN_CHIPS[item.origin]
    ? `<span class="card-chip ${ORIGIN_CHIPS[item.origin].cls}">${escapeHTML(ORIGIN_CHIPS[item.origin].label)}</span>`
    : providerChip || `<span class="provider-badge">${escapeHTML(item.providerName || effectivePm || 'Online')}</span>`;
  const extraProviderChip = ORIGIN_CHIPS[item.origin] ? providerChip : '';

  const newChip = isItemNew(item) ? '<span class="card-chip chip-new">NEU</span>' : '';
  const nvmActiveChip =
    effectivePm === 'nvm' && item.isActive
      ? '<span class="card-chip chip-install-silent" title="Aktuell aktive Node.js-Version">⚡ Aktiv</span>'
      : '';
  const typeChip =
    item.softwareType === 'portable'
      ? '<span class="card-chip">Portabel</span>'
      : item.softwareType === 'driver'
        ? '<span class="card-chip">Treiber</span>'
        : '';
  const keepChip = item.keepAllVersions ? '<span class="card-chip">🔒 Alle Versionen</span>' : '';
  const installBadge = item.inArchive ? getInstallModeBadge(item) : null;
  const installModeChip = installBadge
    ? `<span class="card-chip ${installBadge.type === 'protected' ? 'chip-install-protected' : 'chip-install-silent'}" title="${escapeHTML(installBadge.title)}">${escapeHTML(installBadge.label)}</span>`
    : '';
  const inArchiveRemoteChip =
    item.origin === 'remote' && matchedArchive ? '<span class="discover-status-badge">Im Archiv</span>' : '';
  const offlineArchiveChip = item.archiveOffline
    ? '<span class="card-chip chip-install-protected" title="Die zugehörige Archiv-Quelle ist aktuell nicht erreichbar (zwischengespeicherte Daten)">🔴 Archiv offline</span>'
    : '';
  const multiRootChip =
    Array.isArray(item.alternatePaths) && item.alternatePaths.length > 0
      ? `<span class="card-chip" title="Zusammengeführt aus ${1 + item.alternatePaths.length} Archiv-Orten">🗄️ ${1 + item.alternatePaths.length} Orte</span>`
      : '';

  const headerMeta = [];
  if (item.mainCategory) headerMeta.push(`<span><strong>Kategorie:</strong> ${escapeHTML(item.mainCategory)}</span>`);
  if (item.publisher) headerMeta.push(`<span><strong>Herausgeber:</strong> ${escapeHTML(item.publisher)}</span>`);
  if (effectivePkgId)
    headerMeta.push(`<span><strong>Paket-ID:</strong> <code>${escapeHTML(effectivePkgId)}</code></span>`);

  const postDownloadBanner = freshDownload
    ? `
      <div class="detail-inline-banner is-success">
        <div class="banner-text">
          <strong>✅ Download im Archiv gespeichert!</strong>
          <span>Datei: <code>${escapeHTML(getBaseName(freshDownload.filePath))}</code></span>
        </div>
        <button type="button" class="btn btn-local" data-detail-action="install-fresh" data-file="${escapeHTML(freshDownload.filePath)}" data-version="${escapeHTML(freshDownload.version || '')}">
          ▶️ Jetzt installieren
        </button>
      </div>
    `
    : '';

  const pinnedNotice =
    item.inArchive && item.hasPinnedLast && onlineReady
      ? `
      <label class="detail-pin-choice">
        <input type="checkbox" id="detailSaveIntoLast">
        <span><code>_last</code>-Ordner ist aktiv (gepinnte Version). Neuen Web-Download ebenfalls in <code>_last</code> speichern?</span>
      </label>
    `
      : '';

  const packageProfileHtml = hasPackageProfile
    ? `
      <section class="pkg-profile-card">
        <div class="pkg-profile-head">
          <div class="pkg-profile-title">
            <h4>📦 Paketmanager-Steckbrief (${escapeHTML(provMeta.label || 'Provider')})</h4>
            <span id="pkgProfileCacheBadge" class="pkg-cache-meta">Lade...</span>
          </div>
          <button type="button" class="btn btn-ghost btn-xs" id="btnRefreshPkgProfile" data-detail-action="refresh-pkg-profile" title="Steckbrief neu abrufen">🔄 Aktualisieren</button>
        </div>
        <div id="pkgProfileBody">
          <span class="muted">⏳ Lade Paket-Informationen aus Cache / ${escapeHTML(provMeta.label || 'Provider')}...</span>
        </div>
      </section>
    `
    : '';

  const footerLeftBtns = [];
  if (item.inArchive && item.path) {
    footerLeftBtns.push(
      '<button type="button" class="btn btn-ghost" data-detail-action="open-folder">📂 Archiv-Ordner</button>'
    );
  } else if (item.installLocation) {
    footerLeftBtns.push(
      '<button type="button" class="btn btn-ghost" data-detail-action="open-install-dir">📂 Installationsordner</button>'
    );
  }

  modal.innerHTML = `
    <div class="modal-header detail-header">
      <div class="detail-head-main">
        ${iconHtml}
        <div class="detail-head-text">
          <div class="detail-title-row">
            <h2>${escapeHTML(item.name)}</h2>
            ${statusBadge ? `<span class="status-pill ${statusBadge.cls}">${escapeHTML(statusBadge.label)}</span>` : ''}
            ${extraProviderChip}
            ${originChip}
            ${inArchiveRemoteChip}
            ${offlineArchiveChip}
            ${multiRootChip}
            ${nvmActiveChip}
            ${newChip}
            ${typeChip}
            ${keepChip}
            ${installModeChip}
          </div>
          ${headerMeta.length > 0 ? `<div class="detail-meta-inline">${headerMeta.join('')}</div>` : ''}
        </div>
      </div>
      <button type="button" class="icon-btn" data-detail-action="close" title="Schließen" aria-label="Schließen">✕</button>
    </div>

    <nav class="modal-tabs detail-tabs" role="tablist">
      <button type="button" class="tab-btn ${initialTab === 'overview' ? 'active' : ''}" data-detail-tab="overview">✨ Übersicht</button>
      <button type="button" class="tab-btn ${initialTab === 'changelog' ? 'active' : ''}" data-detail-tab="changelog">
        📋 Changelog ${st.hasWebUpdate && supportsChangelog ? `<span class="detail-tab-badge">Neu</span>` : ''}
      </button>
      <button type="button" class="tab-btn ${initialTab === 'archive-tech' ? 'active' : ''}" data-detail-tab="archive-tech">📂 Archiv & Technik</button>
    </nav>

    <div class="modal-body detail-body">
      <section class="tab-panel" data-detail-panel="overview" ${initialTab === 'overview' ? '' : 'hidden'}>
        ${buildVersionGridHtml(item, st, { matchedArchive })}
        ${postDownloadBanner}
        ${buildHeroBarHtml(item, st, { provMeta, canUninstall, matchedArchive })}
        ${buildInstallModeToggleHtml({
          item,
          st,
          canProviderInstall,
          hasFreshDownload: Boolean(freshDownload),
          selectedMode: selectedInstallMode,
          isSilentLocked,
          lockTooltip: initialModeState.lockTooltip,
        })}
        ${buildArchiveSaveChoiceHtml(item, st, { effectivePkgId, canArchiveDownload, matchedArchive })}
        ${pinnedNotice}
        ${packageProfileHtml}
        ${buildCustomMetaSectionHtml(metaSource, hasPackageProfile)}
      </section>

      <section class="tab-panel" data-detail-panel="changelog" ${initialTab === 'changelog' ? '' : 'hidden'}>
        <div id="detailChangelogBody" class="changelog-body">
          ${
            supportsChangelog
              ? '<span class="muted">Wird beim Öffnen geladen...</span>'
              : '<span class="muted">Für diese Quelle sind keine automatischen Changelogs verfügbar.</span>'
          }
        </div>
      </section>

      <section class="tab-panel" data-detail-panel="archive-tech" ${initialTab === 'archive-tech' ? '' : 'hidden'}>
        ${buildArchiveTechTabHtml(item, { effectivePm, effectivePkgId, matchedArchive })}
      </section>
    </div>

    <div class="modal-footer">
      <div class="footer-group">${footerLeftBtns.join('')}</div>
      <div class="footer-group">
        ${item.inArchive ? '<button type="button" class="btn btn-ghost" data-detail-action="edit">✏️ Bearbeiten</button>' : ''}
        <button type="button" class="btn btn-primary" data-detail-action="close">Schließen</button>
      </div>
    </div>
  `;

  overlay.hidden = false;

  let loadedPkgProfile = null;
  let changelogLoaded = false;

  const isStillActive = () => renderToken === activeRenderToken && !overlay.hidden;

  const loadPackageProfile = async (forceRefresh = false) => {
    if (!hasPackageProfile) return;
    const bodyEl = modal.querySelector('#pkgProfileBody');
    const badgeEl = modal.querySelector('#pkgProfileCacheBadge');
    const refreshBtn = modal.querySelector('#btnRefreshPkgProfile');
    if (!bodyEl) return;

    if (refreshBtn instanceof HTMLButtonElement) refreshBtn.disabled = true;
    if (badgeEl) badgeEl.textContent = forceRefresh ? 'Aktualisiere...' : 'Lade...';
    if (forceRefresh) {
      bodyEl.innerHTML = `<span class="muted">⏳ Frage aktuelle Paketdaten von ${escapeHTML(provMeta.label || 'Provider')} ab...</span>`;
    }

    const res = await window.electronAPI.showPackage(effectivePm, effectivePkgId, { forceRefresh });
    if (!isStillActive()) return;

    if (refreshBtn instanceof HTMLButtonElement) refreshBtn.disabled = false;

    if (res?.success && res.package) {
      loadedPkgProfile = res.package;
      const meta = renderPackageProfileBody(bodyEl, res.package, {
        fromCache: res.fromCache,
        isStale: res.isStale,
        updatedAt: res.updatedAt,
        fallbackPm: effectivePm,
        fallbackPkgId: effectivePkgId,
      });
      if (badgeEl) badgeEl.textContent = meta.cacheLabel;

      const onlineEl = modal.querySelector('#detailOnlineVerVal');
      if (onlineEl && res.package.version && !st.webVersion) {
        onlineEl.textContent = `v${res.package.version}`;
      }

      const techInstallerSlot = modal.querySelector('#detailTechInstallerRows');
      if (techInstallerSlot) {
        const extraRows = [];
        if (res.package.installerType) {
          extraRows.push(
            `<div class="tech-row"><span>Installer-Typ</span><code>${escapeHTML(res.package.installerType)}</code></div>`
          );
        }
        if (res.package.releaseDate) {
          extraRows.push(
            `<div class="tech-row"><span>Freigabedatum</span><code>${escapeHTML(res.package.releaseDate)}</code></div>`
          );
        }
        if (res.package.sha256) {
          extraRows.push(
            `<div class="tech-row"><span>SHA-256</span><code>${escapeHTML(res.package.sha256)}</code></div>`
          );
        }
        techInstallerSlot.innerHTML = extraRows.join('');
      }

      if (!item.icon && (res.package.homepage || res.package.publisherUrl)) {
        window.electronAPI
          .extractCachedAppIcon({
            id: item.id,
            name: item.name || '',
            displayIcon: item.displayIcon || '',
            installLocation: item.installLocation || '',
            executablePath: item.validInstallPath || item.autoPaths?.[0] || item.installPaths?.[0] || '',
            uninstallString: item.uninstallString || '',
            packageManager: effectivePm,
            packageId: effectivePkgId,
            homepage: res.package.homepage || res.package.publisherUrl || '',
            webVersionUrl: item.webVersionUrl || '',
            links: Array.isArray(item.links) ? item.links : [],
          })
          .then((iconRes) => {
            if (!iconRes?.success || !iconRes.iconPath) return;
            state.pcIconCache.set(item.id, iconRes.iconPath);
            if (item.pcApp?.id) state.pcIconCache.set(item.pcApp.id, iconRes.iconPath);
            item.icon = iconRes.iconPath;

            if (isStillActive()) {
              const fallbackEl = modal.querySelector('.detail-icon-fallback');
              if (fallbackEl) {
                const img = document.createElement('img');
                img.className = 'detail-icon';
                img.src = toMediaUrl(iconRes.iconPath);
                img.alt = '';
                fallbackEl.replaceWith(img);
              }
            }

            const gridCard = document.querySelector(`#grid .card[data-id="${CSS.escape(item.id)}"]`);
            const cardFallback = gridCard?.querySelector('.card-icon-fallback');
            if (cardFallback) {
              const img = document.createElement('img');
              img.className = 'card-icon';
              img.src = toMediaUrl(iconRes.iconPath);
              img.loading = 'lazy';
              img.decoding = 'async';
              img.alt = '';
              cardFallback.replaceWith(img);
            }
          })
          .catch(() => {
            // Platzhalter bleibt stehen
          });
      }
    } else {
      if (badgeEl) badgeEl.textContent = 'Nicht verfügbar';
      bodyEl.innerHTML = `<span class="muted">${escapeHTML(res?.error || 'Paket-Steckbrief konnte nicht geladen werden.')}</span>`;
    }
  };

  const loadChangelog = async () => {
    if (!supportsChangelog || changelogLoaded) return;
    changelogLoaded = true;

    const bodyEl = modal.querySelector('#detailChangelogBody');
    if (!bodyEl) return;
    bodyEl.innerHTML = '<span class="muted">⏳ Lade Versionshinweise...</span>';

    const res = await window.electronAPI.fetchChangelog({
      id: item.id,
      webSourceType: item.webSourceType,
      packageManager: effectivePm,
      packageId: effectivePkgId,
      wingetId: isWingetPkg ? effectivePkgId : item.wingetId,
      webVersionUrl: item.webVersionUrl,
    });
    if (!isStillActive()) return;

    if (!res?.success) {
      bodyEl.innerHTML = `<span class="muted">${escapeHTML(res?.error || 'Kein Changelog verfügbar.')}</span>`;
      return;
    }

    if (!res.entries?.length) {
      bodyEl.innerHTML = `
        <div class="changelog-empty">
          <span class="muted">Keine direkten Versionshinweise hinterlegt.</span>
          ${res.externalUrl ? `<button type="button" class="inline-link" data-open-url="${escapeHTML(res.externalUrl)}">Im Browser öffnen ↗</button>` : ''}
        </div>
      `;
      return;
    }

    const depth = state.settings.versionCompareDepth ?? 3;
    const entriesHtml = res.entries
      .map((entry) => {
        const isNewerThanPc =
          st.localVersion && entry.version && compareVersions(entry.version, st.localVersion, depth) > 0;
        return `
          <article class="changelog-entry ${isNewerThanPc ? 'is-unread' : ''}">
            <div class="changelog-entry-head">
              <strong>${escapeHTML(entry.title)}</strong>
              <div class="changelog-entry-meta">
                ${isNewerThanPc ? '<span class="changelog-tag-new">Neu seit deiner PC-Version</span>' : ''}
                ${entry.date ? `<span class="muted">${escapeHTML(entry.date)}</span>` : ''}
                ${entry.url ? `<button type="button" class="inline-link" data-open-url="${escapeHTML(entry.url)}">Original ↗</button>` : ''}
              </div>
            </div>
            <div class="changelog-markdown">${renderMarkdownSafe(entry.body)}</div>
          </article>
        `;
      })
      .join('');

    bodyEl.innerHTML = `
      <div class="changelog-source-row">
        <span class="muted">Quelle: ${escapeHTML(res.source)}</span>
        ${res.externalUrl ? `<button type="button" class="inline-link" data-open-url="${escapeHTML(res.externalUrl)}">Alle Releases ansehen ↗</button>` : ''}
      </div>
      ${entriesHtml}
    `;
  };

  if (hasPackageProfile) {
    loadPackageProfile(false);
  }
  if (initialTab === 'changelog') {
    loadChangelog();
  }

  const switchDetailTab = (tabName) => {
    modal.querySelectorAll('[data-detail-tab]').forEach((b) => {
      if (b instanceof HTMLElement) {
        b.classList.toggle('active', b.dataset.detailTab === tabName);
      }
    });
    modal.querySelectorAll('[data-detail-panel]').forEach((p) => {
      if (p instanceof HTMLElement) {
        p.hidden = p.dataset.detailPanel !== tabName;
      }
    });
    if (tabName === 'changelog') {
      loadChangelog();
    }
  };

  const buildArchivePayloadFromItem = () => {
    const installPaths = item.installLocation ? [item.installLocation] : item.installPaths || [];
    return {
      packageManager: effectivePm,
      packageId: effectivePkgId,
      name: loadedPkgProfile?.name || item.name,
      version: loadedPkgProfile?.version || st.webVersion || st.localVersion || '',
      description: loadedPkgProfile?.description || loadedPkgProfile?.shortDescription || item.shortDescription || '',
      tags: loadedPkgProfile?.tags || item.tags || [],
      homepage: loadedPkgProfile?.homepage || '',
      releaseNotesUrl: loadedPkgProfile?.releaseNotesUrl || '',
      searchNames: item.name ? [item.name] : [],
      installPaths,
    };
  };

  const getSelectedArchiveFile = () => {
    const sel = modal.querySelector('#detailFileSelect');
    const idx = sel instanceof HTMLSelectElement ? parseInt(sel.value, 10) : 0;
    return item.lastFiles?.[idx] || item.lastFiles?.[0] || null;
  };

  const runInstallerFlow = async (filePath, targetVersion) => {
    if (!filePath) return;
    const useSilent = !isSilentLocked && selectedInstallMode === 'silent';
    showToast(`Starte Setup für ${item.name} (${useSilent ? 'Silent' : 'Interaktiv'})...`, { type: 'info' });
    const res = await window.electronAPI.executeInstaller({
      itemId: item.id,
      itemName: item.name,
      sourcePath: filePath,
      targetVersion: targetVersion || null,
      allowSilent: useSilent,
      silent: useSilent,
    });

    if (res.alreadyRunning) {
      showToast('Für dieses Programm läuft bereits eine Installation.', { type: 'warn' });
      return;
    }

    await triggerCatalogReload({ rescanInstalled: Boolean(res.success) });
    if (isStillActive()) {
      renderDetailModal(item.id);
    }

    if (res.success && res.verified) {
      showToast(`${item.name} erfolgreich auf v${res.newVersion} aktualisiert!`, { type: 'success' });
    } else if (res.canceled) {
      showToast('Installation wurde abgebrochen.', { type: 'info' });
    } else if (res.success && res.status === 'opened') {
      showToast('Archiv-Datei wurde geöffnet.', { type: 'info' });
    } else if (!res.success && res.error) {
      showToast(`Installationsfehler: ${res.error}`, { type: 'error', duration: 6000 });
    }
  };

  const runWebDownloadFlow = async () => {
    const saveLastEl = modal.querySelector('#detailSaveIntoLast');
    const saveIntoLastFolder = saveLastEl instanceof HTMLInputElement ? saveLastEl.checked : false;
    const res = await window.electronAPI.downloadWebUpdate(item, { saveIntoLastFolder });

    if (res.alreadyRunning) {
      showToast('Download läuft bereits.', { type: 'info' });
      return;
    }
    if (res.canceled) return;
    if (!res.success) {
      showToast(`Download fehlgeschlagen: ${res.error}`, { type: 'error', duration: 6000 });
      return;
    }

    await triggerCatalogReload();
    showToast(`${item.name} wurde im Archiv gespeichert.`, { type: 'success' });
    if (isStillActive()) {
      renderDetailModal(item.id, { freshDownload: { filePath: res.filePath, version: res.version } });
    }
  };

  const runProviderInstallFlow = async (btn) => {
    if (!canProviderInstall) return;
    const archiveCheck = modal.querySelector('#detailAlsoSaveArchive');
    const shouldSaveToArchive =
      canArchiveDownload && archiveCheck instanceof HTMLInputElement ? archiveCheck.checked : false;

    let archiveTargetSpec = null;
    if (shouldSaveToArchive) {
      const targetMode = state.settings.archiveSaveMode === 'auto-id' ? 'auto-id' : 'ask';
      archiveTargetSpec = await resolveArchiveSaveTarget(buildArchivePayloadFromItem(), { mode: targetMode });
      if (archiveTargetSpec.canceled) {
        return;
      }
    }

    const useSilent = !isSilentLocked && selectedInstallMode === 'silent';
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = item.isInstalled ? '⏳ Aktualisiere...' : '⏳ Installiere...';
    showToast(
      `Starte ${provMeta.label || effectivePm}-${item.isInstalled ? 'Aktualisierung' : 'Installation'} für ${item.name} (${useSilent ? 'Silent' : 'Interaktiv'})...`,
      {
        type: 'info',
      }
    );

    const res = await window.electronAPI.installPackage(effectivePm, effectivePkgId, {
      upgrade: item.isInstalled && st.hasWebUpdate,
      silent: useSilent,
      itemName: item.name,
    });

    btn.disabled = false;
    btn.textContent = origText;

    if (res?.alreadyRunning) {
      showToast('Für dieses Paket läuft bereits eine Installation.', { type: 'warn' });
      return;
    }
    if (res?.canceled) {
      showToast('Vorgang wurde abgebrochen.', { type: 'info' });
      return;
    }
    if (!res?.success) {
      showToast(`Fehler: ${res?.error || 'Unbekannter Fehler'}`, { type: 'error', duration: 6000 });
      return;
    }

    showToast(`${item.name} erfolgreich ${item.isInstalled ? 'aktualisiert' : 'installiert'}!`, { type: 'success' });

    if (shouldSaveToArchive && archiveTargetSpec && !archiveTargetSpec.skipped) {
      const linkRes = await executeArchiveLink(buildArchivePayloadFromItem(), archiveTargetSpec, {
        downloadSetup: true,
      });
      await triggerCatalogReload({ rescanInstalled: true });
      if (linkRes?.success && linkRes.item?.id && isStillActive()) {
        renderDetailModal(linkRes.item.id);
        return;
      }
    } else {
      await triggerCatalogReload({ rescanInstalled: true });
    }

    if (isStillActive()) {
      if (item.origin === 'remote') {
        renderRemoteDetailModal(effectivePm, effectivePkgId, loadedPkgProfile || item);
      } else {
        renderDetailModal(item.id);
      }
    }
  };

  modal.onclick = async (e) => {
    if (!(e.target instanceof Element)) return;

    const anchor = e.target.closest('a[href]');
    if (anchor instanceof HTMLAnchorElement) {
      e.preventDefault();
      window.electronAPI.openUrl(anchor.href);
      return;
    }

    const urlBtn = e.target.closest('[data-open-url]');
    if (urlBtn instanceof HTMLElement) {
      window.electronAPI.openUrl(urlBtn.dataset.openUrl);
      return;
    }

    const thumb = e.target.closest('[data-lightbox-idx]');
    if (thumb instanceof HTMLElement) {
      openLightbox(item.id, parseInt(thumb.dataset.lightboxIdx || '0', 10));
      return;
    }

    const tabBtn = e.target.closest('[data-detail-tab]');
    if (tabBtn instanceof HTMLElement) {
      switchDetailTab(tabBtn.dataset.detailTab);
      return;
    }

    const modeBtn = e.target.closest('[data-detail-install-mode]');
    if (modeBtn instanceof HTMLElement) {
      const requested = modeBtn.dataset.detailInstallMode;
      if (isSilentLocked && requested === 'silent') return;
      if (requested === 'interactive' || requested === 'silent') {
        selectedInstallMode = requested;
        modal.querySelectorAll('[data-detail-install-mode]').forEach((b) => {
          if (!(b instanceof HTMLElement)) return;
          const active = b.dataset.detailInstallMode === selectedInstallMode;
          b.classList.toggle('active', active);
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
      }
      return;
    }

    const btn = e.target.closest('[data-detail-action]');
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.dataset.detailAction;

    if (action === 'close') {
      closeModal();
    } else if (action === 'edit' && item.inArchive) {
      openEditModal(item.id);
    } else if (action === 'open-folder' && item.path) {
      window.electronAPI.openPath(item.path);
    } else if (action === 'open-install-dir' && item.installLocation) {
      window.electronAPI.openPath(item.installLocation);
    } else if (action === 'open-archive-item' && matchedArchive) {
      renderDetailModal(matchedArchive.id);
    } else if (action === 'launch-local' && item.validInstallPath) {
      window.electronAPI.openPath(item.validInstallPath);
    } else if (action === 'refresh-pkg-profile') {
      await loadPackageProfile(true);
    } else if (action === 'web-download') {
      await runWebDownloadFlow();
    } else if (action === 'install-file' || action === 'install-fresh') {
      await runInstallerFlow(btn.dataset.file, btn.dataset.version);
    } else if (action === 'run-selected') {
      await runInstallerFlow(getSelectedArchiveFile(), null);
    } else if (action === 'copy-selected') {
      const file = getSelectedArchiveFile();
      if (!file) return;
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      const res = await window.electronAPI.copyFilesToPc([file]);
      if (btn instanceof HTMLButtonElement) btn.disabled = false;
      if (res.success) showToast(`Gespeichert unter: ${res.dest}`, { type: 'success' });
      else if (res.error) showToast(`Kopierfehler: ${res.error}`, { type: 'error' });
    } else if (action === 'provider-install') {
      await runProviderInstallFlow(btn);
    } else if (action === 'nvm-use' && effectivePm === 'nvm' && effectivePkgId) {
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      const origText = btn.textContent || '';
      btn.textContent = '⏳ Aktiviere Node-Version...';
      showToast(`Aktiviere Node.js v${effectivePkgId} über NVM...`, { type: 'info' });

      const res = await window.electronAPI.useNvmVersion(effectivePkgId);
      if (isStillActive() && btn instanceof HTMLButtonElement) {
        btn.disabled = false;
        btn.textContent = origText;
      }

      if (res?.alreadyRunning) {
        showToast('Es wird bereits eine Node-Version umgeschaltet.', { type: 'warn' });
      } else if (res?.canceled) {
        showToast('Umschalten wurde abgebrochen.', { type: 'info' });
      } else if (res?.success) {
        showToast(`Node.js v${effectivePkgId} ist jetzt aktiv!`, { type: 'success' });
        await triggerCatalogReload({ rescanInstalled: true });
        if (isStillActive()) {
          if (item.origin === 'remote') {
            renderRemoteDetailModal(effectivePm, effectivePkgId, loadedPkgProfile || item);
          } else {
            renderDetailModal(item.id);
          }
        }
      } else {
        showToast(`NVM-Fehler: ${res?.error || 'Node-Version konnte nicht aktiviert werden.'}`, {
          type: 'error',
          duration: 6000,
        });
      }
    } else if (action === 'save-to-archive') {
      const targetMode = state.settings.archiveSaveMode === 'auto-id' ? 'auto-id' : 'ask';
      const res = await savePackageToArchive(buildArchivePayloadFromItem(), {
        mode: targetMode,
        downloadSetup: canArchiveDownload,
      });
      if (res?.success && res.item?.id && isStillActive()) {
        renderDetailModal(res.item.id);
      }
    } else if (action === 'uninstall') {
      if (btn.dataset.armed !== 'true') {
        btn.dataset.armed = 'true';
        btn.dataset.origText = btn.textContent || '';
        btn.textContent = '⚠️ Wirklich deinstallieren?';
        setTimeout(() => {
          if (btn.dataset.armed === 'true') {
            btn.dataset.armed = 'false';
            btn.textContent = btn.dataset.origText || '';
          }
        }, 4000);
        return;
      }

      btn.dataset.armed = 'false';
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      btn.textContent = '⏳ Deinstalliere...';

      const res = await window.electronAPI.uninstallSoftware({
        packageManager: effectivePm,
        packageId: effectivePkgId,
        uninstallString: item.uninstallString,
        quietUninstallString: item.quietUninstallString,
        itemName: item.name,
        archiveItemId: item.archiveItemId || (item.inArchive ? item.id : null),
        silent: false,
      });

      if (btn instanceof HTMLButtonElement) btn.disabled = false;
      btn.textContent = btn.dataset.origText || '🗑️ Deinstallieren';

      if (res?.alreadyRunning) {
        showToast('Deinstallation läuft bereits.', { type: 'warn' });
      } else if (res?.canceled) {
        showToast('Deinstallation abgebrochen.', { type: 'info' });
      } else if (res?.success) {
        showToast(`${item.name} wurde deinstalliert.`, { type: 'success' });
        await triggerCatalogReload({ rescanInstalled: true });
        if (item.inArchive) {
          if (isStillActive()) renderDetailModal(item.id);
        } else {
          closeModal();
        }
      } else {
        showToast(`Deinstallationsfehler: ${res?.error || 'Unbekannter Fehler'}`, { type: 'error', duration: 6000 });
      }
    }
  };
}

export function renderDetailModal(id, options = {}) {
  const item = getItemById(id);
  if (!item) return;
  renderDetailModalCore(item, options);
}

export function renderRemoteDetailModal(providerId, packageId, summary = {}, options = {}) {
  const providerObj = state.providers.find((p) => p.id === providerId);
  const remoteItem = buildRemotePackageItem({
    providerId,
    packageId,
    summary,
    providerName: providerObj?.name || summary.providerName || providerId,
    existingPackages: state.packages,
  });
  renderDetailModalCore(remoteItem, options);
}
