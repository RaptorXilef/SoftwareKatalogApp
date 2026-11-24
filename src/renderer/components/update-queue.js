import { state } from '../state.js';
import { escapeHTML, toMediaUrl } from '../utils/sanitize.js';

let queueState = {
  queue: [],
  history: [],
  activeCount: 0,
  pendingCount: 0,
  completedCount: 0,
  failedCount: 0,
  canceledCount: 0,
  isRunning: false,
};

let callbacks = {};
let dragFromIndex = -1;
let prevCompletedCount = 0;
let wasRunning = false;

function getModeBadgeHtml(item) {
  if (item.interactiveRequired) {
    return '<span class="update-queue-mode-badge is-protected" title="Adware-/Klick-Schutz: wird immer interaktiv ausgeführt">🛡️ Interaktiv-Schutz</span>';
  }
  if (item.mode === 'silent') {
    return '<span class="update-queue-mode-badge is-silent">⚡ Silent</span>';
  }
  return '<span class="update-queue-mode-badge is-interactive">🖱️ Interaktiv</span>';
}

function getVersionText(item) {
  if (item.fromVersion && item.toVersion) {
    return `v${item.fromVersion} → v${item.toVersion}`;
  }
  if (item.toVersion) return `→ v${item.toVersion}`;
  if (item.fromVersion) return `v${item.fromVersion}`;
  return '';
}

function getItemIconHtml(item) {
  if (item.icon) {
    return `<img class="update-queue-item-icon" src="${escapeHTML(toMediaUrl(item.icon))}" alt="">`;
  }
  const emoji = item.source === 'archive' ? '📦' : '💻';
  return `<span class="update-queue-item-icon-fallback">${emoji}</span>`;
}

export function renderUpdateQueue() {
  const panel = document.getElementById('updateQueuePanel');
  if (!panel) return;

  const list = Array.isArray(queueState.queue) ? queueState.queue : [];
  if (state.activeTab !== 'updates' || list.length === 0) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  panel.hidden = false;

  const activeCount = queueState.activeCount || (list[0]?.status === 'running' ? 1 : 0);
  const pendingCount = Math.max(0, list.length - activeCount);

  const rowsHtml = list
    .map((item, idx) => {
      const isActive = idx === 0 && item.status === 'running';
      const versionText = getVersionText(item);
      const modeBadge = getModeBadgeHtml(item);
      const iconHtml = getItemIconHtml(item);

      if (isActive) {
        return `
          <li class="update-queue-item is-active" draggable="false" data-queue-index="0" data-queue-id="${escapeHTML(item.queueId)}">
            <span class="update-queue-pos is-running" title="Läuft gerade (Platz 1 gesperrt)">▶ #1</span>
            ${iconHtml}
            <div class="update-queue-item-main">
              <div class="update-queue-item-top">
                <strong class="update-queue-item-name">${escapeHTML(item.name)}</strong>
                ${versionText ? `<span class="update-queue-item-ver">${escapeHTML(versionText)}</span>` : ''}
                ${modeBadge}
              </div>
              <div class="update-queue-item-detail">${escapeHTML(item.detail || 'Wird aktualisiert...')}</div>
              <div class="update-queue-progress-track">
                <div class="update-queue-progress-fill"></div>
              </div>
            </div>
            <button
              type="button"
              class="btn btn-danger btn-xs"
              data-queue-cancel="${escapeHTML(item.queueId)}"
              title="Aktives Update abbrechen"
            >
              ✕ Abbrechen
            </button>
          </li>
        `;
      }

      return `
        <li class="update-queue-item is-pending" draggable="true" data-queue-index="${idx}" data-queue-id="${escapeHTML(item.queueId)}">
          <span class="update-queue-drag-handle" title="Per Drag & Drop umsortieren (nicht vor Platz 1)">⋮⋮</span>
          <span class="update-queue-pos">#${idx + 1}</span>
          ${iconHtml}
          <div class="update-queue-item-main">
            <div class="update-queue-item-top">
              <strong class="update-queue-item-name">${escapeHTML(item.name)}</strong>
              ${versionText ? `<span class="update-queue-item-ver">${escapeHTML(versionText)}</span>` : ''}
              ${modeBadge}
            </div>
            <div class="update-queue-item-detail">${escapeHTML(item.detail || 'Wartend')}</div>
          </div>
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            data-queue-cancel="${escapeHTML(item.queueId)}"
            title="Aus Warteschlange entfernen"
            aria-label="Entfernen"
          >
            ✕
          </button>
        </li>
      `;
    })
    .join('');

  panel.innerHTML = `
    <div class="update-queue-header">
      <div class="update-queue-title">
        <strong>📦 Update-Warteschlange</strong>
        <span class="update-queue-counts">${activeCount} aktiv, ${pendingCount} wartend</span>
      </div>
      <button type="button" class="btn btn-danger btn-xs" data-queue-action="cancel-all">
        🛑 Alle abbrechen
      </button>
    </div>
    <ul class="update-queue-list" id="updateQueueList">
      ${rowsHtml}
    </ul>
  `;
}

