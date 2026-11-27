import { evaluateBundleStatus, planBundleExecution } from '../../shared/bundles-logic.js';
import { renderBundlesView } from '../components/bundles-view.js';
import { getCachedIconForPackage, queueItemsForIconResolution } from '../components/cards.js';
import { showToast } from '../components/toast.js';
import { buildBundleItemPolicyPkg, evaluateItemPolicy, state } from '../state.js';
import { closestEl, closestInput, qsInput } from '../utils/dom.js';
import { getLocalizedPolicyError, getLocalizedProviderBadge, t } from '../utils/i18n.js';
import { escapeHTML, toMediaUrl } from '../utils/sanitize.js';
import { askBatchArchiveSaveChoice, pickArchiveTargetFolder } from './archive-target-modal.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';

let activeRunnerToken = 0;

function getArchiveSaveModeLabel(mode) {
  if (mode === 'auto-id') return t('bundleRunner.saveModeAutoId');
  if (mode === 'none') return t('bundleRunner.saveModeNone');
  return t('bundleRunner.saveModeAsk');
}

export function renderBundleRunnerModal(bundleId, { onRescanPc = null } = {}) {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;

  const bundle = state.bundles.find((b) => b.id === bundleId);
  if (!bundle) {
    showToast(t('bundleRunner.notFoundToast'), { type: 'error' });
    return;
  }

  resetModalContent();
  const token = ++activeRunnerToken;
  state.currentModalId = null;
  state.isEditModalOpen = false;

  const isStillOpen = () => token === activeRunnerToken && !overlay.hidden;

  let allowSilent = true;
  let silentWinget = false; // Strikt opt-in (Standard bleibt interaktiv)
  let isRescanning = false;
  let isStarting = false;

  const computeEvaluation = () => {
    const rawEval = evaluateBundleStatus(bundle, {
      packages: state.packages,
      versionCompareDepth: state.settings.versionCompareDepth ?? 3,
      t,
    });
    const visibleItems = [];
    let installedCount = 0;
    let upToDateCount = 0;
    let outdatedCount = 0;
    let missingCount = 0;
    let adwareProtectedCount = 0;
    let silentReadyCount = 0;

    for (const entry of rawEval.items) {
      const action = entry.action === 'update' ? 'update' : 'install';
      const policyEval = evaluateItemPolicy(buildBundleItemPolicyPkg(entry), action);
      if (!policyEval.visible) continue;

      const policyBlocked = !policyEval.allowed;
      const enriched = {
        ...entry,
        policyEval,
        policySilentOnly: policyEval.silentOnly,
        policyAdwareConflict: policyEval.adwareConflict,
        policyBlocked,
        defaultSelected: !policyBlocked && entry.defaultSelected,
      };
      visibleItems.push(enriched);

      if (enriched.isInstalled) installedCount++;
      if (enriched.status === 'up-to-date') upToDateCount++;
      else if (enriched.status === 'outdated') outdatedCount++;
      else missingCount++;
      if (enriched.adwareProtected) adwareProtectedCount++;
      if (enriched.canRunArchiveSilent) silentReadyCount++;
    }

    const total = visibleItems.length;
    return {
      items: visibleItems,
      summary: {
        total,
        installedCount,
        upToDateCount,
        outdatedCount,
        missingCount,
        adwareProtectedCount,
        silentReadyCount,
        statusText:
          total === 0
            ? t('bundleRunner.noVisiblePackages')
            : t('bundles.installedOfTotal', { installed: installedCount, total }),
      },
    };
  };

  let evaluation = computeEvaluation();
  const selectedKeys = new Set(evaluation.items.filter((it) => it.defaultSelected).map((it) => it.key));

  const render = () => {
    if (!isStillOpen()) return;

    const currentBundle = state.bundles.find((b) => b.id === bundleId) || bundle;
    evaluation = computeEvaluation();
    const { items, summary } = evaluation;

    const selectedEntries = items.filter((it) => selectedKeys.has(it.key) && !it.archiveMissing && !it.policyBlocked);
    const plan = planBundleExecution(selectedEntries, { allowSilent, silentWinget, t });
    const planByKey = new Map(plan.orderedQueue.map((entry) => [entry.key, entry]));
    const saveMode = state.settings.archiveSaveMode || 'ask';
    const runnerIconCandidates = [];

    const rowsHtml =
      items.length === 0
        ? `<div class="bundle-items-empty">${escapeHTML(t('bundleRunner.emptyVisible'))}</div>`
        : items
            .map((entry) => {
              const rowDisabled = entry.archiveMissing || entry.policyBlocked;
              const checked = selectedKeys.has(entry.key) && !rowDisabled;
              const planned = planByKey.get(entry.key);

              let statusClass = 'is-missing';
              if (entry.archiveMissing || entry.policyBlocked) statusClass = 'is-warn';
              else if (entry.status === 'up-to-date') statusClass = 'is-ok';
              else if (entry.status === 'outdated') statusClass = 'is-outdated';

              const statusText = entry.policyBlocked
                ? `🚫 ${t('bundleRunner.statusPolicyBlocked')}`
                : entry.archiveMissing
                  ? `⚠️ ${t('bundleRunner.statusArchiveMissing')}`
                  : entry.statusLabel;

              let versionNote = '';
              if (entry.installedVersion && entry.availableVersion && entry.status === 'outdated') {
                versionNote = `v${entry.installedVersion} → v${entry.availableVersion}`;
              } else if (entry.installedVersion) {
                versionNote = t('bundleRunner.versionInstalled', { version: entry.installedVersion });
              } else if (entry.availableVersion) {
                versionNote = t('bundleRunner.versionAvailable', { version: entry.availableVersion });
              }

              const policyErrText = entry.policyBlocked
                ? getLocalizedPolicyError(entry.policyEval, 'bundleRunner.statusPolicyBlocked')
                : '';

              let phaseBadgeHtml = '';
              if (entry.policyAdwareConflict) {
                phaseBadgeHtml = `<span class="card-chip chip-install-protected" title="${escapeHTML(policyErrText)}">🚫 ${escapeHTML(t('bundleRunner.badgeAdwareConflict'))}</span>`;
              } else if (entry.adwareProtected) {
                phaseBadgeHtml = `<span class="card-chip chip-install-protected" title="${escapeHTML(t('bundleRunner.badgeAdwareProtectedTitle'))}">🛡️ ${escapeHTML(t('bundleRunner.badgeAdwareProtected'))}</span>`;
              } else if (entry.policySilentOnly) {
                phaseBadgeHtml = `<span class="card-chip chip-install-silent" title="${escapeHTML(t('bundleRunner.badgePolicySilentOnlyTitle'))}">🔒 ${escapeHTML(t('bundleRunner.badgePolicySilentOnly'))}</span>`;
              } else if (planned?.willRunSilent) {
                phaseBadgeHtml = `<span class="card-chip chip-install-silent">⚡ ${escapeHTML(t('bundleRunner.badgePhaseSilent'))}</span>`;
              } else if (checked) {
                phaseBadgeHtml = `<span class="card-chip">🖱️ ${escapeHTML(t('bundleRunner.badgePhaseInteractive'))}</span>`;
              }

              const entryBadge = getLocalizedProviderBadge(entry.source, state.providers);
              const iconTarget = entry.matchedPackage || {
                id: entry.key,
                name: entry.name,
                packageManager: entry.source === 'archive' ? '' : entry.source,
                packageId: entry.packageId || '',
              };
              const iconPkgKey =
                entry.source !== 'archive' && entry.packageId
                  ? `${String(entry.source).toLowerCase()}:${String(entry.packageId).toLowerCase()}`
                  : '';
              const iconPath = getCachedIconForPackage(iconTarget);
              if (!iconPath) {
                runnerIconCandidates.push(iconTarget);
              }
              const itemIconHtml = iconPath
                ? `<img class="bundle-item-icon" src="${escapeHTML(toMediaUrl(iconPath))}" loading="lazy" decoding="async" alt="">`
                : `<span class="bundle-item-icon-fallback" data-icon-item-id="${escapeHTML(iconTarget.id)}" data-icon-pkg-key="${escapeHTML(iconPkgKey)}" data-icon-class="bundle-item-icon"></span>`;

              return `
                <label class="bundle-runner-row ${checked ? 'is-checked' : ''} ${rowDisabled ? 'is-disabled' : ''}" ${entry.policyBlocked ? `title="${escapeHTML(policyErrText)}"` : ''}>
                  <input
                    type="checkbox"
                    class="bundle-runner-check"
                    data-runner-key="${escapeHTML(entry.key)}"
                    ${checked ? 'checked' : ''}
                    ${rowDisabled || isStarting ? 'disabled' : ''}
                  >
                  <span class="bundle-item-order">#${entry.order}</span>
                  <div class="bundle-runner-info">
                    <div class="bundle-item-title">
                      ${itemIconHtml}
                      <strong>${escapeHTML(entry.name)}</strong>
                      <span class="provider-badge ${escapeHTML(entryBadge?.badgeClass || '')}">${escapeHTML(entryBadge?.label || entry.source)}</span>
                      ${entry.optional ? `<span class="card-chip">${escapeHTML(t('common.optional'))}</span>` : ''}
                      ${phaseBadgeHtml}
                    </div>
                    <div class="bundle-item-meta">
                      ${entry.packageId ? `<code>${escapeHTML(entry.packageId)}</code>` : ''}
                      ${versionNote ? `<span class="muted">${escapeHTML(versionNote)}</span>` : ''}
                    </div>
                  </div>
                  <span class="bundle-status-badge ${statusClass}">${escapeHTML(statusText)}</span>
                </label>
              `;
            })
            .join('');

    const phaseNoticeHtml =
      selectedEntries.length === 0
        ? `<div class="bundle-phase-banner">ℹ️ ${escapeHTML(t('bundleRunner.phaseNoneSelected'))}</div>`
        : `
          <div class="bundle-phase-banner ${plan.stats.adwareProtectedCount > 0 ? 'has-protected' : ''}">
            <div>
              <strong>${escapeHTML(t('bundleRunner.phasePlanTitle'))}</strong>
              <span>${escapeHTML(t('bundleRunner.phasePlanSummary', { silentCount: plan.stats.silentCount, interactiveCount: plan.stats.interactiveCount }))}</span>
            </div>
            ${plan.interactiveNotice ? `<p class="muted">${escapeHTML(plan.interactiveNotice)}</p>` : ''}
          </div>
        `;

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${escapeHTML(currentBundle.icon || '📦')} ${escapeHTML(currentBundle.name)}</h2>
          <span class="muted">${escapeHTML(currentBundle.description || t('bundleRunner.defaultSubtitle'))}</span>
        </div>
        <button type="button" class="icon-btn" data-runner-action="close" title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(t('common.close'))}">✕</button>
      </div>

      <div class="modal-body bundle-runner-body">
        <div class="matcher-summary-bar">
          <div class="matcher-kpi is-accent"><strong>${selectedEntries.length}</strong><span>${escapeHTML(t('bundleRunner.kpiSelected'))}</span></div>
          <div class="matcher-kpi"><strong>${summary.missingCount}</strong><span>⬇️ ${escapeHTML(t('bundleRunner.kpiMissing'))}</span></div>
          <div class="matcher-kpi"><strong>${summary.outdatedCount}</strong><span>⬆️ ${escapeHTML(t('bundleRunner.kpiOutdated'))}</span></div>
          <div class="matcher-kpi"><strong>${summary.upToDateCount}</strong><span>✅ ${escapeHTML(t('bundleRunner.kpiUpToDate'))}</span></div>
        </div>

        <div class="bundle-runner-toolbar">
          <div class="bundle-runner-quick-btns">
            <button type="button" class="btn btn-ghost btn-xs" data-runner-action="select-needed" ${isStarting ? 'disabled' : ''}>${escapeHTML(t('bundleRunner.btnSelectNeeded'))}</button>
            <button type="button" class="btn btn-ghost btn-xs" data-runner-action="select-all" ${isStarting ? 'disabled' : ''}>${escapeHTML(t('bundleRunner.btnSelectAll'))}</button>
            <button type="button" class="btn btn-ghost btn-xs" data-runner-action="select-none" ${isStarting ? 'disabled' : ''}>${escapeHTML(t('bundleRunner.btnSelectNone'))}</button>
          </div>
          <button type="button" class="btn btn-local btn-xs" data-runner-action="rescan-pc" ${isRescanning || isStarting ? 'disabled' : ''}>
            ${isRescanning ? `⏳ ${escapeHTML(t('bundleRunner.btnRescanning'))}` : `💻 ${escapeHTML(t('bundleRunner.btnRescanPc'))}`}
          </button>
        </div>

        <div class="bundle-runner-options">
          <label class="check-row">
            <input type="checkbox" id="chkBundleAllowSilent" ${allowSilent ? 'checked' : ''} ${isStarting ? 'disabled' : ''}>
            <span>⚡ ${escapeHTML(t('bundleRunner.chkAllowSilent'))}</span>
          </label>
          <label class="check-row">
            <input type="checkbox" id="chkBundleSilentWinget" ${silentWinget ? 'checked' : ''} ${isStarting ? 'disabled' : ''}>
            <span>⚡ ${escapeHTML(t('bundleRunner.chkSilentWinget'))}</span>
          </label>
          <div class="bundle-save-mode-hint muted">
            ${escapeHTML(t('bundleRunner.saveModeHintPrefix'))} <strong>${escapeHTML(getArchiveSaveModeLabel(saveMode))}</strong>
          </div>
        </div>

        ${phaseNoticeHtml}

        <div class="bundle-runner-list">
          ${rowsHtml}
        </div>
      </div>

      <div class="modal-footer">
        <span class="muted">${escapeHTML(summary.statusText)}</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-runner-action="close" ${isStarting ? 'disabled' : ''}>${escapeHTML(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-runner-action="start" ${selectedEntries.length === 0 || isStarting || state.isBundleInstallRunning ? 'disabled' : ''}>
            ${isStarting ? `⏳ ${escapeHTML(t('bundleRunner.btnStarting'))}` : `🚀 ${escapeHTML(t('bundleRunner.btnStart', { count: selectedEntries.length }))}`}
          </button>
        </div>
      </div>
    `;

    if (runnerIconCandidates.length > 0) {
      queueItemsForIconResolution(runnerIconCandidates, { prioritize: true });
    }

    const chkAllowSilent = qsInput(modal, '#chkBundleAllowSilent');
    if (chkAllowSilent) {
      chkAllowSilent.onchange = () => {
        allowSilent = chkAllowSilent.checked;
        render();
      };
    }

    const chkSilentWinget = qsInput(modal, '#chkBundleSilentWinget');
    if (chkSilentWinget) {
      chkSilentWinget.onchange = () => {
        silentWinget = chkSilentWinget.checked;
        render();
      };
    }
  };

  overlay.hidden = false;

  modal.onchange = (e) => {
    const chk = closestInput(e.target, '[data-runner-key]');
    if (!chk) return;
    const key = chk.dataset.runnerKey;
    if (chk.checked) selectedKeys.add(key);
    else selectedKeys.delete(key);
    render();
  };

  modal.onclick = async (e) => {
    const btn = closestEl(e.target, '[data-runner-action]');
    if (!btn) return;
    const action = btn.dataset.runnerAction;

    if (action === 'close') {
      closeModal();
      return;
    }

    if (action === 'select-needed') {
      selectedKeys.clear();
      for (const it of evaluation.items) {
        if (it.defaultSelected) selectedKeys.add(it.key);
      }
      render();
      return;
    }

    if (action === 'select-all') {
      selectedKeys.clear();
      for (const it of evaluation.items) {
        if (!it.archiveMissing && !it.policyBlocked) selectedKeys.add(it.key);
      }
      render();
      return;
    }

    if (action === 'select-none') {
      selectedKeys.clear();
      render();
      return;
    }

    if (action === 'rescan-pc') {
      isRescanning = true;
      render();
      try {
        await onRescanPc?.();
        if (!isStillOpen()) return;
        const freshEval = computeEvaluation();
        selectedKeys.clear();
        for (const it of freshEval.items) {
          if (it.defaultSelected) selectedKeys.add(it.key);
        }
      } finally {
        isRescanning = false;
        render();
      }
      return;
    }

    if (action === 'start') {
      const selectedEntries = evaluation.items.filter(
        (it) => selectedKeys.has(it.key) && !it.archiveMissing && !it.policyBlocked
      );
      if (selectedEntries.length === 0 || state.isBundleInstallRunning) return;

      const saveMode = state.settings.archiveSaveMode || 'ask';
      const supportsArchiveSave = (pm) => {
        const prov = state.providers.find((p) => p.id === pm);
        return prov ? Boolean(prov.capabilities?.supportsArchiveDownload) : pm === 'winget';
      };
      const nonArchiveWinget = selectedEntries.filter(
        (entry) =>
          entry.source !== 'archive' &&
          entry.packageId &&
          !entry.matchedPackage?.inArchive &&
          supportsArchiveSave(entry.source)
      );
      const archiveSaveSpecs = {};

      if (saveMode === 'ask' && nonArchiveWinget.length > 0) {
        for (let idx = 0; idx < nonArchiveWinget.length; idx++) {
          const entry = nonArchiveWinget[idx];
          const choice = await askBatchArchiveSaveChoice({
            softwareName: entry.name,
            packageId: entry.packageId,
            index: idx + 1,
            total: nonArchiveWinget.length,
          });
          if (choice === 'cancel') {
            return;
          }
          if (choice === 'skip-archive') {
            archiveSaveSpecs[entry.key] = { saveMode: 'none' };
            continue;
          }
          const picked = await pickArchiveTargetFolder({
            softwareName: entry.name,
            packageId: entry.packageId,
          });
          if (picked.canceled) {
            return;
          }
          archiveSaveSpecs[entry.key] = {
            saveMode: 'ask',
            targetDir: picked.targetDir,
            collisionMode: picked.collisionMode,
          };
        }
      }

      isStarting = true;
      state.isBundleInstallRunning = true;
      closeModal();
      if (state.activeTab === 'bundles') renderBundlesView();
      showToast(t('bundleRunner.startingToast', { name: bundle.name, count: selectedEntries.length }), {
        type: 'info',
      });

      try {
        const res = await window.electronAPI.runBundleInstall(
          bundle.id,
          selectedEntries.map((it) => it.key),
          {
            allowSilent,
            silentWinget,
            installedApps: state.installedApps,
            archiveSaveSpecs,
          }
        );

        state.isBundleInstallRunning = false;
        await triggerCatalogReload({ rescanInstalled: true });

        if (res?.alreadyRunning) {
          showToast(t('bundleRunner.alreadyRunningToast'), { type: 'warn' });
        } else if (res?.canceled) {
          showToast(t('bundleRunner.canceledToast'), { type: 'info' });
        } else if (res?.success) {
          const type = res.failed > 0 ? 'warn' : 'success';
          showToast(
            t('bundleRunner.finishedToast', {
              completed: res.completed,
              skipped: res.skipped,
              failed: res.failed,
            }),
            { type, duration: 6000 }
          );
        } else if (res?.error) {
          showToast(t('bundleRunner.errorToast', { error: res.error }), { type: 'error', duration: 6000 });
        }
      } finally {
        state.isBundleInstallRunning = false;
        if (state.activeTab === 'bundles') renderBundlesView();
      }
    }
  };

  render();
}
