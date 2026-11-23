import { evaluateBundleStatus, planBundleExecution } from '../../shared/bundles-logic.js';
import { renderBundlesView } from '../components/bundles-view.js';
import { showToast } from '../components/toast.js';
import { state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';
import { askBatchArchiveSaveChoice, pickArchiveTargetFolder } from './archive-target-modal.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';

let activeRunnerToken = 0;

function getArchiveSaveModeLabel(mode) {
  if (mode === 'auto-id') return 'Automatisch im Archiv unter Paket-ID speichern';
  if (mode === 'none') return 'Nicht automatisch ins Archiv speichern';
  return 'Jedes Mal fragen (Ordner im Archiv wählen)';
}

export function renderBundleRunnerModal(bundleId, { onRescanPc = null } = {}) {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;

  const bundle = state.bundles.find((b) => b.id === bundleId);
  if (!bundle) {
    showToast('Bündel nicht gefunden.', { type: 'error' });
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

  const computeEvaluation = () =>
    evaluateBundleStatus(bundle, {
      packages: state.packages,
      versionCompareDepth: state.settings.versionCompareDepth ?? 3,
    });

  let evaluation = computeEvaluation();
  const selectedKeys = new Set(evaluation.items.filter((it) => it.defaultSelected).map((it) => it.key));

  const render = () => {
    if (!isStillOpen()) return;

    const currentBundle = state.bundles.find((b) => b.id === bundleId) || bundle;
    evaluation = computeEvaluation();
    const { items, summary } = evaluation;

    const selectedEntries = items.filter((it) => selectedKeys.has(it.key) && !it.archiveMissing);
    const plan = planBundleExecution(selectedEntries, { allowSilent, silentWinget });
    const planByKey = new Map(plan.orderedQueue.map((entry) => [entry.key, entry]));
    const saveMode = state.settings.archiveSaveMode || 'ask';

    const rowsHtml =
      items.length === 0
        ? '<div class="bundle-items-empty">Dieses Bündel enthält noch keine Pakete.</div>'
        : items
            .map((entry) => {
              const checked = selectedKeys.has(entry.key) && !entry.archiveMissing;
              const planned = planByKey.get(entry.key);

              let statusClass = 'is-missing';
              if (entry.archiveMissing) statusClass = 'is-warn';
              else if (entry.status === 'up-to-date') statusClass = 'is-ok';
              else if (entry.status === 'outdated') statusClass = 'is-outdated';

              const statusText = entry.archiveMissing ? '⚠️ Nicht im Archiv gefunden' : entry.statusLabel;

              let versionNote = '';
              if (entry.installedVersion && entry.availableVersion && entry.status === 'outdated') {
                versionNote = `v${entry.installedVersion} → v${entry.availableVersion}`;
              } else if (entry.installedVersion) {
                versionNote = `Installiert: v${entry.installedVersion}`;
              } else if (entry.availableVersion) {
                versionNote = `Verfügbar: v${entry.availableVersion}`;
              }

              let phaseBadgeHtml = '';
              if (entry.adwareProtected) {
                phaseBadgeHtml =
                  '<span class="card-chip chip-install-protected" title="Silent-Parameter werden wegen Adware-Schutz immer ignoriert">🛡️ Adware-Schutz</span>';
              } else if (planned?.willRunSilent) {
                phaseBadgeHtml = '<span class="card-chip chip-install-silent">⚡ Phase 1: Still</span>';
              } else if (checked) {
                phaseBadgeHtml = '<span class="card-chip">🖱️ Phase 2: Interaktiv</span>';
              }

              return `
                <label class="bundle-runner-row ${checked ? 'is-checked' : ''} ${entry.archiveMissing ? 'is-disabled' : ''}">
                  <input
                    type="checkbox"
                    class="bundle-runner-check"
                    data-runner-key="${escapeHTML(entry.key)}"
                    ${checked ? 'checked' : ''}
                    ${entry.archiveMissing || isStarting ? 'disabled' : ''}
                  >
                  <span class="bundle-item-order">#${entry.order}</span>
                  <div class="bundle-runner-info">
                    <div class="bundle-item-title">
                      <strong>${escapeHTML(entry.name)}</strong>
                      <span class="provider-badge ${entry.source === 'archive' ? 'is-archive' : ''}">${entry.source === 'archive' ? 'Archiv' : 'Winget'}</span>
                      ${entry.optional ? '<span class="card-chip">Optional</span>' : ''}
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
        ? '<div class="bundle-phase-banner">ℹ️ Keine Pakete ausgewählt. Wähle fehlende oder veraltete Programme aus.</div>'
        : `
          <div class="bundle-phase-banner ${plan.stats.adwareProtectedCount > 0 ? 'has-protected' : ''}">
            <div>
              <strong>Ausführungsplan:</strong>
              <span>⚡ ${plan.stats.silentCount} still zuerst · 🖱️ ${plan.stats.interactiveCount} interaktiv am Ende</span>
            </div>
            ${plan.interactiveNotice ? `<p class="muted">${escapeHTML(plan.interactiveNotice)}</p>` : ''}
          </div>
        `;

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${escapeHTML(currentBundle.icon || '📦')} ${escapeHTML(currentBundle.name)}</h2>
          <span class="muted">${escapeHTML(currentBundle.description || 'PC-Status prüfen und ausgewählte Pakete installieren oder aktualisieren')}</span>
        </div>
        <button type="button" class="icon-btn" data-runner-action="close" title="Schließen" aria-label="Schließen">✕</button>
      </div>

      <div class="modal-body bundle-runner-body">
        <div class="matcher-summary-bar">
          <div class="matcher-kpi is-accent"><strong>${selectedEntries.length}</strong><span>Ausgewählt</span></div>
          <div class="matcher-kpi"><strong>${summary.missingCount}</strong><span>⬇️ Fehlt</span></div>
          <div class="matcher-kpi"><strong>${summary.outdatedCount}</strong><span>⬆️ Veraltet</span></div>
          <div class="matcher-kpi"><strong>${summary.upToDateCount}</strong><span>✅ Aktuell</span></div>
        </div>

        <div class="bundle-runner-toolbar">
          <div class="bundle-runner-quick-btns">
            <button type="button" class="btn btn-ghost btn-xs" data-runner-action="select-needed" ${isStarting ? 'disabled' : ''}>Fehlende &amp; Veraltete</button>
            <button type="button" class="btn btn-ghost btn-xs" data-runner-action="select-all" ${isStarting ? 'disabled' : ''}>Alle</button>
            <button type="button" class="btn btn-ghost btn-xs" data-runner-action="select-none" ${isStarting ? 'disabled' : ''}>Keine</button>
          </div>
          <button type="button" class="btn btn-local btn-xs" data-runner-action="rescan-pc" ${isRescanning || isStarting ? 'disabled' : ''}>
            ${isRescanning ? '⏳ Prüfe PC...' : '💻 PC-Status neu prüfen'}
          </button>
        </div>

        <div class="bundle-runner-options">
          <label class="check-row">
            <input type="checkbox" id="chkBundleAllowSilent" ${allowSilent ? 'checked' : ''} ${isStarting ? 'disabled' : ''}>
            <span>⚡ Konfigurierte Silent-Archiv-Pakete still ausführen (Phase 1 vor interaktiven Setups)</span>
          </label>
          <label class="check-row">
            <input type="checkbox" id="chkBundleSilentWinget" ${silentWinget ? 'checked' : ''} ${isStarting ? 'disabled' : ''}>
            <span>⚡ Saubere Winget-Pakete still installieren (Opt-in · 🛡️ Adware-Kandidaten bleiben immer interaktiv)</span>
          </label>
          <div class="bundle-save-mode-hint muted">
            Archiv-Speicherung für Nicht-Archiv-Winget-Pakete: <strong>${escapeHTML(getArchiveSaveModeLabel(saveMode))}</strong>
          </div>
        </div>

        ${phaseNoticeHtml}

        <div class="bundle-runner-list">
          ${rowsHtml}
        </div>
      </div>

      <div class="modal-footer">
        <span class="muted">${summary.statusText}</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-runner-action="close" ${isStarting ? 'disabled' : ''}>Abbrechen</button>
          <button type="button" class="btn btn-primary" data-runner-action="start" ${selectedEntries.length === 0 || isStarting || state.isBundleInstallRunning ? 'disabled' : ''}>
            ${isStarting ? '⏳ Starte Queue...' : `🚀 Installation starten (${selectedEntries.length})`}
          </button>
        </div>
      </div>
    `;

    const chkAllowSilent = modal.querySelector('#chkBundleAllowSilent');
    if (chkAllowSilent) {
      chkAllowSilent.onchange = () => {
        allowSilent = chkAllowSilent.checked;
        render();
      };
    }

    const chkSilentWinget = modal.querySelector('#chkBundleSilentWinget');
    if (chkSilentWinget) {
      chkSilentWinget.onchange = () => {
        silentWinget = chkSilentWinget.checked;
        render();
      };
    }
  };

  overlay.hidden = false;

  modal.onchange = (e) => {
    const chk = e.target.closest('[data-runner-key]');
    if (!chk) return;
    const key = chk.dataset.runnerKey;
    if (chk.checked) selectedKeys.add(key);
    else selectedKeys.delete(key);
    render();
  };

  modal.onclick = async (e) => {
    const btn = e.target.closest('[data-runner-action]');
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
        if (!it.archiveMissing) selectedKeys.add(it.key);
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
      const selectedEntries = evaluation.items.filter((it) => selectedKeys.has(it.key) && !it.archiveMissing);
      if (selectedEntries.length === 0 || state.isBundleInstallRunning) return;

      const saveMode = state.settings.archiveSaveMode || 'ask';
      const nonArchiveWinget = selectedEntries.filter(
        (entry) => entry.source === 'winget' && entry.packageId && !entry.matchedPackage?.inArchive
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
      showToast(`Starte Bündel "${bundle.name}" (${selectedEntries.length} Paket(e))...`, { type: 'info' });

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
          showToast('Es läuft bereits eine Bündel-Installation.', { type: 'warn' });
        } else if (res?.canceled) {
          showToast('Bündel-Installation wurde abgebrochen.', { type: 'info' });
        } else if (res?.success) {
          const type = res.failed > 0 ? 'warn' : 'success';
          showToast(
            `Bündel abgeschlossen: ${res.completed} installiert/aktualisiert (${res.skipped} übersprungen, ${res.failed} Fehler).`,
            { type, duration: 6000 }
          );
        } else if (res?.error) {
          showToast(`Bündel-Fehler: ${res.error}`, { type: 'error', duration: 6000 });
        }
      } finally {
        state.isBundleInstallRunning = false;
        if (state.activeTab === 'bundles') renderBundlesView();
      }
    }
  };

  render();
}
