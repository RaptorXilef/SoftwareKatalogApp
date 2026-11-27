import { filterUsableProviders } from '../../shared/provider-lifecycle-logic.js';
import { openNestedDialog, pickArchiveTargetFolder } from '../modals/archive-target-modal.js';
import { evaluateItemPolicy, isProviderUsable, state } from '../state.js';
import { closestButton, closestEl, qsInput } from '../utils/dom.js';
import {
  getLocalizedPolicyError,
  getLocalizedProviderBadge,
  getLocalizedProviderDescription,
  getLocalizedProviderName,
  t,
} from '../utils/i18n.js';
import { escapeHTML, toMediaUrl } from '../utils/sanitize.js';
import { getCachedIconForPackage, queueItemsForIconResolution } from './cards.js';
import { showToast } from './toast.js';

let searchRequestSeq = 0;

function getSearchableProviders() {
  return filterUsableProviders(state.providers, { capability: 'search' });
}

function getProviderCapability(providerId, capKey) {
  const provider = state.providers.find((p) => p.id === providerId);
  return Boolean(provider?.capabilities?.[capKey]);
}

function findMatchingArchivePackage(pkg) {
  if (pkg.providerId === 'archive' && pkg.packageId) {
    return state.packages.find((p) => p.inArchive && p.id === pkg.packageId) || null;
  }
  const cleanPid = String(pkg.packageId || '')
    .trim()
    .toLowerCase();
  const cleanPm = String(pkg.packageManager || pkg.providerId || '')
    .trim()
    .toLowerCase();
  if (!cleanPid) return null;

  return (
    state.packages.find((p) => {
      if (!p.inArchive) return false;
      const pId = String(p.packageId || p.wingetId || '')
        .trim()
        .toLowerCase();
      const pPm = String(p.packageManager || (p.wingetId ? 'winget' : ''))
        .trim()
        .toLowerCase();
      if (!pId) return false;
      return cleanPm ? pPm === cleanPm && pId === cleanPid : pId === cleanPid;
    }) || null
  );
}

function findMatchingInstalledPackageObj(pkg) {
  const cleanPid = String(pkg.packageId || '')
    .trim()
    .toLowerCase();
  const cleanPm = String(pkg.packageManager || pkg.providerId || '')
    .trim()
    .toLowerCase();
  if (!cleanPid) return null;

  return (
    state.packages.find((p) => {
      if (!p.isInstalled) return false;
      const pId = String(p.packageId || p.wingetId || '')
        .trim()
        .toLowerCase();
      const pPm = String(p.packageManager || (p.wingetId ? 'winget' : ''))
        .trim()
        .toLowerCase();
      return pId === cleanPid && (!cleanPm || pPm === cleanPm);
    }) || null
  );
}

function toDiscoverPolicyPkg(pkg) {
  const providerId = String(pkg?.providerId || pkg?.packageManager || 'winget')
    .trim()
    .toLowerCase();
  const packageId = String(pkg?.packageId || pkg?.id || '').trim();
  const archiveMatch = findMatchingArchivePackage(pkg);
  const archiveId = providerId === 'archive' ? packageId : archiveMatch?.id || null;
  return {
    id: packageId,
    archiveItemId: archiveId,
    inArchive: Boolean(providerId === 'archive' || archiveMatch),
    providerId,
    source: providerId,
    packageManager: providerId === 'archive' ? archiveMatch?.packageManager || 'archive' : providerId,
    packageId: providerId === 'archive' ? pkg?.linkedPackageId || '' : packageId,
    wingetId: providerId === 'winget' ? packageId : archiveMatch?.wingetId || '',
    name: pkg?.name || packageId,
    installMode: pkg?.installMode || archiveMatch?.installMode || 'interactive',
  };
}

