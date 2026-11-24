import { detectAdwareSignals, normalizeInstallMode } from './installer-logic.js';

const MAX_HISTORY = 30;

function defaultGenerateId() {
  return String(globalThis.crypto.randomUUID());
}

function normalizeQueueItem(raw, { silent = false, generateId = defaultGenerateId } = {}) {
  const itemId = String(raw?.itemId || raw?.id || '').trim();
  const name = String(raw?.name || itemId || 'Unbekannt').trim();
  const installMode = normalizeInstallMode(raw?.installMode);
  const packageId = String(raw?.packageId || raw?.wingetId || '').trim();
  const adwareSignal = detectAdwareSignals({
    name,
    packageId,
    publisher: raw?.publisher || '',
  });

  const interactiveRequired =
    installMode === 'interactive-required' ||
    Boolean(raw?.interactiveRequired) ||
    (installMode !== 'silent' && adwareSignal.flagged);

  let mode;
  if (interactiveRequired) {
    mode = 'interactive';
  } else if (silent === true) {
    mode = 'silent';
  } else {
    mode = installMode === 'silent' ? 'silent' : 'interactive';
  }

  let detail = '🖱️ Wartend (Interaktiv)';
  if (interactiveRequired) {
    detail = '🛡️ Wartend (Adware-Schutz: Interaktiv)';
  } else if (mode === 'silent') {
    detail = '⚡ Wartend (Silent)';
  }

  return {
    queueId: String(generateId()),
    itemId,
    name,
    icon: raw?.icon || null,
    fromVersion: String(raw?.fromVersion || raw?.installedVersion || '').trim(),
    toVersion: String(raw?.toVersion || raw?.availableVersion || raw?.webVersion || '').trim(),
    mode,
    source: String(raw?.source || (raw?.inArchive ? 'archive' : raw?.packageManager || 'winget')).trim(),
    status: 'pending',
    detail,
    interactiveRequired,
    inArchive: Boolean(raw?.inArchive),
    isInstalled: Boolean(raw?.isInstalled),
    packageManager: String(raw?.packageManager || (raw?.wingetId ? 'winget' : '')).trim(),
    packageId,
    hasWebUpdate: Boolean(raw?.hasWebUpdate),
    hasArchiveUpdate: Boolean(raw?.hasArchiveUpdate),
    installMode,
    archiveSaveSpec: raw?.archiveSaveSpec || null,
  };
}

function cloneEntry(entry) {
  return {
    ...entry,
    archiveSaveSpec: entry.archiveSaveSpec ? { ...entry.archiveSaveSpec } : null,
  };
}

/**
 * Erzeugt einen streng sequentiellen Update-Queue-Manager mit Abbruch-, Reorder- und Adware-Schutz-Logik.
 */