function handleQueueSnapshot(nextState) {
  if (!nextState) return;
  const nextCompleted = Number(nextState.completedCount) || 0;
  const nextRunning = Boolean(nextState.isRunning) || (nextState.queue?.length || 0) > 0;

  const itemCompletedNow = nextCompleted > prevCompletedCount;
  const drainedNow = wasRunning && !nextRunning && (nextState.queue?.length || 0) === 0;

  prevCompletedCount = nextCompleted;
  wasRunning = nextRunning;
  queueState = nextState;

  renderUpdateQueue();

  if (drainedNow) {
    callbacks.onQueueDrained?.({
      completed: nextCompleted,
      failed: Number(nextState.failedCount) || 0,
      canceled: Number(nextState.canceledCount) || 0,
    });
  } else if (itemCompletedNow) {
    callbacks.onItemCompleted?.(nextState);
  }
}

export function initUpdateQueue(opts = {}) {
  callbacks = opts || {};

  const panel = document.getElementById('updateQueuePanel');
  if (!panel) return;

  panel.addEventListener('click', async (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const cancelAllBtn = target.closest('[data-queue-action="cancel-all"]');
    if (cancelAllBtn instanceof HTMLButtonElement) {
      cancelAllBtn.disabled = true;
      await window.electronAPI.cancelAllQueue();
      return;
    }

    const cancelItemBtn = target.closest('[data-queue-cancel]');
    if (cancelItemBtn instanceof HTMLButtonElement) {
      const queueId = cancelItemBtn.dataset.queueCancel;
      if (queueId) {
        cancelItemBtn.disabled = true;
        await window.electronAPI.cancelQueueItem(queueId);
      }
    }
  });

  panel.addEventListener('dragstart', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const row = target.closest('.update-queue-item');
    if (!(row instanceof HTMLElement)) {
      e.preventDefault();
      return;
    }
    const idx = Number.parseInt(row.dataset.queueIndex || '-1', 10);
    if (!Number.isInteger(idx) || idx < 1) {
      e.preventDefault();
      dragFromIndex = -1;
      return;
    }
    dragFromIndex = idx;
    row.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    }
  });

  panel.addEventListener('dragover', (e) => {
    const target = e.target;
    if (!(target instanceof Element) || dragFromIndex < 1) return;
    const row = target.closest('.update-queue-item');
    if (!(row instanceof HTMLElement)) return;
    const toIdx = Number.parseInt(row.dataset.queueIndex || '-1', 10);

    // Platz 1 (Index 0) darf niemals Drop-Ziel sein
    if (!Number.isInteger(toIdx) || toIdx < 1) return;

    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    for (const el of panel.querySelectorAll('.update-queue-item.is-drop-target')) {
      if (el !== row) el.classList.remove('is-drop-target');
    }
    row.classList.add('is-drop-target');
  });

  panel.addEventListener('dragleave', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const row = target.closest('.update-queue-item');
    if (row instanceof HTMLElement) {
      row.classList.remove('is-drop-target');
    }
  });

  panel.addEventListener('drop', async (e) => {
    const target = e.target;
    if (!(target instanceof Element) || dragFromIndex < 1) return;
    const row = target.closest('.update-queue-item');
    if (!(row instanceof HTMLElement)) return;
    const toIdx = Number.parseInt(row.dataset.queueIndex || '-1', 10);
    row.classList.remove('is-drop-target');

    if (Number.isInteger(toIdx) && toIdx >= 1 && toIdx !== dragFromIndex) {
      e.preventDefault();
      const fromIdx = dragFromIndex;
      dragFromIndex = -1;
      await window.electronAPI.reorderQueue(fromIdx, toIdx);
    }
  });

  panel.addEventListener('dragend', () => {
    dragFromIndex = -1;
    for (const el of panel.querySelectorAll('.update-queue-item.is-dragging, .update-queue-item.is-drop-target')) {
      el.classList.remove('is-dragging', 'is-drop-target');
    }
  });

  if (typeof window.electronAPI?.onQueueUpdated === 'function') {
    window.electronAPI.onQueueUpdated((snapshot) => handleQueueSnapshot(snapshot));
  }
  if (typeof window.electronAPI?.getQueueState === 'function') {
    window.electronAPI.getQueueState().then((snapshot) => handleQueueSnapshot(snapshot));
  }
}
