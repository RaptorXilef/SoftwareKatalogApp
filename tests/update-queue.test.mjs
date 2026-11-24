import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createUpdateQueueManager } from '../src/shared/update-queue-core.js';

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('update-queue-core: sequentielle Abarbeitung & Duplikatschutz', () => {
  it('arbeitet eingereihte Updates streng sequentiell (max. 1 gleichzeitig) ab und dedupliziert itemIds', async () => {
    let activeNow = 0;
    let maxConcurrent = 0;
    const executionOrder = [];
    const gates = {
      a: createDeferred(),
      b: createDeferred(),
      c: createDeferred(),
    };

    let seq = 0;
    const manager = createUpdateQueueManager({
      generateId: () => `q-${++seq}`,
      executor: async (item) => {
        activeNow++;
        maxConcurrent = Math.max(maxConcurrent, activeNow);
        executionOrder.push(item.itemId);
        await gates[item.itemId].promise;
        activeNow--;
        return { success: true };
      },
    });

    const res1 = manager.enqueueUpdates([
      { id: 'a', name: 'App A', installedVersion: '1.0', webVersion: '2.0' },
      { id: 'b', name: 'App B', installedVersion: '1.0', webVersion: '2.0' },
      { id: 'a', name: 'App A Duplikat' },
    ]);
    assert.equal(res1.added, 2);
    assert.equal(res1.skippedDuplicates, 1);

    // Während a läuft und b wartet: c hinzufügen, aber b nicht doppelt
    const res2 = manager.enqueueUpdates([
      { id: 'b', name: 'App B Duplikat' },
      { id: 'c', name: 'App C', installedVersion: '1.0', webVersion: '2.0' },
    ]);
    assert.equal(res2.added, 1);
    assert.equal(res2.skippedDuplicates, 1);

    assert.deepEqual(executionOrder, ['a']);
    assert.equal(manager.getQueueState().activeCount, 1);
    assert.equal(manager.getQueueState().pendingCount, 2);

    gates.a.resolve();
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(executionOrder, ['a', 'b']);

    gates.b.resolve();
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(executionOrder, ['a', 'b', 'c']);

    gates.c.resolve();
    const finalState = await manager.waitUntilIdle();
    assert.equal(maxConcurrent, 1);
    assert.equal(finalState.completedCount, 3);
    assert.equal(finalState.queue.length, 0);
  });
});

describe('update-queue-core: Sperre von Platz 1 beim Reordern', () => {
  it('verbietet Verschieben von oder auf Index 0, erlaubt aber freies Umsortieren der Plätze 2..N', async () => {
    const executionOrder = [];
    const gates = {
      a: createDeferred(),
      b: createDeferred(),
      c: createDeferred(),
      d: createDeferred(),
    };

    const manager = createUpdateQueueManager({
      executor: async (item) => {
        executionOrder.push(item.itemId);
        await gates[item.itemId].promise;
        return { success: true };
      },
    });

    manager.enqueueUpdates([
      { id: 'a', name: 'App A' },
      { id: 'b', name: 'App B' },
      { id: 'c', name: 'App C' },
      { id: 'd', name: 'App D' },
    ]);

    // Index 0 darf weder weg noch Ziel sein
    const denyFromZero = manager.reorderQueue(0, 2);
    assert.equal(denyFromZero.success, false);
    assert.equal(denyFromZero.state.queue[0].itemId, 'a');

    const denyToZero = manager.reorderQueue(2, 0);
    assert.equal(denyToZero.success, false);
    assert.equal(denyToZero.state.queue[0].itemId, 'a');

    // Platz 4 (Index 3 = 'd') auf Platz 2 (Index 1) vorziehen
    const okReorder = manager.reorderQueue(3, 1);
    assert.equal(okReorder.success, true);
    assert.deepEqual(
      okReorder.state.queue.map((i) => i.itemId),
      ['a', 'd', 'b', 'c']
    );

    gates.a.resolve();
    gates.d.resolve();
    gates.b.resolve();
    gates.c.resolve();
    await manager.waitUntilIdle();

    assert.deepEqual(executionOrder, ['a', 'd', 'b', 'c']);
  });
});

