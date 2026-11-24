import { evaluateBundleStatus } from '../../shared/bundles-logic.js';
import { getUsableProviders, getVisibleBundleItems, getVisibleBundles, state } from '../state.js';
import { getLocalizedProviderBadge, t } from '../utils/i18n.js';
import { escapeHTML, toMediaUrl } from '../utils/sanitize.js';
import { queueItemsForIconResolution } from './cards.js';

let viewHandlers = {};

function renderEmptyBundlesHtml(hasSearch) {
  if (hasSearch) {
    return `
      <div class="bundles-empty">
        <h3>${escapeHTML(t('bundles.emptySearchTitle'))}</h3>
        <p class="muted">${escapeHTML(t('bundles.emptySearchDesc'))}</p>
        <div class="bundles-empty-actions">
          <button type="button" class="btn btn-ghost" data-bundle-action="clear-search">${escapeHTML(t('bundles.resetSearch'))}</button>
        </div>
      </div>
    `;
  }

  return `
    <div class="bundles-empty">
      <div class="bundles-empty-icon">📦</div>
      <h3>${escapeHTML(t('bundles.emptyTitle'))}</h3>
      <p class="muted">${escapeHTML(t('bundles.emptyDesc'))}</p>
      <div class="bundles-empty-actions">
        <button type="button" class="btn btn-primary" data-bundle-action="new">➕ ${escapeHTML(t('bundles.newBundle'))}</button>
        <button type="button" class="btn btn-local" data-bundle-action="snapshot">📸 ${escapeHTML(t('bundles.snapshotFromPc'))}</button>
        <button type="button" class="btn btn-ghost" data-bundle-action="import">📥 ${escapeHTML(t('bundles.importBundle'))}</button>
      </div>
    </div>
  `;
}

function renderBundleCardHtml(bundle) {
  const depth = state.settings.versionCompareDepth ?? 3;
  const visibleBundle = {
    ...bundle,
    items: getVisibleBundleItems(bundle),
  };
  const evaluation = evaluateBundleStatus(visibleBundle, {
    packages: state.packages,
    versionCompareDepth: depth,
    t,
  });
  const { items, summary } = evaluation;

  const sourceCountsMap = new Map();
  for (const it of items) {
    const src = String(it.source || 'archive').toLowerCase();
    sourceCountsMap.set(src, (sourceCountsMap.get(src) || 0) + 1);
  }
  const sourceSummaryParts = [t('bundles.packageCount', { count: summary.total })];
  const countBadgesHtml = [...sourceCountsMap.entries()]
    .map(([src, cnt]) => {
      const badge = getLocalizedProviderBadge(src, state.providers);
      const label = badge?.label || src;
      return `<span class="provider-badge ${escapeHTML(badge?.badgeClass || '')}">${escapeHTML(label)}: ${cnt}</span>`;
    })
    .join('');

  const pct = summary.total > 0 ? Math.round((summary.installedCount / summary.total) * 100) : 0;

  const previewItems = items.slice(0, 5);
  const remainingCount = Math.max(0, items.length - previewItems.length);
  const previewIconItems = [];
  const previewHtml = previewItems
    .map((entry) => {
      const icon = entry.status === 'up-to-date' ? '✅' : entry.status === 'outdated' ? '⬆️' : '⬇️';
      const shield = entry.adwareProtected ? ' 🛡️' : '';
      const iconTarget = entry.matchedPackage || {
        id: entry.key,
        name: entry.name,
        packageManager: entry.source === 'archive' ? '' : entry.source,
        packageId: entry.packageId || '',
      };
      previewIconItems.push(iconTarget);
      const iconPath =
        iconTarget.icon ||
        state.pcIconCache.get(iconTarget.id) ||
        (iconTarget.pcApp?.id ? state.pcIconCache.get(iconTarget.pcApp.id) : null) ||
        null;
      const itemIconHtml = iconPath
        ? `<img class="bundle-item-icon" src="${escapeHTML(toMediaUrl(iconPath))}" loading="lazy" decoding="async" alt="">`
        : `<span class="bundle-item-icon-fallback" data-icon-item-id="${escapeHTML(iconTarget.id)}"></span>`;
      return `<span class="bundle-preview-chip" title="${escapeHTML(entry.statusLabel)}">${itemIconHtml}#${entry.order} ${icon} ${escapeHTML(entry.name)}${shield}</span>`;
    })
    .join('');

  return {
    previewIconItems,
    html: `
    <article class="bundle-card" data-bundle-id="${escapeHTML(bundle.id)}">
      <div class="bundle-card-head">
        <div class="bundle-card-title-row">
          <span class="bundle-card-icon">${escapeHTML(bundle.icon || '📦')}</span>
          <div class="bundle-card-title-text">
            <h3>${escapeHTML(bundle.name)}</h3>
            <span class="bundle-card-counts">${sourceSummaryParts.join('')} ${countBadgesHtml}</span>
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" data-bundle-action="export" data-bundle-id="${escapeHTML(bundle.id)}" title="${escapeHTML(t('bundles.exportTitle'))}">📤 ${escapeHTML(t('common.export'))}</button>
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
          ${summary.upToDateCount > 0 ? `<span class="bundle-pill is-ok">✅ ${escapeHTML(t('bundles.pillUpToDate', { count: summary.upToDateCount }))}</span>` : ''}
          ${summary.outdatedCount > 0 ? `<span class="bundle-pill is-outdated">⬆️ ${escapeHTML(t('bundles.pillOutdated', { count: summary.outdatedCount }))}</span>` : ''}
          ${summary.missingCount > 0 ? `<span class="bundle-pill is-missing">⬇️ ${escapeHTML(t('bundles.pillMissing', { count: summary.missingCount }))}</span>` : ''}
          ${summary.adwareProtectedCount > 0 ? `<span class="bundle-pill is-protected">🛡️ ${escapeHTML(t('bundles.pillProtected', { count: summary.adwareProtectedCount }))}</span>` : ''}
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
          data-bundle-action="run"
          data-bundle-id="${escapeHTML(bundle.id)}"
          ${summary.total === 0 || state.isBundleInstallRunning ? 'disabled' : ''}
        >
          🚀 ${escapeHTML(t('bundles.runBundle'))}
        </button>
        <button type="button" class="btn btn-ghost" data-bundle-action="edit" data-bundle-id="${escapeHTML(bundle.id)}">✏️ ${escapeHTML(t('common.edit'))}</button>
        <button type="button" class="btn btn-ghost" data-bundle-action="duplicate" data-bundle-id="${escapeHTML(bundle.id)}">📋 ${escapeHTML(t('bundles.duplicate'))}</button>
        <button type="button" class="btn btn-danger" data-bundle-action="delete" data-bundle-id="${escapeHTML(bundle.id)}">🗑️ ${escapeHTML(t('common.delete'))}</button>
      </div>
    </article>
  `,
  };
}

