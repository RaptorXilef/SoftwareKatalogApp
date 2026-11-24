import { closestButton, closestEl } from '../utils/dom.js';
import { t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';

let onJobActionCallback = null;
let lastJobs = [];

export function rerenderJobsBar() {
  renderJobs(lastJobs);
}

/**
 * @param {{ onJobAction?: (payload: { jobId?: string, type?: string, itemId?: string }) => void }} [options]
 */
export function initJobsBar({ onJobAction } = {}) {
  onJobActionCallback = onJobAction;

  const container = document.getElementById('jobsContainer');
  if (!container) return;

  container.addEventListener('click', async (e) => {
    const cancelBtn = closestButton(e.target, '[data-cancel-job]');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      await window.electronAPI.cancelJob(cancelBtn.dataset.cancelJob);
      return;
    }

    const dismissBtn = closestEl(e.target, '[data-dismiss-job]');
    if (dismissBtn) {
      await window.electronAPI.dismissJob(dismissBtn.dataset.dismissJob);
      return;
    }

    const actionBtn = closestEl(e.target, '[data-job-action]');
    if (actionBtn) {
      const payload = {
        jobId: actionBtn.dataset.jobId,
        type: actionBtn.dataset.jobAction,
        itemId: actionBtn.dataset.itemId,
      };
      onJobActionCallback?.(payload);
    }
  });

  window.electronAPI.onJobsUpdated((jobs) => renderJobs(jobs));
  window.electronAPI.getJobs().then((jobs) => renderJobs(jobs));
}

function renderJobs(jobs) {
  lastJobs = Array.isArray(jobs) ? jobs : [];
  const container = document.getElementById('jobsContainer');
  if (!container) return;

  if (lastJobs.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  container.hidden = false;
  container.innerHTML = lastJobs
    .map((job) => {
      const isIndeterminate = job.status === 'running' && job.progress === null;
      const pct = job.progress ?? 0;
      const pctText = job.status === 'running' ? (isIndeterminate ? t('jobs.running') : `${pct}%`) : '';

      const actionHtml = job.action
        ? `<button type="button" class="job-action-btn" data-job-id="${escapeHTML(job.id)}" data-job-action="${escapeHTML(job.action.type)}" data-item-id="${escapeHTML(job.action.itemId || '')}">${escapeHTML(job.action.label)}</button>`
        : '';

      const controlHtml =
        job.status === 'running' && job.cancelable
          ? `<button type="button" class="job-cancel-btn" data-cancel-job="${escapeHTML(job.id)}" title="${escapeHTML(t('jobs.cancelTitle'))}">${escapeHTML(t('jobs.cancel'))}</button>`
          : job.status !== 'running'
            ? `<button type="button" class="job-dismiss-btn" data-dismiss-job="${escapeHTML(job.id)}" title="${escapeHTML(t('jobs.closeTitle'))}">✕</button>`
            : '';

      return `
        <div class="job-row job-${escapeHTML(job.status)}">
          <div class="job-meta">
            <div class="job-header">
              <strong class="job-title">${escapeHTML(job.title)}</strong>
              <span class="job-detail" title="${escapeHTML(job.detail)}">${escapeHTML(job.detail)}</span>
            </div>
            <div class="job-bar-track">
              <div class="job-bar-fill ${isIndeterminate ? 'is-indeterminate' : ''}" style="width: ${isIndeterminate ? 35 : pct}%"></div>
            </div>
          </div>
          <div class="job-controls">
            ${pctText ? `<span class="job-pct">${pctText}</span>` : ''}
            ${actionHtml}
            ${controlHtml}
          </div>
        </div>
      `;
    })
    .join('');
}
