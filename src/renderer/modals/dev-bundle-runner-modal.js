import { evaluateDevBundleForProject, getDevManagerEcosystem } from '../../shared/dev-bundles-logic.js';
import { getDevManagerMeta } from '../../shared/dev-ui-logic.js';
import { showToast } from '../components/toast.js';
import { setDevScanResult, state } from '../state.js';
import { closestEl, closestInput } from '../utils/dom.js';
import { t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';
import { closeModal, resetModalContent } from './index.js';
import { ensureAdminAuthenticated } from './login-modal.js';

let activeRunnerToken = 0;

/**
 * Oeffnet den Projekt-Abgleich & Installer fuer ein Dev-Buendel im geoeffneten Projekt.
 * @param {{
 *   project: Record<string, any>,
 *   bundle: Record<string, any>,
 *   scan: Record<string, any> | null,
 *   onInstalled?: ((res: any) => void) | null,
 * }} params
 */
export function renderDevBundleRunnerModal({ project, bundle, scan = null, onInstalled = null }) {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal || !project || !bundle) return;

  resetModalContent();
  const token = ++activeRunnerToken;
  state.currentModalId = null;
  state.isEditModalOpen = false;

  const isStillOpen = () => token === activeRunnerToken && !overlay.hidden;

  const projectManagers = Array.isArray(scan?.managers) ? scan.managers : [];
  const bundleEco = getDevManagerEcosystem(bundle.manager);
  const sameEcoManagers = projectManagers.filter((m) => getDevManagerEcosystem(m) === bundleEco);
  let targetManager = projectManagers.includes(bundle.manager) ? bundle.manager : sameEcoManagers[0] || bundle.manager;

  const evaluation = evaluateDevBundleForProject(bundle, scan, { t });
  const selectedKeys = new Set(evaluation.packages.filter((p) => p.defaultSelected).map((p) => p.key));
  let isInstalling = false;

  const render = () => {
    if (!isStillOpen()) return;

    const { packages, summary } = evaluation;
    const selectedEntries = packages.filter((p) => selectedKeys.has(p.key));
    const mgrMeta = getDevManagerMeta(targetManager);

    const targetManagerSelectorHtml =
      sameEcoManagers.length > 1 || (sameEcoManagers.length === 1 && targetManager !== bundle.manager)
        ? `
          <div class="dev-bundle-runner-mgr-row">
            <span class="muted">${escapeHTML(t('dev.bundleRunner.targetManagerLabel'))}</span>
            <div class="dev-filter-chips">
              ${(sameEcoManagers.length > 0 ? sameEcoManagers : [bundle.manager])
                .map((mgr) => {
                  const mMeta = getDevManagerMeta(mgr);
                  return `<button type="button" class="origin-chip ${mgr === targetManager ? 'active' : ''}" data-dev-runner-mgr="${escapeHTML(mgr)}" ${isInstalling ? 'disabled' : ''}>${escapeHTML(mMeta.label)}</button>`;
                })
                .join('')}
            </div>
          </div>
        `
        : '';

    const rowsHtml =
      packages.length === 0
        ? `<div class="bundle-items-empty">${escapeHTML(t('dev.bundleRunner.emptyPackages'))}</div>`
        : packages
            .map((entry) => {
              const checked = selectedKeys.has(entry.key);
              const statusClass =
                entry.status === 'installed' ? 'is-ok' : entry.status === 'outdated' ? 'is-outdated' : 'is-missing';
              const scopeLabel = entry.isDev ? t('dev.workspace.scopeBadgeDev') : t('dev.workspace.scopeBadgeProd');

              let versionNote = '';
              if (entry.installedVersion && entry.targetVersion && entry.status === 'outdated') {
                versionNote = `v${entry.installedVersion} -> v${entry.targetVersion}`;
              } else if (entry.installedVersion) {
                versionNote = t('bundleRunner.versionInstalled', { version: entry.installedVersion });
              } else if (entry.version) {
                versionNote = t('dev.bundleRunner.requestedVersion', { version: entry.version });
              }

              return `
                <label class="bundle-runner-row ${checked ? 'is-checked' : ''}">
                  <input
                    type="checkbox"
                    class="bundle-runner-check"
                    data-dev-runner-key="${escapeHTML(entry.key)}"
                    ${checked ? 'checked' : ''}
                    ${isInstalling ? 'disabled' : ''}
                  >
                  <span class="bundle-item-order">#${entry.order}</span>
                  <div class="bundle-runner-info">
                    <div class="bundle-item-title">
                      <strong>${escapeHTML(entry.name)}</strong>
                      <span class="dev-scope-badge ${entry.isDev ? 'is-dev' : 'is-prod'}">${escapeHTML(scopeLabel)}</span>
                      ${entry.optional ? `<span class="card-chip">${escapeHTML(t('common.optional'))}</span>` : ''}
                      ${entry.isMajor ? `<span class="dev-major-badge">⚠️ ${escapeHTML(t('dev.workspace.badgeMajor'))}</span>` : ''}
                    </div>
                    ${
                      versionNote
                        ? `<div class="bundle-item-meta"><span class="muted">${escapeHTML(versionNote)}</span></div>`
                        : ''
                    }
                  </div>
                  <span class="bundle-status-badge ${statusClass}">${escapeHTML(entry.statusLabel)}</span>
                </label>
              `;
            })
            .join('');

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${escapeHTML(bundle.icon || '🧺')} ${escapeHTML(bundle.name)}</h2>
          <span class="muted">${escapeHTML(t('dev.bundleRunner.subtitle', { project: project.name, manager: mgrMeta.label }))}</span>
        </div>
        <button type="button" class="icon-btn" data-dev-runner-action="close" title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(t('common.close'))}">✕</button>
      </div>

      <div class="modal-body bundle-runner-body">
        <div class="matcher-summary-bar">
          <div class="matcher-kpi is-accent"><strong>${selectedEntries.length}</strong><span>${escapeHTML(t('bundleRunner.kpiSelected'))}</span></div>
          <div class="matcher-kpi"><strong>${summary.missingCount}</strong><span>⬇️ ${escapeHTML(t('dev.bundles.kpiMissing'))}</span></div>
          <div class="matcher-kpi"><strong>${summary.outdatedCount}</strong><span>⬆️ ${escapeHTML(t('dev.bundles.kpiOutdated'))}</span></div>
          <div class="matcher-kpi"><strong>${summary.installedCount}</strong><span>✅ ${escapeHTML(t('dev.bundles.kpiInstalled'))}</span></div>
        </div>

        ${targetManagerSelectorHtml}

        <div class="bundle-runner-toolbar">
          <div class="bundle-runner-quick-btns">
            <button type="button" class="btn btn-ghost btn-xs" data-dev-runner-action="select-needed" ${isInstalling ? 'disabled' : ''}>${escapeHTML(t('bundleRunner.btnSelectNeeded'))}</button>
            <button type="button" class="btn btn-ghost btn-xs" data-dev-runner-action="select-all" ${isInstalling ? 'disabled' : ''}>${escapeHTML(t('bundleRunner.btnSelectAll'))}</button>
            <button type="button" class="btn btn-ghost btn-xs" data-dev-runner-action="select-none" ${isInstalling ? 'disabled' : ''}>${escapeHTML(t('bundleRunner.btnSelectNone'))}</button>
          </div>
          <span class="muted">${escapeHTML(summary.statusText)}</span>
        </div>

        <div class="bundle-runner-list">
          ${rowsHtml}
        </div>
      </div>

      <div class="modal-footer">
        <span class="muted">${escapeHTML(t('dev.bundleRunner.footerHint', { manager: mgrMeta.label }))}</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-dev-runner-action="close" ${isInstalling ? 'disabled' : ''}>${escapeHTML(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-dev-runner-action="start" ${selectedEntries.length === 0 || isInstalling || state.isDevBundleInstallRunning ? 'disabled' : ''}>
            ${isInstalling ? `⏳ ${escapeHTML(t('dev.bundleRunner.btnStarting'))}` : `🚀 ${escapeHTML(t('dev.bundleRunner.btnStart', { count: selectedEntries.length }))}`}
          </button>
        </div>
      </div>
    `;
  };

  overlay.hidden = false;

  modal.onchange = (e) => {
    const chk = closestInput(e.target, '[data-dev-runner-key]');
    if (!chk) return;
    const key = chk.dataset.devRunnerKey;
    if (!key) return;
    if (chk.checked) selectedKeys.add(key);
    else selectedKeys.delete(key);
    render();
  };

  modal.onclick = async (e) => {
    const mgrBtn = closestEl(e.target, '[data-dev-runner-mgr]');
    if (mgrBtn) {
      const nextMgr = mgrBtn.dataset.devRunnerMgr || '';
      if (nextMgr && nextMgr !== targetManager) {
        targetManager = nextMgr;
        render();
      }
      return;
    }

    const btn = closestEl(e.target, '[data-dev-runner-action]');
    if (!btn) return;
    const action = btn.dataset.devRunnerAction;

    if (action === 'close') {
      closeModal();
      return;
    }
    if (action === 'select-needed') {
      selectedKeys.clear();
      for (const p of evaluation.packages) {
        if (p.defaultSelected) selectedKeys.add(p.key);
      }
      render();
      return;
    }
    if (action === 'select-all') {
      selectedKeys.clear();
      for (const p of evaluation.packages) selectedKeys.add(p.key);
      render();
      return;
    }
    if (action === 'select-none') {
      selectedKeys.clear();
      render();
      return;
    }
    if (action === 'start') {
      const selected = evaluation.packages.filter((p) => selectedKeys.has(p.key));
      if (selected.length === 0 || state.isDevBundleInstallRunning) return;

      const ok = await ensureAdminAuthenticated({
        reason: t('dev.authReasonDevBundleAction', { project: project.name }),
      });
      if (!ok) return;

      isInstalling = true;
      state.isDevBundleInstallRunning = true;
      const busyKey = `${project.id}:dev-bundle:${bundle.id}`;
      state.devBusyActionKeys.add(busyKey);
      closeModal();
      onInstalled?.({ starting: true });

      showToast(t('dev.bundleRunner.startingToast', { name: bundle.name, count: selected.length }), {
        type: 'info',
      });

      try {
        const res = await window.electronAPI.installDevBundle(
          project.id,
          bundle.id,
          selected.map((p) => p.name),
          { manager: targetManager, scan }
        );

        if (res?.scan && (res.scan.success || res.scan.unavailable)) {
          setDevScanResult(project.id, res.scan, { checkedUpdates: Boolean(res.scan.success) });
        }

        if (res?.alreadyRunning) {
          showToast(t('dev.toastActionAlreadyRunning'), { type: 'info' });
        } else if (res?.canceled) {
          showToast(t('dev.toastActionCanceled'), { type: 'info' });
        } else if (res?.success) {
          showToast(
            t('dev.bundleRunner.finishedToast', {
              installed: res.installedCount || 0,
              updated: res.updatedCount || 0,
              skipped: res.skippedCount || 0,
            }),
            { type: 'success', duration: 6000 }
          );
        } else if (res?.error) {
          showToast(t('dev.toastActionFailed', { error: res.error }), { type: 'error', duration: 6000 });
        }
        onInstalled?.(res);
      } finally {
        state.isDevBundleInstallRunning = false;
        state.devBusyActionKeys.delete(busyKey);
        onInstalled?.({ finished: true });
      }
    }
  };

  render();
}
