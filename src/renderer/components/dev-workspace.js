import {
  buildDevUpdateKey,
  filterDevDependencies,
  filterDevInstalled,
  filterDevUpdates,
  getCompatibleDevUpdates,
  getDevManagerMeta,
  getOrderedSearchManagers,
  isCompatibleDevUpdate,
  shortenProjectPath,
} from '../../shared/dev-ui-logic.js';
import { ensureAdminAuthenticated } from '../modals/login-modal.js';
import { getSelectedDevProject, setDevScanResult, state } from '../state.js';
import { t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';
import { showToast } from './toast.js';

let discoverSearchSeq = 0;

function getProjectScan(projectId) {
  return state.devScanByProjectId[projectId] || null;
}

function getEffectiveManagerFilter(scan) {
  const managers = Array.isArray(scan?.managers) ? scan.managers : [];
  if (managers.length <= 1) return 'all';
  if (state.devWorkspace.managerFilter !== 'all' && !managers.includes(state.devWorkspace.managerFilter)) {
    state.devWorkspace.managerFilter = 'all';
  }
  return state.devWorkspace.managerFilter;
}

function getEffectiveDiscoverManager(scan) {
  const ordered = getOrderedSearchManagers(scan?.managers || []);
  const current = state.devWorkspace.discoverManager;
  if (current && ordered.some((m) => m.id === current)) {
    return current;
  }
  const next = ordered[0]?.id || 'npm';
  state.devWorkspace.discoverManager = next;
  return next;
}

function isProjectActionBusy(projectId) {
  for (const key of state.devBusyActionKeys) {
    if (key.startsWith(`${projectId}:`)) return true;
  }
  return false;
}

function renderScopeBadgeHtml(scope) {
  const clean = String(scope || 'prod').toLowerCase();
  if (clean === 'dev') {
    return `<span class="dev-scope-badge is-dev">${escapeHTML(t('dev.workspace.scopeBadgeDev'))}</span>`;
  }
  if (clean === 'optional') {
    return `<span class="dev-scope-badge is-optional">${escapeHTML(t('dev.workspace.scopeBadgeOptional'))}</span>`;
  }
  return `<span class="dev-scope-badge is-prod">${escapeHTML(t('dev.workspace.scopeBadgeProd'))}</span>`;
}

function renderUpdatesListHtml(project, scan) {
  const ws = state.devWorkspace;
  const managerFilter = getEffectiveManagerFilter(scan);
  const allUpdates = Array.isArray(scan?.updates) ? scan.updates : [];
  const filtered = filterDevUpdates(allUpdates, { managerFilter, query: ws.updatesQuery });
  const compatibleInView = getCompatibleDevUpdates(filtered);
  const validKeys = new Set(compatibleInView.map((u) => buildDevUpdateKey(u)));

  for (const k of [...ws.selectedUpdateKeys]) {
    if (!validKeys.has(k)) ws.selectedUpdateKeys.delete(k);
  }

  const selectedCount = ws.selectedUpdateKeys.size;
  const allCompatibleChecked = compatibleInView.length > 0 && selectedCount === compatibleInView.length;
  const projectBusy = isProjectActionBusy(project.id) || project.isAvailable === false;
  const batchBusy = state.devBusyActionKeys.has(`${project.id}:batch-update`);

  const batchTargetCount = selectedCount > 0 ? selectedCount : compatibleInView.length;
  const batchBtnLabel =
    selectedCount > 0
      ? t('dev.workspace.updateSelectedCompatible', { count: selectedCount })
      : t('dev.workspace.updateAllCompatible', { count: compatibleInView.length });

  const batchBarHtml =
    allUpdates.length > 0
      ? `
        <div class="dev-ws-batch-bar">
          <div class="dev-ws-batch-left">
            <label class="batch-select-all">
              <input
                type="checkbox"
                id="chkDevSelectAllUpdates"
                ${allCompatibleChecked ? 'checked' : ''}
                ${compatibleInView.length === 0 || projectBusy ? 'disabled' : ''}
              >
              <span>${escapeHTML(t('dev.workspace.selectAllCompatible'))}</span>
            </label>
            ${
              selectedCount > 0
                ? `<span class="muted">${escapeHTML(t('dev.workspace.selectedCount', { count: selectedCount }))}</span>`
                : ''
            }
          </div>
          <button
            type="button"
            class="btn btn-primary btn-xs"
            data-dev-ws-action="batch-update-compatible"
            ${batchTargetCount === 0 || projectBusy ? 'disabled' : ''}
          >⬆️ ${escapeHTML(batchBusy ? t('dev.workspace.updatingPackages') : batchBtnLabel)}</button>
        </div>
      `
      : '';

  if (!scan?.hasCheckedUpdates && allUpdates.length === 0) {
    return `
      <div class="dev-empty">
        <h3>${escapeHTML(t('dev.workspace.updatesNotCheckedTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.workspace.updatesNotCheckedDesc'))}</p>
        <button
          type="button"
          class="btn btn-primary"
          data-dev-ws-action="scan-project"
          ${project.isAvailable === false || state.devScanningProjectIds.has(project.id) ? 'disabled' : ''}
        >🔄 ${escapeHTML(t('dev.workspace.checkUpdates'))}</button>
      </div>
    `;
  }

  if (allUpdates.length === 0) {
    return `
      <div class="dev-empty">
        <h3>✅ ${escapeHTML(t('dev.workspace.updatesEmptyTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.workspace.updatesEmptyDesc'))}</p>
      </div>
    `;
  }

  if (filtered.length === 0) {
    return `${batchBarHtml}<div class="dev-empty"><p class="muted">${escapeHTML(t('dev.workspace.updatesNoMatches'))}</p></div>`;
  }

  const rowsHtml = filtered
    .map((upd) => {
      const key = buildDevUpdateKey(upd);
      const mgrMeta = getDevManagerMeta(upd.manager);
      const compatible = isCompatibleDevUpdate(upd);
      const isChecked = compatible && ws.selectedUpdateKeys.has(key);
      const isItemBusy = state.devBusyActionKeys.has(`${project.id}:update:${key}`);
      const showMajorBtn = upd.isMajor || !compatible || (upd.latest && upd.latest !== upd.wanted);

      return `
        <article class="dev-pkg-row ${upd.isMajor ? 'is-major' : 'is-compatible'}">
          <div class="dev-pkg-check">
            <input
              type="checkbox"
              class="dev-update-checkbox"
              data-dev-update-key="${escapeHTML(key)}"
              ${isChecked ? 'checked' : ''}
              ${!compatible || projectBusy ? 'disabled' : ''}
            >
          </div>

          <div class="dev-pkg-main">
            <div class="dev-pkg-title-row">
              <strong class="dev-pkg-name">${escapeHTML(upd.name)}</strong>
              <span class="provider-badge ${escapeHTML(mgrMeta.badgeClass)}">${escapeHTML(mgrMeta.label)}</span>
              ${renderScopeBadgeHtml(upd.scope)}
              ${
                upd.isMajor
                  ? `<span class="dev-major-badge" title="${escapeHTML(t('dev.workspace.badgeMajorTitle'))}">⚠️ ${escapeHTML(t('dev.workspace.badgeMajor'))}</span>`
                  : ''
              }
            </div>
            ${upd.description ? `<p class="dev-pkg-desc">${escapeHTML(upd.description)}</p>` : ''}
            <div class="dev-ver-flow">
              <div class="dev-ver-pill">
                <span>${escapeHTML(t('dev.workspace.colInstalled'))}</span>
                <code>v${escapeHTML(upd.current || '-')}</code>
              </div>
              <span class="dev-ver-arrow">-></span>
              <div class="dev-ver-pill ${compatible ? 'is-wanted' : ''}">
                <span>${escapeHTML(t('dev.workspace.colWanted'))}</span>
                <code>v${escapeHTML(upd.wanted || upd.current || '-')}</code>
              </div>
              <span class="dev-ver-arrow">-></span>
              <div class="dev-ver-pill ${upd.isMajor ? 'is-major' : 'is-latest'}">
                <span>${escapeHTML(t('dev.workspace.colLatest'))}</span>
                <code>v${escapeHTML(upd.latest || upd.wanted || '-')}</code>
              </div>
            </div>
          </div>

          <div class="dev-pkg-actions">
            ${
              compatible
                ? `<button
                    type="button"
                    class="btn btn-primary btn-xs"
                    data-dev-ws-action="update-pkg"
                    data-dev-manager="${escapeHTML(upd.manager)}"
                    data-dev-pkg="${escapeHTML(upd.name)}"
                    data-dev-target-ver="${escapeHTML(upd.wanted)}"
                    data-dev-scope="${escapeHTML(upd.scope || 'prod')}"
                    data-dev-major="false"
                    ${projectBusy ? 'disabled' : ''}
                  >${isItemBusy ? '⏳' : '⬆️'} ${escapeHTML(t('dev.workspace.btnUpdateCompatible', { version: upd.wanted }))}</button>`
                : ''
            }
            ${
              showMajorBtn
                ? `<button
                    type="button"
                    class="btn ${upd.isMajor ? 'btn-archive' : 'btn-ghost'} btn-xs"
                    data-dev-ws-action="update-pkg"
                    data-dev-manager="${escapeHTML(upd.manager)}"
                    data-dev-pkg="${escapeHTML(upd.name)}"
                    data-dev-target-ver="${escapeHTML(upd.latest || upd.wanted)}"
                    data-dev-scope="${escapeHTML(upd.scope || 'prod')}"
                    data-dev-major="true"
                    title="${escapeHTML(t('dev.workspace.btnUpdateMajorTitle', { version: upd.latest || upd.wanted }))}"
                    ${projectBusy ? 'disabled' : ''}
                  >${isItemBusy ? '⏳' : upd.isMajor ? '⚠️' : '⚡'} ${escapeHTML(t('dev.workspace.btnUpdateMajor', { version: upd.latest || upd.wanted }))}</button>`
                : ''
            }
          </div>
        </article>
      `;
    })
    .join('');

  return `${batchBarHtml}<div class="dev-pkg-list">${rowsHtml}</div>`;
}

function renderUpdatesTabHtml(project, scan) {
  const ws = state.devWorkspace;
  return `
    <div class="dev-ws-controls">
      <div class="dev-search-box">
        <input
          type="text"
          id="devUpdatesSearchInput"
          value="${escapeHTML(ws.updatesQuery)}"
          placeholder="${escapeHTML(t('dev.workspace.updatesSearchPlaceholder'))}"
          autocomplete="off"
        >
        <button type="button" id="clearDevUpdatesSearchBtn" class="clear-btn" title="${escapeHTML(t('toolbar.clearSearch'))}" ${ws.updatesQuery ? '' : 'hidden'}>✕</button>
      </div>
    </div>
    <div id="devWsListHost">${renderUpdatesListHtml(project, scan)}</div>
  `;
}

function renderInstalledListHtml(project, scan) {
  const ws = state.devWorkspace;
  const managerFilter = getEffectiveManagerFilter(scan);
  const allInstalled = Array.isArray(scan?.installed) ? scan.installed : [];
  const updates = Array.isArray(scan?.updates) ? scan.updates : [];
  const updateMap = new Map(updates.map((u) => [buildDevUpdateKey(u), u]));
  const filtered = filterDevInstalled(allInstalled, {
    managerFilter,
    scopeFilter: ws.installedScopeFilter,
    query: ws.installedQuery,
  });

  if (allInstalled.length === 0) {
    return `
      <div class="dev-empty">
        <h3>${escapeHTML(t('dev.workspace.installedEmptyTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.workspace.installedEmptyDesc'))}</p>
      </div>
    `;
  }

  if (filtered.length === 0) {
    return `<div class="dev-empty"><p class="muted">${escapeHTML(t('dev.workspace.installedNoMatches'))}</p></div>`;
  }

  const projectBusy = isProjectActionBusy(project.id) || project.isAvailable === false;

  const rowsHtml = filtered
    .map((pkg) => {
      const mgrMeta = getDevManagerMeta(pkg.manager);
      const key = buildDevUpdateKey(pkg);
      const upd = updateMap.get(key) || null;
      const isDevScope = String(pkg.scope || 'prod').toLowerCase() === 'dev';
      const nextScope = isDevScope ? 'prod' : 'dev';
      const toggleLabel = isDevScope ? t('dev.workspace.toggleToProd') : t('dev.workspace.toggleToDev');

      return `
        <article class="dev-pkg-row">
          <div class="dev-pkg-main">
            <div class="dev-pkg-title-row">
              <strong class="dev-pkg-name">${escapeHTML(pkg.name)}</strong>
              <span class="provider-badge ${escapeHTML(mgrMeta.badgeClass)}">${escapeHTML(mgrMeta.label)}</span>
              ${renderScopeBadgeHtml(pkg.scope)}
              ${
                upd
                  ? `<span class="dev-update-pill">${escapeHTML(t('dev.workspace.updateAvailablePill', { version: upd.latest || upd.wanted }))}</span>`
                  : ''
              }
            </div>
            ${pkg.description ? `<p class="dev-pkg-desc">${escapeHTML(pkg.description)}</p>` : ''}
            <div class="dev-pkg-versions-meta">
              <span>${escapeHTML(t('dev.workspace.declaredLabel'))}: <code>${escapeHTML(pkg.declaredRange || '-')}</code></span>
              <span>${escapeHTML(t('dev.workspace.installedLabel'))}: <code>${escapeHTML(pkg.installedVersion ? `v${pkg.installedVersion}` : t('dev.workspace.versionUnknown'))}</code></span>
            </div>
          </div>

          <div class="dev-pkg-actions">
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              data-dev-ws-action="toggle-scope"
              data-dev-manager="${escapeHTML(pkg.manager)}"
              data-dev-pkg="${escapeHTML(pkg.name)}"
              data-dev-target-scope="${escapeHTML(nextScope)}"
              data-dev-range="${escapeHTML(pkg.declaredRange || '')}"
              title="${escapeHTML(mgrMeta.supportsToggleScope ? toggleLabel : t('dev.workspace.toggleScopeUnsupported'))}"
              ${!mgrMeta.supportsToggleScope || projectBusy ? 'disabled' : ''}
            >↔️ ${escapeHTML(toggleLabel)}</button>
            <button
              type="button"
              class="btn btn-danger btn-xs"
              data-dev-ws-action="uninstall-pkg"
              data-dev-manager="${escapeHTML(pkg.manager)}"
              data-dev-pkg="${escapeHTML(pkg.name)}"
              data-dev-scope="${escapeHTML(pkg.scope || 'prod')}"
              title="${escapeHTML(mgrMeta.supportsUninstall ? t('common.remove') : t('dev.workspace.uninstallUnsupported'))}"
              ${!mgrMeta.supportsUninstall || projectBusy ? 'disabled' : ''}
            >🗑️ ${escapeHTML(t('common.remove'))}</button>
          </div>
        </article>
      `;
    })
    .join('');

  return `<div class="dev-pkg-list">${rowsHtml}</div>`;
}

function renderInstalledTabHtml(project, scan) {
  const ws = state.devWorkspace;
  const managerFilter = getEffectiveManagerFilter(scan);
  const allInstalled = Array.isArray(scan?.installed) ? scan.installed : [];
  const filtered = filterDevInstalled(allInstalled, {
    managerFilter,
    scopeFilter: ws.installedScopeFilter,
    query: ws.installedQuery,
  });

  const scopeChips = [
    { id: 'all', label: t('dev.workspace.scopeAll') },
    { id: 'prod', label: t('dev.workspace.scopeProd') },
    { id: 'dev', label: t('dev.workspace.scopeDev') },
  ];

  return `
    <div class="dev-ws-controls">
      <div class="dev-search-box">
        <input
          type="text"
          id="devInstalledSearchInput"
          value="${escapeHTML(ws.installedQuery)}"
          placeholder="${escapeHTML(t('dev.workspace.installedSearchPlaceholder'))}"
          autocomplete="off"
        >
        <button type="button" id="clearDevInstalledSearchBtn" class="clear-btn" title="${escapeHTML(t('toolbar.clearSearch'))}" ${ws.installedQuery ? '' : 'hidden'}>✕</button>
      </div>
      <div class="dev-filter-chips">
        ${scopeChips
          .map(
            (c) =>
              `<button type="button" class="origin-chip ${ws.installedScopeFilter === c.id ? 'active' : ''}" data-dev-installed-scope="${escapeHTML(c.id)}">${escapeHTML(c.label)}</button>`
          )
          .join('')}
      </div>
      <span id="devInstalledCountEl" class="muted">${escapeHTML(t('dev.workspace.countShown', { shown: filtered.length, total: allInstalled.length }))}</span>
    </div>
    <div id="devWsListHost">${renderInstalledListHtml(project, scan)}</div>
  `;
}

function renderDependenciesListHtml(scan) {
  const ws = state.devWorkspace;
  const managerFilter = getEffectiveManagerFilter(scan);
  const allDeps = Array.isArray(scan?.dependencies) ? scan.dependencies : [];
  const filtered = filterDevDependencies(allDeps, {
    managerFilter,
    directFilter: ws.depsDirectFilter,
    query: ws.depsQuery,
  });

  if (allDeps.length === 0) {
    return `
      <div class="dev-empty">
        <h3>${escapeHTML(t('dev.workspace.depsEmptyTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.workspace.depsEmptyDesc'))}</p>
      </div>
    `;
  }

  if (filtered.length === 0) {
    return `<div class="dev-empty"><p class="muted">${escapeHTML(t('dev.workspace.depsNoMatches'))}</p></div>`;
  }

  const limit = ws.depsRenderLimit || 150;
  const visible = filtered.slice(0, limit);
  const remaining = Math.max(0, filtered.length - visible.length);

  const rowsHtml = visible
    .map((dep) => {
      const mgrMeta = getDevManagerMeta(dep.manager);
      const reqBy = Array.isArray(dep.requiredBy) ? dep.requiredBy : [];
      const shownReqs = reqBy.slice(0, 4);
      const hiddenReqCount = Math.max(0, reqBy.length - shownReqs.length);

      let requiredByHtml = '';
      if (reqBy.length > 0) {
        const chips = shownReqs.map((r) => `<code class="dev-req-chip">${escapeHTML(r)}</code>`).join('');
        const more =
          hiddenReqCount > 0
            ? `<span class="dev-req-more" title="${escapeHTML(reqBy.join(', '))}">${escapeHTML(t('dev.workspace.requiredByMore', { count: hiddenReqCount }))}</span>`
            : '';
        requiredByHtml = `<div class="dev-dep-required-by"><span class="muted">${escapeHTML(t('dev.workspace.requiredByLabel'))}:</span> ${chips}${more}</div>`;
      } else if (dep.direct) {
        requiredByHtml = `<div class="dev-dep-required-by"><span class="muted">${escapeHTML(t('dev.workspace.directProjectDep'))}</span></div>`;
      }

      return `
        <article class="dev-pkg-row is-dependency">
          <div class="dev-pkg-main">
            <div class="dev-pkg-title-row">
              <strong class="dev-pkg-name">${escapeHTML(dep.name)}</strong>
              ${dep.version ? `<span class="card-chip">v${escapeHTML(dep.version)}</span>` : ''}
              <span class="provider-badge ${escapeHTML(mgrMeta.badgeClass)}">${escapeHTML(mgrMeta.label)}</span>
              <span class="dev-direct-badge ${dep.direct ? 'is-direct' : 'is-transitive'}">${escapeHTML(dep.direct ? t('dev.workspace.badgeDirect') : t('dev.workspace.badgeTransitive'))}</span>
              ${renderScopeBadgeHtml(dep.scope)}
              ${dep.license ? `<span class="dev-license-badge" title="${escapeHTML(t('dev.workspace.licenseLabel'))}">${escapeHTML(dep.license)}</span>` : ''}
            </div>
            ${requiredByHtml}
          </div>
          ${
            dep.homepage
              ? `<div class="dev-pkg-actions">
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs"
                    data-dev-open-url="${escapeHTML(dep.homepage)}"
                    title="${escapeHTML(t('dev.workspace.openHomepageTitle'))}"
                  >🔗</button>
                </div>`
              : ''
          }
        </article>
      `;
    })
    .join('');

  const showMoreHtml =
    remaining > 0
      ? `<div class="dev-deps-more-row">
          <button type="button" class="btn btn-ghost" data-dev-ws-action="show-more-deps">
            ${escapeHTML(t('dev.workspace.showMoreDeps', { count: Math.min(150, remaining), remaining }))}
          </button>
        </div>`
      : '';

  return `<div class="dev-pkg-list">${rowsHtml}</div>${showMoreHtml}`;
}

function renderDependenciesTabHtml(scan) {
  const ws = state.devWorkspace;
  const managerFilter = getEffectiveManagerFilter(scan);
  const allDeps = Array.isArray(scan?.dependencies) ? scan.dependencies : [];
  const filtered = filterDevDependencies(allDeps, {
    managerFilter,
    directFilter: ws.depsDirectFilter,
    query: ws.depsQuery,
  });

  const directChips = [
    { id: 'all', label: t('dev.workspace.depsAll') },
    { id: 'direct', label: t('dev.workspace.depsDirectOnly') },
    { id: 'transitive', label: t('dev.workspace.depsTransitiveOnly') },
  ];

  return `
    <div class="dev-ws-controls">
      <div class="dev-search-box">
        <input
          type="text"
          id="devDepsSearchInput"
          value="${escapeHTML(ws.depsQuery)}"
          placeholder="${escapeHTML(t('dev.workspace.depsSearchPlaceholder'))}"
          autocomplete="off"
        >
        <button type="button" id="clearDevDepsSearchBtn" class="clear-btn" title="${escapeHTML(t('toolbar.clearSearch'))}" ${ws.depsQuery ? '' : 'hidden'}>✕</button>
      </div>
      <div class="dev-filter-chips">
        ${directChips
          .map(
            (c) =>
              `<button type="button" class="origin-chip ${ws.depsDirectFilter === c.id ? 'active' : ''}" data-dev-deps-direct="${escapeHTML(c.id)}">${escapeHTML(c.label)}</button>`
          )
          .join('')}
      </div>
      <span id="devDepsCountEl" class="muted">${escapeHTML(t('dev.workspace.countShown', { shown: filtered.length, total: allDeps.length }))}</span>
    </div>
    <div id="devWsListHost">${renderDependenciesListHtml(scan)}</div>
  `;
}

function renderBundlesPlaceholderTabHtml() {
  return `
    <div class="dev-bundles-placeholder">
      <div class="dev-empty-icon">🧺</div>
      <span class="dev-soon-badge">${escapeHTML(t('dev.workspace.bundlesBadgeSoon'))}</span>
      <h3>${escapeHTML(t('dev.workspace.bundlesTitle'))}</h3>
      <p class="muted">${escapeHTML(t('dev.workspace.bundlesDesc'))}</p>
      <div class="dev-bundles-preview-chips">
        <span class="card-chip">📋 ${escapeHTML(t('dev.workspace.bundlesFeatureTemplates'))}</span>
        <span class="card-chip">📸 ${escapeHTML(t('dev.workspace.bundlesFeatureSnapshot'))}</span>
        <span class="card-chip">🚀 ${escapeHTML(t('dev.workspace.bundlesFeatureInstall'))}</span>
      </div>
    </div>
  `;
}

function renderDiscoverTabHtml(project, scan) {
  const ws = state.devWorkspace;
  const orderedManagers = getOrderedSearchManagers(scan?.managers || []);
  const activeMgr = getEffectiveDiscoverManager(scan);
  const activeMgrMeta = getDevManagerMeta(activeMgr);
  const installedList = Array.isArray(scan?.installed) ? scan.installed : [];
  const installedSet = new Set(
    installedList
      .filter((p) => String(p.manager || '').toLowerCase() === activeMgr)
      .map((p) => String(p.name || '').toLowerCase())
  );

  if (!activeMgrMeta.supportsDevScope && ws.discoverIsDev) {
    ws.discoverIsDev = false;
  }

  const managerChipsHtml = orderedManagers
    .map(
      (m) => `
        <button
          type="button"
          class="source-chip ${m.id === activeMgr ? 'active' : ''}"
          data-dev-discover-mgr="${escapeHTML(m.id)}"
        >
          <span>${escapeHTML(m.label)}</span>
          ${m.detected ? `<span class="dev-chip-detected-tag">${escapeHTML(t('dev.workspace.discoverInProjectTag'))}</span>` : ''}
        </button>
      `
    )
    .join('');

  const scopeToggleHtml = `
    <div class="dev-scope-toggle-row">
      <span class="discover-sources-label">${escapeHTML(t('dev.workspace.discoverScopeLabel'))}</span>
      <div class="dev-scope-switcher" role="group" aria-label="${escapeHTML(t('dev.workspace.discoverScopeAria'))}">
        <button
          type="button"
          class="dev-scope-btn ${!ws.discoverIsDev ? 'active' : ''}"
          data-dev-discover-scope="prod"
        >📦 ${escapeHTML(t('dev.workspace.discoverScopeProd'))}</button>
        <button
          type="button"
          class="dev-scope-btn ${ws.discoverIsDev ? 'active' : ''}"
          data-dev-discover-scope="dev"
          ${activeMgrMeta.supportsDevScope ? '' : 'disabled'}
          title="${escapeHTML(activeMgrMeta.supportsDevScope ? t('dev.workspace.discoverScopeDev') : t('dev.workspace.discoverScopeUnsupportedHint'))}"
        >🛠️ ${escapeHTML(t('dev.workspace.discoverScopeDev'))}</button>
      </div>
      ${
        !activeMgrMeta.supportsDevScope
          ? `<span class="muted">${escapeHTML(t('dev.workspace.discoverScopeUnsupportedHint'))}</span>`
          : ''
      }
    </div>
  `;

  let resultsHtml = '';
  const projectBusy = isProjectActionBusy(project.id) || project.isAvailable === false;

  if (ws.discoverLoading) {
    resultsHtml = `
      <div class="dev-empty">
        <h3>⏳ ${escapeHTML(t('dev.workspace.discoverSearching', { manager: activeMgrMeta.label }))}</h3>
      </div>
    `;
  } else if (ws.discoverError) {
    resultsHtml = `<div class="discover-notice">${escapeHTML(ws.discoverError)}</div>`;
  } else if (!ws.discoverHasSearched) {
    resultsHtml = `
      <div class="dev-empty">
        <h3>${escapeHTML(t('dev.workspace.discoverEmptyTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.workspace.discoverEmptyDesc'))}</p>
      </div>
    `;
  } else if (ws.discoverResults.length === 0) {
    resultsHtml = `
      <div class="dev-empty">
        <h3>${escapeHTML(t('dev.workspace.discoverNoResultsTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.workspace.discoverNoResultsDesc'))}</p>
      </div>
    `;
  } else {
    resultsHtml = `
      <div class="dev-pkg-list">
        ${ws.discoverResults
          .map((pkg) => {
            const pkgName = String(pkg.packageId || pkg.id || pkg.name || '').trim();
            const displayName = String(pkg.name || pkgName).trim();
            const isAlreadyInstalled = installedSet.has(pkgName.toLowerCase());
            const isInstalling = state.devBusyActionKeys.has(
              `${project.id}:install:${activeMgr}:${pkgName.toLowerCase()}`
            );

            return `
              <article class="discover-card">
                <div class="discover-card-main">
                  <div class="discover-card-title">
                    <strong>${escapeHTML(displayName)}</strong>
                    <span class="provider-badge ${escapeHTML(activeMgrMeta.badgeClass)}">${escapeHTML(activeMgrMeta.label)}</span>
                    ${pkg.version ? `<span class="card-chip">v${escapeHTML(pkg.version)}</span>` : ''}
                    ${isAlreadyInstalled ? `<span class="discover-status-badge">${escapeHTML(t('dev.workspace.discoverAlreadyInstalled'))}</span>` : ''}
                  </div>
                  <div class="discover-card-meta">
                    <code>${escapeHTML(pkgName)}</code>
                    ${pkg.publisher ? `<span>${escapeHTML(pkg.publisher)}</span>` : ''}
                  </div>
                  ${pkg.shortDescription ? `<p class="discover-card-desc">${escapeHTML(pkg.shortDescription)}</p>` : ''}
                </div>
                <div class="discover-card-actions">
                  <button
                    type="button"
                    class="btn btn-primary"
                    data-dev-ws-action="install-pkg"
                    data-dev-manager="${escapeHTML(activeMgr)}"
                    data-dev-pkg="${escapeHTML(pkgName)}"
                    ${projectBusy ? 'disabled' : ''}
                  >${isInstalling ? '⏳' : '⬇️'} ${escapeHTML(isInstalling ? t('dev.workspace.discoverInstallingBtn') : t('dev.workspace.discoverInstallBtn'))}</button>
                </div>
              </article>
            `;
          })
          .join('')}
      </div>
    `;
  }

  return `
    <div class="dev-discover-panel">
      <div class="discover-search-row">
        <div class="discover-search-box">
          <input
            type="text"
            id="devDiscoverSearchInput"
            value="${escapeHTML(ws.discoverQuery)}"
            placeholder="${escapeHTML(t('dev.workspace.discoverSearchPlaceholder', { manager: activeMgrMeta.label }))}"
            autocomplete="off"
          >
          <button type="button" id="clearDevDiscoverSearchBtn" class="clear-btn" title="${escapeHTML(t('toolbar.clearSearch'))}" ${ws.discoverQuery ? '' : 'hidden'}>✕</button>
        </div>
        <button type="button" id="btnDevDiscoverSearch" class="btn btn-primary" data-dev-ws-action="discover-search">🔎 ${escapeHTML(t('dev.workspace.discoverSearchBtn'))}</button>
      </div>
      <div class="discover-sources-row">
        <span class="discover-sources-label">${escapeHTML(t('dev.workspace.discoverManagerLabel'))}</span>
        <div class="discover-source-chips">${managerChipsHtml}</div>
      </div>
      ${scopeToggleHtml}
    </div>
    <div id="devDiscoverResultsHost">${resultsHtml}</div>
  `;
}

export function renderDevWorkspace(container, project) {
  const scan = getProjectScan(project.id);
  const ws = state.devWorkspace;
  const managers = Array.isArray(scan?.managers) ? scan.managers : [];
  const activeManagerFilter = getEffectiveManagerFilter(scan);
  const isScanning = state.devScanningProjectIds.has(project.id);

  const updatesCount = Array.isArray(scan?.updates) ? scan.updates.length : 0;
  const installedCount = Array.isArray(scan?.installed) ? scan.installed.length : 0;
  const depsCount = Array.isArray(scan?.dependencies) ? scan.dependencies.length : 0;

  let managerBarHtml = '';
  if (managers.length > 1) {
    const chips = [
      `<button type="button" class="origin-chip ${activeManagerFilter === 'all' ? 'active' : ''}" data-dev-ws-manager="all">${escapeHTML(t('dev.workspace.allManagers'))}</button>`,
      ...managers.map((mgr) => {
        const meta = getDevManagerMeta(mgr);
        return `<button type="button" class="origin-chip ${activeManagerFilter === mgr ? 'active' : ''}" data-dev-ws-manager="${escapeHTML(mgr)}">${escapeHTML(meta.label)}</button>`;
      }),
    ];
    managerBarHtml = `<div class="dev-ws-managers-bar">${chips.join('')}</div>`;
  } else if (managers.length === 1) {
    const meta = getDevManagerMeta(managers[0]);
    managerBarHtml = `<div class="dev-ws-managers-bar"><span class="provider-badge ${escapeHTML(meta.badgeClass)}">${escapeHTML(meta.label)}</span></div>`;
  }

  const warnings = Array.isArray(scan?.warnings) ? scan.warnings.filter(Boolean) : [];
  const warningsHtml =
    warnings.length > 0
      ? `<div class="discover-notice"><strong>${escapeHTML(t('dev.workspace.warningsTitle'))}</strong> ${escapeHTML(warnings.join(' · '))}</div>`
      : '';

  const offlineHtml =
    project.isAvailable === false
      ? `<div class="auth-integrity-banner is-warn">⚠️ ${escapeHTML(t('dev.workspace.offlineBanner', { path: project.path }))}</div>`
      : '';

  const subTabs = [
    {
      id: 'updates',
      icon: '⬆️',
      label: t('dev.workspace.tabUpdates'),
      count: updatesCount,
      highlight: updatesCount > 0,
    },
    { id: 'installed', icon: '📦', label: t('dev.workspace.tabInstalled'), count: installedCount, highlight: false },
    { id: 'dependencies', icon: '🌳', label: t('dev.workspace.tabDependencies'), count: depsCount, highlight: false },
    { id: 'bundles', icon: '🧺', label: t('dev.workspace.tabBundles'), count: null, highlight: false },
    { id: 'discover', icon: '🛍️', label: t('dev.workspace.tabDiscover'), count: null, highlight: false },
  ];

  let activeBodyHtml = '';
  if (ws.activeSubTab === 'updates') activeBodyHtml = renderUpdatesTabHtml(project, scan);
  else if (ws.activeSubTab === 'installed') activeBodyHtml = renderInstalledTabHtml(project, scan);
  else if (ws.activeSubTab === 'dependencies') activeBodyHtml = renderDependenciesTabHtml(scan);
  else if (ws.activeSubTab === 'bundles') activeBodyHtml = renderBundlesPlaceholderTabHtml();
  else activeBodyHtml = renderDiscoverTabHtml(project, scan);

  container.innerHTML = `
    <div class="dev-ws-header">
      <div class="dev-ws-header-top">
        <div class="dev-ws-title-group">
          <button type="button" class="btn btn-ghost btn-xs" data-dev-ws-action="back">← ${escapeHTML(t('dev.workspace.backToProjects'))}</button>
          <div class="dev-ws-identity">
            <span class="dev-project-icon">${escapeHTML(project.icon || '🛠️')}</span>
            <div>
              <h2>${escapeHTML(project.name)}</h2>
              <code class="dev-project-path" title="${escapeHTML(project.path)}">${escapeHTML(shortenProjectPath(project.path, 72))}</code>
            </div>
          </div>
        </div>
        <div class="dev-ws-header-actions">
          <button
            type="button"
            class="btn btn-online"
            data-dev-ws-action="scan-project"
            ${project.isAvailable === false || isScanning ? 'disabled' : ''}
          >🔄 ${escapeHTML(isScanning ? t('dev.workspace.checkingUpdates') : t('dev.workspace.checkUpdates'))}</button>
          <button
            type="button"
            class="btn btn-ghost"
            data-dev-ws-action="open-folder"
            ${project.isAvailable === false ? 'disabled' : ''}
          >📂 ${escapeHTML(t('dev.openFolder'))}</button>
          <button type="button" class="btn btn-ghost" data-dev-ws-action="edit-project">✏️ ${escapeHTML(t('common.edit'))}</button>
        </div>
      </div>
      ${managerBarHtml}
    </div>

    ${offlineHtml}
    ${warningsHtml}

    <nav class="dev-subtabs" role="tablist">
      ${subTabs
        .map((tab) => {
          const isActive = ws.activeSubTab === tab.id;
          return `
            <button
              type="button"
              class="nav-tab dev-subtab-btn ${isActive ? 'active' : ''}"
              role="tab"
              aria-selected="${isActive ? 'true' : 'false'}"
              data-dev-subtab="${escapeHTML(tab.id)}"
            >
              <span>${tab.icon} ${escapeHTML(tab.label)}</span>
              ${
                tab.count !== null
                  ? `<span class="nav-count ${tab.highlight ? 'has-updates' : ''}">${tab.count}</span>`
                  : ''
              }
            </button>
          `;
        })
        .join('')}
    </nav>

    <div class="dev-ws-body">${activeBodyHtml}</div>
  `;
}

async function runDiscoverSearch(project, { onRerender }) {
  const ws = state.devWorkspace;
  const scan = getProjectScan(project.id);
  const manager = getEffectiveDiscoverManager(scan);
  const query = ws.discoverQuery.trim();

  if (query.length < 2) {
    showToast(t('dev.workspace.discoverMinChars'), { type: 'info' });
    return;
  }

  const seq = ++discoverSearchSeq;
  ws.discoverLoading = true;
  ws.discoverHasSearched = true;
  ws.discoverError = '';
  onRerender();

  try {
    const res = await window.electronAPI.devSearchPackages(manager, query, { limit: 25 });
    if (seq !== discoverSearchSeq) return;
    ws.discoverLoading = false;
    if (res?.success) {
      ws.discoverResults = Array.isArray(res.results) ? res.results : [];
      ws.discoverError = '';
    } else if (!res?.canceled) {
      ws.discoverResults = [];
      ws.discoverError = res?.error || t('common.unknownError');
    }
    onRerender();
  } catch (err) {
    if (seq !== discoverSearchSeq) return;
    ws.discoverLoading = false;
    ws.discoverResults = [];
    ws.discoverError = err?.message || t('common.unknownError');
    onRerender();
  }
}

async function handleActionResult(project, res, successMsg, { onRerender, onUpdateNavCounts }) {
  if (res?.canceled) {
    showToast(t('dev.toastActionCanceled'), { type: 'info' });
    return false;
  }
  if (res?.alreadyRunning) {
    showToast(t('dev.toastActionAlreadyRunning'), { type: 'info' });
    return false;
  }
  if (!res?.success) {
    showToast(t('dev.toastActionFailed', { error: res?.error || t('common.unknownError') }), {
      type: 'error',
      duration: 6000,
    });
    return false;
  }

  if (res.scan && (res.scan.success || res.scan.unavailable)) {
    setDevScanResult(project.id, res.scan, { checkedUpdates: Boolean(res.scan.success) });
  }
  onUpdateNavCounts();
  onRerender();
  if (successMsg) {
    showToast(successMsg, { type: 'success' });
  }
  return true;
}

async function runBatchCompatibleUpdate(project, scan, { onRerender, onUpdateNavCounts }) {
  const ws = state.devWorkspace;
  const managerFilter = getEffectiveManagerFilter(scan);
  const filtered = filterDevUpdates(scan?.updates || [], { managerFilter, query: ws.updatesQuery });
  const compatible = getCompatibleDevUpdates(filtered);
  const selectedList =
    ws.selectedUpdateKeys.size > 0
      ? compatible.filter((u) => ws.selectedUpdateKeys.has(buildDevUpdateKey(u)))
      : compatible;

  if (selectedList.length === 0) return;

  const ok = await ensureAdminAuthenticated({
    reason: t('dev.authReasonPkgAction', { project: project.name }),
  });
  if (!ok) return;

  const busyKey = `${project.id}:batch-update`;
  state.devBusyActionKeys.add(busyKey);
  onRerender();

  let updated = 0;
  let failed = 0;
  let latestScan = null;

  try {
    for (let i = 0; i < selectedList.length; i++) {
      const upd = selectedList[i];
      const isLast = i === selectedList.length - 1;
      const res = await window.electronAPI.devUpdatePackage(
        project.id,
        {
          manager: upd.manager,
          packageName: upd.name,
          targetVersion: upd.wanted,
          allowMajor: false,
          isDev: upd.scope === 'dev',
        },
        { checkUpdates: isLast }
      );
      if (res?.canceled) {
        showToast(t('dev.toastActionCanceled'), { type: 'info' });
        break;
      }
      if (res?.success) {
        updated++;
        ws.selectedUpdateKeys.delete(buildDevUpdateKey(upd));
        if (res.scan) latestScan = res.scan;
      } else {
        failed++;
      }
    }

    if (latestScan && (latestScan.success || latestScan.unavailable)) {
      setDevScanResult(project.id, latestScan, { checkedUpdates: Boolean(latestScan.success) });
    }
    onUpdateNavCounts();

    if (updated > 0 && failed === 0) {
      showToast(t('dev.toastBatchUpdated', { count: updated }), { type: 'success' });
    } else if (updated > 0 || failed > 0) {
      showToast(t('dev.toastBatchPartial', { updated, failed }), { type: 'warn', duration: 6000 });
    }
  } finally {
    state.devBusyActionKeys.delete(busyKey);
    onRerender();
  }
}

export function handleDevWorkspaceInput(e) {
  const project = getSelectedDevProject();
  if (!project) return;
  const scan = getProjectScan(project.id);
  const ws = state.devWorkspace;
  const target = e.target;
  if (!(target instanceof HTMLInputElement)) return;

  const listHost = document.getElementById('devWsListHost');

  if (target.id === 'devUpdatesSearchInput') {
    ws.updatesQuery = target.value;
    const clr = document.getElementById('clearDevUpdatesSearchBtn');
    if (clr) clr.hidden = ws.updatesQuery.length === 0;
    if (listHost) listHost.innerHTML = renderUpdatesListHtml(project, scan);
  } else if (target.id === 'devInstalledSearchInput') {
    ws.installedQuery = target.value;
    const clr = document.getElementById('clearDevInstalledSearchBtn');
    if (clr) clr.hidden = ws.installedQuery.length === 0;
    if (listHost) listHost.innerHTML = renderInstalledListHtml(project, scan);
    const countEl = document.getElementById('devInstalledCountEl');
    if (countEl) {
      const allInstalled = Array.isArray(scan?.installed) ? scan.installed : [];
      const filtered = filterDevInstalled(allInstalled, {
        managerFilter: getEffectiveManagerFilter(scan),
        scopeFilter: ws.installedScopeFilter,
        query: ws.installedQuery,
      });
      countEl.textContent = t('dev.workspace.countShown', { shown: filtered.length, total: allInstalled.length });
    }
  } else if (target.id === 'devDepsSearchInput') {
    ws.depsQuery = target.value;
    ws.depsRenderLimit = 150;
    const clr = document.getElementById('clearDevDepsSearchBtn');
    if (clr) clr.hidden = ws.depsQuery.length === 0;
    if (listHost) listHost.innerHTML = renderDependenciesListHtml(scan);
    const countEl = document.getElementById('devDepsCountEl');
    if (countEl) {
      const allDeps = Array.isArray(scan?.dependencies) ? scan.dependencies : [];
      const filtered = filterDevDependencies(allDeps, {
        managerFilter: getEffectiveManagerFilter(scan),
        directFilter: ws.depsDirectFilter,
        query: ws.depsQuery,
      });
      countEl.textContent = t('dev.workspace.countShown', { shown: filtered.length, total: allDeps.length });
    }
  } else if (target.id === 'devDiscoverSearchInput') {
    ws.discoverQuery = target.value;
    const clr = document.getElementById('clearDevDiscoverSearchBtn');
    if (clr) clr.hidden = ws.discoverQuery.length === 0;
  }
}

export function handleDevWorkspaceChange(e) {
  const project = getSelectedDevProject();
  if (!project) return;
  const scan = getProjectScan(project.id);
  const ws = state.devWorkspace;
  const target = e.target;
  if (!(target instanceof HTMLInputElement)) return;

  if (target.id === 'chkDevSelectAllUpdates') {
    const filtered = filterDevUpdates(scan?.updates || [], {
      managerFilter: getEffectiveManagerFilter(scan),
      query: ws.updatesQuery,
    });
    const compatible = getCompatibleDevUpdates(filtered);
    if (target.checked) {
      for (const u of compatible) ws.selectedUpdateKeys.add(buildDevUpdateKey(u));
    } else {
      ws.selectedUpdateKeys.clear();
    }
    const listHost = document.getElementById('devWsListHost');
    if (listHost) listHost.innerHTML = renderUpdatesListHtml(project, scan);
    return;
  }

  if (target.classList.contains('dev-update-checkbox')) {
    const key = target.dataset.devUpdateKey || '';
    if (!key) return;
    if (target.checked) ws.selectedUpdateKeys.add(key);
    else ws.selectedUpdateKeys.delete(key);
    const listHost = document.getElementById('devWsListHost');
    if (listHost) listHost.innerHTML = renderUpdatesListHtml(project, scan);
  }
}

export function handleDevWorkspaceKeydown(e, callbacks) {
  const project = getSelectedDevProject();
  if (!project) return;
  if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.id === 'devDiscoverSearchInput') {
    e.preventDefault();
    void runDiscoverSearch(project, callbacks);
  }
}