function renderSourceChips() {
  const container = document.getElementById('discoverSourceChips');
  if (!container) return;

  const searchable = getSearchableProviders();
  if (searchable.length === 0) {
    container.innerHTML = `<span class="muted">${escapeHTML(t('discover.noUsableSources'))}</span>`;
    return;
  }

  container.innerHTML = searchable
    .map((p) => {
      const active = state.discoverSelectedProviders.includes(p.id);
      const provName = getLocalizedProviderName(p);
      const provDesc = getLocalizedProviderDescription(p) || provName;
      return `
        <button
          type="button"
          class="source-chip ${active ? 'active' : ''}"
          data-discover-provider="${escapeHTML(p.id)}"
          aria-pressed="${active ? 'true' : 'false'}"
          title="${escapeHTML(provDesc)}"
        >
          <span>${active ? '✓' : '+'}</span>
          <span>${escapeHTML(provName)}</span>
        </button>
      `;
    })
    .join('');
}

function renderLocalActions() {
  const container = document.getElementById('discoverLocalActions');
  if (!container) return;

  const msiProvider = state.providers.find((p) => p.id === 'msi');
  const msiPolicy = evaluateItemPolicy({ providerId: 'msi', packageManager: 'msi', name: 'MSI' }, 'install');
  const showMsiBtn = msiProvider
    ? isProviderUsable('msi') && !(msiPolicy.listType === 'blacklist' && !msiPolicy.visible)
    : false;
  if (!showMsiBtn) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  container.hidden = false;
  container.innerHTML = `
    <span class="discover-sources-label">${escapeHTML(t('discover.localPackagesLabel'))}</span>
    <button type="button" class="btn btn-local btn-xs" id="btnInstallLocalMsi">
      📦 ${escapeHTML(t('discover.installLocalMsiButton'))}
    </button>
  `;
}

