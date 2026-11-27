import { isIdLikeDisplayName } from '../../shared/installed-merger.js';
import { getInstallModeBadge, resolveDetailInstallMode } from '../../shared/installer-logic.js';
import { formatMultiRootFileLabel, sortArchiveSetupFiles } from '../../shared/multi-archive-logic.js';
import { filterUsableProviders } from '../../shared/provider-lifecycle-logic.js';
import { buildRemotePackageItem, canDownloadOnline } from '../../shared/unified-packages.js';
import { compareVersions, extractVersion } from '../../shared/version.js';
import { getCachedIconForPackage, queueItemsForIconResolution } from '../components/cards.js';
import { openLightbox } from '../components/lightbox.js';
import { showToast } from '../components/toast.js';
import { evaluateItemPolicy, getBaseName, getItemById, getItemStatus, isItemNew, state } from '../state.js';
import { getI18nLocale, getLocalizedPolicyError, getLocalizedProviderBadge, t } from '../utils/i18n.js';
import { renderMarkdownSafe } from '../utils/markdown.js';
import { escapeHTML, sanitizeRichHtml, toMediaUrl } from '../utils/sanitize.js';
import { executeArchiveLink, resolveArchiveSaveTarget, savePackageToArchive } from './archive-target-modal.js';
import { closeModal, openEditModal, resetModalContent, triggerCatalogReload } from './index.js';
import { ensureAdminAuthenticated } from './login-modal.js';

function getSourceLabel(sourceType) {
  if (sourceType === 'winget') return t('detail.sourceWinget');
  if (sourceType === 'provider') return t('detail.sourceProvider');
  if (sourceType === 'github') return t('detail.sourceGithub');
  if (sourceType === 'web') return t('detail.sourceWeb');
  return '';
}

function getStatusBadge(status) {
  if (status === 'webupdate') return { label: t('detail.statusWebUpdate'), cls: 'is-webupdate' };
  if (status === 'update') return { label: t('detail.statusArchiveUpdate'), cls: 'is-update' };
  if (status === 'installed') return { label: t('detail.statusInstalled'), cls: 'is-installed' };
  if (status === 'newer') return { label: t('detail.statusNewer'), cls: 'is-newer' };
  return null;
}

function getOriginChip(origin) {
  if (origin === 'both') return { label: t('detail.originBoth'), cls: '' };
  if (origin === 'archive') return { label: t('detail.originArchive'), cls: 'chip-origin-archive' };
  if (origin === 'pc') return { label: t('detail.originPc'), cls: 'chip-origin-pc' };
  return null;
}

let activeRenderToken = 0;

