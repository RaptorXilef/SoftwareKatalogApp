import {
  DEV_PROJECT_EMOJI_PRESETS,
  filterDevProjects,
  getDevManagerMeta,
  getProjectFolderBaseName,
  shortenProjectPath,
  summarizeDevProjectScan,
} from '../../shared/dev-ui-logic.js';
import { openNestedDialog } from '../modals/archive-target-modal.js';
import { ensureAdminAuthenticated } from '../modals/login-modal.js';
import {
  getSelectedDevProject,
  refreshDevProjects,
  resetDevWorkspaceForProject,
  setDevScanResult,
  state,
} from '../state.js';
import { getI18nLocale, t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';
import {
  handleDevWorkspaceChange,
  handleDevWorkspaceClick,
  handleDevWorkspaceInput,
  handleDevWorkspaceKeydown,
  renderDevWorkspace,
} from './dev-workspace.js';
import { showToast } from './toast.js';
import { updateNavCounts } from './toolbar.js';

let initialized = false;
const autoQuickScanStarted = new Set();

function renderProjectCardHtml(project) {
  const scan = state.devScanByProjectId[project.id] || null;
  const summary = summarizeDevProjectScan(scan);
  const isScanning = state.devScanningProjectIds.has(project.id);
  const isAvailable = project.isAvailable !== false;

  const cardClasses = ['dev-project-card'];
  if (!isAvailable) cardClasses.push('is-unavailable');
  if (summary.majorUpdatesCount > 0) cardClasses.push('has-major-updates');
  else if (summary.updatesCount > 0) cardClasses.push('has-updates');

  let managersHtml = '';
  if (!isAvailable) {
    managersHtml = `<span class="dev-project-status-pill is-offline" title="${escapeHTML(t('dev.statusOfflineTitle'))}">⚠️ ${escapeHTML(t('dev.statusOffline'))}</span>`;
  } else if (isScanning && !summary.hasScan) {
    managersHtml = `<span class="muted">⏳ ${escapeHTML(t('dev.scanning'))}</span>`;
  } else if (summary.managers.length > 0) {
    managersHtml = summary.managers
      .map((mgr) => {
        const meta = getDevManagerMeta(mgr);
        return `<span class="provider-badge ${escapeHTML(meta.badgeClass)}">${escapeHTML(meta.label)}</span>`;
      })
      .join('');
  } else if (summary.hasScan) {
    managersHtml = `<span class="muted">${escapeHTML(t('dev.noManagersDetected'))}</span>`;
  } else {
    managersHtml = `<span class="muted">${escapeHTML(t('dev.notScannedYet'))}</span>`;
  }

  const updatesCellClass =
    summary.updatesCount > 0
      ? summary.majorUpdatesCount > 0
        ? 'dev-kpi-box is-major-alert'
        : 'dev-kpi-box is-updates-alert'
      : 'dev-kpi-box';

  const directVal = summary.hasScan ? String(summary.directCount) : '-';
  const depsVal = summary.hasScan ? String(summary.depsCount) : '-';
  const updatesVal = summary.hasCheckedUpdates ? String(summary.updatesCount) : '-';

  const locale = getI18nLocale() || 'en';
  const lastScanText = project.lastScannedAt
    ? t('dev.lastScanned', { time: new Date(project.lastScannedAt).toLocaleString(locale) })
    : t('dev.neverScanned');

  return `
    <article
      class="${cardClasses.join(' ')}"
      data-dev-project-id="${escapeHTML(project.id)}"
      tabindex="0"
      role="button"
    >
      <div class="dev-project-card-head">
        <div class="dev-project-title-row">
          <span class="dev-project-icon">${escapeHTML(project.icon || '🛠️')}</span>
          <div class="dev-project-title-text">
            <h3>${escapeHTML(project.name)}</h3>
            <code class="dev-project-path" title="${escapeHTML(project.path)}">${escapeHTML(shortenProjectPath(project.path, 48))}</code>
          </div>
        </div>
        ${
          !isAvailable
            ? `<span class="dev-project-offline-dot" title="${escapeHTML(t('dev.statusOfflineTitle'))}">⚠️</span>`
            : ''
        }
      </div>

      <div class="dev-project-managers">
        ${managersHtml}
      </div>

      <div class="dev-project-kpis">
        <div class="dev-kpi-box">
          <strong class="dev-kpi-value">${escapeHTML(directVal)}</strong>
          <span class="dev-kpi-label">${escapeHTML(t('dev.kpiDirect'))}</span>
        </div>
        <div class="dev-kpi-box">
          <strong class="dev-kpi-value">${escapeHTML(depsVal)}</strong>
          <span class="dev-kpi-label">${escapeHTML(t('dev.kpiDeps'))}</span>
        </div>
        <div class="${updatesCellClass}">
          <strong class="dev-kpi-value">${escapeHTML(updatesVal)}</strong>
          <span class="dev-kpi-label">${escapeHTML(t('dev.kpiUpdates'))}</span>
        </div>
      </div>

      ${project.notes ? `<p class="dev-project-notes">${escapeHTML(project.notes)}</p>` : ''}

      <div class="dev-project-meta-row">
        <span class="muted">${escapeHTML(lastScanText)}</span>
      </div>

      <div class="dev-project-card-actions">
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          data-dev-card-action="open-folder"
          data-dev-project-id="${escapeHTML(project.id)}"
          ${isAvailable ? '' : 'disabled'}
        >📂 ${escapeHTML(t('dev.openFolder'))}</button>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          data-dev-card-action="scan-project"
          data-dev-project-id="${escapeHTML(project.id)}"
          title="${escapeHTML(t('dev.scanProjectTitle'))}"
          ${!isAvailable || isScanning ? 'disabled' : ''}
        >${isScanning ? '⏳' : '🔄'}</button>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          data-dev-card-action="edit-project"
          data-dev-project-id="${escapeHTML(project.id)}"
        >✏️ ${escapeHTML(t('common.edit'))}</button>
        <button
          type="button"
          class="btn btn-danger btn-xs"
          data-dev-card-action="remove-project"
          data-dev-project-id="${escapeHTML(project.id)}"
        >🗑️ ${escapeHTML(t('common.remove'))}</button>
      </div>
    </article>
  `;
}

function renderProjectsGridInnerHtml() {
  const allProjects = state.devProjects || [];
  const q = state.devProjectSearchQuery.trim();
  const filtered = filterDevProjects(allProjects, q, state.devScanByProjectId);

  if (allProjects.length === 0) {
    return `
      <div class="dev-empty">
        <div class="dev-empty-icon">🛠️</div>
        <h3>${escapeHTML(t('dev.emptyTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.emptyDesc'))}</p>
        <div class="dev-empty-actions">
          <button type="button" class="btn btn-primary" data-dev-action="add-project">➕ ${escapeHTML(t('dev.addProject'))}</button>
        </div>
      </div>
    `;
  }

  if (filtered.length === 0) {
    return `
      <div class="dev-empty">
        <h3>${escapeHTML(t('dev.emptySearchTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.emptySearchDesc'))}</p>
        <div class="dev-empty-actions">
          <button type="button" class="btn btn-ghost" data-dev-action="clear-search">${escapeHTML(t('dev.resetSearch'))}</button>
        </div>
      </div>
    `;
  }

  return `<div class="dev-projects-grid">${filtered.map(renderProjectCardHtml).join('')}</div>`;
}

function renderDevOverview(container) {
  const allProjects = state.devProjects || [];
  const q = state.devProjectSearchQuery.trim();
  const filtered = filterDevProjects(allProjects, q, state.devScanByProjectId);
  const hasAvailable = allProjects.some((p) => p.isAvailable !== false);

  const ipcNoticeHtml = state.devProjectsIpcUnavailable
    ? `<div class="discover-notice">⚠️ ${escapeHTML(t('dev.ipcUnavailableNotice'))}</div>`
    : '';

  container.innerHTML = `
    <div class="dev-header">
      <div class="dev-header-main">
        <div>
          <h2>🛠️ ${escapeHTML(t('dev.headerTitle'))}</h2>
          <p class="muted">${escapeHTML(t('dev.headerSubtitle'))}</p>
        </div>
        <div class="dev-header-actions">
          <button type="button" class="btn btn-primary" data-dev-action="add-project">➕ ${escapeHTML(t('dev.addProject'))}</button>
          <button
            type="button"
            class="btn btn-online"
            data-dev-action="scan-all"
            ${state.devScanningAll || !hasAvailable ? 'disabled' : ''}
          >🔄 ${escapeHTML(state.devScanningAll ? t('dev.scanningAll') : t('dev.scanAllProjects'))}</button>
        </div>
      </div>

      <div class="dev-search-row">
        <div class="dev-search-box">
          <input
            type="text"
            id="devProjectSearchInput"
            value="${escapeHTML(state.devProjectSearchQuery)}"
            placeholder="${escapeHTML(t('dev.searchPlaceholder'))}"
            autocomplete="off"
          >
          <button
            type="button"
            id="clearDevProjectSearchBtn"
            class="clear-btn"
            title="${escapeHTML(t('toolbar.clearSearch'))}"
            ${state.devProjectSearchQuery ? '' : 'hidden'}
          >✕</button>
        </div>
        <span id="devProjectsCountSummary" class="muted">${escapeHTML(t('dev.countSummary', { filtered: filtered.length, total: allProjects.length }))}</span>
        <span class="dev-drop-hint muted">${escapeHTML(t('dev.dragDropHint'))}</span>
      </div>
    </div>

    ${ipcNoticeHtml}

    <div id="devProjectsGridHost">${renderProjectsGridInnerHtml()}</div>
  `;

  void triggerAutoQuickScanForNewProjects();
}

async function triggerAutoQuickScanForNewProjects() {
  const pending = (state.devProjects || []).filter(
    (p) =>
      p.isAvailable !== false &&
      !state.devScanByProjectId[p.id] &&
      !state.devScanningProjectIds.has(p.id) &&
      !autoQuickScanStarted.has(p.id)
  );
  if (pending.length === 0) return;

  for (const proj of pending) {
    autoQuickScanStarted.add(proj.id);
    await scanSingleDevProject(proj.id, { useJob: false, checkUpdates: false, silent: true });
  }
}

export async function scanSingleDevProject(projectId, { useJob = true, checkUpdates = true, silent = false } = {}) {
  const cleanId = String(projectId || '').trim();
  if (!cleanId || typeof window.electronAPI?.scanDevProject !== 'function') return null;
  if (state.devScanningProjectIds.has(cleanId)) return null;

  state.devScanningProjectIds.add(cleanId);
  renderDevView();

  try {
    const res = await window.electronAPI.scanDevProject(cleanId, { useJob, checkUpdates });
    if (res && (res.success || res.unavailable)) {
      setDevScanResult(cleanId, res, { checkedUpdates: Boolean(checkUpdates && res.success) });
      updateNavCounts();
      if (!silent && res.success) {
        const name = res.project?.name || state.devProjects.find((p) => p.id === cleanId)?.name || '';
        showToast(
          t('dev.toastScanDone', {
            name,
            direct: res.installed?.length || 0,
            updates: res.updates?.length || 0,
          }),
          { type: 'success' }
        );
      } else if (!silent && res.unavailable && res.error) {
        showToast(res.error, { type: 'warn', duration: 5000 });
      }
    } else if (res?.canceled) {
      if (!silent) showToast(t('dev.toastScanCanceled'), { type: 'info' });
    } else if (res?.alreadyRunning) {
      if (!silent) showToast(t('dev.toastScanAlreadyRunning'), { type: 'info' });
    } else if (res?.error && !silent) {
      showToast(t('dev.toastScanFailed', { error: res.error }), { type: 'error', duration: 6000 });
    }
    return res;
  } catch (err) {
    if (!silent) {
      showToast(t('dev.toastScanFailed', { error: err?.message || t('common.unknownError') }), {
        type: 'error',
        duration: 6000,
      });
    }
    return null;
  } finally {
    state.devScanningProjectIds.delete(cleanId);
    renderDevView();
  }
}

async function scanAllDevProjects() {
  if (state.devScanningAll) return;
  const targets = (state.devProjects || []).filter((p) => p.isAvailable !== false);
  if (targets.length === 0) return;

  state.devScanningAll = true;
  renderDevView();

  let scannedCount = 0;
  let totalUpdates = 0;
  try {
    for (const proj of targets) {
      const res = await scanSingleDevProject(proj.id, { useJob: true, checkUpdates: true, silent: true });
      if (res?.success) {
        scannedCount++;
        totalUpdates += Array.isArray(res.updates) ? res.updates.length : 0;
      }
    }
    showToast(t('dev.toastScanAllDone', { count: scannedCount, updates: totalUpdates }), {
      type: totalUpdates > 0 ? 'info' : 'success',
    });
  } finally {
    state.devScanningAll = false;
    renderDevView();
  }
}

export async function openDevProjectDialog({ project = null, initialPath = '' } = {}) {
  const isEdit = Boolean(project);
  const authOk = await ensureAdminAuthenticated({
    reason: t(isEdit ? 'dev.authReasonEditProject' : 'dev.authReasonAddProject'),
  });
  if (!authOk) return null;

  const initPath = isEdit ? project.path || '' : initialPath || '';
  const defaultFolderName = getProjectFolderBaseName(initPath);
  const initName = isEdit ? project.name || defaultFolderName : defaultFolderName;
  const initIcon = isEdit ? project.icon || '🛠️' : '🛠️';
  const initNotes = isEdit ? project.notes || '' : '';

  const emojiPresetsHtml = DEV_PROJECT_EMOJI_PRESETS.map(
    (emoji) =>
      `<button type="button" class="btn btn-ghost btn-xs dev-emoji-preset-btn" data-dev-emoji="${escapeHTML(emoji)}">${escapeHTML(emoji)}</button>`
  ).join('');

  let nameTouched = Boolean(isEdit && project?.name);

  const dialogPromise = openNestedDialog({
    defaultAction: 'cancel',
    html: `
      <div class="modal-header">
        <h2>${escapeHTML(isEdit ? t('dev.dialogEditTitle') : t('dev.dialogAddTitle'))}</h2>
        <button type="button" class="icon-btn" data-dialog-action="cancel" title="${escapeHTML(t('common.cancel'))}" aria-label="${escapeHTML(t('common.cancel'))}">✕</button>
      </div>

      <div class="modal-body dev-project-dialog-body">
        <label class="form-field">
          <span>${escapeHTML(t('dev.fieldFolder'))}</span>
          <div class="input-action-row">
            <input
              type="text"
              id="devDlgPath"
              value="${escapeHTML(initPath)}"
              placeholder="${escapeHTML(t('dev.fieldFolderPlaceholder'))}"
              autocomplete="off"
            >
            <button type="button" class="btn btn-ghost" id="btnDevDlgBrowse">📂 ${escapeHTML(t('dev.chooseFolder'))}</button>
          </div>
        </label>

        <div class="form-grid-2">
          <label class="form-field">
            <span>${escapeHTML(t('dev.fieldName'))}</span>
            <input
              type="text"
              id="devDlgName"
              value="${escapeHTML(initName)}"
              placeholder="${escapeHTML(t('dev.fieldNamePlaceholder'))}"
              autocomplete="off"
            >
          </label>
          <label class="form-field">
            <span>${escapeHTML(t('dev.fieldIcon'))}</span>
            <input type="text" id="devDlgIcon" value="${escapeHTML(initIcon)}" maxlength="8" autocomplete="off">
          </label>
        </div>

        <div class="dev-emoji-presets">${emojiPresetsHtml}</div>

        <label class="form-field">
          <span>${escapeHTML(t('dev.fieldNotes'))}</span>
          <textarea id="devDlgNotes" rows="3" placeholder="${escapeHTML(t('dev.fieldNotesPlaceholder'))}">${escapeHTML(initNotes)}</textarea>
        </label>
      </div>

      <div class="modal-footer">
        <span></span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-dialog-action="cancel">${escapeHTML(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-dialog-action="save">💾 ${escapeHTML(isEdit ? t('dev.btnSaveProject') : t('dev.btnAddProject'))}</button>
        </div>
      </div>
    `,
    onAction: (action) => {
      if (action !== 'save') return 'cancel';
      const dlg = document.getElementById('dialogContent');
      const pathInp = dlg?.querySelector('#devDlgPath');
      const nameInp = dlg?.querySelector('#devDlgName');
      const iconInp = dlg?.querySelector('#devDlgIcon');
      const notesInp = dlg?.querySelector('#devDlgNotes');

      const projPath = pathInp instanceof HTMLInputElement ? pathInp.value.trim() : '';
      const projName = nameInp instanceof HTMLInputElement ? nameInp.value.trim() : '';
      const projIcon = iconInp instanceof HTMLInputElement ? iconInp.value.trim() || '🛠️' : '🛠️';
      const projNotes = notesInp instanceof HTMLTextAreaElement ? notesInp.value.trim() : '';

      if (!projPath) {
        showToast(t('dev.validationPathRequired'), { type: 'warn' });
        if (pathInp instanceof HTMLInputElement) pathInp.focus();
        return undefined;
      }
      if (!projName) {
        showToast(t('dev.validationNameRequired'), { type: 'warn' });
        if (nameInp instanceof HTMLInputElement) nameInp.focus();
        return undefined;
      }

      return {
        confirmed: true,
        path: projPath,
        name: projName,
        icon: projIcon,
        notes: projNotes,
      };
    },
  });

  const dialog = document.getElementById('dialogContent');
  if (dialog) {
    const pathInp = dialog.querySelector('#devDlgPath');
    const nameInp = dialog.querySelector('#devDlgName');
    const iconInp = dialog.querySelector('#devDlgIcon');
    const browseBtn = dialog.querySelector('#btnDevDlgBrowse');

    if (nameInp instanceof HTMLInputElement) {
      nameInp.addEventListener('input', () => {
        nameTouched = nameInp.value.trim().length > 0;
      });
    }

    if (pathInp instanceof HTMLInputElement) {
      pathInp.addEventListener('input', () => {
        if (!nameTouched && nameInp instanceof HTMLInputElement) {
          nameInp.value = getProjectFolderBaseName(pathInp.value);
        }
      });
    }

    if (browseBtn instanceof HTMLButtonElement) {
      browseBtn.addEventListener('click', async () => {
        const currentPath = pathInp instanceof HTMLInputElement ? pathInp.value.trim() : '';
        const picked = await window.electronAPI.selectDir({
          title: t('dev.selectFolderTitle'),
          defaultPath: currentPath || undefined,
        });
        if (!picked) return;
        if (pathInp instanceof HTMLInputElement) pathInp.value = picked;
        if (!nameTouched && nameInp instanceof HTMLInputElement) {
          nameInp.value = getProjectFolderBaseName(picked);
        }
      });
    }

    dialog.querySelectorAll('[data-dev-emoji]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!(btn instanceof HTMLElement) || !(iconInp instanceof HTMLInputElement)) return;
        iconInp.value = btn.dataset.devEmoji || '🛠️';
      });
    });
  }

  const result = await dialogPromise;
  if (!result || result === 'cancel' || !result.confirmed) return null;

  if (isEdit && project) {
    const res = await window.electronAPI.updateDevProject(project.id, {
      name: result.name,
      path: result.path,
      icon: result.icon,
      notes: result.notes,
    });
    if (!res?.success) {
      showToast(res?.error || t('common.unknownError'), { type: 'error', duration: 6000 });
      return null;
    }
    await refreshDevProjects();
    updateNavCounts();
    renderDevView();
    showToast(t('dev.toastProjectUpdated', { name: res.project?.name || result.name }), { type: 'success' });
    return res.project || null;
  }

  const res = await window.electronAPI.addDevProject({
    name: result.name,
    path: result.path,
    icon: result.icon,
    notes: result.notes,
  });
  if (!res?.success) {
    showToast(res?.error || t('common.unknownError'), { type: 'error', duration: 6000 });
    return null;
  }

  await refreshDevProjects();
  updateNavCounts();
  renderDevView();
  showToast(t('dev.toastProjectAdded', { name: res.project?.name || result.name }), { type: 'success' });
  if (res.project?.id) {
    void scanSingleDevProject(res.project.id, { useJob: true, checkUpdates: true, silent: true });
  }
  return res.project || null;
}