export function createUpdateQueueManager({
  executor = null,
  onUpdate = null,
  onItemFinished = null,
  onQueueDrained = null,
  generateId = defaultGenerateId,
} = {}) {
  const queue = [];
  const history = [];
  let isProcessing = false;
  let activeController = null;
  let cancelAllRequested = false;
  let completedCount = 0;
  let failedCount = 0;
  let canceledCount = 0;
  const idleWaiters = [];

  const getQueueState = () => {
    const activeCount = queue[0]?.status === 'running' ? 1 : 0;
    const pendingCount = Math.max(0, queue.length - activeCount);
    return {
      queue: queue.map(cloneEntry),
      history: history.map(cloneEntry),
      activeCount,
      pendingCount,
      completedCount,
      failedCount,
      canceledCount,
      isRunning: isProcessing || activeCount > 0,
    };
  };

  const emitUpdate = () => {
    onUpdate?.(getQueueState());
  };

  const pushHistory = (entry) => {
    history.push(cloneEntry(entry));
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
  };

  const resolveIdleWaiters = () => {
    if (isProcessing || queue.length > 0) return;
    while (idleWaiters.length > 0) {
      const resolve = idleWaiters.shift();
      resolve?.(getQueueState());
    }
  };

  const processQueue = async () => {
    if (isProcessing) return;
    isProcessing = true;
    cancelAllRequested = false;

    try {
      while (queue.length > 0) {
        if (cancelAllRequested) break;

        const current = queue[0];
        if (!current) break;

        const controller = new AbortController();
        activeController = controller;

        current.status = 'running';
        current.detail =
          current.mode === 'silent'
            ? '⚡ Wird still aktualisiert...'
            : current.interactiveRequired
              ? '🛡️ Interaktive Installation (Adware-Schutz)...'
              : '🖱️ Interaktiver Installer läuft...';
        emitUpdate();

        let result = null;
        let execError = null;
        try {
          if (typeof executor === 'function') {
            result = await executor(cloneEntry(current), {
              signal: controller.signal,
              onProgress: (_pct, detailText) => {
                if (queue[0]?.queueId === current.queueId && detailText && !controller.signal.aborted) {
                  current.detail = String(detailText);
                  emitUpdate();
                }
              },
            });
          } else {
            result = { success: true };
          }
        } catch (err) {
          execError = err;
        } finally {
          if (activeController === controller) {
            activeController = null;
          }
        }

        const wasAborted = controller.signal.aborted || result?.canceled || execError?.name === 'AbortError';
        if (wasAborted) {
          current.status = 'canceled';
          current.detail = 'Abgebrochen';
          canceledCount++;
        } else if (execError || !result?.success) {
          current.status = 'failed';
          current.detail = String(execError?.message || result?.error || 'Update fehlgeschlagen');
          failedCount++;
        } else {
          current.status = 'done';
          current.detail = 'Erfolgreich aktualisiert';
          completedCount++;
        }

        const finishedEntry = cloneEntry(current);
        if (queue[0]?.queueId === current.queueId) {
          queue.shift();
        } else {
          const idx = queue.findIndex((item) => item.queueId === current.queueId);
          if (idx !== -1) queue.splice(idx, 1);
        }

        pushHistory(finishedEntry);
        emitUpdate();
        onItemFinished?.(finishedEntry, getQueueState());

        if (cancelAllRequested) break;
      }
    } finally {
      isProcessing = false;
      activeController = null;
      cancelAllRequested = false;
      const summary = {
        completed: completedCount,
        failed: failedCount,
        canceled: canceledCount,
        state: getQueueState(),
      };
      emitUpdate();
      onQueueDrained?.(summary);
      resolveIdleWaiters();
    }
  };

  const enqueueUpdates = (items = [], { silent = false } = {}) => {
    if (!Array.isArray(items) || items.length === 0) {
      return { success: true, added: 0, skippedDuplicates: 0, state: getQueueState() };
    }

    if (!isProcessing && queue.length === 0) {
      completedCount = 0;
      failedCount = 0;
      canceledCount = 0;
      history.length = 0;
    }

    const existingIds = new Set(queue.map((q) => q.itemId).filter(Boolean));
    let added = 0;
    let skippedDuplicates = 0;

    for (const raw of items) {
      const normalized = normalizeQueueItem(raw, { silent: Boolean(silent), generateId });
      if (!normalized.itemId) continue;
      if (existingIds.has(normalized.itemId)) {
        skippedDuplicates++;
        continue;
      }
      existingIds.add(normalized.itemId);
      queue.push(normalized);
      added++;
    }

    if (added > 0) {
      emitUpdate();
      void processQueue();
    }

    return {
      success: true,
      added,
      skippedDuplicates,
      state: getQueueState(),
    };
  };

  const reorderQueue = (fromIndex, toIndex) => {
    const from = Number(fromIndex);
    const to = Number(toIndex);

    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return { success: false, error: 'Ungültige Positionen für das Umsortieren.', state: getQueueState() };
    }

    // Platz 1 (Index 0 = aktives Element) ist strikt gesperrt
    if (from === 0 || to === 0) {
      return {
        success: false,
        error: 'Das aktive Update auf Platz 1 kann nicht verschoben werden.',
        state: getQueueState(),
      };
    }

    if (from < 1 || to < 1 || from >= queue.length || to >= queue.length) {
      return { success: false, error: 'Position außerhalb der wartenden Elemente.', state: getQueueState() };
    }

    if (queue[from]?.status !== 'pending' || queue[to]?.status !== 'pending') {
      return {
        success: false,
        error: 'Nur wartende Elemente können umsortiert werden.',
        state: getQueueState(),
      };
    }

    if (from === to) {
      return { success: true, state: getQueueState() };
    }

    const [moved] = queue.splice(from, 1);
    queue.splice(to, 0, moved);
    emitUpdate();
    return { success: true, state: getQueueState() };
  };

  const cancelQueueItem = (queueId) => {
    const cleanId = String(queueId || '').trim();
    if (!cleanId) {
      return { success: false, error: 'Keine Queue-ID angegeben.', state: getQueueState() };
    }

    const idx = queue.findIndex((item) => item.queueId === cleanId);
    if (idx === -1) {
      return { success: false, error: 'Eintrag nicht in der Warteschlange gefunden.', state: getQueueState() };
    }

    if (idx === 0 && queue[0].status === 'running') {
      queue[0].detail = 'Wird abgebrochen...';
      emitUpdate();
      activeController?.abort();
      return { success: true, canceledActive: true, state: getQueueState() };
    }

    const [removed] = queue.splice(idx, 1);
    removed.status = 'canceled';
    removed.detail = 'Aus Warteschlange entfernt';
    canceledCount++;
    pushHistory(removed);
    emitUpdate();
    return { success: true, canceledActive: false, state: getQueueState() };
  };

  const cancelAllQueue = () => {
    cancelAllRequested = true;

    if (queue.length > 1) {
      const removedPending = queue.splice(1);
      for (const item of removedPending) {
        item.status = 'canceled';
        item.detail = 'Abgebrochen';
        canceledCount++;
        pushHistory(item);
      }
    }

    if (queue[0]?.status === 'running') {
      queue[0].detail = 'Wird abgebrochen...';
      emitUpdate();
      activeController?.abort();
    } else if (queue.length > 0) {
      const [item] = queue.splice(0, 1);
      item.status = 'canceled';
      item.detail = 'Abgebrochen';
      canceledCount++;
      pushHistory(item);
      emitUpdate();
    } else {
      emitUpdate();
    }

    return { success: true, state: getQueueState() };
  };

  const waitUntilIdle = () => {
    if (!isProcessing && queue.length === 0) {
      return Promise.resolve(getQueueState());
    }
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  };

  return {
    enqueueUpdates,
    reorderQueue,
    cancelQueueItem,
    cancelAllQueue,
    getQueueState,
    waitUntilIdle,
  };
}