function getBundleProviderFilterOptions() {
  const options = [
    { id: 'all', label: t('common.all') },
    { id: 'archive', label: t('providers.names.archive') },
  ];
  const seen = new Set(['all', 'archive']);

  for (const prov of getUsableProviders({ excludeIds: ['archive', 'msi'] })) {
    if (!seen.has(prov.id)) {
      seen.add(prov.id);
      options.push({ id: prov.id, label: prov.name });
    }
  }
  for (const bundle of getVisibleBundles()) {
    for (const item of getVisibleBundleItems(bundle)) {
      const src = String(item.source || '')
        .trim()
        .toLowerCase();
      if (!src || seen.has(src)) continue;
      seen.add(src);
      const badge = getLocalizedProviderBadge(src, state.providers);
      options.push({ id: src, label: badge?.label || src });
    }
  }
  return options;
}

export function renderBundlesView() {
  const container = document.getElementById('bundlesView');
  if (!container) return;

  const filterOptions = getBundleProviderFilterOptions();
  if (!filterOptions.some((opt) => opt.id === state.bundleProviderFilter)) {
    state.bundleProviderFilter = 'all';
  }
  const activeFilter = state.bundleProviderFilter || 'all';

  const visibleBundles = getVisibleBundles();
  const q = state.bundleSearchQuery.trim().toLowerCase();
  const filtered = visibleBundles.filter((b) => {
    const visibleItems = getVisibleBundleItems(b);
    if (activeFilter !== 'all') {
      const hasSource = visibleItems.some((it) => String(it.source || '').toLowerCase() === activeFilter);
      if (!hasSource) return false;
    }
    if (!q) return true;
    const itemNames = visibleItems.map((i) => `${i.name} ${i.packageId}`).join(' ');
    return `${b.name} ${b.description} ${itemNames}`.toLowerCase().includes(q);
  });

  const filterBarHtml =
    filterOptions.length > 1
      ? `<div class="bundles-filter-bar">${filterOptions
          .map(
            (opt) =>
              `<button type="button" class="origin-chip ${activeFilter === opt.id ? 'active' : ''}" data-bundle-provider-filter="${escapeHTML(opt.id)}">${escapeHTML(opt.label)}</button>`
          )
          .join('')}</div>`
      : '';

  const activeEl = document.activeElement;
  const activeElId = activeEl instanceof HTMLElement ? activeEl.id : '';
  const selStart = activeEl instanceof HTMLInputElement ? activeEl.selectionStart : null;
  const selEnd = activeEl instanceof HTMLInputElement ? activeEl.selectionEnd : null;

  const ipcNoticeHtml = state.bundlesIpcUnavailable
    ? `<div class="discover-notice">⚠️ ${escapeHTML(t('bundles.ipcUnavailableNotice'))}</div>`
    : '';

  const renderedCards = filtered.map(renderBundleCardHtml);
  const bundleIconCandidates = renderedCards.flatMap((c) => c.previewIconItems);

  container.innerHTML = `
    <div class="bundles-header">
      <div class="bundles-header-main">
        <div>
          <h2>📦 ${escapeHTML(t('bundles.headerTitle'))}</h2>
          <p class="muted">${escapeHTML(t('bundles.headerSubtitle'))}</p>
        </div>
        <div class="bundles-header-actions">
          <button type="button" class="btn btn-primary" data-bundle-action="new">➕ ${escapeHTML(t('bundles.newBundle'))}</button>
          <button type="button" class="btn btn-local" data-bundle-action="snapshot">📸 ${escapeHTML(t('bundles.snapshotFromPc'))}</button>
          <button type="button" class="btn btn-ghost" data-bundle-action="import">📥 ${escapeHTML(t('bundles.importBundle'))}</button>
          <button type="button" class="btn btn-ghost" data-bundle-action="export-all" ${state.bundles.length === 0 ? 'disabled' : ''}>📤 ${escapeHTML(t('bundles.exportAllBundles'))}</button>
        </div>
      </div>

      <div class="bundles-search-row">
        <div class="bundles-search-box">
          <input type="text" id="bundleSearchInput" value="${escapeHTML(state.bundleSearchQuery)}" placeholder="${escapeHTML(t('bundles.searchPlaceholder'))}" autocomplete="off">
          <button type="button" id="clearBundleSearchBtn" class="clear-btn" title="${escapeHTML(t('toolbar.clearSearch'))}" ${state.bundleSearchQuery ? '' : 'hidden'}>✕</button>
        </div>
        <span class="muted">${escapeHTML(t('bundles.countSummary', { filtered: filtered.length, total: visibleBundles.length }))}</span>
      </div>
      ${filterBarHtml}
    </div>

    ${ipcNoticeHtml}

    ${
      filtered.length === 0
        ? renderEmptyBundlesHtml(Boolean(q || activeFilter !== 'all'))
        : `<div class="bundles-grid">${renderedCards.map((c) => c.html).join('')}</div>`
    }
  `;

  if (bundleIconCandidates.length > 0) {
    queueItemsForIconResolution(bundleIconCandidates, { prioritize: true });
  }

  const searchInput = container.querySelector('#bundleSearchInput');
  const clearBtn = container.querySelector('#clearBundleSearchBtn');
  if (searchInput instanceof HTMLInputElement) {
    searchInput.oninput = () => {
      state.bundleSearchQuery = searchInput.value;
      if (clearBtn instanceof HTMLElement) clearBtn.hidden = state.bundleSearchQuery.length === 0;
      renderBundlesView();
    };
  }
  if (clearBtn instanceof HTMLElement) {
    clearBtn.onclick = () => {
      state.bundleSearchQuery = '';
      renderBundlesView();
      const inputEl = container.querySelector('#bundleSearchInput');
      if (inputEl instanceof HTMLElement) inputEl.focus();
    };
  }

  if (activeElId === 'bundleSearchInput') {
    const refocused = container.querySelector('#bundleSearchInput');
    if (refocused instanceof HTMLInputElement) {
      refocused.focus();
      if (selStart !== null && selEnd !== null) {
        try {
          refocused.setSelectionRange(selStart, selEnd);
        } catch {
          // Ignorieren
        }
      }
    }
  }
}

