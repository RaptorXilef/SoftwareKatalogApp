import { getDevManagerMeta } from '../../shared/dev-ui-logic.js';
import { showToast } from '../components/toast.js';
import { setDevScanResult, state } from '../state.js';
import { closestEl } from '../utils/dom.js';
import { t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';
import { closeModal, resetModalContent } from './index.js';
import { ensureAdminAuthenticated } from './login-modal.js';

let activeAuditToken = 0;

/**
 * Fuehrt einen Sicherheits-Check (`npm audit` / `composer audit`) aus und zeigt die Ergebnisse kompakt im Modal.
 * @param {{
 *   project: Record<string, any>,
 *   onScanUpdated?: (() => void) | null,
 * }} params
 */
export function renderDevAuditModal({ project, onScanUpdated = null }) {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal || !project) return;

  resetModalContent();
  const token = ++activeAuditToken;
  state.currentModalId = null;
  state.isEditModalOpen = false;

  const isStillOpen = () => token === activeAuditToken && !overlay.hidden;

  let isLoading = true;
  let isFixing = false;
  let severityFilter = 'all';
  let errorMsg = '';
  let report = null;

  const getSeverityBadgeLabel = (sev) => {
    if (sev === 'critical') return t('dev.audit.sevCritical');
    if (sev === 'high') return t('dev.audit.sevHigh');
    if (sev === 'low') return t('dev.audit.sevLow');
    return t('dev.audit.sevModerate');
  };

  const renderBodyHtml = () => {
    if (isLoading) {
      return `
        <div class="matcher-loading-box">
          <strong>⏳ ${escapeHTML(t('dev.audit.loadingTitle'))}</strong>
          <p class="muted">${escapeHTML(t('dev.audit.loadingDesc'))}</p>
        </div>
      `;
    }

    if (errorMsg) {
      return `<div class="discover-notice">⚠️ ${escapeHTML(errorMsg)}</div>`;
    }

    if (!report || report.unsupported) {
      return `
        <div class="matcher-empty-box">
          <strong>ℹ️ ${escapeHTML(t('dev.audit.unsupportedTitle'))}</strong>
          <p class="muted">${escapeHTML(t('dev.audit.unsupportedDesc'))}</p>
        </div>
      `;
    }

    const counts = report.counts || { critical: 0, high: 0, moderate: 0, low: 0, total: 0 };
    const vulns = Array.isArray(report.vulnerabilities) ? report.vulnerabilities : [];
    const abandoned = Array.isArray(report.abandoned) ? report.abandoned : [];
    const warnings = Array.isArray(report.warnings) ? report.warnings.filter(Boolean) : [];

    const filteredVulns = severityFilter === 'all' ? vulns : vulns.filter((v) => v.severity === severityFilter);

    const kpiHtml = `
      <div class="matcher-summary-bar">
        <div class="matcher-kpi dev-audit-kpi is-critical"><strong>${counts.critical}</strong><span>${escapeHTML(t('dev.audit.sevCritical'))}</span></div>
        <div class="matcher-kpi dev-audit-kpi is-high"><strong>${counts.high}</strong><span>${escapeHTML(t('dev.audit.sevHigh'))}</span></div>
        <div class="matcher-kpi dev-audit-kpi is-moderate"><strong>${counts.moderate}</strong><span>${escapeHTML(t('dev.audit.sevModerate'))}</span></div>
        <div class="matcher-kpi dev-audit-kpi is-low"><strong>${counts.low}</strong><span>${escapeHTML(t('dev.audit.sevLow'))}</span></div>
      </div>
    `;

    const warningsHtml =
      warnings.length > 0 ? `<div class="discover-notice">${escapeHTML(warnings.join(' · '))}</div>` : '';

    const abandonedHtml =
      abandoned.length > 0
        ? `
          <div class="dev-audit-abandoned">
            <strong>⚠️ ${escapeHTML(t('dev.audit.abandonedTitle', { count: abandoned.length }))}</strong>
            <div class="dev-audit-abandoned-list">
              ${abandoned
                .map(
                  (a) =>
                    `<span class="card-chip"><code>${escapeHTML(a.packageName)}</code>${a.replacement ? ` -> <code>${escapeHTML(a.replacement)}</code>` : ''}</span>`
                )
                .join('')}
            </div>
          </div>
        `
        : '';

    if (counts.total === 0) {
      return `
        ${kpiHtml}
        ${warningsHtml}
        <div class="matcher-empty-box dev-audit-clean-box">
          <strong>✅ ${escapeHTML(t('dev.audit.cleanTitle'))}</strong>
          <p class="muted">${escapeHTML(t('dev.audit.cleanDesc'))}</p>
        </div>
        ${abandonedHtml}
      `;
    }

    const filterChips = [
      { id: 'all', label: t('common.all'), count: counts.total },
      { id: 'critical', label: t('dev.audit.sevCritical'), count: counts.critical },
      { id: 'high', label: t('dev.audit.sevHigh'), count: counts.high },
      { id: 'moderate', label: t('dev.audit.sevModerate'), count: counts.moderate },
      { id: 'low', label: t('dev.audit.sevLow'), count: counts.low },
    ];

    const listHtml =
      filteredVulns.length === 0
        ? `<div class="bundle-items-empty">${escapeHTML(t('dev.audit.filterEmpty'))}</div>`
        : filteredVulns
            .map((v) => {
              const mgrMeta = getDevManagerMeta(v.manager);
              return `
                <article class="dev-audit-row is-${escapeHTML(v.severity)}">
                  <div class="dev-audit-row-main">
                    <div class="dev-audit-row-head">
                      <span class="dev-audit-sev-badge is-${escapeHTML(v.severity)}">${escapeHTML(getSeverityBadgeLabel(v.severity))}</span>
                      <strong>${escapeHTML(v.packageName)}</strong>
                      <span class="provider-badge ${escapeHTML(mgrMeta.badgeClass)}">${escapeHTML(mgrMeta.label)}</span>
                      ${v.cve ? `<span class="card-chip">${escapeHTML(v.cve)}</span>` : ''}
                      ${
                        v.fixAvailable
                          ? `<span class="dev-audit-fix-pill">${escapeHTML(v.fixIsMajor ? t('dev.audit.fixMajor') : t('dev.audit.fixReady'))}</span>`
                          : ''
                      }
                    </div>
                    <p class="dev-audit-row-title">${escapeHTML(v.title)}</p>
                    ${
                      v.affectedVersions
                        ? `<div class="dev-audit-row-meta"><span class="muted">${escapeHTML(t('dev.audit.affectedRange'))}:</span> <code>${escapeHTML(v.affectedVersions)}</code></div>`
                        : ''
                    }
                  </div>
                  ${
                    v.url
                      ? `<button type="button" class="btn btn-ghost btn-xs" data-dev-audit-url="${escapeHTML(v.url)}" title="${escapeHTML(t('dev.audit.openAdvisory'))}">🔗</button>`
                      : ''
                  }
                </article>
              `;
            })
            .join('');

    return `
      ${kpiHtml}
      ${warningsHtml}
      <div class="dev-filter-chips">
        ${filterChips
          .map(
            (c) =>
              `<button type="button" class="origin-chip ${severityFilter === c.id ? 'active' : ''}" data-dev-audit-filter="${escapeHTML(c.id)}">${escapeHTML(c.label)} (${c.count})</button>`
          )
          .join('')}
      </div>
      <div class="dev-audit-list">${listHtml}</div>
      ${abandonedHtml}
    `;
  };

  const render = () => {
    if (!isStillOpen()) return;

    const managersText =
      Array.isArray(report?.managers) && report.managers.length > 0
        ? report.managers.map((m) => getDevManagerMeta(m).label).join(', ')
        : 'npm / Composer';

    const showFixBtn = Boolean(!isLoading && !errorMsg && report?.canAutoFix && (report.counts?.total || 0) > 0);

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>🛡️ ${escapeHTML(t('dev.audit.modalTitle', { project: project.name }))}</h2>
          <span class="muted">${escapeHTML(t('dev.audit.modalSubtitle', { managers: managersText }))}</span>
        </div>
        <button type="button" class="icon-btn" data-dev-audit-action="close" title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(t('common.close'))}">✕</button>
      </div>

      <div class="modal-body dev-audit-body">
        ${renderBodyHtml()}
      </div>

      <div class="modal-footer">
        <button type="button" class="btn btn-ghost" data-dev-audit-action="recheck" ${isLoading || isFixing ? 'disabled' : ''}>
          🔄 ${escapeHTML(t('dev.audit.btnRecheck'))}
        </button>
        <div class="footer-group">
          ${
            showFixBtn
              ? `<button type="button" class="btn btn-primary" data-dev-audit-action="fix" ${isFixing ? 'disabled' : ''}>
                  ${isFixing ? `⏳ ${escapeHTML(t('dev.audit.btnFixing'))}` : `🛠️ ${escapeHTML(t('dev.audit.btnRunFix'))}`}
                </button>`
              : ''
          }
          <button type="button" class="btn btn-ghost" data-dev-audit-action="close" ${isFixing ? 'disabled' : ''}>${escapeHTML(t('common.close'))}</button>
        </div>
      </div>
    `;
  };

  const runAudit = async () => {
    isLoading = true;
    errorMsg = '';
    render();
    try {
      const res = await window.electronAPI.devAuditProject(project.id, {});
      if (!isStillOpen()) return;
      isLoading = false;
      if (res?.canceled) {
        errorMsg = t('dev.audit.canceledMsg');
      } else if (res?.alreadyRunning) {
        errorMsg = t('dev.audit.alreadyRunningMsg');
      } else if (!res?.success) {
        errorMsg = res?.error || t('common.unknownError');
      } else {
        report = res;
      }
      render();
    } catch (err) {
      if (!isStillOpen()) return;
      isLoading = false;
      errorMsg = err?.message || t('common.unknownError');
      render();
    }
  };

  overlay.hidden = false;

  modal.onclick = async (e) => {
    const urlBtn = closestEl(e.target, '[data-dev-audit-url]');
    if (urlBtn) {
      const url = urlBtn.dataset.devAuditUrl || '';
      if (url) window.electronAPI.openUrl(url);
      return;
    }

    const filterBtn = closestEl(e.target, '[data-dev-audit-filter]');
    if (filterBtn) {
      severityFilter = filterBtn.dataset.devAuditFilter || 'all';
      render();
      return;
    }

    const actionBtn = closestEl(e.target, '[data-dev-audit-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.devAuditAction;

    if (action === 'close') {
      closeModal();
      return;
    }

    if (action === 'recheck') {
      await runAudit();
      return;
    }

    if (action === 'fix') {
      const fixManagers = Array.isArray(report?.fixableManagers) ? report.fixableManagers : [];
      if (fixManagers.length === 0 || isFixing) return;

      const ok = await ensureAdminAuthenticated({
        reason: t('dev.authReasonAuditFix', { project: project.name }),
      });
      if (!ok) return;

      isFixing = true;
      render();

      let allOk = true;
      try {
        for (let i = 0; i < fixManagers.length; i++) {
          const mgr = fixManagers[i];
          const pkgs = (report?.vulnerabilities || []).filter((v) => v.manager === mgr).map((v) => v.packageName);
          const res = await window.electronAPI.devAuditFixProject(
            project.id,
            { manager: mgr, packages: pkgs },
            { checkUpdates: i === fixManagers.length - 1 }
          );
          if (!isStillOpen()) return;
          if (res?.canceled) {
            showToast(t('dev.toastActionCanceled'), { type: 'info' });
            allOk = false;
            break;
          }
          if (!res?.success) {
            allOk = false;
            showToast(t('dev.toastActionFailed', { error: res?.error || t('common.unknownError') }), {
              type: 'error',
              duration: 6000,
            });
          } else if (res.scan && (res.scan.success || res.scan.unavailable)) {
            setDevScanResult(project.id, res.scan, { checkedUpdates: Boolean(res.scan.success) });
            onScanUpdated?.();
          }
        }
        if (allOk) {
          showToast(t('dev.audit.fixDoneToast'), { type: 'success' });
        }
      } finally {
        isFixing = false;
      }

      if (isStillOpen()) {
        await runAudit();
      }
    }
  };

  void runAudit();
}
