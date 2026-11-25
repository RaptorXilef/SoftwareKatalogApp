import {
  AUDIT_SUPPORTED_MANAGERS,
  buildDevBundleDraftFromProject,
  evaluateDevBundleForProject,
  filterDevBundlesForProject,
} from '../../shared/dev-bundles-logic.js';
import {
  buildDevDependencyGraph,
  buildDevDependencyTree,
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
import { openDevAuditModal, openDevBundleEditorModal, openDevBundleRunnerModal } from '../modals/index.js';
import { ensureAdminAuthenticated } from '../modals/login-modal.js';
import { getSelectedDevProject, refreshDevBundles, setDevScanResult, state } from '../state.js';
import { t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';
import { showToast } from './toast.js';

let discoverSearchSeq = 0;
let suppressNextGraphClick = false;

function getSemverTierOptions(upd) {
  const opts = upd?.semverOptions;
  if (!opts || typeof opts !== 'object') return [];
  const tiers = [];
  if (opts.patch) {
    tiers.push({
      tier: 'patch',
      version: opts.patch,
      isMajor: false,
      label: t('dev.workspace.tierPatch', { version: opts.patch }),
    });
  }
  if (opts.minor) {
    tiers.push({
      tier: 'minor',
      version: opts.minor,
      isMajor: false,
      label: t('dev.workspace.tierMinor', { version: opts.minor }),
    });
  }
  if (opts.major) {
    tiers.push({
      tier: 'major',
      version: opts.major,
      isMajor: true,
      label: t('dev.workspace.tierMajor', { version: opts.major }),
    });
  }
  return tiers;
}

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
      const tierOptions = getSemverTierOptions(upd);
      const defaultTier =
        tierOptions.find((o) => o.tier === 'minor')?.tier ||
        tierOptions.find((o) => o.tier === 'patch')?.tier ||
        tierOptions[0]?.tier ||
        '';
      const activeTierId = ws.selectedUpdateTierByKey?.[key] || defaultTier;
      const chosenTier = tierOptions.find((o) => o.tier === activeTierId) || tierOptions[0] || null;

      let actionsHtml = '';
      if (tierOptions.length > 0 && chosenTier) {
        actionsHtml = `
          <div class="dev-tier-controls">
            <select
              class="dev-tier-select"
              data-dev-tier-select="${escapeHTML(key)}"
              aria-label="${escapeHTML(t('dev.workspace.tierSelectLabel'))}"
              ${projectBusy ? 'disabled' : ''}
            >
              ${tierOptions
                .map(
                  (opt) =>
                    `<option value="${escapeHTML(opt.tier)}" ${opt.tier === chosenTier.tier ? 'selected' : ''}>${escapeHTML(opt.label)}</option>`
                )
                .join('')}
            </select>
            <button
              type="button"
              class="btn ${chosenTier.isMajor ? 'btn-archive' : 'btn-primary'} btn-xs"
              data-dev-ws-action="update-pkg"
              data-dev-manager="${escapeHTML(upd.manager)}"
              data-dev-pkg="${escapeHTML(upd.name)}"
              data-dev-target-ver="${escapeHTML(chosenTier.version)}"
              data-dev-scope="${escapeHTML(upd.scope || 'prod')}"
              data-dev-major="${chosenTier.isMajor ? 'true' : 'false'}"
              data-dev-exact-target="true"
              ${projectBusy ? 'disabled' : ''}
            >${isItemBusy ? '⏳' : chosenTier.isMajor ? '⚠️' : '⬆️'} ${escapeHTML(t('dev.workspace.btnUpdateVersion', { version: chosenTier.version }))}</button>
          </div>
        `;
      } else {
        actionsHtml = `
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
        `;
      }

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

          <div class="dev-pkg-actions">${actionsHtml}</div>
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

function renderDependenciesListHtml(scan, viewMode = 'list') {
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
  const highlightKey = String(ws.depsHighlightPkg || '')
    .trim()
    .toLowerCase();

  const rowsHtml = visible
    .map((dep) => {
      const mgrMeta = getDevManagerMeta(dep.manager);
      const isHighlighted = highlightKey && `${dep.manager}:${dep.name}`.toLowerCase() === highlightKey;
      const reqBy = Array.isArray(dep.requiredBy) ? dep.requiredBy : [];
      const reqs = Array.isArray(dep.requires) ? dep.requires : [];

      let relationHtml = '';
      if (viewMode === 'requires') {
        if (reqs.length > 0) {
          const shown = reqs.slice(0, 12);
          const hiddenCount = Math.max(0, reqs.length - shown.length);
          const chips = shown
            .map(
              (r) =>
                `<button type="button" class="dev-req-chip is-clickable" data-dev-deps-jump="${escapeHTML(r)}" data-dev-deps-manager="${escapeHTML(dep.manager)}" title="${escapeHTML(t('dev.workspace.depsJumpTitle', { name: r }))}">${escapeHTML(r)}</button>`
            )
            .join('');
          const more =
            hiddenCount > 0
              ? `<span class="dev-req-more" title="${escapeHTML(reqs.join(', '))}">${escapeHTML(t('dev.workspace.requiredByMore', { count: hiddenCount }))}</span>`
              : '';
          relationHtml = `<div class="dev-dep-required-by"><span class="muted">${escapeHTML(t('dev.workspace.requiresLabel'))}:</span> ${chips}${more}</div>`;
        } else {
          relationHtml = `<div class="dev-dep-required-by"><span class="muted">${escapeHTML(t('dev.workspace.noOutgoingDeps'))}</span></div>`;
        }
      } else {
        const shownReqs = reqBy.slice(0, 4);
        const hiddenReqCount = Math.max(0, reqBy.length - shownReqs.length);
        if (reqBy.length > 0) {
          const chips = shownReqs.map((r) => `<code class="dev-req-chip">${escapeHTML(r)}</code>`).join('');
          const more =
            hiddenReqCount > 0
              ? `<span class="dev-req-more" title="${escapeHTML(reqBy.join(', '))}">${escapeHTML(t('dev.workspace.requiredByMore', { count: hiddenReqCount }))}</span>`
              : '';
          relationHtml = `<div class="dev-dep-required-by"><span class="muted">${escapeHTML(t('dev.workspace.requiredByLabel'))}:</span> ${chips}${more}</div>`;
        } else if (dep.direct) {
          relationHtml = `<div class="dev-dep-required-by"><span class="muted">${escapeHTML(t('dev.workspace.directProjectDep'))}</span></div>`;
        }
      }

      return `
        <article class="dev-pkg-row is-dependency ${isHighlighted ? 'is-jump-highlighted' : ''}" data-dep-row-key="${escapeHTML(`${dep.manager}:${dep.name}`.toLowerCase())}">
          <div class="dev-pkg-main">
            <div class="dev-pkg-title-row">
              <strong class="dev-pkg-name">${escapeHTML(dep.name)}</strong>
              ${dep.version ? `<span class="card-chip">v${escapeHTML(dep.version)}</span>` : ''}
              <span class="provider-badge ${escapeHTML(mgrMeta.badgeClass)}">${escapeHTML(mgrMeta.label)}</span>
              <span class="dev-direct-badge ${dep.direct ? 'is-direct' : 'is-transitive'}">${escapeHTML(dep.direct ? t('dev.workspace.badgeDirect') : t('dev.workspace.badgeTransitive'))}</span>
              ${renderScopeBadgeHtml(dep.scope)}
              ${dep.license ? `<span class="dev-license-badge" title="${escapeHTML(t('dev.workspace.licenseLabel'))}">${escapeHTML(dep.license)}</span>` : ''}
            </div>
            ${relationHtml}
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

function collectAllTreeExpandKeys(nodes, acc = []) {
  for (const node of nodes) {
    if (Array.isArray(node.children) && node.children.length > 0) {
      acc.push(node.pathKey);
      collectAllTreeExpandKeys(node.children, acc);
    }
  }
  return acc;
}

function renderDependenciesTreeHtml(project, scan) {
  const ws = state.devWorkspace;
  const managerFilter = getEffectiveManagerFilter(scan);
  const allDeps = Array.isArray(scan?.dependencies) ? scan.dependencies : [];

  if (allDeps.length === 0) {
    return `
      <div class="dev-empty">
        <h3>${escapeHTML(t('dev.workspace.depsEmptyTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.workspace.depsEmptyDesc'))}</p>
      </div>
    `;
  }

  const tree = buildDevDependencyTree(allDeps, {
    managerFilter,
    directFilter: ws.depsDirectFilter,
    query: ws.depsQuery,
  });

  if (tree.roots.length === 0) {
    return `<div class="dev-empty"><p class="muted">${escapeHTML(t('dev.workspace.depsNoMatches'))}</p></div>`;
  }

  const forceExpandForSearch = Boolean(String(ws.depsQuery || '').trim());
  const rows = [];

  const renderNodes = (nodeList, ancestorPrefix, isRootLevel) => {
    nodeList.forEach((node, idx) => {
      const isLast = idx === nodeList.length - 1;
      const connector = isRootLevel ? (isLast ? '└── ' : '├── ') : isLast ? '└── ' : '├── ';
      const nextAncestorPrefix = `${ancestorPrefix}${isLast ? '    ' : '│   '}`;
      const hasChildren = Array.isArray(node.children) && node.children.length > 0;
      const isExpanded = hasChildren && (forceExpandForSearch || ws.depsTreeExpanded.has(node.pathKey));
      const mgrMeta = getDevManagerMeta(node.manager);

      rows.push(`
        <div class="dev-tree-row">
          <span class="dev-tree-prefix">${escapeHTML(`${ancestorPrefix}${connector}`)}</span>
          ${
            hasChildren
              ? `<button type="button" class="dev-tree-toggle" data-dev-tree-toggle="${escapeHTML(node.pathKey)}" aria-expanded="${isExpanded ? 'true' : 'false'}">${isExpanded ? '-' : '+'}</button>`
              : '<span class="dev-tree-leaf-spacer"></span>'
          }
          <span class="dev-tree-pkg-name ${node.matched ? 'is-match' : ''}">${escapeHTML(node.name)}</span>
          ${node.version ? `<span class="dev-tree-ver">v${escapeHTML(node.version)}</span>` : ''}
          <span class="provider-badge ${escapeHTML(mgrMeta.badgeClass)}">${escapeHTML(mgrMeta.label)}</span>
          ${node.cyclic ? `<span class="dev-tree-cyclic">↻ (${escapeHTML(t('dev.workspace.cyclicLabel'))})</span>` : ''}
          ${node.missing ? `<span class="dev-tree-missing">(${escapeHTML(t('dev.workspace.treeNotInLockfile'))})</span>` : ''}
        </div>
      `);

      if (hasChildren && isExpanded) {
        renderNodes(node.children, nextAncestorPrefix, false);
      }
    });
  };

  renderNodes(tree.roots, '', true);

  return `
    <div class="dev-tree-toolbar">
      <div class="dev-tree-actions">
        <button type="button" class="btn btn-ghost btn-xs" data-dev-ws-action="deps-tree-expand-all">
          📂 ${escapeHTML(t('dev.workspace.treeExpandAll'))}
        </button>
        <button type="button" class="btn btn-ghost btn-xs" data-dev-ws-action="deps-tree-collapse-all">
          📁 ${escapeHTML(t('dev.workspace.treeCollapseAll'))}
        </button>
      </div>
      <span class="muted">${escapeHTML(project.name)}${tree.truncated ? ` · ${escapeHTML(t('dev.workspace.treeTruncatedHint'))}` : ''}</span>
    </div>
    <div class="dev-tree-box" role="tree">${rows.join('')}</div>
  `;
}

function applyGraphTransformDom() {
  const g = document.getElementById('devGraphTransformGroup');
  if (!g) return;
  const tr = state.devWorkspace.depsGraphTransform || { x: 0, y: 0, scale: 1 };
  g.setAttribute('transform', `translate(${tr.x} ${tr.y}) scale(${tr.scale})`);
}

function applyGraphNodeHighlightDom(activeId) {
  const svg = document.getElementById('devGraphSvg');
  if (!svg) return;
  const cleanId = String(activeId || '').trim();
  const pinnedId = state.devWorkspace.depsGraphSelectedId || '';
  const related = new Set();

  if (cleanId) {
    related.add(cleanId);
    for (const edge of svg.querySelectorAll('.dev-graph-edge')) {
      const from = edge.getAttribute('data-from') || '';
      const to = edge.getAttribute('data-to') || '';
      if (from === cleanId) related.add(to);
      if (to === cleanId) related.add(from);
    }
  }

  for (const edge of svg.querySelectorAll('.dev-graph-edge')) {
    const from = edge.getAttribute('data-from') || '';
    const to = edge.getAttribute('data-to') || '';
    const active = Boolean(cleanId && (from === cleanId || to === cleanId));
    edge.classList.toggle('is-highlighted', active);
    edge.classList.toggle('is-dimmed', Boolean(cleanId && !active));
    edge.setAttribute('marker-end', active ? 'url(#devGraphArrowActive)' : 'url(#devGraphArrow)');
  }

  let activeNodeEl = null;
  for (const nodeEl of svg.querySelectorAll('.dev-graph-node')) {
    const nid = nodeEl.getAttribute('data-graph-node-id') || '';
    if (nid === cleanId) activeNodeEl = nodeEl;
    nodeEl.classList.toggle('is-selected', Boolean(pinnedId && nid === pinnedId));
    nodeEl.classList.toggle('is-highlighted', Boolean(cleanId && related.has(nid)));
    nodeEl.classList.toggle('is-dimmed', Boolean(cleanId && !related.has(nid)));
  }

  const infoBar = document.getElementById('devGraphInfoBar');
  if (infoBar) {
    if (activeNodeEl) {
      infoBar.innerHTML = buildGraphNodeInfoHtml({
        id: cleanId,
        kind: activeNodeEl.getAttribute('data-graph-node-kind') || 'package',
        name: activeNodeEl.getAttribute('data-graph-node-name') || cleanId,
        version: activeNodeEl.getAttribute('data-graph-node-ver') || '',
        manager: activeNodeEl.getAttribute('data-graph-node-mgr') || '',
        license: activeNodeEl.getAttribute('data-graph-node-lic') || '',
        requiredBy: Array(Number(activeNodeEl.getAttribute('data-graph-reqby-count') || 0)),
        requires: Array(Number(activeNodeEl.getAttribute('data-graph-req-count') || 0)),
      });
    } else {
      infoBar.innerHTML = buildGraphNodeInfoHtml(null);
    }
  }
}

export function setupDevWorkspaceGraphInteractions(container) {
  if (!(container instanceof HTMLElement)) return;
  let dragState = null;

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !(e.target instanceof Element)) return;
    const viewport = e.target.closest('.dev-graph-viewport');
    if (!(viewport instanceof HTMLElement)) return;
    const tr = state.devWorkspace.depsGraphTransform || { x: 0, y: 0, scale: 1 };
    dragState = {
      viewport,
      startX: e.clientX,
      startY: e.clientY,
      origX: tr.x,
      origY: tr.y,
      moved: false,
    };
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) > 3) {
      dragState.moved = true;
      dragState.viewport.classList.add('is-panning');
    }
    if (!dragState.moved) return;
    const svg = document.getElementById('devGraphSvg');
    let ratio = 1;
    if (svg instanceof SVGSVGElement) {
      const rect = svg.getBoundingClientRect();
      const vb = svg.viewBox?.baseVal;
      if (vb?.width && rect.width) {
        ratio = Math.max(vb.width / rect.width, vb.height / rect.height);
      }
    }
    const prev = state.devWorkspace.depsGraphTransform || { x: 0, y: 0, scale: 1 };
    state.devWorkspace.depsGraphTransform = {
      ...prev,
      x: Math.round(dragState.origX + dx * ratio),
      y: Math.round(dragState.origY + dy * ratio),
    };
    applyGraphTransformDom();
  });

  window.addEventListener('mouseup', () => {
    if (!dragState) return;
    dragState.viewport.classList.remove('is-panning');
    if (dragState.moved) {
      suppressNextGraphClick = true;
      setTimeout(() => {
        suppressNextGraphClick = false;
      }, 0);
    }
    dragState = null;
  });

  container.addEventListener(
    'wheel',
    (e) => {
      if (!(e.target instanceof Element)) return;
      const viewport = e.target.closest('.dev-graph-viewport');
      if (!(viewport instanceof HTMLElement)) return;
      e.preventDefault();
      const prev = state.devWorkspace.depsGraphTransform || { x: 0, y: 0, scale: 1 };
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      const nextScale = Math.max(0.25, Math.min(3, Number((prev.scale * factor).toFixed(3))));
      state.devWorkspace.depsGraphTransform = { ...prev, scale: nextScale };
      applyGraphTransformDom();
    },
    { passive: false }
  );

  container.addEventListener('mouseover', (e) => {
    if (!(e.target instanceof Element)) return;
    const nodeEl = e.target.closest('[data-graph-node-id]');
    if (!nodeEl || !e.target.closest('.dev-graph-viewport')) return;
    const nid = nodeEl.getAttribute('data-graph-node-id') || '';
    if (nid) applyGraphNodeHighlightDom(nid);
  });

  container.addEventListener('mouseout', (e) => {
    if (!(e.target instanceof Element)) return;
    const nodeEl = e.target.closest('[data-graph-node-id]');
    if (!nodeEl || !e.target.closest('.dev-graph-viewport')) return;
    const related = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-graph-node-id]') : null;
    if (related === nodeEl) return;
    applyGraphNodeHighlightDom(state.devWorkspace.depsGraphSelectedId || '');
  });
}

function buildGraphNodeInfoHtml(node) {
  if (!node) {
    return `<span class="muted">${escapeHTML(t('dev.workspace.graphInfoHint'))}</span>`;
  }
  const mgrMeta = node.manager ? getDevManagerMeta(node.manager) : null;
  const reqByCount = Array.isArray(node.requiredBy) ? node.requiredBy.length : 0;
  const reqCount = Array.isArray(node.requires) ? node.requires.length : 0;
  return `
    <div class="dev-graph-info-meta">
      <strong>${escapeHTML(node.name)}</strong>
      ${node.version ? `<span class="card-chip">v${escapeHTML(node.version)}</span>` : ''}
      ${mgrMeta ? `<span class="provider-badge ${escapeHTML(mgrMeta.badgeClass)}">${escapeHTML(mgrMeta.label)}</span>` : ''}
      ${node.license ? `<span class="dev-license-badge">${escapeHTML(node.license)}</span>` : ''}
    </div>
    <span class="muted">
      ${
        node.kind === 'project'
          ? escapeHTML(t('dev.workspace.graphProjectRoot'))
          : escapeHTML(t('dev.workspace.graphNodeRelations', { requiredBy: reqByCount, requires: reqCount }))
      }
    </span>
  `;
}

function truncateGraphText(text, maxLen = 22) {
  const s = String(text || '');
  return s.length > maxLen ? `${s.slice(0, maxLen - 3)}...` : s;
}

function renderDependenciesGraphHtml(project, scan) {
  const ws = state.devWorkspace;
  const managerFilter = getEffectiveManagerFilter(scan);
  const allDeps = Array.isArray(scan?.dependencies) ? scan.dependencies : [];

  if (allDeps.length === 0) {
    return `
      <div class="dev-empty">
        <h3>${escapeHTML(t('dev.workspace.depsEmptyTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.workspace.depsEmptyDesc'))}</p>
      </div>
    `;
  }

  const graph = buildDevDependencyGraph(allDeps, {
    projectName: project.name,
    managerFilter,
    directFilter: ws.depsDirectFilter,
    query: ws.depsQuery,
    focusNodeKey: ws.depsGraphFocusKey,
    maxNodes: 80,
  });

  if (graph.nodes.length <= 1) {
    return `<div class="dev-empty"><p class="muted">${escapeHTML(t('dev.workspace.depsNoMatches'))}</p></div>`;
  }

  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const selectedId = ws.depsGraphSelectedId && nodeMap.has(ws.depsGraphSelectedId) ? ws.depsGraphSelectedId : '';
  const selectedNode = selectedId ? nodeMap.get(selectedId) : null;

  const relatedIds = new Set();
  if (selectedId) {
    relatedIds.add(selectedId);
    for (const edge of graph.edges) {
      if (edge.from === selectedId) relatedIds.add(edge.to);
      if (edge.to === selectedId) relatedIds.add(edge.from);
    }
  }

  const tr = ws.depsGraphTransform || { x: 0, y: 0, scale: 1 };
  const edgesSvg = graph.edges
    .map((edge) => {
      const fromNode = nodeMap.get(edge.from);
      const toNode = nodeMap.get(edge.to);
      if (!fromNode || !toNode) return '';
      const x1 = fromNode.x + fromNode.w;
      const y1 = fromNode.y + Math.round(fromNode.h / 2);
      const x2 = toNode.x;
      const y2 = toNode.y + Math.round(toNode.h / 2);
      const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
      const pathD = edge.cyclic
        ? `M ${x1} ${y1} C ${x1 + 50} ${y1 - 60}, ${x2 - 50} ${y2 - 60}, ${x2} ${y2}`
        : `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;

      const isEdgeActive = selectedId && (edge.from === selectedId || edge.to === selectedId);
      const cls = ['dev-graph-edge', edge.cyclic ? 'is-cyclic' : ''];
      if (selectedId) cls.push(isEdgeActive ? 'is-highlighted' : 'is-dimmed');

      return `<path class="${cls.filter(Boolean).join(' ')}" data-from="${escapeHTML(edge.from)}" data-to="${escapeHTML(edge.to)}" d="${pathD}" marker-end="${isEdgeActive ? 'url(#devGraphArrowActive)' : 'url(#devGraphArrow)'}"></path>`;
    })
    .join('');

  const nodesSvg = graph.nodes
    .map((node) => {
      const cls = ['dev-graph-node', `is-${node.kind}`, node.direct ? 'is-direct' : ''];
      if (selectedId) {
        if (node.id === selectedId) cls.push('is-selected', 'is-highlighted');
        else if (relatedIds.has(node.id)) cls.push('is-highlighted');
        else cls.push('is-dimmed');
      }
      const subtitle =
        node.kind === 'project'
          ? t('dev.workspace.graphProjectRoot')
          : `${node.version ? `v${node.version}` : ''}${node.manager ? ` · ${node.manager}` : ''}`;

      return `
        <g
          class="${cls.filter(Boolean).join(' ')}"
          data-graph-node-id="${escapeHTML(node.id)}"
          data-graph-node-name="${escapeHTML(node.name)}"
          data-graph-node-ver="${escapeHTML(node.version || '')}"
          data-graph-node-mgr="${escapeHTML(node.manager || '')}"
          data-graph-node-lic="${escapeHTML(node.license || '')}"
          data-graph-node-kind="${escapeHTML(node.kind)}"
          data-graph-reqby-count="${String(node.requiredBy.length)}"
          data-graph-req-count="${String(node.requires.length)}"
          transform="translate(${node.x}, ${node.y})"
        >
          <title>${escapeHTML(`${node.name}${node.version ? ` v${node.version}` : ''}${node.license ? ` (${node.license})` : ''}`)}</title>
          <rect width="${node.w}" height="${node.h}" rx="8"></rect>
          <text class="dev-graph-node-title" x="10" y="20">${escapeHTML(truncateGraphText(node.name, 22))}</text>
          <text class="dev-graph-node-sub" x="10" y="36">${escapeHTML(truncateGraphText(subtitle, 26))}</text>
        </g>
      `;
    })
    .join('');

  const focusOptionsHtml = [
    `<option value="">${escapeHTML(t('dev.workspace.graphFocusAll'))}</option>`,
    ...graph.focusOptions.map(
      (opt) =>
        `<option value="${escapeHTML(opt.nodeKey)}" ${graph.focusNodeKey === opt.nodeKey ? 'selected' : ''}>${escapeHTML(opt.name)}${opt.version ? ` (v${escapeHTML(opt.version)})` : ''}</option>`
    ),
  ].join('');

  return `
    <div class="dev-graph-wrap">
      <div class="dev-graph-toolbar">
        <div class="dev-graph-focus-group">
          <label for="devGraphFocusSelect">${escapeHTML(t('dev.workspace.graphFocusLabel'))}:</label>
          <select id="devGraphFocusSelect" class="dev-graph-focus-select">${focusOptionsHtml}</select>
          ${
            graph.truncated
              ? `<span class="muted">${escapeHTML(t('dev.workspace.graphTruncatedHint', { shown: graph.nodes.length - 1, total: graph.totalFilteredCount }))}</span>`
              : ''
          }
        </div>
        <div class="dev-graph-zoom-group">
          <button type="button" class="btn btn-ghost btn-xs" data-dev-ws-action="graph-zoom-out" title="${escapeHTML(t('dev.workspace.graphZoomOut'))}">-</button>
          <button type="button" class="btn btn-ghost btn-xs" data-dev-ws-action="graph-zoom-in" title="${escapeHTML(t('dev.workspace.graphZoomIn'))}">+</button>
          <button type="button" class="btn btn-ghost btn-xs" data-dev-ws-action="graph-zoom-reset">${escapeHTML(t('dev.workspace.graphZoomReset'))}</button>
        </div>
      </div>
      <div class="dev-graph-viewport" id="devGraphViewport">
        <svg class="dev-graph-svg" id="devGraphSvg" viewBox="0 0 ${graph.width} ${graph.height}" role="img" aria-label="${escapeHTML(t('dev.workspace.graphAriaLabel'))}">
          <defs>
            <marker id="devGraphArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="currentColor" opacity="0.55"></path>
            </marker>
            <marker id="devGraphArrowActive" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--accent)"></path>
            </marker>
          </defs>
          <g id="devGraphTransformGroup" transform="translate(${tr.x} ${tr.y}) scale(${tr.scale})">
            <g class="dev-graph-edges">${edgesSvg}</g>
            <g class="dev-graph-nodes">${nodesSvg}</g>
          </g>
        </svg>
      </div>
      <div class="dev-graph-info-bar" id="devGraphInfoBar">${buildGraphNodeInfoHtml(selectedNode)}</div>
    </div>
  `;
}

function renderDependenciesContentHtml(project, scan) {
  const mode = state.devWorkspace.depsViewMode || 'list';
  if (mode === 'tree') return renderDependenciesTreeHtml(project, scan);
  if (mode === 'graph') return renderDependenciesGraphHtml(project, scan);
  return renderDependenciesListHtml(scan, mode);
}

function renderDependenciesTabHtml(project, scan) {
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

  const viewModes = [
    { id: 'list', icon: '📋', label: t('dev.workspace.depsViewList') },
    { id: 'requires', icon: '📦', label: t('dev.workspace.depsViewRequires') },
    { id: 'tree', icon: '🌲', label: t('dev.workspace.depsViewTree') },
    { id: 'graph', icon: '🕸️', label: t('dev.workspace.depsViewGraph') },
  ];

  return `
    <div class="dev-deps-view-bar">
      <div class="dev-deps-view-switch" role="tablist">
        ${viewModes
          .map(
            (v) =>
              `<button type="button" role="tab" aria-selected="${ws.depsViewMode === v.id ? 'true' : 'false'}" class="dev-deps-view-btn ${ws.depsViewMode === v.id ? 'active' : ''}" data-dev-deps-view="${v.id}">${v.icon} ${escapeHTML(v.label)}</button>`
          )
          .join('')}
      </div>
    </div>
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
    <div id="devWsListHost">${renderDependenciesContentHtml(project, scan)}</div>
  `;
}

function renderBundlesListHtml(project, scan) {
  const ws = state.devWorkspace;
  const detectedManagers = Array.isArray(scan?.managers) ? scan.managers : [];
  const allBundles = Array.isArray(state.devBundles) ? state.devBundles : [];
  const filtered = filterDevBundlesForProject(allBundles, {
    detectedManagers,
    showAllManagers: Boolean(ws.bundlesShowAllManagers),
    query: ws.bundlesQuery,
  });

  if (allBundles.length === 0) {
    return `
      <div class="dev-empty">
        <div class="dev-empty-icon">🧺</div>
        <h3>${escapeHTML(t('dev.bundles.emptyTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.bundles.emptyDesc'))}</p>
      </div>
    `;
  }

  if (filtered.length === 0) {
    return `
      <div class="dev-empty">
        <h3>${escapeHTML(t('dev.bundles.noMatchesTitle'))}</h3>
        <p class="muted">${escapeHTML(t('dev.bundles.noMatchesDesc'))}</p>
      </div>
    `;
  }

  const projectBusy =
    isProjectActionBusy(project.id) || project.isAvailable === false || state.isDevBundleInstallRunning;

  const cardsHtml = filtered
    .map((bundle) => {
      const mgrMeta = getDevManagerMeta(bundle.manager);
      const evaluation = evaluateDevBundleForProject(bundle, scan, { t });
      const { packages, summary } = evaluation;
      const pct = summary.total > 0 ? Math.round((summary.presentCount / summary.total) * 100) : 0;

      const previewPkgs = packages.slice(0, 6);
      const remainingCount = Math.max(0, packages.length - previewPkgs.length);
      const previewHtml = previewPkgs
        .map((pkg) => {
          const icon = pkg.status === 'installed' ? '✅' : pkg.status === 'outdated' ? '⬆️' : '⬇️';
          const scopeTag = pkg.isDev ? t('dev.workspace.scopeBadgeDev') : t('dev.workspace.scopeBadgeProd');
          return `<span class="bundle-preview-chip" title="${escapeHTML(pkg.statusLabel)}">${icon} ${escapeHTML(pkg.name)} <span class="dev-bundle-pkg-scope">${escapeHTML(scopeTag)}</span></span>`;
        })
        .join('');

      return `
        <article class="bundle-card dev-bundle-card" data-dev-bundle-id="${escapeHTML(bundle.id)}">
          <div class="bundle-card-head">
            <div class="bundle-card-title-row">
              <span class="bundle-card-icon">${escapeHTML(bundle.icon || '🧺')}</span>
              <div class="bundle-card-title-text">
                <h3>${escapeHTML(bundle.name)}</h3>
                <span class="bundle-card-counts">
                  <span class="provider-badge ${escapeHTML(mgrMeta.badgeClass)}">${escapeHTML(mgrMeta.label)}</span>
                  <span>${escapeHTML(t('bundles.packageCount', { count: summary.total }))}</span>
                </span>
              </div>
            </div>
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              data-dev-ws-action="bundle-export"
              data-dev-bundle-id="${escapeHTML(bundle.id)}"
              title="${escapeHTML(t('dev.bundles.exportTitle'))}"
            >📤 ${escapeHTML(t('common.export'))}</button>
          </div>

          ${bundle.description ? `<p class="bundle-card-desc">${escapeHTML(bundle.description)}</p>` : ''}

          <div class="bundle-progress-block">
            <div class="bundle-progress-labels">
              <strong>${escapeHTML(summary.statusText)}</strong>
              <span class="muted">${pct}%</span>
            </div>
            <div class="bundle-progress-track">
              <div class="bundle-progress-fill" style="width: ${pct}%"></div>
            </div>
            <div class="bundle-status-pills">
              ${summary.installedCount > 0 ? `<span class="bundle-pill is-ok">✅ ${escapeHTML(t('dev.bundles.pillInstalled', { count: summary.installedCount }))}</span>` : ''}
              ${summary.outdatedCount > 0 ? `<span class="bundle-pill is-outdated">⬆️ ${escapeHTML(t('dev.bundles.pillOutdated', { count: summary.outdatedCount }))}</span>` : ''}
              ${summary.missingCount > 0 ? `<span class="bundle-pill is-missing">⬇️ ${escapeHTML(t('dev.bundles.pillMissing', { count: summary.missingCount }))}</span>` : ''}
            </div>
          </div>

          <div class="bundle-preview-list">
            ${previewHtml}
            ${remainingCount > 0 ? `<span class="bundle-preview-more">${escapeHTML(t('bundles.moreItems', { count: remainingCount }))}</span>` : ''}
          </div>

          <div class="bundle-card-actions">
            <button
              type="button"
              class="btn btn-primary"
              data-dev-ws-action="bundle-install"
              data-dev-bundle-id="${escapeHTML(bundle.id)}"
              ${summary.total === 0 || projectBusy ? 'disabled' : ''}
            >🚀 ${escapeHTML(t('dev.bundles.btnInstallInProject'))}</button>
            <button
              type="button"
              class="btn btn-ghost"
              data-dev-ws-action="bundle-edit"
              data-dev-bundle-id="${escapeHTML(bundle.id)}"
            >✏️ ${escapeHTML(t('common.edit'))}</button>
            <button
              type="button"
              class="btn btn-ghost"
              data-dev-ws-action="bundle-duplicate"
              data-dev-bundle-id="${escapeHTML(bundle.id)}"
            >📋 ${escapeHTML(t('bundles.duplicate'))}</button>
            <button
              type="button"
              class="btn btn-danger"
              data-dev-ws-action="bundle-delete"
              data-dev-bundle-id="${escapeHTML(bundle.id)}"
            >🗑️ ${escapeHTML(t('common.delete'))}</button>
          </div>
        </article>
      `;
    })
    .join('');

  return `<div class="bundles-grid">${cardsHtml}</div>`;
}

function renderBundlesTabHtml(project, scan) {
  const ws = state.devWorkspace;
  const detectedManagers = Array.isArray(scan?.managers) ? scan.managers : [];
  const allBundles = Array.isArray(state.devBundles) ? state.devBundles : [];
  const filtered = filterDevBundlesForProject(allBundles, {
    detectedManagers,
    showAllManagers: Boolean(ws.bundlesShowAllManagers),
    query: ws.bundlesQuery,
  });
  const hasSnapshotPkgs = Array.isArray(scan?.installed) && scan.installed.length > 0;
  const ipcNoticeHtml = state.devBundlesIpcUnavailable
    ? `<div class="discover-notice">⚠️ ${escapeHTML(t('dev.bundles.ipcUnavailableNotice'))}</div>`
    : '';

  return `
    <div class="dev-bundles-toolbar">
      <div class="dev-bundles-actions">
        <button type="button" class="btn btn-primary" data-dev-ws-action="bundle-new">➕ ${escapeHTML(t('dev.bundles.btnNew'))}</button>
        <button
          type="button"
          class="btn btn-local"
          data-dev-ws-action="bundle-snapshot"
          ${hasSnapshotPkgs ? '' : 'disabled'}
          title="${escapeHTML(hasSnapshotPkgs ? t('dev.bundles.btnSnapshotTitle') : t('dev.bundles.btnSnapshotDisabledTitle'))}"
        >📸 ${escapeHTML(t('dev.bundles.btnSnapshot'))}</button>
        <button type="button" class="btn btn-ghost" data-dev-ws-action="bundle-import">📥 ${escapeHTML(t('dev.bundles.btnImport'))}</button>
      </div>
      <div class="dev-ws-controls">
        <div class="dev-search-box">
          <input
            type="text"
            id="devBundlesSearchInput"
            value="${escapeHTML(ws.bundlesQuery)}"
            placeholder="${escapeHTML(t('dev.bundles.searchPlaceholder'))}"
            autocomplete="off"
          >
          <button type="button" id="clearDevBundlesSearchBtn" class="clear-btn" title="${escapeHTML(t('toolbar.clearSearch'))}" ${ws.bundlesQuery ? '' : 'hidden'}>✕</button>
        </div>
        <label class="dev-bundles-toggle">
          <input type="checkbox" id="chkDevBundlesAllManagers" ${ws.bundlesShowAllManagers ? 'checked' : ''}>
          <span>${escapeHTML(t('dev.bundles.showAllManagers'))}</span>
        </label>
        <span id="devBundlesCountEl" class="muted">${escapeHTML(t('dev.bundles.countSummary', { shown: filtered.length, total: allBundles.length }))}</span>
      </div>
    </div>
    ${ipcNoticeHtml}
    <div id="devWsListHost">${renderBundlesListHtml(project, scan)}</div>
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
  const matchingBundlesCount = filterDevBundlesForProject(state.devBundles || [], {
    detectedManagers: managers,
    showAllManagers: Boolean(ws.bundlesShowAllManagers),
    query: '',
  }).length;
  const projectBusy = isProjectActionBusy(project.id) || project.isAvailable === false;
  const isSyncBusy = state.devBusyActionKeys.has(`${project.id}:sync`);
  const auditManagers = managers.filter((m) => AUDIT_SUPPORTED_MANAGERS.includes(String(m || '').toLowerCase()));

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
    { id: 'bundles', icon: '🧺', label: t('dev.workspace.tabBundles'), count: matchingBundlesCount, highlight: false },
    { id: 'discover', icon: '🛍️', label: t('dev.workspace.tabDiscover'), count: null, highlight: false },
  ];

  let activeBodyHtml = '';
  if (ws.activeSubTab === 'updates') activeBodyHtml = renderUpdatesTabHtml(project, scan);
  else if (ws.activeSubTab === 'installed') activeBodyHtml = renderInstalledTabHtml(project, scan);
  else if (ws.activeSubTab === 'dependencies') activeBodyHtml = renderDependenciesTabHtml(project, scan);
  else if (ws.activeSubTab === 'bundles') activeBodyHtml = renderBundlesTabHtml(project, scan);
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
            class="btn btn-local"
            data-dev-ws-action="sync-project"
            title="${escapeHTML(managers.length === 0 ? t('dev.workspace.syncNoManagerTitle') : t('dev.workspace.syncTitle'))}"
            ${projectBusy || managers.length === 0 ? 'disabled' : ''}
          >${isSyncBusy ? '⏳' : '🔄'} ${escapeHTML(isSyncBusy ? t('dev.workspace.syncingBtn') : t('dev.workspace.syncBtn'))}</button>
          <button
            type="button"
            class="btn btn-ghost"
            data-dev-ws-action="audit-project"
            title="${escapeHTML(auditManagers.length === 0 ? t('dev.audit.unsupportedDesc') : t('dev.workspace.auditTitle'))}"
            ${project.isAvailable === false || auditManagers.length === 0 ? 'disabled' : ''}
          >🛡️ ${escapeHTML(t('dev.workspace.auditBtn'))}</button>
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
    if (listHost) listHost.innerHTML = renderDependenciesContentHtml(project, scan);
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
  } else if (target.id === 'devBundlesSearchInput') {
    ws.bundlesQuery = target.value;
    const clr = document.getElementById('clearDevBundlesSearchBtn');
    if (clr) clr.hidden = ws.bundlesQuery.length === 0;
    if (listHost) listHost.innerHTML = renderBundlesListHtml(project, scan);
    const countEl = document.getElementById('devBundlesCountEl');
    if (countEl) {
      const allBundles = Array.isArray(state.devBundles) ? state.devBundles : [];
      const filtered = filterDevBundlesForProject(allBundles, {
        detectedManagers: Array.isArray(scan?.managers) ? scan.managers : [],
        showAllManagers: Boolean(ws.bundlesShowAllManagers),
        query: ws.bundlesQuery,
      });
      countEl.textContent = t('dev.bundles.countSummary', { shown: filtered.length, total: allBundles.length });
    }
  }
}

export function handleDevWorkspaceChange(e) {
  const project = getSelectedDevProject();
  if (!project) return;
  const scan = getProjectScan(project.id);
  const ws = state.devWorkspace;
  const target = e.target;

  if (target instanceof HTMLSelectElement) {
    const tierKey = target.dataset.devTierSelect || '';
    if (tierKey) {
      if (!ws.selectedUpdateTierByKey || typeof ws.selectedUpdateTierByKey !== 'object') {
        ws.selectedUpdateTierByKey = {};
      }
      ws.selectedUpdateTierByKey[tierKey] = target.value;
      const listHost = document.getElementById('devWsListHost');
      if (listHost) listHost.innerHTML = renderUpdatesListHtml(project, scan);
      return;
    }
    if (target.id === 'devGraphFocusSelect') {
      ws.depsGraphFocusKey = target.value || '';
      ws.depsGraphSelectedId = ws.depsGraphFocusKey;
      ws.depsGraphTransform = { x: 0, y: 0, scale: 1 };
      const listHost = document.getElementById('devWsListHost');
      if (listHost) listHost.innerHTML = renderDependenciesContentHtml(project, scan);
      return;
    }
    return;
  }

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

  if (target.id === 'chkDevBundlesAllManagers') {
    ws.bundlesShowAllManagers = target.checked;
    const listHost = document.getElementById('devWsListHost');
    if (listHost) listHost.innerHTML = renderBundlesListHtml(project, scan);
    const countEl = document.getElementById('devBundlesCountEl');
    if (countEl) {
      const allBundles = Array.isArray(state.devBundles) ? state.devBundles : [];
      const filtered = filterDevBundlesForProject(allBundles, {
        detectedManagers: Array.isArray(scan?.managers) ? scan.managers : [],
        showAllManagers: Boolean(ws.bundlesShowAllManagers),
        query: ws.bundlesQuery,
      });
      countEl.textContent = t('dev.bundles.countSummary', { shown: filtered.length, total: allBundles.length });
    }
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
  if (target.id === 'clearDevBundlesSearchBtn') {
    ws.bundlesQuery = '';
    callbacks.onRerender();
    document.getElementById('devBundlesSearchInput')?.focus();
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

  const viewBtn = target.closest('[data-dev-deps-view]');
  if (viewBtn instanceof HTMLElement) {
    const nextView = viewBtn.dataset.devDepsView || 'list';
    if (nextView !== ws.depsViewMode) {
      ws.depsViewMode = nextView;
      ws.depsHighlightPkg = '';
      callbacks.onRerender();
    }
    return;
  }

  const treeToggleBtn = target.closest('[data-dev-tree-toggle]');
  if (treeToggleBtn instanceof HTMLElement) {
    const pathKey = treeToggleBtn.dataset.devTreeToggle || '';
    if (pathKey) {
      if (ws.depsTreeExpanded.has(pathKey)) {
        ws.depsTreeExpanded.delete(pathKey);
      } else {
        ws.depsTreeExpanded.add(pathKey);
      }
      const listHost = document.getElementById('devWsListHost');
      if (listHost) listHost.innerHTML = renderDependenciesContentHtml(project, scan);
    }
    return;
  }

  const jumpBtn = target.closest('[data-dev-deps-jump]');
  if (jumpBtn instanceof HTMLElement) {
    const pkgName = jumpBtn.dataset.devDepsJump || '';
    const mgr = jumpBtn.dataset.devDepsManager || '';
    if (pkgName) {
      const targetKey = `${mgr}:${pkgName}`.toLowerCase();
      ws.depsDirectFilter = 'all';
      ws.depsQuery = '';
      ws.depsHighlightPkg = targetKey;
      const allDeps = Array.isArray(scan?.dependencies) ? scan.dependencies : [];
      const filtered = filterDevDependencies(allDeps, {
        managerFilter: getEffectiveManagerFilter(scan),
        directFilter: 'all',
        query: '',
      });
      const targetIdx = filtered.findIndex((d) => `${d.manager}:${d.name}`.toLowerCase() === targetKey);
      if (targetIdx >= 0 && targetIdx >= (ws.depsRenderLimit || 150)) {
        ws.depsRenderLimit = targetIdx + 50;
      }
      callbacks.onRerender();
      requestAnimationFrame(() => {
        const row = document.querySelector(`[data-dep-row-key="${CSS.escape(targetKey)}"]`);
        if (row instanceof HTMLElement) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }
    return;
  }

  if (target.closest('.dev-graph-viewport')) {
    if (suppressNextGraphClick) {
      suppressNextGraphClick = false;
      return;
    }
    const graphNodeEl = target.closest('[data-graph-node-id]');
    const nextSelectedId = graphNodeEl instanceof Element ? graphNodeEl.getAttribute('data-graph-node-id') || '' : '';
    ws.depsGraphSelectedId = nextSelectedId === ws.depsGraphSelectedId ? '' : nextSelectedId;
    applyGraphNodeHighlightDom(ws.depsGraphSelectedId);
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
  } else if (action === 'sync-project') {
    const managers = Array.isArray(scan?.managers) ? scan.managers : [];
    const activeFilter = getEffectiveManagerFilter(scan);
    const targetManagers = activeFilter !== 'all' ? [activeFilter] : managers;
    if (targetManagers.length === 0) return;

    const ok = await ensureAdminAuthenticated({
      reason: t('dev.authReasonSyncProject', { project: project.name }),
    });
    if (!ok) return;

    const busyKey = `${project.id}:sync`;
    state.devBusyActionKeys.add(busyKey);
    callbacks.onRerender();
    try {
      let lastRes = null;
      for (let i = 0; i < targetManagers.length; i++) {
        const mgr = targetManagers[i];
        const res = await window.electronAPI.devSyncProject(project.id, mgr, {
          checkUpdates: i === targetManagers.length - 1,
        });
        lastRes = res;
        if (res?.canceled) {
          showToast(t('dev.toastActionCanceled'), { type: 'info' });
          return;
        }
        if (res?.alreadyRunning) {
          showToast(t('dev.toastActionAlreadyRunning'), { type: 'info' });
          return;
        }
        if (!res?.success) {
          showToast(t('dev.toastActionFailed', { error: res?.error || t('common.unknownError') }), {
            type: 'error',
            duration: 6000,
          });
          return;
        }
      }
      if (lastRes?.scan && (lastRes.scan.success || lastRes.scan.unavailable)) {
        setDevScanResult(project.id, lastRes.scan, { checkedUpdates: Boolean(lastRes.scan.success) });
      }
      callbacks.onUpdateNavCounts();
      showToast(t('dev.toastSyncDone', { project: project.name }), { type: 'success' });
    } finally {
      state.devBusyActionKeys.delete(busyKey);
      callbacks.onRerender();
    }
  } else if (action === 'audit-project') {
    openDevAuditModal({
      project,
      onScanUpdated: () => {
        callbacks.onUpdateNavCounts();
        callbacks.onRerender();
      },
    });
  } else if (action === 'bundle-new') {
    const detected = Array.isArray(scan?.managers) ? scan.managers : [];
    await openDevBundleEditorModal({
      project,
      projectScan: scan,
      defaultManager: detected[0] === 'yarn' ? 'npm' : detected[0] || 'npm',
      onSaved: () => callbacks.onRerender(),
    });
  } else if (action === 'bundle-snapshot') {
    const snapshot = buildDevBundleDraftFromProject({ project, scan, t });
    if (snapshot.totalCount === 0) {
      showToast(t('dev.bundles.snapshotEmptyToast'), { type: 'warn' });
      return;
    }
    await openDevBundleEditorModal({
      snapshotDraft: snapshot.draft,
      snapshotStats: snapshot,
      project,
      projectScan: scan,
      onSaved: () => callbacks.onRerender(),
    });
  } else if (action === 'bundle-import') {
    const ok = await ensureAdminAuthenticated({
      reason: t('toasts.authReasonImportBundle'),
    });
    if (!ok) return;
    const res = await window.electronAPI.importDevBundle();
    if (res?.success) {
      await refreshDevBundles();
      callbacks.onRerender();
      const msg =
        res.importedCount > 1
          ? t('dev.bundles.importedManyToast', { count: res.importedCount })
          : t('dev.bundles.importedOneToast', { name: res.bundle?.name || t('toasts.bundleImportDefault') });
      showToast(msg, { type: 'success' });
    } else if (res?.error && !res.canceled) {
      showToast(t('toasts.bundleImportFailed', { error: res.error }), { type: 'error', duration: 6000 });
    }
  } else if (action === 'bundle-install') {
    const bundleId = actionBtn.dataset.devBundleId || '';
    const bundle = (state.devBundles || []).find((b) => b.id === bundleId);
    if (!bundle) return;
    openDevBundleRunnerModal({
      project,
      bundle,
      scan,
      onInstalled: () => {
        callbacks.onUpdateNavCounts();
        callbacks.onRerender();
      },
    });
  } else if (action === 'bundle-edit') {
    const bundleId = actionBtn.dataset.devBundleId || '';
    const bundle = (state.devBundles || []).find((b) => b.id === bundleId);
    if (!bundle) return;
    await openDevBundleEditorModal({
      bundle,
      project,
      projectScan: scan,
      onSaved: () => callbacks.onRerender(),
    });
  } else if (action === 'bundle-duplicate') {
    const bundleId = actionBtn.dataset.devBundleId || '';
    if (!bundleId) return;
    const ok = await ensureAdminAuthenticated({
      reason: t('toasts.authReasonDuplicateBundle'),
    });
    if (!ok) return;
    const res = await window.electronAPI.duplicateDevBundle(bundleId);
    if (res?.success) {
      await refreshDevBundles();
      callbacks.onRerender();
      showToast(t('toasts.bundleCreated', { name: res.bundle?.name || t('toasts.bundleCopyDefault') }), {
        type: 'success',
      });
    } else {
      showToast(res?.error || t('toasts.bundleDuplicateFailed'), { type: 'error' });
    }
  } else if (action === 'bundle-export') {
    const bundleId = actionBtn.dataset.devBundleId || '';
    if (!bundleId) return;
    const res = await window.electronAPI.exportDevBundle(bundleId);
    if (res?.success) {
      showToast(t('toasts.bundleExported'), { type: 'success' });
    } else if (res?.error && !res.canceled) {
      showToast(t('toasts.bundleExportFailed', { error: res.error }), { type: 'error' });
    }
  } else if (action === 'bundle-delete' && actionBtn instanceof HTMLButtonElement) {
    if (actionBtn.dataset.armed !== 'true') {
      actionBtn.dataset.armed = 'true';
      actionBtn.dataset.origText = actionBtn.textContent || '';
      actionBtn.textContent = `⚠️ ${t('common.confirmRemoveArmed')}`;
      setTimeout(() => {
        if (actionBtn.isConnected && actionBtn.dataset.armed === 'true') {
          actionBtn.dataset.armed = 'false';
          actionBtn.textContent = actionBtn.dataset.origText || `🗑️ ${t('common.delete')}`;
        }
      }, 4000);
      return;
    }
    actionBtn.dataset.armed = 'false';
    const bundleId = actionBtn.dataset.devBundleId || '';
    const bundle = (state.devBundles || []).find((b) => b.id === bundleId);
    if (!bundleId) return;

    const ok = await ensureAdminAuthenticated({
      reason: t('toasts.authReasonDeleteBundle'),
    });
    if (!ok) return;

    const res = await window.electronAPI.deleteDevBundle(bundleId);
    if (res?.success) {
      await refreshDevBundles();
      callbacks.onRerender();
      showToast(t('toasts.bundleDeleted', { name: bundle?.name || '' }), { type: 'success' });
    } else {
      showToast(res?.error || t('toasts.bundleDeleteFailed'), { type: 'error' });
    }
  } else if (action === 'show-more-deps') {
    ws.depsRenderLimit = (ws.depsRenderLimit || 150) + 150;
    callbacks.onRerender();
  } else if (action === 'deps-tree-expand-all') {
    const tree = buildDevDependencyTree(scan?.dependencies || [], {
      managerFilter: getEffectiveManagerFilter(scan),
      directFilter: ws.depsDirectFilter,
      query: ws.depsQuery,
    });
    ws.depsTreeExpandAll = true;
    ws.depsTreeExpanded = new Set(collectAllTreeExpandKeys(tree.roots));
    const listHost = document.getElementById('devWsListHost');
    if (listHost) listHost.innerHTML = renderDependenciesContentHtml(project, scan);
  } else if (action === 'deps-tree-collapse-all') {
    ws.depsTreeExpandAll = false;
    ws.depsTreeExpanded.clear();
    const listHost = document.getElementById('devWsListHost');
    if (listHost) listHost.innerHTML = renderDependenciesContentHtml(project, scan);
  } else if (action === 'graph-zoom-in') {
    const tr = ws.depsGraphTransform || { x: 0, y: 0, scale: 1 };
    ws.depsGraphTransform = { ...tr, scale: Math.min(3, Number((tr.scale * 1.2).toFixed(3))) };
    applyGraphTransformDom();
  } else if (action === 'graph-zoom-out') {
    const tr = ws.depsGraphTransform || { x: 0, y: 0, scale: 1 };
    ws.depsGraphTransform = { ...tr, scale: Math.max(0.25, Number((tr.scale / 1.2).toFixed(3))) };
    applyGraphTransformDom();
  } else if (action === 'graph-zoom-reset') {
    ws.depsGraphTransform = { x: 0, y: 0, scale: 1 };
    applyGraphTransformDom();
  } else if (action === 'discover-search') {
    await runDiscoverSearch(project, callbacks);
  } else if (action === 'batch-update-compatible') {
    await runBatchCompatibleUpdate(project, scan, callbacks);
  } else if (action === 'update-pkg') {
    const manager = actionBtn.dataset.devManager || '';
    const packageName = actionBtn.dataset.devPkg || '';
    const targetVersion = actionBtn.dataset.devTargetVer || '';
    const allowMajor = actionBtn.dataset.devMajor === 'true';
    const exactTarget = actionBtn.dataset.devExactTarget === 'true';
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
        exactTarget,
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