async function runLocalMsiWizard({ onReload }) {
  const filePath = await window.electronAPI.selectFile(
    [{ name: t('discover.msiPickerFilter'), extensions: ['msi'] }],
    true
  );
  if (!filePath) return;

  const meta = await window.electronAPI.inspectMsiFile(filePath);
  const pkgName = meta?.name || filePath.split(/[\\/]/).pop() || t('discover.msiDefaultName');
  const pkgVer = meta?.version || '';
  const pkgPublisher = meta?.publisher || '';
  const productCode = meta?.productCode || '';

  const msiPolicy = evaluateItemPolicy(
    {
      providerId: 'msi',
      packageManager: 'msi',
      packageId: productCode,
      name: pkgName,
      installMode: 'interactive',
    },
    'install'
  );
  if (!msiPolicy.allowed) {
    showToast(getLocalizedPolicyError(msiPolicy, 'discover.msiPolicyBlocked'), {
      type: 'error',
      duration: 6000,
    });
    return;
  }

  const msiModeOptionsHtml = msiPolicy.silentOnly
    ? `
        <div class="archive-link-options">
          <label class="radio-card">
            <input type="radio" name="msiInstallMode" value="silent" checked>
            <div>
              <strong>⚡ ${escapeHTML(t('discover.msiModeSilentOnlyTitle'))}</strong>
              <p>${escapeHTML(t('discover.msiModeSilentOnlyDesc'))}</p>
            </div>
          </label>
        </div>
      `
    : `
        <div class="archive-link-options">
          <label class="radio-card">
            <input type="radio" name="msiInstallMode" value="interactive" checked>
            <div>
              <strong>🖱️ ${escapeHTML(t('discover.msiModeInteractiveTitle'))}</strong>
              <p>${escapeHTML(t('discover.msiModeInteractiveDesc'))}</p>
            </div>
          </label>
          <label class="radio-card">
            <input type="radio" name="msiInstallMode" value="silent">
            <div>
              <strong>⚡ ${escapeHTML(t('discover.msiModeSilentTitle'))}</strong>
              <p>${escapeHTML(t('discover.msiModeSilentDesc'))}</p>
            </div>
          </label>
        </div>
      `;

  const choice = await openNestedDialog({
    defaultAction: 'cancel',
    html: `
      <div class="modal-header">
        <h2>📦 ${escapeHTML(t('discover.msiModalTitle'))}</h2>
        <button type="button" class="icon-btn" data-dialog-action="cancel" title="${escapeHTML(t('common.cancel'))}" aria-label="${escapeHTML(t('common.cancel'))}">✕</button>
      </div>

      <div class="modal-body collision-warning-body">
        <div class="collision-meta-card">
          <div class="tech-row"><span>${escapeHTML(t('discover.msiFieldPackageName'))}</span><strong>${escapeHTML(pkgName)}</strong></div>
          ${pkgVer ? `<div class="tech-row"><span>${escapeHTML(t('discover.msiFieldVersion'))}</span><code>v${escapeHTML(pkgVer)}</code></div>` : ''}
          ${pkgPublisher ? `<div class="tech-row"><span>${escapeHTML(t('discover.msiFieldPublisher'))}</span><span>${escapeHTML(pkgPublisher)}</span></div>` : ''}
          ${productCode ? `<div class="tech-row"><span>${escapeHTML(t('discover.msiFieldProductCode'))}</span><code>${escapeHTML(productCode)}</code></div>` : ''}
          <div class="tech-row"><span>${escapeHTML(t('discover.msiFieldFile'))}</span><code>${escapeHTML(filePath)}</code></div>
        </div>

        ${msiModeOptionsHtml}

        <label class="check-row">
          <input type="checkbox" id="chkMsiSaveToArchive">
          <span>🗄️ ${escapeHTML(t('discover.msiSaveToArchiveLabel'))}</span>
        </label>
      </div>

      <div class="modal-footer">
        <span></span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-dialog-action="cancel">${escapeHTML(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-dialog-action="install">▶️ ${escapeHTML(t('common.install'))}</button>
        </div>
      </div>
    `,
    onAction: (action) => {
      if (action !== 'install') return 'cancel';
      const dialog = document.getElementById('dialogContent');
      const modeInput = dialog?.querySelector('input[name="msiInstallMode"]:checked');
      const archiveChk = dialog?.querySelector('#chkMsiSaveToArchive');
      return {
        confirmed: true,
        silent: modeInput instanceof HTMLInputElement && modeInput.value === 'silent',
        saveToArchive: archiveChk instanceof HTMLInputElement && archiveChk.checked,
      };
    },
  });

  if (!choice || choice === 'cancel' || !choice.confirmed) return;

  let targetDir = '';
  let collisionMode = 'create';
  if (choice.saveToArchive) {
    const picked = await pickArchiveTargetFolder({ softwareName: pkgName, packageId: productCode || pkgName });
    if (picked.canceled) return;
    targetDir = picked.targetDir;
    collisionMode = picked.collisionMode;
  }

  showToast(t('discover.msiStarting', { name: pkgName }), { type: 'info' });
  const res = await window.electronAPI.installLocalMsi({
    filePath,
    silent: choice.silent,
    itemName: pkgName,
    saveToArchive: choice.saveToArchive,
    targetDir,
    collisionMode,
  });

  if (res?.alreadyRunning) {
    showToast(t('discover.msiAlreadyRunning'), { type: 'warn' });
  } else if (res?.canceled) {
    showToast(t('discover.msiCanceled'), { type: 'info' });
  } else if (res?.success) {
    await onReload?.({ rescanInstalled: true });
    if (choice.saveToArchive && res.archived) {
      showToast(t('discover.msiInstalledAndArchived', { name: pkgName }), { type: 'success' });
    } else if (choice.saveToArchive && res.archiveError) {
      showToast(t('discover.msiInstalledArchiveError', { name: pkgName, error: res.archiveError }), {
        type: 'warn',
        duration: 6000,
      });
    } else {
      showToast(t('discover.msiInstalled', { name: pkgName }), { type: 'success' });
    }
  } else {
    showToast(t('discover.msiFailed', { error: res?.error || t('common.unknownError') }), {
      type: 'error',
      duration: 6000,
    });
  }
}