function formatCacheTimestamp(ts) {
  if (!ts) return '';
  try {
    return new Intl.DateTimeFormat(getI18nLocale() || 'en', {
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
  const badge = getLocalizedProviderBadge(cleanPm, state.providers);
  return {
    provider: prov,
    label: badge?.label || (cleanPm === 'winget' ? 'Winget' : cleanPm),
    badge,
    canInstall: prov ? Boolean(prov.capabilities?.install) : cleanPm === 'winget',
    canShow: prov ? Boolean(prov.capabilities?.show) : cleanPm === 'winget',
    canUninstall: prov ? Boolean(prov.capabilities?.uninstall) : cleanPm === 'winget',
    canListVersions: prov ? Boolean(prov.capabilities?.listVersions) : cleanPm === 'winget',
    supportsArchiveDownload: prov ? Boolean(prov.capabilities?.supportsArchiveDownload) : cleanPm === 'winget',
  };
}

function normalizeCompareName(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/\s+\(?(?:x64|x86|64-bit|32-bit|current user|user|portable)\)?/gi, '')
    .replace(/\s+v?\d+(?:\.\d+)+.*$/i, '')
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim();
}

function buildAvailableInstallSources(
  item,
  { sortedLastFiles, st, effectivePm, effectivePkgId, provMeta, matchedArchive, discoveredSources = [] }
) {
  const sources = [];
  const seenKeys = new Set();

  const archiveTarget = item.inArchive ? item : matchedArchive;
  const archiveFiles = item.inArchive
    ? sortedLastFiles
    : sortArchiveSetupFiles(matchedArchive?.lastFiles || [], matchedArchive?.lastFileSources || {});

  if (archiveTarget && archiveFiles.length > 0) {
    const firstArchiveVer =
      st.archiveVersion || (archiveFiles[0] ? extractVersion(getBaseName(archiveFiles[0])) || '' : '');
    seenKeys.add('archive');
    sources.push({
      key: 'archive',
      kind: 'archive',
      label: t('providers.names.archive'),
      badgeClass: 'is-archive',
      version: firstArchiveVer,
      files: archiveFiles,
      archiveItem: archiveTarget,
    });
  }

  const pushProviderSource = ({ providerId, packageId, version = '' }) => {
    const pm = String(providerId || '')
      .trim()
      .toLowerCase();
    const pid = String(packageId || '').trim();
    if (!pm || pm === 'archive' || !pid) return;
    const pMeta = getProviderMeta(pm);
    if (!pMeta.canInstall) return;
    const key = `provider:${pm}:${pid.toLowerCase()}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    sources.push({
      key,
      kind: 'provider',
      providerId: pm,
      packageId: pid,
      label: pMeta.label || pm,
      badgeClass: pMeta.badge?.badgeClass || `is-${pm}`,
      version: String(version || '').trim(),
      provMeta: pMeta,
    });
  };

  if (effectivePm && effectivePm !== 'archive' && effectivePkgId && provMeta.canInstall) {
    pushProviderSource({
      providerId: effectivePm,
      packageId: effectivePkgId,
      version: st.webVersion || '',
    });
  }

  // Weitere bereits im Katalog / auf dem PC bekannte Paketmanager-Quellen für dieselbe Software einsammeln
  const normItemName = normalizeCompareName(item.name);
  const itemArchiveId = item.inArchive ? item.id : matchedArchive?.id || '';
  for (const pkg of state.packages || []) {
    if (!pkg || pkg.id === item.id) continue;
    const pkgPm = getEffectivePackageManager(pkg);
    const pkgId = getEffectivePackageId(pkg);
    if (!pkgPm || pkgPm === 'archive' || !pkgId) continue;

    const sameArchive = Boolean(itemArchiveId && (pkg.id === itemArchiveId || pkg.archiveItemId === itemArchiveId));
    const sameName = Boolean(normItemName.length >= 3 && normalizeCompareName(pkg.name) === normItemName);
    if (!sameArchive && !sameName) continue;

    pushProviderSource({
      providerId: pkgPm,
      packageId: pkgId,
      version: pkg.webVersion || pkg.installedVersion || '',
    });
  }

  for (const extra of discoveredSources || []) {
    pushProviderSource(extra);
  }

  return sources;
}

function isCanUninstall(item, provMeta, effectivePkgId) {
  if (!item.isInstalled) return false;
  if (item.canUninstall || item.uninstallString || item.quietUninstallString) return true;
  return item.softwareType !== 'portable' && provMeta.canUninstall && Boolean(effectivePkgId);
}

function buildArchiveHeroAction(item, st, { selectedFile = null, isExplicitArchiveSource = false } = {}) {
  const onlineReady = canDownloadOnline(item);
  const firstFile = selectedFile || item.lastFiles?.[0] || null;
  const chosenVer = (firstFile ? extractVersion(getBaseName(firstFile)) : '') || st.archiveVersion || '';

  if (!isExplicitArchiveSource && st.hasWebUpdate && onlineReady) {
    return {
      action: 'web-download',
      label: `⬇️ ${t('detail.heroWebDownload', { version: st.webVersion })}`,
      cls: 'btn-online',
    };
  }

  if (firstFile && isExplicitArchiveSource) {
    if (item.isInstalled) {
      return {
        action: 'install-file',
        file: firstFile,
        version: chosenVer,
        label: chosenVer
          ? `⬆️ ${t('detail.heroArchiveUpdateVer', { version: chosenVer })}`
          : `▶️ ${t('detail.heroArchiveInstallGeneric')}`,
        cls: 'btn-archive',
      };
    }
    return {
      action: 'install-file',
      file: firstFile,
      version: chosenVer,
      label: chosenVer
        ? `▶️ ${t('detail.heroArchiveInstallVer', { version: chosenVer })}`
        : `▶️ ${t('detail.heroArchiveInstallGeneric')}`,
      cls: 'btn-primary',
    };
  }

  if (st.hasArchiveUpdate && firstFile) {
    return {
      action: 'install-file',
      file: firstFile,
      version: chosenVer,
      label: `⬆️ ${t('detail.heroInstallFileUpdate', { version: chosenVer })}`,
      cls: 'btn-archive',
    };
  }

  if (!item.isInstalled && firstFile) {
    return {
      action: 'install-file',
      file: firstFile,
      version: chosenVer,
      label: chosenVer
        ? `▶️ ${t('detail.heroInstallFileVersion', { version: chosenVer })}`
        : `▶️ ${t('detail.heroInstallFileGeneric')}`,
      cls: 'btn-primary',
    };
  }

  if (item.isInstalled && item.validInstallPath) {
    return {
      action: 'launch-local',
      label: `🚀 ${t('detail.heroLaunchLocal')}`,
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
    return `<button type="button" class="btn btn-ghost" disabled>✅ ${escapeHTML(t('detail.heroNvmActive'))}</button>`;
  }
  const sizeCls = large ? 'btn-lg ' : '';
  return `<button type="button" class="btn ${sizeCls}btn-local" data-detail-action="nvm-use">✅ ${escapeHTML(t('detail.heroNvmUse', { version: pkgVer }))}</button>`;
}

function buildHeroBarHtml(
  item,
  st,
  { provMeta, canUninstall, matchedArchive, policyEval = null, activeSource = null, hasSourceChoice = false }
) {
  const buttons = [];
  const onlineReady = canDownloadOnline(item);
  const blockedByPolicy = Boolean(policyEval && !policyEval.allowed);
  const blockedAttr = blockedByPolicy
    ? `disabled title="${escapeHTML(getLocalizedPolicyError(policyEval, 'policy.blockedDefault'))}"`
    : '';

  if (activeSource?.kind === 'provider') {
    const srcProvLabel = activeSource.label || provMeta.label || t('detail.sourceProvider');
    const srcVer = activeSource.version || st.webVersion || '';
    let installLabel;
    if (item.isInstalled && srcVer) {
      installLabel = `⬆️ ${t('detail.heroProviderUpdateVer', { provider: srcProvLabel, version: srcVer })}`;
    } else if (item.isInstalled) {
      installLabel = `⬆️ ${t('detail.heroProviderUpdate', { provider: srcProvLabel })}`;
    } else if (srcVer) {
      installLabel = `⬇️ ${t('detail.heroProviderInstallVer', { provider: srcProvLabel, version: srcVer })}`;
    } else {
      installLabel = `⬇️ ${t('detail.heroProviderInstall', { provider: srcProvLabel })}`;
    }
    buttons.push(
      `<button type="button" class="btn btn-lg ${item.isInstalled ? 'btn-online' : 'btn-primary'}" data-detail-action="provider-install" ${blockedAttr}>${escapeHTML(installLabel)}</button>`
    );

    const nvmBtn = buildNvmUseButtonHtml(item);
    if (nvmBtn) buttons.push(nvmBtn);

    if (item.isInstalled && item.validInstallPath) {
      buttons.push(
        `<button type="button" class="btn btn-ghost" data-detail-action="launch-local">🚀 ${escapeHTML(t('detail.heroLaunchLocal'))}</button>`
      );
    }
    if (onlineReady && item.inArchive) {
      buttons.push(
        `<button type="button" class="btn btn-ghost" data-detail-action="web-download">🌐 ${escapeHTML(t('detail.heroWebDownloadShort'))}</button>`
      );
    }
    if (!item.inArchive) {
      if (matchedArchive) {
        buttons.push(
          `<button type="button" class="btn btn-ghost" data-detail-action="open-archive-item">📂 ${escapeHTML(t('detail.heroOpenArchive'))}</button>`
        );
      } else {
        buttons.push(
          `<button type="button" class="btn btn-archive" data-detail-action="save-to-archive">📥 ${escapeHTML(t('detail.heroSaveToArchive'))}</button>`
        );
      }
    }
  } else if (activeSource?.kind === 'archive' && hasSourceChoice) {
    const hero = buildArchiveHeroAction(item, st, {
      selectedFile: activeSource.files?.[0] || null,
      isExplicitArchiveSource: true,
    });
    if (hero) {
      const heroBlockedAttr = blockedByPolicy && hero.action === 'install-file' ? blockedAttr : '';
      buttons.push(
        `<button type="button" class="btn btn-lg ${hero.cls}" data-detail-action="${hero.action}" data-file="${escapeHTML(hero.file || '')}" data-version="${escapeHTML(hero.version || '')}" ${heroBlockedAttr}>${escapeHTML(hero.label)}</button>`
      );
    }
    if (item.isInstalled && item.validInstallPath) {
      buttons.push(
        `<button type="button" class="btn btn-ghost" data-detail-action="launch-local">🚀 ${escapeHTML(t('detail.heroLaunchLocal'))}</button>`
      );
    }
    if (onlineReady && item.inArchive) {
      const dlLabel =
        st.hasWebUpdate && st.webVersion
          ? `⬇️ ${t('detail.heroWebDownload', { version: st.webVersion })}`
          : `🌐 ${t('detail.heroWebDownloadShort')}`;
      buttons.push(
        `<button type="button" class="btn btn-ghost" data-detail-action="web-download">${escapeHTML(dlLabel)}</button>`
      );
    }
  } else {
    const provLabel = provMeta.label || t('detail.sourceProvider');
    const canProviderInstall = provMeta.canInstall && Boolean(getEffectivePackageId(item));

    if (item.origin === 'remote') {
      const installLabel =
        item.isInstalled && st.hasWebUpdate
          ? `⬆️ ${t('detail.heroRemoteUpdate', { provider: provLabel, version: st.webVersion })}`
          : item.isInstalled
            ? `🔄 ${t('detail.heroRemoteReinstall', { provider: provLabel })}`
            : `⬇️ ${t('detail.heroRemoteInstall')}`;
      buttons.push(
        `<button type="button" class="btn btn-lg ${item.isInstalled && st.hasWebUpdate ? 'btn-online' : 'btn-primary'}" data-detail-action="provider-install" ${blockedAttr}>${escapeHTML(installLabel)}</button>`
      );

      const nvmBtn = buildNvmUseButtonHtml(item);
      if (nvmBtn) buttons.push(nvmBtn);

      if (matchedArchive) {
        buttons.push(
          `<button type="button" class="btn btn-ghost" data-detail-action="open-archive-item">📂 ${escapeHTML(t('detail.heroOpenArchive'))}</button>`
        );
      } else if (getEffectivePackageManager(item) !== 'archive' && getEffectivePackageId(item)) {
        buttons.push(
          `<button type="button" class="btn btn-archive" data-detail-action="save-to-archive">📥 ${escapeHTML(t('detail.heroSaveToArchive'))}</button>`
        );
      }
    } else if (item.origin === 'pc') {
      const nvmBtn = buildNvmUseButtonHtml(item, { large: true });
      if (nvmBtn) buttons.push(nvmBtn);
      if (canProviderInstall && st.hasWebUpdate) {
        buttons.push(
          `<button type="button" class="btn btn-lg btn-online" data-detail-action="provider-install" ${blockedAttr}>⬆️ ${escapeHTML(t('detail.heroPcUpdate', { provider: provLabel, version: st.webVersion }))}</button>`
        );
      } else if (!nvmBtn && item.validInstallPath) {
        buttons.push(
          `<button type="button" class="btn btn-lg btn-local" data-detail-action="launch-local">🚀 ${escapeHTML(t('detail.heroLaunchLocal'))}</button>`
        );
      }
      buttons.push(
        `<button type="button" class="btn btn-archive" data-detail-action="save-to-archive">📥 ${escapeHTML(t('detail.heroSaveToArchive'))}</button>`
      );
    } else {
      const hero = buildArchiveHeroAction(item, st);
      if (hero) {
        const heroBlockedAttr =
          blockedByPolicy && (hero.action === 'install-file' || hero.action === 'install-fresh') ? blockedAttr : '';
        buttons.push(
          `<button type="button" class="btn btn-lg ${hero.cls}" data-detail-action="${hero.action}" data-file="${escapeHTML(hero.file || '')}" data-version="${escapeHTML(hero.version || '')}" ${heroBlockedAttr}>${escapeHTML(hero.label)}</button>`
        );
      } else if (canProviderInstall) {
        const provBtnLabel =
          item.isInstalled && st.hasWebUpdate && st.webVersion
            ? `⬆️ ${t('detail.heroProviderUpdateVer', { provider: provLabel, version: st.webVersion })}`
            : item.isInstalled
              ? `⬆️ ${t('detail.heroProviderUpdate', { provider: provLabel })}`
              : `⬇️ ${t('detail.heroProviderInstall', { provider: provLabel })}`;
        buttons.push(
          `<button type="button" class="btn btn-lg ${item.isInstalled && st.hasWebUpdate ? 'btn-online' : 'btn-primary'}" data-detail-action="provider-install" ${blockedAttr}>${escapeHTML(provBtnLabel)}</button>`
        );
      }
      const nvmBtn = buildNvmUseButtonHtml(item);
      if (nvmBtn) buttons.push(nvmBtn);
      if (item.isInstalled && item.validInstallPath && hero?.action !== 'launch-local') {
        buttons.push(
          `<button type="button" class="btn btn-ghost" data-detail-action="launch-local">🚀 ${escapeHTML(t('detail.heroLaunchLocal'))}</button>`
        );
      }
      if (onlineReady && hero?.action !== 'web-download') {
        buttons.push(
          `<button type="button" class="btn btn-ghost" data-detail-action="web-download">🌐 ${escapeHTML(t('detail.heroWebDownloadShort'))}</button>`
        );
      }
    }
  }

  if (canUninstall) {
    buttons.push(
      `<button type="button" class="btn btn-danger" data-detail-action="uninstall">🗑️ ${escapeHTML(t('common.uninstall'))}</button>`
    );
  }

  if (buttons.length === 0) return '';
  return `<div class="detail-hero-bar">${buttons.join('')}</div>`;
}

function buildSourceSelectorBarHtml({ availableSources, selectedSourceKey, canDiscoverMoreSources }) {
  if (availableSources.length <= 1 && !canDiscoverMoreSources) return '';

  const chipsHtml = availableSources
    .map((src) => {
      const isSelected = src.key === selectedSourceKey;
      const verSuffix = src.version ? ` (v${src.version})` : '';
      const iconPrefix = src.kind === 'archive' ? '🗄️ ' : '';
      return `
        <button
          type="button"
          class="detail-source-chip ${isSelected ? 'active' : ''}"
          data-detail-source-key="${escapeHTML(src.key)}"
          aria-pressed="${isSelected ? 'true' : 'false'}"
        >
          <span>${iconPrefix}${escapeHTML(src.label)}${escapeHTML(verSuffix)}</span>
        </button>
      `;
    })
    .join('');

  const findMoreBtnHtml = canDiscoverMoreSources
    ? `<button type="button" class="btn btn-ghost btn-xs" id="btnDiscoverMoreSources" data-detail-action="discover-more-sources">🔎 ${escapeHTML(t('detail.sourceFindMoreBtn'))}</button>`
    : '';

  return `
    <div class="detail-source-bar">
      <span class="detail-source-label">🔀 ${escapeHTML(t('detail.sourceSelectLabel'))}</span>
      <div class="detail-source-chips" role="group" aria-label="${escapeHTML(t('detail.sourceSelectAria'))}">
        ${chipsHtml}
      </div>
      ${findMoreBtnHtml}
    </div>
  `;
}

function buildInstallModeToggleHtml({
  item,
  st,
  canProviderInstall,
  hasFreshDownload,
  selectedMode,
  isSilentLocked,
  lockTooltip,
  policyEval = null,
}) {
  const hasInstallAction =
    item.origin === 'remote' ||
    (item.origin === 'pc' && canProviderInstall && st.hasWebUpdate) ||
    (item.inArchive && (item.lastFiles?.length > 0 || hasFreshDownload || canDownloadOnline(item))) ||
    canProviderInstall;

  if (policyEval?.adwareConflict) {
    return `
      <div class="policy-conflict-banner" role="alert">
        <strong>🚫 ${escapeHTML(t('detail.policyConflictHeading'))}</strong>
        <span>${escapeHTML(getLocalizedPolicyError(policyEval, 'policy.errorAdwareConflict'))}</span>
      </div>
    `;
  }

  if (policyEval && !policyEval.allowed) {
    return `
      <div class="policy-conflict-banner" role="alert">
        <strong>🔒 ${escapeHTML(t('detail.policyLockedHeading'))}</strong>
        <span>${escapeHTML(getLocalizedPolicyError(policyEval, 'policy.blockedDefault'))}</span>
      </div>
    `;
  }

  if (!hasInstallAction) return '';

  if (policyEval?.silentOnly) {
    return `
      <div class="detail-install-mode-bar" id="detailInstallModeBar">
        <span class="detail-install-mode-label">${escapeHTML(t('detail.installModeLabel'))}</span>
        <div class="detail-mode-toggle" role="group" aria-label="${escapeHTML(t('detail.installModeAria'))}">
          <button
            type="button"
            class="detail-mode-btn active"
            data-detail-install-mode="silent"
            aria-pressed="true"
            title="${escapeHTML(t('detail.installModeSilentPolicyTitle'))}"
          >
            ⚡ ${escapeHTML(t('detail.installModeSilent'))}
          </button>
        </div>
        <span class="policy-silent-lock-pill" title="${escapeHTML(t('detail.policySilentOnlyPillTitle'))}">🔒 ${escapeHTML(t('detail.policySilentOnlyPill'))}</span>
      </div>
    `;
  }

  const isSilent = !isSilentLocked && selectedMode === 'silent';
  const silentTitle = isSilentLocked ? lockTooltip : t('detail.installModeSilentTitle');

  return `
    <div class="detail-install-mode-bar" id="detailInstallModeBar">
      <span class="detail-install-mode-label">${escapeHTML(t('detail.installModeLabel'))}</span>
      <div class="detail-mode-toggle" role="group" aria-label="${escapeHTML(t('detail.installModeAria'))}">
        <button
          type="button"
          class="detail-mode-btn ${!isSilent ? 'active' : ''}"
          data-detail-install-mode="interactive"
          aria-pressed="${!isSilent ? 'true' : 'false'}"
          title="${escapeHTML(t('detail.installModeInteractiveTitle'))}"
        >
          🖱️ ${escapeHTML(t('detail.installModeInteractive'))}
        </button>
        <button
          type="button"
          class="detail-mode-btn ${isSilent ? 'active' : ''}"
          data-detail-install-mode="silent"
          aria-pressed="${isSilent ? 'true' : 'false'}"
          ${isSilentLocked ? 'disabled' : ''}
          title="${escapeHTML(silentTitle)}"
        >
          ⚡ ${escapeHTML(t('detail.installModeSilent'))}
        </button>
      </div>
      ${
        isSilentLocked
          ? `<span class="detail-mode-lock-hint" title="${escapeHTML(lockTooltip)}">🛡️ ${escapeHTML(t('detail.adwareLockHint'))}</span>`
          : ''
      }
    </div>
  `;
}

function buildArchiveSaveChoiceHtml(item, st, { effectivePm, effectivePkgId, canArchiveDownload, matchedArchive }) {
  const hasProviderInstallBtn = item.origin === 'remote' || (item.origin === 'pc' && st.hasWebUpdate);
  if (
    !hasProviderInstallBtn ||
    !effectivePm ||
    effectivePm === 'archive' ||
    !effectivePkgId ||
    item.inArchive ||
    matchedArchive
  ) {
    return '';
  }

  const saveMode = state.settings.archiveSaveMode || 'ask';
  const checked = saveMode === 'ask' || saveMode === 'auto-id';
  let labelText = canArchiveDownload
    ? `🗄️ ${t('detail.saveChoiceSetupDefault')}`
    : `🗄️ ${t('detail.saveChoiceMetaDefault')}`;
  if (saveMode === 'auto-id') {
    labelText = canArchiveDownload
      ? `🗄️ ${t('detail.saveChoiceSetupAuto', { id: effectivePkgId })}`
      : `🗄️ ${t('detail.saveChoiceMetaAuto', { id: effectivePkgId })}`;
  } else if (saveMode === 'none') {
    labelText = canArchiveDownload ? `🗄️ ${t('detail.saveChoiceSetupOff')}` : `🗄️ ${t('detail.saveChoiceMetaOff')}`;
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
  const provBadge = effectivePm ? getLocalizedProviderBadge(effectivePm, state.providers) : null;
  const sourceLabel = getSourceLabel(item.webSourceType) || item.providerName || provBadge?.label || '';

  const archiveVersion =
    st.archiveVersion || (matchedArchive?.lastFiles?.length > 0 ? getBaseName(matchedArchive.lastFiles[0]) : '') || '';

  let archiveBoxVal = escapeHTML(t('detail.verNotInArchive'));
  if (item.inArchive || matchedArchive) {
    archiveBoxVal = st.archiveVersion
      ? `v${escapeHTML(st.archiveVersion)}`
      : archiveVersion
        ? escapeHTML(archiveVersion)
        : escapeHTML(t('detail.verNoSetupFile'));
  }

  const onlineVal = st.webVersion
    ? `v${escapeHTML(st.webVersion)}`
    : provBadge && item.origin === 'pc'
      ? escapeHTML(t('detail.verUpToDate'))
      : escapeHTML(t('detail.verNotConfigured'));

  return `
    <div class="detail-version-grid">
      <div class="detail-ver-box ${st.isPcNewer ? 'is-newer' : st.localVersion && !st.hasArchiveUpdate ? 'is-ok' : ''}">
        <span class="ver-box-lbl">${escapeHTML(t('detail.verInstalledPcLabel'))}</span>
        <strong class="ver-box-val">${
          st.localVersion
            ? `v${escapeHTML(st.localVersion)}`
            : item.isInstalled
              ? escapeHTML(t('detail.verInstalledFallback'))
              : escapeHTML(t('detail.verNotInstalled'))
        }</strong>
      </div>
      <div class="detail-ver-box ${st.hasArchiveUpdate ? 'is-archive-update' : ''}">
        <span class="ver-box-lbl">${escapeHTML(t('providers.names.archive'))}${item.hasPinnedLast ? escapeHTML(t('detail.verArchivePinnedSuffix')) : ''}</span>
        <strong class="ver-box-val">${archiveBoxVal}</strong>
      </div>
      <div class="detail-ver-box ${st.hasWebUpdate ? 'is-web-update' : ''}">
        <span class="ver-box-lbl">${escapeHTML(t('detail.verOnlineLabel'))}${sourceLabel ? ` · ${escapeHTML(sourceLabel)}` : ''}</span>
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
          <h4>📝 ${escapeHTML(t('detail.customInfoTitle'))}</h4>
          <span class="muted"><code>_metadata/meta.json</code></span>
        </div>
        <div class="detail-description">
          <span class="muted">${escapeHTML(t('detail.customInfoEmpty'))}</span>
        </div>
      </section>
    `;
  }

  const infoChips = [];
  if (item.mainCategory) {
    infoChips.push(
      `<span><strong>${escapeHTML(t('detail.metaCategory'))}</strong> ${escapeHTML(item.mainCategory)}</span>`
    );
  }
  if (item.subCategories?.length) {
    infoChips.push(
      `<span><strong>${escapeHTML(t('detail.metaTags'))}</strong> ${escapeHTML(item.subCategories.join(', '))}</span>`
    );
  }
  if (hasFormats) {
    infoChips.push(
      `<span><strong>${escapeHTML(t('detail.metaFormats'))}</strong> ${escapeHTML(item.formats.join(', '))}</span>`
    );
  }
  if (hasOs) {
    infoChips.push(
      `<span><strong>${escapeHTML(t('detail.metaSystems'))}</strong> ${escapeHTML(item.os.join(', '))}</span>`
    );
  }

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
                <button type="button" class="media-thumb is-video" data-lightbox-idx="${idx}" title="${escapeHTML(t('detail.playVideoTitle'))}">
                  <video src="${url}#t=1" muted preload="metadata"></video>
                  <span class="play-badge">▶</span>
                </button>
              `;
            }
            return `
              <button type="button" class="media-thumb" data-lightbox-idx="${idx}" title="${escapeHTML(t('detail.zoomImageTitle'))}">
                <img src="${url}" loading="lazy" alt="${escapeHTML(t('detail.screenshotAlt'))}">
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
        <h4>📝 ${escapeHTML(t('detail.customInfoTitle'))}</h4>
        <span class="muted">${escapeHTML(t('detail.customInfoFromMeta'))}</span>
      </div>
      ${cleanDesc ? `<div class="detail-description">${cleanDesc}</div>` : ''}
      ${infoChips.length > 0 ? `<div class="custom-info-chips">${infoChips.join('')}</div>` : ''}
      ${linksHtml}
      ${mediaHtml}
    </section>
  `;
}

function buildArchiveTechTabHtml(item, { effectivePm, effectivePkgId, matchedArchive, policyEval = null }) {
  const blockedByPolicy = Boolean(policyEval && !policyEval.allowed);
  const originLabel = getOriginChip(item.origin)?.label || t('detail.originOnline');

  let archiveSectionHtml = '';
  if (item.inArchive) {
    let filesBarHtml = `<p class="muted">${escapeHTML(t('detail.techNoSetupFile'))}</p>`;
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
          <span class="detail-archive-label">${escapeHTML(t('detail.techSetupFileLabel'))}</span>
          ${selectorHtml}
          <div class="detail-archive-btns">
            <button type="button" class="btn btn-ghost" data-detail-action="run-selected" ${blockedByPolicy ? `disabled title="${escapeHTML(getLocalizedPolicyError(policyEval, 'policy.blockedDefault'))}"` : ''}>▶️ ${escapeHTML(t('detail.techRunSelected'))}</button>
            <button type="button" class="btn btn-ghost" data-detail-action="copy-selected">💾 ${escapeHTML(t('detail.techCopySelected'))}</button>
          </div>
        </div>
      `;
    }

    const pinNoticeHtml = item.hasPinnedLast
      ? `
        <div class="archive-pin-banner">
          <strong>📌 ${escapeHTML(t('detail.techLastPinTitle'))}</strong>
          <span>${escapeHTML(t('detail.techLastPinDesc'))}</span>
        </div>
      `
      : '';

    const keepNoticeHtml = item.keepAllVersions
      ? `
        <div class="archive-keep-banner">
          <strong>🔒 ${escapeHTML(t('detail.techKeepAllTitle'))}</strong>
          <span>${escapeHTML(t('detail.techKeepAllDesc'))}</span>
        </div>
      `
      : '';

    archiveSectionHtml = `
      <div class="detail-section">
        <h4>${escapeHTML(t('detail.techSectionSetupFiles'))}</h4>
        ${filesBarHtml}
        ${pinNoticeHtml}
        ${keepNoticeHtml}
      </div>
    `;
  } else {
    archiveSectionHtml = `
      <div class="archive-status-card">
        <div>
          <strong>${escapeHTML(matchedArchive ? t('detail.techArchiveExists') : t('detail.techArchiveMissing'))}</strong>
          <p class="muted">
            ${
              matchedArchive
                ? `${escapeHTML(t('detail.techArchiveLinkedPath'))} <code>${escapeHTML(matchedArchive.path)}</code>`
                : escapeHTML(t('detail.techArchiveMissingDesc'))
            }
          </p>
        </div>
        ${
          matchedArchive
            ? `<button type="button" class="btn btn-ghost" data-detail-action="open-archive-item">📂 ${escapeHTML(t('detail.heroOpenArchive'))}</button>`
            : `<button type="button" class="btn btn-archive" data-detail-action="save-to-archive">📥 ${escapeHTML(t('detail.heroSaveToArchive'))}</button>`
        }
      </div>
    `;
  }

  const techRows = [
    `<div class="tech-row"><span>${escapeHTML(t('detail.techOrigin'))}</span><strong>${escapeHTML(originLabel)}</strong></div>`,
  ];
  if (item.path) {
    const primaryRootLabel = item.archiveRootLabel
      ? ` (#${(item.archiveRootIndex ?? 0) + 1} ${item.archiveRootLabel})`
      : '';
    const offlineTag = item.archiveOffline ? t('detail.techOfflineCacheTag') : '';
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techPrimaryArchiveFolder'))}${escapeHTML(primaryRootLabel)}${escapeHTML(offlineTag)}</span><code>${escapeHTML(item.path)}</code></div>`
    );
  }
  if (Array.isArray(item.alternatePaths) && item.alternatePaths.length > 0) {
    const archiveFallback = t('providers.names.archive');
    const offlineSuffix = t('detail.techOfflineTag');
    const altHtml = item.alternatePaths
      .map(
        (alt) =>
          `[#${(alt.rootIndex ?? 0) + 1} ${alt.rootLabel || archiveFallback}${alt.offline ? offlineSuffix : ''}] ${alt.path}`
      )
      .map(escapeHTML)
      .join('<br>');
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techOtherArchiveLocations'))}</span><code>${altHtml}</code></div>`
    );
  }
  if (effectivePm) {
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techPackageManager'))}</span><code>${escapeHTML(effectivePm)}</code></div>`
    );
  }
  if (effectivePkgId) {
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techPackageId'))}</span><code>${escapeHTML(effectivePkgId)}</code></div>`
    );
  }
  if (item.publisher) {
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techPublisher'))}</span><code>${escapeHTML(item.publisher)}</code></div>`
    );
  }
  if (item.webVersionUrl) {
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techVersionSource'))}</span><button type="button" class="inline-link" data-open-url="${escapeHTML(item.webVersionUrl)}">${escapeHTML(item.webVersionUrl)}</button></div>`
    );
  }
  if (item.downloadUrl) {
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techDownloadSource'))}</span><button type="button" class="inline-link" data-open-url="${escapeHTML(item.downloadUrl)}">${escapeHTML(item.downloadUrl)}</button></div>`
    );
  }
  if (item.autoPaths?.length) {
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techPcPathAuto'))}</span><code>${item.autoPaths.map(escapeHTML).join('<br>')}</code></div>`
    );
  }
  if (item.installPaths?.length) {
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techPcPathManual'))}</span><code>${item.installPaths.map(escapeHTML).join('<br>')}</code></div>`
    );
  }
  if (item.installLocation) {
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techInstallDir'))}</span><code>${escapeHTML(item.installLocation)}</code></div>`
    );
  }
  if (item.registryKey) {
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techRegistryKey'))}</span><code>${escapeHTML(item.registryKey)}</code></div>`
    );
  }
  if (item.searchNames?.length) {
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techSearchNames'))}</span><code>${escapeHTML(item.searchNames.join(', '))}</code></div>`
    );
  }
  if (item.inArchive) {
    const modeLabel =
      item.installMode === 'interactive-required'
        ? `🛡️ ${t('detail.techInstallModeProtected')}`
        : item.installMode === 'silent'
          ? `⚡ ${t('detail.techInstallModeSilent')}`
          : `🖱️ ${t('detail.techInstallModeInteractive')}`;
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techInstallModeLabel'))}</span><strong>${escapeHTML(modeLabel)}</strong></div>`
    );
    if (item.silentArgs) {
      techRows.push(
        `<div class="tech-row"><span>${escapeHTML(t('detail.techSilentArgs'))}</span><code>${escapeHTML(item.silentArgs)}</code></div>`
      );
    }
    if (item.innoInfFile) {
      const infHint = item.innoInfExists ? t('detail.techInnoInfPresent') : t('detail.techInnoInfMissing');
      techRows.push(
        `<div class="tech-row"><span>${escapeHTML(t('detail.techInnoInf'))}</span><code>${escapeHTML(item.innoInfFile)}</code> <span class="muted">(${escapeHTML(infHint)})</span></div>`
      );
    }
    techRows.push(
      `<div class="tech-row"><span>${escapeHTML(t('detail.techCleanupProtection'))}</span><code>${escapeHTML(item.keepAllVersions ? t('detail.techCleanupProtectionActive') : t('detail.techCleanupProtectionDefault'))}</code></div>`
    );
  }

  return `
    ${archiveSectionHtml}
    <div class="detail-section">
      <h4>${escapeHTML(t('detail.techSectionTitle'))}</h4>
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
  const pmLabel = getLocalizedProviderBadge(pmId, state.providers)?.label || pmId;
  const pidLabel = pkg.packageId || fallbackPkgId;
  const formattedTime = formatCacheTimestamp(updatedAt);

  const staleNoticeHtml = isStale
    ? `
      <div class="pkg-stale-notice">
        ⚠️ ${escapeHTML(t('detail.profileOfflineNotice'))}${formattedTime ? escapeHTML(t('detail.profileOfflineAsOf', { time: formattedTime })) : ''}.
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
    descBlocks.push(`<p class="muted">${escapeHTML(t('detail.profileNoDesc'))}</p>`);
  }

  const tagsHtml =
    tags.length > 0
      ? `
        <div class="pkg-tags-list">
          ${tags.map((tg) => `<span class="pkg-tag-chip">${escapeHTML(tg)}</span>`).join('')}
        </div>
      `
      : '';

  const gridItems = [];
  if (pkg.publisher) {
    const pubContent = pkg.publisherUrl
      ? `<button type="button" class="inline-link" data-open-url="${escapeHTML(pkg.publisherUrl)}">${escapeHTML(pkg.publisher)} ↗</button>`
      : escapeHTML(pkg.publisher);
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">${escapeHTML(t('detail.techPublisher'))}</span><div class="pkg-profile-val">${pubContent}</div></div>`
    );
  }
  if (pkg.author) {
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">${escapeHTML(t('detail.profileAuthor'))}</span><div class="pkg-profile-val">${escapeHTML(pkg.author)}</div></div>`
    );
  }
  if (pkg.license || pkg.licenseUrl) {
    const licText = pkg.license ? escapeHTML(pkg.license) : escapeHTML(t('detail.profileLicense'));
    const licLink = pkg.licenseUrl
      ? ` <button type="button" class="inline-link" data-open-url="${escapeHTML(pkg.licenseUrl)}">${escapeHTML(t('detail.profileLicenseText'))} ↗</button>`
      : '';
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">${escapeHTML(t('detail.profileLicense'))}</span><div class="pkg-profile-val">${licText}${licLink}</div></div>`
    );
  }
  if (pkg.homepage) {
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">${escapeHTML(t('detail.profileHomepage'))}</span><div class="pkg-profile-val"><button type="button" class="inline-link" data-open-url="${escapeHTML(pkg.homepage)}">${escapeHTML(pkg.homepage)} ↗</button></div></div>`
    );
  }
  if (pkg.repositoryUrl && pkg.repositoryUrl !== pkg.homepage) {
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">${escapeHTML(t('detail.profileRepository'))}</span><div class="pkg-profile-val"><button type="button" class="inline-link" data-open-url="${escapeHTML(pkg.repositoryUrl)}">${escapeHTML(pkg.repositoryUrl)} ↗</button></div></div>`
    );
  }
  if (pmLabel) {
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">${escapeHTML(t('detail.techPackageManager'))}</span><div class="pkg-profile-val">${escapeHTML(pmLabel)}</div></div>`
    );
  }
  if (pidLabel) {
    gridItems.push(
      `<div class="pkg-profile-item"><span class="pkg-profile-label">${escapeHTML(t('detail.techPackageId'))}</span><div class="pkg-profile-val"><code>${escapeHTML(pidLabel)}</code></div></div>`
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
      ? t('detail.profileCacheStale', { time: formattedTime || t('detail.profileCacheOutdated') })
      : fromCache
        ? t('detail.profileCacheHit', { time: formattedTime || t('detail.profileCacheCurrent') })
        : t('detail.profileCacheLive', { time: formattedTime || t('detail.profileCacheJustNow') }),
  };
}

