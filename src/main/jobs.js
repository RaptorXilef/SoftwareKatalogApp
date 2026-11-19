import crypto from 'node:crypto';
import { BrowserWindow } from 'electron';

const activeJobs = new Map();

function broadcastJobs() {
  const snapshot = Array.from(activeJobs.values()).map((j) => ({
    id: j.id,
    type: j.type,
    title: j.title,
    detail: j.detail,
    progress: j.progress, // 0..100 oder null (indeterminate)
    status: j.status, // 'running' | 'done' | 'error' | 'canceled'
    cancelable: j.cancelable,
    action: j.action || null, // z. B. { label: 'Status erneut prüfen', itemId }
  }));

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('jobs-updated', snapshot);
    }
  }
}

/**
 * Startet einen neuen sichtbaren Hintergrund-Job.
 * Mehrere Jobs laufen parallel und erscheinen im UI sauber untereinander.
 */
export function createJob({ type, title, dedupeKey = null, cancelable = true, onCancel = null }) {
  // Verhindert doppelte identische Scans (z. B. zweimal gleichzeitig Archiv scannen)
  if (dedupeKey) {
    for (const existing of activeJobs.values()) {
      if (existing.dedupeKey === dedupeKey && existing.status === 'running') {
        return null;
      }
    }
  }

  const id = crypto.randomUUID();
  const controller = new AbortController();

  const job = {
    id,
    type,
    title,
    dedupeKey,
    detail: 'Wird gestartet...',
    progress: 0,
    status: 'running',
    cancelable,
    controller,
    onCancel,
    action: null,
  };

  activeJobs.set(id, job);
  broadcastJobs();

  return {
    id,
    signal: controller.signal,
    update(progress, detail) {
      if (job.status !== 'running') return;
      if (progress !== undefined)
        job.progress = progress === null ? null : Math.min(100, Math.max(0, Math.round(progress)));
      if (detail !== undefined) job.detail = detail;
      broadcastJobs();
    },
    finish(status = 'done', detail = 'Abgeschlossen', { autoRemoveMs = 2500, action = null } = {}) {
      if (job.status === 'canceled') return;
      job.status = status;
      job.progress = status === 'done' ? 100 : job.progress;
      job.detail = detail;
      job.cancelable = false;
      job.action = action;
      broadcastJobs();

      if (autoRemoveMs > 0 && !action) {
        setTimeout(() => {
          activeJobs.delete(id);
          broadcastJobs();
        }, autoRemoveMs);
      }
    },
  };
}

export async function cancelJob(id) {
  const job = activeJobs.get(id);
  if (job?.status !== 'running' || !job.cancelable) return false;

  job.status = 'canceled';
  job.detail = 'Wird abgebrochen...';
  job.cancelable = false;
  broadcastJobs();

  job.controller.abort();
  if (typeof job.onCancel === 'function') {
    try {
      await job.onCancel();
    } catch (e) {
      console.warn(`Cleanup nach Abbruch für Job ${id} fehlgeschlagen:`, e);
    }
  }

  job.detail = 'Abgebrochen';
  broadcastJobs();

  setTimeout(() => {
    activeJobs.delete(id);
    broadcastJobs();
  }, 1500);

  return true;
}

export function dismissJob(id) {
  if (activeJobs.delete(id)) {
    broadcastJobs();
  }
}

export function getJobsSnapshot() {
  return Array.from(activeJobs.values()).map(({ controller: _c, onCancel: _o, ...rest }) => rest);
}