export async function handleDevFolderDrop(folderPath) {
  const cleanPath = String(folderPath || '').trim();
  if (!cleanPath) {
    showToast(t('dev.toastFolderInvalid'), { type: 'warn' });
    return;
  }
  state.devSelectedProjectId = null;
  renderDevView();
  await openDevProjectDialog({ initialPath: cleanPath });
}

async function handleRemoveProjectClick(btn, project) {
  if (btn.dataset.armed !== 'true') {
    btn.dataset.armed = 'true';
    btn.dataset.origText = btn.textContent || '';
    btn.textContent = `⚠️ ${t('common.confirmRemoveArmed')}`;
    setTimeout(() => {
      if (btn.isConnected && btn.dataset.armed === 'true') {
        btn.dataset.armed = 'false';
        btn.textContent = btn.dataset.origText || `🗑️ ${t('common.remove')}`;
      }
    }, 4000);
    return;
  }

  btn.dataset.armed = 'false';
  const ok = await ensureAdminAuthenticated({
    reason: t('dev.authReasonRemoveProject'),
  });
  if (!ok) return;

  btn.disabled = true;
  const res = await window.electronAPI.removeDevProject(project.id);
  if (!res?.success) {
    btn.disabled = false;
    showToast(res?.error || t('common.unknownError'), { type: 'error', duration: 6000 });
    return;
  }

  delete state.devScanByProjectId[project.id];
  if (state.devSelectedProjectId === project.id) {
    state.devSelectedProjectId = null;
  }
  await refreshDevProjects();
  updateNavCounts();
  renderDevView();
  showToast(t('dev.toastProjectRemoved', { name: project.name }), { type: 'success' });
}