export function initBundlesView(handlers) {
  viewHandlers = handlers || {};
  const container = document.getElementById('bundlesView');
  if (!container) return;

  container.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const filterBtn = target.closest('[data-bundle-provider-filter]');
    if (filterBtn instanceof HTMLElement) {
      state.bundleProviderFilter = filterBtn.dataset.bundleProviderFilter || 'all';
      renderBundlesView();
      return;
    }

    const btn = target.closest('[data-bundle-action]');
    if (!(btn instanceof HTMLElement)) return;
    const action = btn.dataset.bundleAction;
    const bundleId = btn.dataset.bundleId || '';
    const bundle = bundleId ? state.bundles.find((b) => b.id === bundleId) || null : null;

    if (action === 'new') {
      viewHandlers.onNewBundle?.();
    } else if (action === 'snapshot') {
      viewHandlers.onSnapshotFromPc?.();
    } else if (action === 'import') {
      viewHandlers.onImportBundle?.();
    } else if (action === 'export-all') {
      viewHandlers.onExportAllBundles?.();
    } else if (action === 'clear-search') {
      state.bundleSearchQuery = '';
      state.bundleProviderFilter = 'all';
      renderBundlesView();
    } else if (action === 'run' && bundle) {
      viewHandlers.onRunBundle?.(bundle.id);
    } else if (action === 'edit' && bundle) {
      viewHandlers.onEditBundle?.(bundle);
    } else if (action === 'duplicate' && bundle) {
      viewHandlers.onDuplicateBundle?.(bundle.id);
    } else if (action === 'export' && bundle) {
      viewHandlers.onExportBundle?.(bundle.id);
    } else if (action === 'delete' && bundle) {
      viewHandlers.onDeleteBundle?.(bundle);
    }
  });
}