function renderDetailModalCore(
  item,
  { freshDownload = null, initialTab = 'overview', initialSourceKey = null, discoveredSources = [] } = {}
) {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();

  const renderToken = ++activeRenderToken;
  state.currentModalId = item.id;
  state.isEditModalOpen = false;

  const st = getItemStatus(item);
  const statusBadge = getStatusBadge(st.status);
  const basePm = getEffectivePackageManager(item);
  const basePkgId = getEffectivePackageId(item);
  const baseProvMeta = getProviderMeta(basePm);
  const sortedLastFiles = sortArchiveSetupFiles(item.lastFiles || [], item.lastFileSources || {});
  const archiveViewItem = sortedLastFiles.length > 0 ? { ...item, lastFiles: sortedLastFiles } : item;
  const matchedArchive = item.matchedArchiveItem || null;
  const metaSource = item.inArchive ? item : matchedArchive || item;

  const availableSources = buildAvailableInstallSources(item, {
    sortedLastFiles,
    st,
    effectivePm: basePm,
    effectivePkgId: basePkgId,
    provMeta: baseProvMeta,
    matchedArchive,
    discoveredSources,
  });

  let selectedSourceKey =
    initialSourceKey && availableSources.some((s) => s.key === initialSourceKey) ? initialSourceKey : null;
  if (!selectedSourceKey && availableSources.length > 0) {
    const providerSrc = availableSources.find((s) => s.kind === 'provider');
    const archiveSrc = availableSources.find((s) => s.kind === 'archive');
    if (item.origin === 'remote' || item.origin === 'pc') {
      selectedSourceKey = providerSrc?.key || availableSources[0].key;
    } else if (item.isInstalled && st.hasWebUpdate && providerSrc) {
      selectedSourceKey = providerSrc.key;
    } else {
      selectedSourceKey = archiveSrc?.key || providerSrc?.key || availableSources[0].key;
    }
  }

  const activeSource = availableSources.find((s) => s.key === selectedSourceKey) || null;
  const hasSourceChoice = availableSources.length > 1;
  const effectivePm = activeSource?.kind === 'provider' ? activeSource.providerId : basePm;
  const effectivePkgId = activeSource?.kind === 'provider' ? activeSource.packageId : basePkgId;
  const provMeta = activeSource?.kind === 'provider' ? activeSource.provMeta : baseProvMeta;

  const presentProviderIds = new Set(availableSources.filter((s) => s.kind === 'provider').map((s) => s.providerId));
  const otherSearchableProviders = filterUsableProviders(state.providers, {
    capability: 'search',
    excludeIds: ['archive'],
  }).filter((p) => p.capabilities?.install && !presentProviderIds.has(p.id));
  const canDiscoverMoreSources = otherSearchableProviders.length > 0 && Boolean(normalizeCompareName(item.name));

  const isWingetPkg = effectivePm === 'winget' && Boolean(effectivePkgId);
  const canProviderInstall = provMeta.canInstall && Boolean(effectivePkgId);
  const canArchiveDownload = provMeta.supportsArchiveDownload && Boolean(effectivePkgId);
  const hasPackageProfile = Boolean(effectivePkgId) && provMeta.canShow;
  const primaryAction =
    item.origin === 'remote'
      ? item.isInstalled && st.hasWebUpdate
        ? 'update'
        : 'install'
      : item.isInstalled
        ? 'update'
        : 'install';
  const policyTarget =
    activeSource?.kind === 'provider' ? { ...item, packageManager: effectivePm, packageId: effectivePkgId } : item;
  const policyEval = evaluateItemPolicy(policyTarget, primaryAction);
  const initialModeState = resolveDetailInstallMode(metaSource.installMode || item.installMode, null, { t });
  let selectedInstallMode = policyEval.silentOnly && !policyEval.adwareConflict ? 'silent' : initialModeState.selected;
  const isSilentLocked = initialModeState.silentLocked;
  const canUninstall = isCanUninstall(item, baseProvMeta, basePkgId);
  const onlineReady = canDownloadOnline(item);
  let selectedArchiveIdx = 0;
  let selectedProviderVersion = '';

  const activeArchiveFiles = activeSource?.kind === 'archive' ? activeSource.files || sortedLastFiles : sortedLastFiles;
  const activeArchiveSourceMap =
    activeSource?.kind === 'archive'
      ? activeSource.archiveItem?.lastFileSources || item.lastFileSources
      : item.lastFileSources;
  const fileSourceIndices = new Set(Object.values(activeArchiveSourceMap || {}).map((s) => Number(s?.rootIndex ?? 0)));
  const showRootPrefix = Boolean(item.hasMultipleArchiveRoots || fileSourceIndices.size > 1);
  const showArchiveFilePicker = activeArchiveFiles.length > 1 && (!activeSource || activeSource.kind === 'archive');
  const archiveVersionBarHtml = showArchiveFilePicker
    ? `
      <div class="detail-version-bar">
        <label for="detailOverviewFileSelect" class="detail-version-label">📦 ${escapeHTML(t('detail.archiveVersionLabel'))}</label>
        <select id="detailOverviewFileSelect" class="detail-file-select">
          ${activeArchiveFiles
            .map(
              (f, idx) =>
                `<option value="${idx}">${escapeHTML(formatMultiRootFileLabel(f, activeArchiveSourceMap, showRootPrefix))}</option>`
            )
            .join('')}
        </select>
      </div>
    `
    : '';

  const showProviderVersionBar =
    Boolean(effectivePkgId) &&
    provMeta.canListVersions &&
    (activeSource?.kind === 'provider' || (!activeSource && (canProviderInstall || onlineReady)));
  const activeProviderLatestVer =
    (activeSource?.kind === 'provider' ? activeSource.version : '') || st.webVersion || '';
  const providerLatestLabel = activeProviderLatestVer
    ? t('detail.providerVersionLatestWithVer', { version: activeProviderLatestVer })
    : t('detail.providerVersionLatest');
  const providerVersionBarHtml = showProviderVersionBar
    ? `
      <div class="detail-provider-version-bar">
        <label for="detailProviderVersionSelect" class="detail-version-label">🏷️ ${escapeHTML(t('detail.providerVersionLabel'))}</label>
        <select id="detailProviderVersionSelect" class="detail-file-select">
          <option value="">${escapeHTML(providerLatestLabel)}</option>
        </select>
        <button type="button" class="btn btn-ghost btn-xs" id="btnLoadProviderVersions" data-detail-action="load-provider-versions">
          🕒 ${escapeHTML(t('detail.loadOlderVersionsBtn'))}
        </button>
      </div>
    `
    : '';
  const supportsChangelog =
    (item.webSourceType === 'github' && Boolean(item.webVersionUrl)) ||
    (Boolean(effectivePm) && effectivePm !== 'archive' && Boolean(effectivePkgId) && provMeta.canShow);

  const initialIconPath = getCachedIconForPackage(item);
  if (initialIconPath && !item.icon) {
    item.icon = initialIconPath;
  }
  const fallbackEmoji = item.origin === 'pc' ? '💻' : item.origin === 'remote' ? '🛍️' : '📦';
  const iconHtml = initialIconPath
    ? `<img class="detail-icon" src="${escapeHTML(toMediaUrl(initialIconPath))}" alt="">`
    : `<div class="detail-icon-fallback">${fallbackEmoji}</div>`;

  const providerChip =
    effectivePm && provMeta.badge
      ? `<span class="provider-badge ${escapeHTML(provMeta.badge.badgeClass)}">${escapeHTML(provMeta.label)}</span>`
      : '';
  const originCfg = getOriginChip(item.origin);
  const originChip = originCfg
    ? `<span class="card-chip ${originCfg.cls}">${escapeHTML(originCfg.label)}</span>`
    : providerChip ||
      `<span class="provider-badge">${escapeHTML(item.providerName || effectivePm || t('detail.verOnlineLabel'))}</span>`;
  const extraProviderChip = originCfg ? providerChip : '';

  const newChip = isItemNew(item) ? `<span class="card-chip chip-new">${escapeHTML(t('cards.chipNew'))}</span>` : '';
  const nvmActiveChip =
    effectivePm === 'nvm' && item.isActive
      ? `<span class="card-chip chip-install-silent" title="${escapeHTML(t('cards.chipActiveTitle'))}">⚡ ${escapeHTML(t('cards.chipActive'))}</span>`
      : '';
  const typeChip =
    item.softwareType === 'portable'
      ? `<span class="card-chip">${escapeHTML(t('cards.chipPortable'))}</span>`
      : item.softwareType === 'driver'
        ? `<span class="card-chip">${escapeHTML(t('cards.chipDriver'))}</span>`
        : '';
  const keepChip = item.keepAllVersions
    ? `<span class="card-chip">🔒 ${escapeHTML(t('detail.chipKeepAllVersions'))}</span>`
    : '';
  const installBadge = item.inArchive ? getInstallModeBadge(item, { t }) : null;
  const installModeChip = installBadge
    ? `<span class="card-chip ${installBadge.type === 'protected' ? 'chip-install-protected' : 'chip-install-silent'}" title="${escapeHTML(installBadge.title)}">${escapeHTML(installBadge.label)}</span>`
    : '';
  const inArchiveRemoteChip =
    item.origin === 'remote' && matchedArchive
      ? `<span class="discover-status-badge">${escapeHTML(t('discover.badgeInArchive'))}</span>`
      : '';
  const offlineArchiveChip = item.archiveOffline
    ? `<span class="card-chip chip-install-protected" title="${escapeHTML(t('detail.chipOfflineArchiveTitle'))}">🔴 ${escapeHTML(t('detail.chipOfflineArchive'))}</span>`
    : '';
  const multiRootChip =
    Array.isArray(item.alternatePaths) && item.alternatePaths.length > 0
      ? `<span class="card-chip" title="${escapeHTML(t('detail.chipMultiRootTitle', { count: 1 + item.alternatePaths.length }))}">🗄️ ${escapeHTML(t('detail.chipMultiRoot', { count: 1 + item.alternatePaths.length }))}</span>`
      : '';

  const headerMeta = [];
  if (item.mainCategory)
    headerMeta.push(
      `<span><strong>${escapeHTML(t('detail.metaCategory'))}</strong> ${escapeHTML(item.mainCategory)}</span>`
    );
  if (item.publisher)
    headerMeta.push(
      `<span><strong>${escapeHTML(t('detail.techPublisher'))}:</strong> ${escapeHTML(item.publisher)}</span>`
    );
  if (effectivePkgId)
    headerMeta.push(
      `<span><strong>${escapeHTML(t('detail.techPackageId'))}:</strong> <code>${escapeHTML(effectivePkgId)}</code></span>`
    );

  const postDownloadBanner = freshDownload
    ? `
      <div class="detail-inline-banner is-success">
        <div class="banner-text">
          <strong>✅ ${escapeHTML(t('detail.postDownloadTitle'))}</strong>
          <span>${escapeHTML(t('detail.postDownloadFile'))} <code>${escapeHTML(getBaseName(freshDownload.filePath))}</code></span>
        </div>
        <button type="button" class="btn btn-local" data-detail-action="install-fresh" data-file="${escapeHTML(freshDownload.filePath)}" data-version="${escapeHTML(freshDownload.version || '')}">
          ▶️ ${escapeHTML(t('detail.postDownloadInstall'))}
        </button>
      </div>
    `
    : '';

  const pinnedNotice =
    item.inArchive && item.hasPinnedLast && onlineReady
      ? `
      <label class="detail-pin-choice">
        <input type="checkbox" id="detailSaveIntoLast">
        <span>${escapeHTML(t('detail.pinnedLastPrompt'))}</span>
      </label>
    `
      : '';

  const providerTitleLabel = provMeta.label || 'Provider';
  const packageProfileHtml = hasPackageProfile
    ? `
      <section class="pkg-profile-card">
        <div class="pkg-profile-head">
          <div class="pkg-profile-title">
            <h4>📦 ${escapeHTML(t('detail.profileHeading', { provider: providerTitleLabel }))}</h4>
            <span id="pkgProfileCacheBadge" class="pkg-cache-meta">${escapeHTML(t('common.loading'))}</span>
          </div>
          <button type="button" class="btn btn-ghost btn-xs" id="btnRefreshPkgProfile" data-detail-action="refresh-pkg-profile" title="${escapeHTML(t('detail.profileRefreshTitle'))}">🔄 ${escapeHTML(t('common.refresh'))}</button>
        </div>
        <div id="pkgProfileBody">
          <span class="muted">⏳ ${escapeHTML(t('detail.profileLoading', { provider: providerTitleLabel }))}</span>
        </div>
      </section>
    `
    : '';

  const footerLeftBtns = [];
  if (item.inArchive && item.path) {
    footerLeftBtns.push(
      `<button type="button" class="btn btn-ghost" data-detail-action="open-folder">📂 ${escapeHTML(t('detail.footerArchiveFolder'))}</button>`
    );
  } else if (item.installLocation) {
    footerLeftBtns.push(
      `<button type="button" class="btn btn-ghost" data-detail-action="open-install-dir">📂 ${escapeHTML(t('detail.footerInstallDir'))}</button>`
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
      <button type="button" class="icon-btn" data-detail-action="close" title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(t('common.close'))}">✕</button>
    </div>

    <nav class="modal-tabs detail-tabs" role="tablist">
      <button type="button" class="tab-btn ${initialTab === 'overview' ? 'active' : ''}" data-detail-tab="overview">✨ ${escapeHTML(t('detail.tabOverview'))}</button>
      <button type="button" class="tab-btn ${initialTab === 'changelog' ? 'active' : ''}" data-detail-tab="changelog">
        📋 ${escapeHTML(t('detail.tabChangelog'))} ${st.hasWebUpdate && supportsChangelog ? `<span class="detail-tab-badge">${escapeHTML(t('detail.tabChangelogNew'))}</span>` : ''}
      </button>
      <button type="button" class="tab-btn ${initialTab === 'archive-tech' ? 'active' : ''}" data-detail-tab="archive-tech">📂 ${escapeHTML(t('detail.tabArchiveTech'))}</button>
    </nav>

    <div class="modal-body detail-body">
      <section class="tab-panel" data-detail-panel="overview" ${initialTab === 'overview' ? '' : 'hidden'}>
        ${buildVersionGridHtml(item, st, { matchedArchive })}
        ${postDownloadBanner}
        ${buildSourceSelectorBarHtml({ availableSources, selectedSourceKey, canDiscoverMoreSources })}
        ${buildHeroBarHtml(archiveViewItem, st, {
          provMeta,
          canUninstall,
          matchedArchive,
          policyEval,
          activeSource,
          hasSourceChoice,
        })}
        ${archiveVersionBarHtml}
        ${providerVersionBarHtml}
        ${buildInstallModeToggleHtml({
          item,
          st,
          canProviderInstall,
          hasFreshDownload: Boolean(freshDownload),
          selectedMode: selectedInstallMode,
          isSilentLocked,
          lockTooltip: initialModeState.lockTooltip,
          policyEval,
        })}
        ${buildArchiveSaveChoiceHtml(item, st, { effectivePm, effectivePkgId, canArchiveDownload, matchedArchive })}
        ${pinnedNotice}
        ${packageProfileHtml}
        ${buildCustomMetaSectionHtml(metaSource, hasPackageProfile)}
      </section>

      <section class="tab-panel" data-detail-panel="changelog" ${initialTab === 'changelog' ? '' : 'hidden'}>
        <div id="detailChangelogBody" class="changelog-body">
          ${
            supportsChangelog
              ? `<span class="muted">${escapeHTML(t('detail.changelogLoadingOnOpen'))}</span>`
              : `<span class="muted">${escapeHTML(t('detail.changelogUnsupported'))}</span>`
          }
        </div>
      </section>

      <section class="tab-panel" data-detail-panel="archive-tech" ${initialTab === 'archive-tech' ? '' : 'hidden'}>
        ${buildArchiveTechTabHtml(archiveViewItem, { effectivePm, effectivePkgId, matchedArchive, policyEval })}
      </section>
    </div>

    <div class="modal-footer">
      <div class="footer-group">${footerLeftBtns.join('')}</div>
      <div class="footer-group">
        ${item.inArchive ? `<button type="button" class="btn btn-ghost" data-detail-action="edit">✏️ ${escapeHTML(t('common.edit'))}</button>` : ''}
        <button type="button" class="btn btn-primary" data-detail-action="close">${escapeHTML(t('common.close'))}</button>
      </div>
    </div>
  `;

  overlay.hidden = false;

  if (!initialIconPath) {
    queueItemsForIconResolution([item], { prioritize: true });
  }

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
    if (badgeEl) badgeEl.textContent = forceRefresh ? t('detail.profileRefreshing') : t('common.loading');
    if (forceRefresh) {
      bodyEl.innerHTML = `<span class="muted">⏳ ${escapeHTML(t('detail.profileFetchingLive', { provider: provMeta.label || 'Provider' }))}</span>`;
    }

    const res = await window.electronAPI.showPackage(effectivePm, effectivePkgId, { forceRefresh });
    if (!isStillActive()) return;

    if (refreshBtn instanceof HTMLButtonElement) refreshBtn.disabled = false;

    if (res?.success && res.package) {
      loadedPkgProfile = res.package;
      if (
        res.package.name &&
        isIdLikeDisplayName(item.name, effectivePkgId) &&
        !isIdLikeDisplayName(res.package.name, effectivePkgId)
      ) {
        item.name = res.package.name;
        const modalHeading = modal.querySelector('.detail-title-row h2');
        if (modalHeading) modalHeading.textContent = res.package.name;
        const gridTitle = document.querySelector(`#grid .card[data-id="${CSS.escape(item.id)}"] .card-title`);
        if (gridTitle) gridTitle.textContent = res.package.name;
      }
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
            `<div class="tech-row"><span>${escapeHTML(t('detail.techInstallerType'))}</span><code>${escapeHTML(res.package.installerType)}</code></div>`
          );
        }
        if (res.package.releaseDate) {
          extraRows.push(
            `<div class="tech-row"><span>${escapeHTML(t('detail.techReleaseDate'))}</span><code>${escapeHTML(res.package.releaseDate)}</code></div>`
          );
        }
        if (res.package.sha256) {
          extraRows.push(
            `<div class="tech-row"><span>${escapeHTML(t('detail.techSha256'))}</span><code>${escapeHTML(res.package.sha256)}</code></div>`
          );
        }
        techInstallerSlot.innerHTML = extraRows.join('');
      }

      if (!item.icon && (res.package.homepage || res.package.publisherUrl || res.package.repositoryUrl)) {
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
            homepage: res.package.homepage || res.package.publisherUrl || res.package.repositoryUrl || '',
            webVersionUrl: item.webVersionUrl || '',
            links: Array.isArray(item.links) ? item.links : [],
          })
          .then((iconRes) => {
            if (!iconRes?.success || !iconRes.iconPath) return;
            state.pcIconCache.set(item.id, iconRes.iconPath);
            if (item.pcApp?.id) state.pcIconCache.set(item.pcApp.id, iconRes.iconPath);
            if (effectivePm && effectivePkgId) {
              state.pcIconCache.set(`${effectivePm}:${effectivePkgId.toLowerCase()}`, iconRes.iconPath);
            }
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
      if (badgeEl) badgeEl.textContent = t('detail.profileUnavailable');
      bodyEl.innerHTML = `<span class="muted">${escapeHTML(res?.error || t('detail.profileLoadFailed'))}</span>`;
    }
  };

  const loadChangelog = async () => {
    if (!supportsChangelog || changelogLoaded) return;
    changelogLoaded = true;

    const bodyEl = modal.querySelector('#detailChangelogBody');
    if (!bodyEl) return;
    bodyEl.innerHTML = `<span class="muted">⏳ ${escapeHTML(t('detail.changelogLoading'))}</span>`;

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
      bodyEl.innerHTML = `<span class="muted">${escapeHTML(res?.error || t('detail.changelogError'))}</span>`;
      return;
    }

    if (!res.entries?.length) {
      bodyEl.innerHTML = `
        <div class="changelog-empty">
          <span class="muted">${escapeHTML(t('detail.changelogEmpty'))}</span>
          ${res.externalUrl ? `<button type="button" class="inline-link" data-open-url="${escapeHTML(res.externalUrl)}">${escapeHTML(t('detail.changelogOpenBrowser'))} ↗</button>` : ''}
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
                ${isNewerThanPc ? `<span class="changelog-tag-new">${escapeHTML(t('detail.changelogNewSincePc'))}</span>` : ''}
                ${entry.date ? `<span class="muted">${escapeHTML(entry.date)}</span>` : ''}
                ${entry.url ? `<button type="button" class="inline-link" data-open-url="${escapeHTML(entry.url)}">${escapeHTML(t('detail.changelogOriginal'))} ↗</button>` : ''}
              </div>
            </div>
            <div class="changelog-markdown">${renderMarkdownSafe(entry.body)}</div>
          </article>
        `;
      })
      .join('');

    bodyEl.innerHTML = `
      <div class="changelog-source-row">
        <span class="muted">${escapeHTML(t('detail.changelogSource', { source: res.source }))}</span>
        ${res.externalUrl ? `<button type="button" class="inline-link" data-open-url="${escapeHTML(res.externalUrl)}">${escapeHTML(t('detail.changelogAllReleases'))} ↗</button>` : ''}
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
      id: item.id || '',
      packageManager: effectivePm,
      packageId: effectivePkgId,
      name: loadedPkgProfile?.name || item.name,
      version: selectedProviderVersion || loadedPkgProfile?.version || st.webVersion || st.localVersion || '',
      selectedVersion: selectedProviderVersion,
      description: loadedPkgProfile?.description || loadedPkgProfile?.shortDescription || item.shortDescription || '',
      tags: loadedPkgProfile?.tags || item.tags || [],
      homepage: loadedPkgProfile?.homepage || item.homepage || '',
      repositoryUrl: loadedPkgProfile?.repositoryUrl || '',
      releaseNotesUrl: loadedPkgProfile?.releaseNotesUrl || '',
      searchNames: item.name ? [item.name] : [],
      installPaths,
      icon: item.icon || '',
      displayIcon: item.displayIcon || '',
      installLocation: item.installLocation || '',
      validInstallPath: item.validInstallPath || '',
      uninstallString: item.uninstallString || '',
      appxPackageFamilyName: item.appxPackageFamilyName || '',
    };
  };

  const getSelectedArchiveFile = () => {
    return activeArchiveFiles[selectedArchiveIdx] || activeArchiveFiles[0] || null;
  };

  const syncArchiveSelectsAndHero = (nextIdx) => {
    selectedArchiveIdx = nextIdx;
    const overviewSel = modal.querySelector('#detailOverviewFileSelect');
    const techSel = modal.querySelector('#detailFileSelect');
    if (overviewSel instanceof HTMLSelectElement) overviewSel.value = String(nextIdx);
    if (techSel instanceof HTMLSelectElement) techSel.value = String(nextIdx);

    const chosenFile = getSelectedArchiveFile();
    if (!chosenFile) return;
    const chosenVer = extractVersion(getBaseName(chosenFile)) || st.archiveVersion || '';
    const heroBtn = modal.querySelector('.detail-hero-bar [data-detail-action="install-file"]');
    if (heroBtn instanceof HTMLElement) {
      heroBtn.dataset.file = chosenFile;
      heroBtn.dataset.version = chosenVer;
      if (hasSourceChoice && activeSource?.kind === 'archive') {
        heroBtn.textContent = item.isInstalled
          ? chosenVer
            ? `⬆️ ${t('detail.heroArchiveUpdateVer', { version: chosenVer })}`
            : `▶️ ${t('detail.heroArchiveInstallGeneric')}`
          : chosenVer
            ? `▶️ ${t('detail.heroArchiveInstallVer', { version: chosenVer })}`
            : `▶️ ${t('detail.heroArchiveInstallGeneric')}`;
      } else if (st.hasArchiveUpdate && nextIdx === 0 && st.archiveVersion) {
        heroBtn.textContent = `⬆️ ${t('detail.heroInstallFileUpdate', { version: st.archiveVersion })}`;
      } else if (chosenVer) {
        heroBtn.textContent = `▶️ ${t('detail.heroInstallFileVersion', { version: chosenVer })}`;
      } else {
        heroBtn.textContent = `▶️ ${t('detail.heroInstallFileGeneric')}`;
      }
    }
  };

  const syncProviderHeroVersion = (ver) => {
    selectedProviderVersion = ver || '';
    if (activeSource?.kind !== 'provider') return;
    const heroBtn = modal.querySelector('.detail-hero-bar [data-detail-action="provider-install"]');
    if (!(heroBtn instanceof HTMLElement)) return;
    const provLabel = activeSource.label || provMeta.label || effectivePm;
    const displayVer = selectedProviderVersion || activeSource.version || st.webVersion || '';
    if (item.isInstalled && displayVer) {
      heroBtn.textContent = `⬆️ ${t('detail.heroProviderUpdateVer', { provider: provLabel, version: displayVer })}`;
    } else if (item.isInstalled) {
      heroBtn.textContent = `⬆️ ${t('detail.heroProviderUpdate', { provider: provLabel })}`;
    } else if (displayVer) {
      heroBtn.textContent = `⬇️ ${t('detail.heroProviderInstallVer', { provider: provLabel, version: displayVer })}`;
    } else {
      heroBtn.textContent = `⬇️ ${t('detail.heroProviderInstall', { provider: provLabel })}`;
    }
  };

  modal.onchange = (e) => {
    const target = e.target;
    if (!(target instanceof HTMLSelectElement)) return;
    if (target.id === 'detailOverviewFileSelect' || target.id === 'detailFileSelect') {
      const idx = Number.parseInt(target.value, 10);
      if (Number.isFinite(idx) && idx >= 0 && idx < activeArchiveFiles.length) {
        syncArchiveSelectsAndHero(idx);
      }
    } else if (target.id === 'detailProviderVersionSelect') {
      syncProviderHeroVersion(target.value || '');
    }
  };

  const runInstallerFlow = async (filePath, targetVersion) => {
    if (!filePath) return;
    if (!policyEval.allowed) {
      showToast(getLocalizedPolicyError(policyEval, 'policy.blockedDefault'), {
        type: 'error',
        duration: 6000,
      });
      return;
    }
    const archiveTarget = activeSource?.kind === 'archive' ? activeSource.archiveItem || item : item;
    const useSilent = policyEval.silentOnly ? true : !isSilentLocked && selectedInstallMode === 'silent';
    const modeLabel = useSilent ? t('detail.installModeSilent') : t('detail.installModeInteractive');
    showToast(t('detail.toastSetupStarting', { name: item.name, mode: modeLabel }), { type: 'info' });
    const res = await window.electronAPI.executeInstaller({
      itemId: archiveTarget.id,
      itemName: item.name,
      sourcePath: filePath,
      targetVersion: targetVersion || null,
      allowSilent: useSilent,
      silent: useSilent,
      action: primaryAction,
    });

    if (res.alreadyRunning) {
      showToast(t('detail.toastAlreadyRunning'), { type: 'warn' });
      return;
    }

    await triggerCatalogReload({ rescanInstalled: Boolean(res.success) });
    if (isStillActive()) {
      renderDetailModal(item.id, { initialSourceKey: selectedSourceKey, discoveredSources });
    }

    if (res.success && res.verified) {
      showToast(t('detail.toastUpdatedVerified', { name: item.name, version: res.newVersion }), { type: 'success' });
    } else if (res.canceled) {
      showToast(t('detail.toastInstallCanceled'), { type: 'info' });
    } else if (res.success && res.status === 'opened') {
      showToast(t('detail.toastArchiveFileOpened'), { type: 'info' });
    } else if (!res.success && res.error) {
      showToast(t('detail.toastInstallError', { error: res.error }), { type: 'error', duration: 6000 });
    }
  };

  const runWebDownloadFlow = async () => {
    const saveLastEl = modal.querySelector('#detailSaveIntoLast');
    const saveIntoLastFolder = saveLastEl instanceof HTMLInputElement ? saveLastEl.checked : false;
    const res = await window.electronAPI.downloadWebUpdate(item, {
      saveIntoLastFolder,
      version: selectedProviderVersion,
    });

    if (res.alreadyRunning) {
      showToast(t('detail.toastDownloadRunning'), { type: 'info' });
      return;
    }
    if (res.canceled) return;
    if (!res.success) {
      showToast(t('detail.toastDownloadFailed', { error: res.error }), { type: 'error', duration: 6000 });
      return;
    }

    await triggerCatalogReload();
    showToast(t('detail.toastSavedInArchive', { name: item.name }), { type: 'success' });
    if (isStillActive()) {
      renderDetailModal(item.id, {
        freshDownload: { filePath: res.filePath, version: res.version },
        initialSourceKey: selectedSourceKey,
        discoveredSources,
      });
    }
  };

  const runProviderInstallFlow = async (btn) => {
    if (!canProviderInstall) return;
    if (!policyEval.allowed) {
      showToast(getLocalizedPolicyError(policyEval, 'policy.blockedDefault'), {
        type: 'error',
        duration: 6000,
      });
      return;
    }
    const archiveCheck = modal.querySelector('#detailAlsoSaveArchive');
    const shouldSaveToArchive = archiveCheck instanceof HTMLInputElement ? archiveCheck.checked : false;

    let archiveTargetSpec = null;
    if (shouldSaveToArchive) {
      const targetMode = state.settings.archiveSaveMode === 'auto-id' ? 'auto-id' : 'ask';
      archiveTargetSpec = await resolveArchiveSaveTarget(buildArchivePayloadFromItem(), { mode: targetMode });
      if (archiveTargetSpec.canceled) {
        return;
      }
    }

    const useSilent = policyEval.silentOnly ? true : !isSilentLocked && selectedInstallMode === 'silent';
    const modeLabel = useSilent ? t('detail.installModeSilent') : t('detail.installModeInteractive');
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = item.isInstalled ? `⏳ ${t('detail.toastUpdatingBtn')}` : `⏳ ${t('detail.toastInstallingBtn')}`;
    showToast(
      t('detail.toastProviderStarting', {
        provider: provMeta.label || effectivePm,
        action: item.isInstalled ? t('detail.toastProviderActionUpdate') : t('detail.toastProviderActionInstall'),
        name: item.name,
        mode: modeLabel,
      }),
      {
        type: 'info',
      }
    );

    const chosenVersion =
      selectedProviderVersion ||
      (activeSource?.kind === 'provider' && activeSource.version ? activeSource.version : '') ||
      (item.isInstalled && st.hasWebUpdate ? st.webVersion || '' : '');
    const shouldUpgrade = selectedProviderVersion
      ? Boolean(item.isInstalled && st.localVersion && compareVersions(selectedProviderVersion, st.localVersion, 0) > 0)
      : Boolean(item.isInstalled && (st.hasWebUpdate || activeSource?.kind === 'provider'));

    const res = await window.electronAPI.installPackage(effectivePm, effectivePkgId, {
      upgrade: shouldUpgrade,
      version: selectedProviderVersion || '',
      targetVersion: chosenVersion,
      silent: useSilent,
      itemName: item.name,
    });

    btn.disabled = false;
    btn.textContent = origText;

    if (res?.alreadyRunning) {
      showToast(t('detail.toastPkgAlreadyRunning'), { type: 'warn' });
      return;
    }
    if (res?.canceled) {
      showToast(t('common.operationCanceled'), { type: 'info' });
      return;
    }
    if (!res?.success) {
      showToast(t('common.errorPrefix', { error: res?.error || t('common.unknownError') }), {
        type: 'error',
        duration: 6000,
      });
      return;
    }

    showToast(
      item.isInstalled
        ? t('detail.toastProviderUpdated', { name: item.name })
        : t('detail.toastProviderInstalled', { name: item.name }),
      { type: 'success' }
    );

    if (shouldSaveToArchive && archiveTargetSpec && !archiveTargetSpec.skipped) {
      const linkRes = await executeArchiveLink(buildArchivePayloadFromItem(), archiveTargetSpec, {
        downloadSetup: canArchiveDownload,
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
        renderRemoteDetailModal(effectivePm, effectivePkgId, loadedPkgProfile || item, {
          initialSourceKey: selectedSourceKey,
          discoveredSources,
        });
      } else {
        renderDetailModal(item.id, { initialSourceKey: selectedSourceKey, discoveredSources });
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

    const sourceBtn = e.target.closest('[data-detail-source-key]');
    if (sourceBtn instanceof HTMLElement) {
      const nextKey = sourceBtn.dataset.detailSourceKey || '';
      if (nextKey && nextKey !== selectedSourceKey) {
        renderDetailModalCore(item, {
          freshDownload,
          initialTab: 'overview',
          initialSourceKey: nextKey,
          discoveredSources,
        });
      }
      return;
    }

    const modeBtn = e.target.closest('[data-detail-install-mode]');
    if (modeBtn instanceof HTMLElement) {
      const requested = modeBtn.dataset.detailInstallMode;
      if (isSilentLocked && requested === 'silent') return;
      if (policyEval.silentOnly && requested === 'interactive') return;
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
    } else if (action === 'discover-more-sources') {
      if (!(btn instanceof HTMLButtonElement) || otherSearchableProviders.length === 0) return;
      const query = normalizeCompareName(item.name);
      if (!query || query.length < 2) return;
      btn.disabled = true;
      btn.textContent = `⏳ ${t('detail.sourceFindingMoreBtn')}`;
      try {
        const res = await window.electronAPI.searchProviders(query, {
          providerIds: otherSearchableProviders.map((p) => p.id),
          limit: 12,
        });
        if (!isStillActive()) return;
        const foundExtra = [];
        const seenExtra = new Set();
        const queryCompact = query.replace(/\s+/g, '');
        for (const cand of Array.isArray(res?.results) ? res.results : []) {
          const pm = String(cand?.providerId || cand?.packageManager || '')
            .trim()
            .toLowerCase();
          const pid = String(cand?.packageId || cand?.id || '').trim();
          if (!pm || !pid || presentProviderIds.has(pm) || seenExtra.has(pm)) continue;
          const candNorm = normalizeCompareName(cand?.name || '');
          const pidTail =
            pid
              .split(/[./]/)
              .pop()
              ?.toLowerCase()
              .replace(/[^a-z0-9äöüß]/g, '') || '';
          const isMatch =
            candNorm === query ||
            (queryCompact.length >= 3 && (candNorm.replace(/\s+/g, '') === queryCompact || pidTail === queryCompact));
          if (!isMatch) continue;
          seenExtra.add(pm);
          foundExtra.push({ providerId: pm, packageId: pid, version: cand?.version || '' });
        }

        if (foundExtra.length === 0) {
          showToast(t('detail.sourceNoMoreFound'), { type: 'info' });
          btn.disabled = false;
          btn.textContent = `🔎 ${t('detail.sourceFindMoreBtn')}`;
          return;
        }

        showToast(t('detail.sourceMoreFoundToast', { count: foundExtra.length }), { type: 'success' });
        renderDetailModalCore(item, {
          freshDownload,
          initialTab: 'overview',
          initialSourceKey: selectedSourceKey,
          discoveredSources: [...discoveredSources, ...foundExtra],
        });
      } catch {
        if (isStillActive()) {
          btn.disabled = false;
          btn.textContent = `🔎 ${t('detail.sourceFindMoreBtn')}`;
        }
      }
    } else if (action === 'load-provider-versions') {
      if (!(btn instanceof HTMLButtonElement) || !effectivePm || !effectivePkgId) return;
      btn.disabled = true;
      const origText = btn.textContent || '';
      btn.textContent = `⏳ ${t('detail.loadingVersionsBtn')}`;
      const res = await window.electronAPI.listPackageVersions(effectivePm, effectivePkgId);
      if (!isStillActive()) return;
      if (res?.success && Array.isArray(res.versions) && res.versions.length > 0) {
        const verSel = modal.querySelector('#detailProviderVersionSelect');
        if (verSel instanceof HTMLSelectElement) {
          const prevVal = verSel.value;
          verSel.innerHTML = [
            `<option value="">${escapeHTML(providerLatestLabel)}</option>`,
            ...res.versions.map((v) => `<option value="${escapeHTML(v)}">v${escapeHTML(v)}</option>`),
          ].join('');
          if (prevVal && res.versions.includes(prevVal)) {
            verSel.value = prevVal;
          }
        }
        btn.textContent = `✅ ${t('detail.versionsLoadedCount', { count: res.versions.length })}`;
      } else {
        btn.disabled = false;
        btn.textContent = origText;
        showToast(res?.error || t('detail.versionsNoneFound'), { type: 'warn' });
      }
    } else if (action === 'web-download') {
      await runWebDownloadFlow();
    } else if (action === 'install-file') {
      const selectedFile = getSelectedArchiveFile() || btn.dataset.file;
      const derivedVer = (selectedFile ? extractVersion(getBaseName(selectedFile)) : '') || btn.dataset.version;
      await runInstallerFlow(selectedFile, derivedVer);
    } else if (action === 'install-fresh') {
      await runInstallerFlow(btn.dataset.file, btn.dataset.version);
    } else if (action === 'run-selected') {
      await runInstallerFlow(getSelectedArchiveFile(), null);
    } else if (action === 'copy-selected') {
      const file = getSelectedArchiveFile();
      if (!file) return;
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      const res = await window.electronAPI.copyFilesToPc([file]);
      if (btn instanceof HTMLButtonElement) btn.disabled = false;
      if (res.success) showToast(t('detail.toastCopiedTo', { dest: res.dest }), { type: 'success' });
      else if (res.error) showToast(t('detail.toastCopyError', { error: res.error }), { type: 'error' });
    } else if (action === 'provider-install') {
      await runProviderInstallFlow(btn);
    } else if (action === 'nvm-use' && effectivePm === 'nvm' && effectivePkgId) {
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      const origText = btn.textContent || '';
      btn.textContent = `⏳ ${t('detail.toastNvmActivatingBtn')}`;
      showToast(t('detail.toastNvmActivating', { version: effectivePkgId }), { type: 'info' });

      const res = await window.electronAPI.useNvmVersion(effectivePkgId);
      if (isStillActive() && btn instanceof HTMLButtonElement) {
        btn.disabled = false;
        btn.textContent = origText;
      }

      if (res?.alreadyRunning) {
        showToast(t('detail.toastNvmAlreadySwitching'), { type: 'warn' });
      } else if (res?.canceled) {
        showToast(t('detail.toastNvmCanceled'), { type: 'info' });
      } else if (res?.success) {
        showToast(t('detail.toastNvmActive', { version: effectivePkgId }), { type: 'success' });
        await triggerCatalogReload({ rescanInstalled: true });
        if (isStillActive()) {
          if (item.origin === 'remote') {
            renderRemoteDetailModal(effectivePm, effectivePkgId, loadedPkgProfile || item);
          } else {
            renderDetailModal(item.id);
          }
        }
      } else {
        showToast(t('detail.toastNvmError', { error: res?.error || t('detail.toastNvmDefaultError') }), {
          type: 'error',
          duration: 6000,
        });
      }
    } else if (action === 'save-to-archive') {
      const ok = await ensureAdminAuthenticated({
        reason: t('modals.authReasonAddArchive'),
      });
      if (!ok) return;
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
        btn.textContent = `⚠️ ${t('common.confirmUninstallArmed')}`;
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
      btn.textContent = `⏳ ${t('detail.toastUninstallingBtn')}`;

      const res = await window.electronAPI.uninstallSoftware({
        packageManager: basePm,
        packageId: basePkgId,
        uninstallString: item.uninstallString,
        quietUninstallString: item.quietUninstallString,
        itemName: item.name,
        archiveItemId: item.archiveItemId || (item.inArchive ? item.id : null),
        silent: false,
      });

      if (btn instanceof HTMLButtonElement) btn.disabled = false;
      btn.textContent = btn.dataset.origText || `🗑️ ${t('common.uninstall')}`;

      if (res?.alreadyRunning) {
        showToast(t('detail.toastUninstallAlreadyRunning'), { type: 'warn' });
      } else if (res?.canceled) {
        showToast(t('detail.toastUninstallCanceled'), { type: 'info' });
      } else if (res?.success) {
        showToast(t('detail.toastUninstalled', { name: item.name }), { type: 'success' });
        await triggerCatalogReload({ rescanInstalled: true });
        if (item.inArchive) {
          if (isStillActive()) renderDetailModal(item.id);
        } else {
          closeModal();
        }
      } else {
        showToast(t('detail.toastUninstallError', { error: res?.error || t('common.unknownError') }), {
          type: 'error',
          duration: 6000,
        });
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