function getWorkspaceCallbacks() {
  return {
    onBack: () => {
      state.devSelectedProjectId = null;
      renderDevView();
    },
    onScanProject: (projectId, opts) => scanSingleDevProject(projectId, opts),
    onEditProject: (proj) => openDevProjectDialog({ project: proj }),
    onRerender: () => renderDevView(),
    onUpdateNavCounts: () => updateNavCounts(),
  };
}

export function renderDevView() {
  const container = document.getElementById('devView');
  if (!container) return;

  const selectedProject = getSelectedDevProject();
  if (selectedProject) {
    renderDevWorkspace(container, selectedProject);
  } else {
    state.devSelectedProjectId = null;
    renderDevOverview(container);
  }
}

export function initDevView() {
  if (initialized) return;
  initialized = true;

  const container = document.getElementById('devView');
  if (!container) return;

  container.addEventListener('input', (e) => {
    if (getSelectedDevProject()) {
      handleDevWorkspaceInput(e);
      return;
    }

    if (!(e.target instanceof HTMLInputElement) || e.target.id !== 'devProjectSearchInput') return;
    state.devProjectSearchQuery = e.target.value;
    const clearBtn = container.querySelector('#clearDevProjectSearchBtn');
    if (clearBtn instanceof HTMLElement) clearBtn.hidden = state.devProjectSearchQuery.length === 0;
    const gridHost = container.querySelector('#devProjectsGridHost');
    if (gridHost instanceof HTMLElement) {
      gridHost.innerHTML = renderProjectsGridInnerHtml();
    }
    const summaryEl = container.querySelector('#devProjectsCountSummary');
    if (summaryEl instanceof HTMLElement) {
      const filtered = filterDevProjects(state.devProjects, state.devProjectSearchQuery, state.devScanByProjectId);
      summaryEl.textContent = t('dev.countSummary', {
        filtered: filtered.length,
        total: state.devProjects.length,
      });
    }
  });

  container.addEventListener('change', (e) => {
    if (getSelectedDevProject()) {
      handleDevWorkspaceChange(e);
    }
  });

  container.addEventListener('keydown', (e) => {
    if (getSelectedDevProject()) {
      handleDevWorkspaceKeydown(e, getWorkspaceCallbacks());
      return;
    }

    if (e.key === 'Enter' && e.target instanceof HTMLElement) {
      const card = e.target.closest('.dev-project-card');
      if (card instanceof HTMLElement && !e.target.closest('button')) {
        const projId = card.dataset.devProjectId || '';
        if (projId) {
          resetDevWorkspaceForProject(projId);
          renderDevView();
          const proj = getSelectedDevProject();
          const cached = proj ? state.devScanByProjectId[proj.id] : null;
          if (proj && proj.isAvailable !== false && !cached?.hasCheckedUpdates) {
            void scanSingleDevProject(proj.id, { useJob: true, checkUpdates: true, silent: true });
          }
        }
      }
    }
  });

  container.addEventListener('click', async (e) => {
    if (getSelectedDevProject()) {
      await handleDevWorkspaceClick(e, getWorkspaceCallbacks());
      return;
    }

    const target = e.target;
    if (!(target instanceof Element)) return;

    if (target.id === 'clearDevProjectSearchBtn') {
      state.devProjectSearchQuery = '';
      renderDevView();
      const input = container.querySelector('#devProjectSearchInput');
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }

    const headerActionBtn = target.closest('[data-dev-action]');
    if (headerActionBtn instanceof HTMLElement) {
      const act = headerActionBtn.dataset.devAction;
      if (act === 'add-project') {
        await openDevProjectDialog();
      } else if (act === 'scan-all') {
        await scanAllDevProjects();
      } else if (act === 'clear-search') {
        state.devProjectSearchQuery = '';
        renderDevView();
      }
      return;
    }

    const cardActionBtn = target.closest('[data-dev-card-action]');
    if (cardActionBtn instanceof HTMLButtonElement) {
      e.stopPropagation();
      const action = cardActionBtn.dataset.devCardAction;
      const projId = cardActionBtn.dataset.devProjectId || '';
      const project = state.devProjects.find((p) => p.id === projId);
      if (!project) return;

      if (action === 'open-folder') {
        window.electronAPI.openPath(project.path);
      } else if (action === 'scan-project') {
        await scanSingleDevProject(project.id, { useJob: true, checkUpdates: true });
      } else if (action === 'edit-project') {
        await openDevProjectDialog({ project });
      } else if (action === 'remove-project') {
        await handleRemoveProjectClick(cardActionBtn, project);
      }
      return;
    }

    const card = target.closest('.dev-project-card');
    if (card instanceof HTMLElement) {
      const projId = card.dataset.devProjectId || '';
      if (!projId) return;
      resetDevWorkspaceForProject(projId);
      renderDevView();
      const proj = getSelectedDevProject();
      const cached = proj ? state.devScanByProjectId[proj.id] : null;
      if (proj && proj.isAvailable !== false && !cached?.hasCheckedUpdates) {
        void scanSingleDevProject(proj.id, { useJob: true, checkUpdates: true, silent: true });
      }
    }
  });
}