export async function handleDevWorkspaceClick(e, callbacks) {
  const project = getSelectedDevProject();
  if (!project) return;
  const scan = getProjectScan(project.id);
  const ws = state.devWorkspace;
  const target = e.target;
  if (!(target instanceof Element)) return;

  if (target.id === 'clearDevUpdatesSearchBtn') {
    ws.updatesQuery = '';
    callbacks.onRerender();
    document.getElementById('devUpdatesSearchInput')?.focus();
    return;
  }
  if (target.id === 'clearDevInstalledSearchBtn') {
    ws.installedQuery = '';
    callbacks.onRerender();
    document.getElementById('devInstalledSearchInput')?.focus();
    return;
  }
  if (target.id === 'clearDevDepsSearchBtn') {
    ws.depsQuery = '';
    ws.depsRenderLimit = 150;
    callbacks.onRerender();
    document.getElementById('devDepsSearchInput')?.focus();
    return;
  }
  if (target.id === 'clearDevDiscoverSearchBtn') {
    ws.discoverQuery = '';
    ws.discoverHasSearched = false;
    ws.discoverResults = [];
    ws.discoverError = '';
    callbacks.onRerender();
    document.getElementById('devDiscoverSearchInput')?.focus();
    return;
  }

  const mgrChip = target.closest('[data-dev-ws-manager]');
  if (mgrChip instanceof HTMLElement) {
    ws.managerFilter = mgrChip.dataset.devWsManager || 'all';
    callbacks.onRerender();
    return;
  }

  const subTabBtn = target.closest('[data-dev-subtab]');
  if (subTabBtn instanceof HTMLElement) {
    ws.activeSubTab = subTabBtn.dataset.devSubtab || 'updates';
    callbacks.onRerender();
    return;
  }

  const scopeChip = target.closest('[data-dev-installed-scope]');
  if (scopeChip instanceof HTMLElement) {
    ws.installedScopeFilter = scopeChip.dataset.devInstalledScope || 'all';
    callbacks.onRerender();
    return;
  }

  const directChip = target.closest('[data-dev-deps-direct]');
  if (directChip instanceof HTMLElement) {
    ws.depsDirectFilter = directChip.dataset.devDepsDirect || 'all';
    ws.depsRenderLimit = 150;
    callbacks.onRerender();
    return;
  }

  const discoverMgrBtn = target.closest('[data-dev-discover-mgr]');
  if (discoverMgrBtn instanceof HTMLElement) {
    const nextMgr = discoverMgrBtn.dataset.devDiscoverMgr || '';
    if (nextMgr && nextMgr !== ws.discoverManager) {
      ws.discoverManager = nextMgr;
      if (!getDevManagerMeta(nextMgr).supportsDevScope) {
        ws.discoverIsDev = false;
      }
      ws.discoverResults = [];
      ws.discoverHasSearched = false;
      ws.discoverError = '';
      callbacks.onRerender();
      if (ws.discoverQuery.trim().length >= 2) {
        void runDiscoverSearch(project, callbacks);
      }
    }
    return;
  }

  const discoverScopeBtn = target.closest('[data-dev-discover-scope]');
  if (discoverScopeBtn instanceof HTMLButtonElement && !discoverScopeBtn.disabled) {
    ws.discoverIsDev = discoverScopeBtn.dataset.devDiscoverScope === 'dev';
    callbacks.onRerender();
    return;
  }

  const urlBtn = target.closest('[data-dev-open-url]');
  if (urlBtn instanceof HTMLElement) {
    const url = urlBtn.dataset.devOpenUrl || '';
    if (url) window.electronAPI.openUrl(url);
    return;
  }

  const actionBtn = target.closest('[data-dev-ws-action]');
  if (!(actionBtn instanceof HTMLElement)) return;
  const action = actionBtn.dataset.devWsAction;

  if (action === 'back') {
    callbacks.onBack();
  } else if (action === 'open-folder') {
    window.electronAPI.openPath(project.path);
  } else if (action === 'edit-project') {
    await callbacks.onEditProject(project);
  } else if (action === 'scan-project') {
    await callbacks.onScanProject(project.id, { useJob: true, checkUpdates: true });
  } else if (action === 'show-more-deps') {
    ws.depsRenderLimit = (ws.depsRenderLimit || 150) + 150;
    callbacks.onRerender();
  } else if (action === 'discover-search') {
    await runDiscoverSearch(project, callbacks);
  } else if (action === 'batch-update-compatible') {
    await runBatchCompatibleUpdate(project, scan, callbacks);
  } else if (action === 'update-pkg') {
    const manager = actionBtn.dataset.devManager || '';
    const packageName = actionBtn.dataset.devPkg || '';
    const targetVersion = actionBtn.dataset.devTargetVer || '';
    const allowMajor = actionBtn.dataset.devMajor === 'true';
    const isDev = actionBtn.dataset.devScope === 'dev';
    if (!manager || !packageName) return;

    const ok = await ensureAdminAuthenticated({
      reason: t('dev.authReasonPkgAction', { project: project.name }),
    });
    if (!ok) return;

    const key = buildDevUpdateKey({ manager, name: packageName });
    const busyKey = `${project.id}:update:${key}`;
    state.devBusyActionKeys.add(busyKey);
    callbacks.onRerender();
    try {
      const res = await window.electronAPI.devUpdatePackage(project.id, {
        manager,
        packageName,
        targetVersion,
        allowMajor,
        isDev,
      });
      await handleActionResult(
        project,
        res,
        t('dev.toastPkgUpdated', { pkg: packageName, project: project.name, manager }),
        callbacks
      );
    } finally {
      state.devBusyActionKeys.delete(busyKey);
      callbacks.onRerender();
    }
  } else if (action === 'toggle-scope') {
    const manager = actionBtn.dataset.devManager || '';
    const packageName = actionBtn.dataset.devPkg || '';
    const targetScope = actionBtn.dataset.devTargetScope === 'dev' ? 'dev' : 'prod';
    const currentRange = actionBtn.dataset.devRange || '';
    if (!manager || !packageName) return;

    const ok = await ensureAdminAuthenticated({
      reason: t('dev.authReasonPkgAction', { project: project.name }),
    });
    if (!ok) return;

    const busyKey = `${project.id}:scope:${manager}:${packageName}`;
    state.devBusyActionKeys.add(busyKey);
    callbacks.onRerender();
    try {
      const res = await window.electronAPI.devToggleScope(project.id, {
        manager,
        packageName,
        targetScope,
        currentRange,
      });
      await handleActionResult(
        project,
        res,
        t('dev.toastScopeChanged', {
          pkg: packageName,
          scope: targetScope === 'dev' ? t('dev.workspace.scopeBadgeDev') : t('dev.workspace.scopeBadgeProd'),
        }),
        callbacks
      );
    } finally {
      state.devBusyActionKeys.delete(busyKey);
      callbacks.onRerender();
    }
  } else if (action === 'uninstall-pkg' && actionBtn instanceof HTMLButtonElement) {
    if (actionBtn.dataset.armed !== 'true') {
      actionBtn.dataset.armed = 'true';
      actionBtn.dataset.origText = actionBtn.textContent || '';
      actionBtn.textContent = `⚠️ ${t('common.confirmRemoveArmed')}`;
      setTimeout(() => {
        if (actionBtn.isConnected && actionBtn.dataset.armed === 'true') {
          actionBtn.dataset.armed = 'false';
          actionBtn.textContent = actionBtn.dataset.origText || `🗑️ ${t('common.remove')}`;
        }
      }, 4000);
      return;
    }

    actionBtn.dataset.armed = 'false';
    const manager = actionBtn.dataset.devManager || '';
    const packageName = actionBtn.dataset.devPkg || '';
    const isDev = actionBtn.dataset.devScope === 'dev';
    if (!manager || !packageName) return;

    const ok = await ensureAdminAuthenticated({
      reason: t('dev.authReasonPkgAction', { project: project.name }),
    });
    if (!ok) return;

    const busyKey = `${project.id}:uninstall:${manager}:${packageName}`;
    state.devBusyActionKeys.add(busyKey);
    callbacks.onRerender();
    try {
      const res = await window.electronAPI.devUninstallPackage(project.id, {
        manager,
        packageName,
        isDev,
      });
      await handleActionResult(
        project,
        res,
        t('dev.toastPkgRemoved', { pkg: packageName, project: project.name }),
        callbacks
      );
    } finally {
      state.devBusyActionKeys.delete(busyKey);
      callbacks.onRerender();
    }
  } else if (action === 'install-pkg') {
    const manager = actionBtn.dataset.devManager || '';
    const packageName = actionBtn.dataset.devPkg || '';
    if (!manager || !packageName) return;

    const ok = await ensureAdminAuthenticated({
      reason: t('dev.authReasonPkgAction', { project: project.name }),
    });
    if (!ok) return;

    const busyKey = `${project.id}:install:${manager}:${packageName.toLowerCase()}`;
    state.devBusyActionKeys.add(busyKey);
    callbacks.onRerender();
    try {
      const res = await window.electronAPI.devInstallPackage(project.id, {
        manager,
        packageName,
        isDev: Boolean(ws.discoverIsDev && getDevManagerMeta(manager).supportsDevScope),
      });
      await handleActionResult(
        project,
        res,
        t('dev.toastPkgInstalled', { pkg: packageName, project: project.name, manager }),
        callbacks
      );
    } finally {
      state.devBusyActionKeys.delete(busyKey);
      callbacks.onRerender();
    }
  }
}