describe('update-queue-core: Einzel-Abbruch & Alle-Abbrechen', () => {
  it('entfernt wartende Elemente sofort und bricht das aktive Element per AbortSignal ab ohne Folgende zu blockieren', async () => {
    const executionOrder = [];
    let activeAborted = false;
    const gateA = createDeferred();
    const gateC = createDeferred();

    const manager = createUpdateQueueManager({
      executor: async (item, { signal }) => {
        executionOrder.push(item.itemId);
        if (item.itemId === 'a') {
          signal.addEventListener('abort', () => {
            activeAborted = true;
            gateA.resolve();
          });
          await gateA.promise;
          return { success: false, canceled: signal.aborted };
        }
        await gateC.promise;
        return { success: true };
      },
    });

    manager.enqueueUpdates([
      { id: 'a', name: 'App A' },
      { id: 'b', name: 'App B' },
      { id: 'c', name: 'App C' },
    ]);

    const snapshot = manager.getQueueState();
    const qIdA = snapshot.queue[0].queueId;
    const qIdB = snapshot.queue[1].queueId;

    // Wartendes Element B entfernen
    const cancelB = manager.cancelQueueItem(qIdB);
    assert.equal(cancelB.success, true);
    assert.equal(cancelB.canceledActive, false);
    assert.deepEqual(
      cancelB.state.queue.map((i) => i.itemId),
      ['a', 'c']
    );

    // Aktives Element A abbrechen -> AbortSignal feuert, danach startet C
    const cancelA = manager.cancelQueueItem(qIdA);
    assert.equal(cancelA.success, true);
    assert.equal(cancelA.canceledActive, true);

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(activeAborted, true);
    assert.deepEqual(executionOrder, ['a', 'c']);

    gateC.resolve();
    const finalState = await manager.waitUntilIdle();
    assert.equal(finalState.completedCount, 1);
    assert.equal(finalState.canceledCount, 2);
  });

  it('bricht per cancelAllQueue das aktive Element ab und leert alle wartenden Elemente', async () => {
    const executionOrder = [];
    let aborted = false;
    const gateA = createDeferred();

    const manager = createUpdateQueueManager({
      executor: async (item, { signal }) => {
        executionOrder.push(item.itemId);
        signal.addEventListener('abort', () => {
          aborted = true;
          gateA.resolve();
        });
        await gateA.promise;
        return { success: false, canceled: signal.aborted };
      },
    });

    manager.enqueueUpdates([
      { id: 'a', name: 'App A' },
      { id: 'b', name: 'App B' },
      { id: 'c', name: 'App C' },
    ]);

    const cancelRes = manager.cancelAllQueue();
    assert.equal(cancelRes.success, true);
    assert.equal(cancelRes.state.pendingCount, 0);

    const finalState = await manager.waitUntilIdle();
    assert.equal(aborted, true);
    assert.deepEqual(executionOrder, ['a']);
    assert.equal(finalState.queue.length, 0);
    assert.equal(finalState.canceledCount, 3);
  });
});

describe('update-queue-core: Adware-Schutz (interactive-required) bei Silent-Queue', () => {
  it('erzwingt bei interactive-required und erkannten Adware-Kandidaten auch in der Silent-Queue den interaktiven Modus', async () => {
    const executedModes = [];

    const manager = createUpdateQueueManager({
      executor: async (item) => {
        executedModes.push({
          id: item.itemId,
          mode: item.mode,
          interactiveRequired: item.interactiveRequired,
        });
        return { success: true };
      },
    });

    const res = manager.enqueueUpdates(
      [
        { id: '7zip', name: '7-Zip', installMode: 'interactive' },
        { id: 'iobit', name: 'IObit Uninstaller', installMode: 'interactive-required' },
        { id: 'ccleaner', name: 'CCleaner Free', installMode: 'interactive' },
      ],
      { silent: true }
    );

    assert.equal(res.added, 3);
    const q = res.state.queue;
    assert.equal(q[0].mode, 'silent');
    assert.equal(q[0].interactiveRequired, false);

    assert.equal(q[1].mode, 'interactive');
    assert.equal(q[1].interactiveRequired, true);
    assert.match(q[1].detail, /🛡️/);

    assert.equal(q[2].mode, 'interactive');
    assert.equal(q[2].interactiveRequired, true);
    assert.match(q[2].detail, /🛡️/);

    await manager.waitUntilIdle();
    assert.deepEqual(executedModes, [
      { id: '7zip', mode: 'silent', interactiveRequired: false },
      { id: 'iobit', mode: 'interactive', interactiveRequired: true },
      { id: 'ccleaner', mode: 'interactive', interactiveRequired: true },
    ]);
  });

  it('erzwingt mit forceInteractive: true den interaktiven Modus auch bei silent-konfigurierten Paketen', async () => {
    const executedModes = [];
    const manager = createUpdateQueueManager({
      executor: async (item) => {
        executedModes.push({ id: item.itemId, mode: item.mode });
        return { success: true };
      },
    });

    const res = manager.enqueueUpdates([{ id: 'vlc', name: 'VLC Media Player', installMode: 'silent' }], {
      silent: false,
      forceInteractive: true,
    });

    assert.equal(res.added, 1);
    assert.equal(res.state.queue[0].mode, 'interactive');
    await manager.waitUntilIdle();
    assert.deepEqual(executedModes, [{ id: 'vlc', mode: 'interactive' }]);
  });
});