function renderNotice() {
  const notice = document.getElementById('discoverNotice');
  if (!notice) return;

  const errors = Object.values(state.discoverByProvider || {})
    .filter((entry) => entry && !entry.success && entry.error)
    .map((entry) => `${entry.providerName || entry.providerId}: ${entry.error}`);

  if (errors.length === 0) {
    notice.hidden = true;
    notice.textContent = '';
    return;
  }

  notice.hidden = false;
  notice.textContent = errors.join(' · ');
}

function renderResults() {
  const container = document.getElementById('discoverResults');
  if (!container) return;

  if (state.discoverLoading) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>⏳ ${escapeHTML(t('discover.searchingTitle'))}</h3>
        <p>${escapeHTML(t('discover.searchingDesc'))}</p>
      </div>
    `;
    return;
  }

  if (!state.discoverHasSearched) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>${escapeHTML(t('discover.emptyTitle'))}</h3>
        <p>${escapeHTML(t('discover.emptyDesc'))}</p>
      </div>
    `;
    return;
  }

  const visibleEntries = state.discoverResults
    .map((pkg, idx) => ({
      pkg,
      idx,
      policy: evaluateItemPolicy(toDiscoverPolicyPkg(pkg), 'install'),
    }))
    .filter((entry) => entry.policy.visible);

  if (visibleEntries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>${escapeHTML(state.discoverResults.length > 0 ? t('discover.hiddenByPolicyTitle') : t('discover.noResultsTitle'))}</h3>
        <p>${escapeHTML(
          state.discoverResults.length > 0 ? t('discover.hiddenByPolicyDesc') : t('discover.noResultsDesc')
        )}</p>
      </div>
    `;
    return;
  }

  const iconCandidates = [];

  container.innerHTML = visibleEntries
    .map(({ pkg, idx, policy }) => {
      const providerId = String(pkg.providerId || pkg.packageManager || 'winget')
        .trim()
        .toLowerCase();
      const packageId = String(pkg.packageId || pkg.id || '').trim();
      const badgeInfo = getLocalizedProviderBadge(providerId, state.providers);
      const providerLabel =
        providerId === 'archive' ? t('providers.names.archive') : pkg.providerName || badgeInfo?.label || providerId;
      const badgeClass = badgeInfo?.badgeClass || '';
      const isArchiveSource = providerId === 'archive';
      const archiveMatch = findMatchingArchivePackage(pkg);
      const installedMatch = findMatchingInstalledPackageObj(pkg);
      const isInstalled = Boolean(pkg.isInstalled || installedMatch);
      const canDownloadToArchive =
        !isArchiveSource && !archiveMatch && getProviderCapability(providerId, 'supportsArchiveDownload');
      const canLinkToArchive = !isArchiveSource && !archiveMatch && Boolean(packageId);

      const iconItemId = isArchiveSource ? archiveMatch?.id || packageId : `remote:${providerId}:${packageId}`;
      const iconPkgKey = !isArchiveSource && packageId ? `${providerId}:${packageId.toLowerCase()}` : '';
      const iconTarget = {
        id: iconItemId,
        name: pkg.name || packageId,
        icon: archiveMatch?.icon || installedMatch?.icon || pkg.icon || null,
        displayIcon: installedMatch?.displayIcon || archiveMatch?.displayIcon || '',
        installLocation: installedMatch?.installLocation || archiveMatch?.installLocation || '',
        validInstallPath: installedMatch?.validInstallPath || archiveMatch?.validInstallPath || '',
        uninstallString: installedMatch?.uninstallString || archiveMatch?.uninstallString || '',
        appxPackageFamilyName: installedMatch?.appxPackageFamilyName || archiveMatch?.appxPackageFamilyName || '',
        packageManager: isArchiveSource ? archiveMatch?.packageManager || '' : providerId,
        packageId: isArchiveSource ? archiveMatch?.packageId || archiveMatch?.wingetId || '' : packageId,
        homepage: pkg.homepage || installedMatch?.homepage || archiveMatch?.homepage || '',
        webVersionUrl: archiveMatch?.webVersionUrl || '',
        links: Array.isArray(archiveMatch?.links) ? archiveMatch.links : [],
      };
      const resolvedIconPath = getCachedIconForPackage(iconTarget);
      if (!resolvedIconPath) {
        iconCandidates.push(iconTarget);
      }

      const iconHtml = resolvedIconPath
        ? `<img class="discover-card-icon" src="${escapeHTML(toMediaUrl(resolvedIconPath))}" width="36" height="36" loading="lazy" decoding="async" alt="">`
        : `<div class="discover-card-icon-fallback" data-icon-item-id="${escapeHTML(iconItemId)}" data-icon-pkg-key="${escapeHTML(iconPkgKey)}" data-icon-class="discover-card-icon">${isArchiveSource ? '📦' : '🛍️'}</div>`;

      const archiveActionHtml = archiveMatch
        ? `<button type="button" class="btn btn-ghost" data-discover-action="open-archive" data-archive-id="${escapeHTML(archiveMatch.id)}">📂 ${escapeHTML(t('discover.openInArchive'))}</button>`
        : canLinkToArchive
          ? `<button type="button" class="btn btn-archive" data-discover-action="link-archive" data-result-idx="${idx}">${
              canDownloadToArchive
                ? `🗄️ ${escapeHTML(t('discover.downloadToArchive'))}`
                : `📥 ${escapeHTML(t('discover.addToArchive'))}`
            }</button>`
          : '';

      const installBtnHtml = policy.adwareConflict
        ? `<button type="button" class="btn btn-primary" data-discover-action="install" data-result-idx="${idx}" disabled title="${escapeHTML(getLocalizedPolicyError(policy, 'discover.policyBlocked'))}">🚫 ${escapeHTML(t('discover.blockedAdware'))}</button>`
        : policy.silentOnly
          ? `<button type="button" class="btn btn-primary" data-discover-action="install" data-result-idx="${idx}" title="${escapeHTML(t('discover.installSilentTitle'))}">⚡ ${escapeHTML(t('discover.installSilent'))}</button>`
          : `<button type="button" class="btn btn-primary" data-discover-action="install" data-result-idx="${idx}">⬇️ ${escapeHTML(t('common.install'))}</button>`;

      return `
        <article class="discover-card">
          ${iconHtml}
          <div class="discover-card-main">
            <div class="discover-card-title">
              <strong>${escapeHTML(pkg.name || packageId)}</strong>
              <span class="provider-badge ${escapeHTML(badgeClass)}">${escapeHTML(providerLabel)}</span>
              ${pkg.version ? `<span class="card-chip">v${escapeHTML(pkg.version)}</span>` : ''}
              ${archiveMatch && !isArchiveSource ? `<span class="discover-status-badge">${escapeHTML(t('discover.badgeInArchive'))}</span>` : ''}
              ${isInstalled ? `<span class="discover-status-badge">${escapeHTML(t('discover.badgeInstalled'))}</span>` : ''}
            </div>
            <div class="discover-card-meta">
              <code>${escapeHTML(packageId)}</code>
              ${pkg.source && pkg.source !== providerId ? `<span>${escapeHTML(t('discover.sourceMeta', { source: pkg.source }))}</span>` : ''}
            </div>
            ${pkg.shortDescription ? `<p class="discover-card-desc">${escapeHTML(pkg.shortDescription)}</p>` : ''}
          </div>
          <div class="discover-card-actions">
            <button type="button" class="btn btn-ghost" data-discover-action="details" data-result-idx="${idx}">ℹ️ ${escapeHTML(t('discover.detailsButton'))}</button>
            ${installBtnHtml}
            ${archiveActionHtml}
          </div>
        </article>
      `;
    })
    .join('');

  if (iconCandidates.length > 0) {
    queueItemsForIconResolution(iconCandidates, { prioritize: true });
  }
}

export function renderDiscoverView() {
  const input = qsInput(document, '#discoverSearchInput');
  const clearBtn = document.getElementById('clearDiscoverSearchBtn');
  if (input && input.value !== state.discoverQuery) {
    input.value = state.discoverQuery;
  }
  if (clearBtn) {
    clearBtn.hidden = state.discoverQuery.length === 0;
  }

  renderSourceChips();
  renderLocalActions();
  renderNotice();
  renderResults();
}

export function initDiscoverView({ onReload, onOpenArchiveDetail, onOpenPackageDetail, onLinkToArchive }) {
  const searchInput = qsInput(document, '#discoverSearchInput');
  const clearBtn = document.getElementById('clearDiscoverSearchBtn');
  const searchBtn = document.getElementById('btnDiscoverSearch');
  const chipsContainer = document.getElementById('discoverSourceChips');
  const localActionsContainer = document.getElementById('discoverLocalActions');
  const resultsContainer = document.getElementById('discoverResults');

  const executeSearch = async () => {
    const query = (searchInput?.value ?? state.discoverQuery).trim();
    state.discoverQuery = query;

    if (state.discoverSelectedProviders.length === 0) {
      showToast(t('discover.selectAtLeastOneSource'), { type: 'warn' });
      return;
    }

    const onlyLocalOrNvm = state.discoverSelectedProviders.every((id) => id === 'archive' || id === 'nvm');
    if (!onlyLocalOrNvm && query.length < 2) {
      showToast(t('discover.minCharsQuery'), { type: 'info' });
      return;
    }

    const reqId = ++searchRequestSeq;
    state.discoverLoading = true;
    state.discoverHasSearched = true;
    state.discoverByProvider = {};
    renderDiscoverView();

    try {
      const res = await window.electronAPI.searchProviders(query, {
        providerIds: [...state.discoverSelectedProviders],
        limit: 30,
      });

      if (reqId !== searchRequestSeq) return;

      state.discoverLoading = false;
      state.discoverResults = Array.isArray(res?.results) ? res.results : [];
      state.discoverByProvider = res?.byProvider || {};
      renderDiscoverView();
    } catch (err) {
      if (reqId !== searchRequestSeq) return;
      state.discoverLoading = false;
      state.discoverResults = [];
      state.discoverByProvider = {
        error: { success: false, providerName: t('discover.searchProviderFallback'), error: err.message },
      };
      renderDiscoverView();
    }
  };

  searchInput?.addEventListener('input', () => {
    state.discoverQuery = searchInput.value;
    if (clearBtn) clearBtn.hidden = state.discoverQuery.length === 0;
  });

  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeSearch();
    }
  });

  clearBtn?.addEventListener('click', () => {
    if (!searchInput) return;
    searchInput.value = '';
    state.discoverQuery = '';
    state.discoverHasSearched = false;
    state.discoverResults = [];
    state.discoverByProvider = {};
    clearBtn.hidden = true;
    renderDiscoverView();
    searchInput.focus();
  });

  searchBtn?.addEventListener('click', () => executeSearch());

  chipsContainer?.addEventListener('click', (e) => {
    const chip = closestEl(e.target, '[data-discover-provider]');
    if (!chip) return;
    const providerId = chip.dataset.discoverProvider;
    const idx = state.discoverSelectedProviders.indexOf(providerId);
    if (idx > -1) {
      state.discoverSelectedProviders.splice(idx, 1);
    } else {
      state.discoverSelectedProviders.push(providerId);
    }
    renderSourceChips();

    if (state.discoverHasSearched && state.discoverSelectedProviders.length > 0) {
      executeSearch();
    }
  });

  localActionsContainer?.addEventListener('click', (e) => {
    const btn = closestButton(e.target, '#btnInstallLocalMsi');
    if (btn) {
      void runLocalMsiWizard({ onReload });
    }
  });

  resultsContainer?.addEventListener('click', async (e) => {
    const btn = closestButton(e.target, '[data-discover-action]');
    if (!btn) return;

    const action = btn.dataset.discoverAction;
    if (action === 'open-archive') {
      onOpenArchiveDetail?.(btn.dataset.archiveId);
      return;
    }

    const idx = parseInt(btn.dataset.resultIdx, 10);
    const pkg = state.discoverResults[idx];
    if (!pkg) return;

    const providerId = pkg.providerId || pkg.packageManager || 'winget';
    const packageId = pkg.packageId || pkg.id;

    if (action === 'details') {
      if (providerId === 'archive') {
        onOpenArchiveDetail?.(packageId);
      } else {
        onOpenPackageDetail?.(providerId, packageId, pkg);
      }
      return;
    }

    if (action === 'link-archive') {
      const supportsSetupDl = getProviderCapability(providerId, 'supportsArchiveDownload');
      onLinkToArchive?.(
        {
          id: `remote:${providerId}:${packageId}`,
          packageManager: providerId,
          packageId,
          name: pkg.name || packageId,
          version: pkg.version || '',
          shortDescription: pkg.shortDescription || '',
          homepage: pkg.homepage || '',
        },
        { downloadSetup: supportsSetupDl }
      );
      return;
    }

    if (action === 'install') {
      const policyEval = evaluateItemPolicy(toDiscoverPolicyPkg(pkg), 'install');
      if (!policyEval.allowed) {
        showToast(getLocalizedPolicyError(policyEval, 'discover.policyBlocked'), {
          type: 'error',
          duration: 6000,
        });
        return;
      }

      const archiveMatch = findMatchingArchivePackage(pkg);
      const canLinkAfterInstall = providerId !== 'archive' && !archiveMatch && Boolean(packageId);
      const supportsSetupDl = getProviderCapability(providerId, 'supportsArchiveDownload');
      const saveMode = state.settings.archiveSaveMode || 'ask';

      const linkPayload = {
        id: `remote:${providerId}:${packageId}`,
        packageManager: providerId,
        packageId,
        name: pkg.name || packageId,
        version: pkg.version || '',
        shortDescription: pkg.shortDescription || '',
        homepage: pkg.homepage || '',
      };

      const itemName = pkg.name || packageId;
      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = `⏳ ${t('discover.installingBtn')}`;
      showToast(t('discover.installStarting', { name: itemName }), { type: 'info' });

      const res = await window.electronAPI.installPackage(providerId, packageId, {
        silent: policyEval.silentOnly,
        itemName,
      });

      btn.disabled = false;
      btn.textContent = origText;

      if (res?.alreadyRunning) {
        showToast(t('discover.installAlreadyRunning'), { type: 'warn' });
      } else if (res?.canceled) {
        showToast(t('discover.installCanceled'), { type: 'info' });
      } else if (res?.success) {
        await onReload?.({ rescanInstalled: true });
        if (canLinkAfterInstall && saveMode === 'auto-id') {
          showToast(t('discover.installedAutoArchiving', { name: itemName }), { type: 'info' });
          await onLinkToArchive?.(linkPayload, { mode: 'auto-id', downloadSetup: supportsSetupDl });
        } else if (canLinkAfterInstall && saveMode === 'ask') {
          showToast(t('discover.installedSuccess', { name: itemName }), {
            type: 'success',
            duration: 6000,
            action: {
              label: `📥 ${t('discover.installToArchiveAction')}`,
              onClick: () => onLinkToArchive?.(linkPayload, { mode: 'ask', downloadSetup: supportsSetupDl }),
            },
          });
        } else {
          showToast(t('discover.installedSuccess', { name: itemName }), { type: 'success' });
        }
      } else {
        showToast(t('discover.installError', { error: res?.error || t('common.unknownError') }), {
          type: 'error',
          duration: 6000,
        });
      }
    }
  });
}
