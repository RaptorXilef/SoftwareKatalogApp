import { escapeHTML } from '../utils/sanitize.js';

let onJobActionCallback = null;

export function initJobsBar({ onJobAction } = {}) {
  onJobActionCallback = onJobAction;

  const container = document.getElementById('jobsContainer');
  if (!container) return;

  container.addEventListener('click', async (e) => {
    const cancelBtn = e.target.closest('[data-cancel-job]');
    if (cancelBtn) {
      cancelBtn.disabled = true;
      await window.electronAPI.cancelJob(cancelBtn.dataset.cancelJob);
      return;
    }

    const dismissBtn = e.target.closest('[data-dismiss-job]');
    if (dismissBtn) {
      await window.electronAPI.dismissJob(dismissBtn.dataset.dismissJob);
      return;
    }

    const actionBtn = e.target.closest('[data-job-action]');
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

export function renderJobs(jobs) {
  const container = document.getElementById('jobsContainer');
  if (!container) return;

  if (!jobs || jobs.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  container.hidden = false;
  container.innerHTML = jobs
    .map((job) => {
      const isIndeterminate = job.status === 'running' && job.progress === null;
      const pct = job.progress ?? 0;
      const pctText = job.status === 'running' ? (isIndeterminate ? 'läuft...' : `${pct}%`) : '';

      const actionHtml = job.action
        ? `<button type="button" class="job-action-btn" data-job-id="${escapeHTML(job.id)}" data-job-action="${escapeHTML(job.action.type)}" data-item-id="${escapeHTML(job.action.itemId || '')}">${escapeHTML(job.action.label)}</button>`
        : '';

      const controlHtml =
        job.status === 'running' && job.cancelable
          ? `<button type="button" class="job-cancel-btn" data-cancel-job="${escapeHTML(job.id)}" title="Vorgang abbrechen">Abbrechen</button>`
          : job.status !== 'running'
            ? `<button type="button" class="job-dismiss-btn" data-dismiss-job="${escapeHTML(job.id)}" title="Schließen">✕</button>`
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
