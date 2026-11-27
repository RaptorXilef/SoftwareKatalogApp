import {
  BUNDLE_ICON_PRESETS,
  DEFAULT_BUNDLE_ICON,
  evaluateBundleItemStatus,
  getBundleEditorArchiveCandidates,
  getBundleItemKey,
  getKnownProviderPackages,
  mergeProviderEditorResults,
  moveBundleItem,
  sortBundleItems,
} from '../../shared/bundles-logic.js';
import { filterUsableProviders } from '../../shared/provider-lifecycle-logic.js';
import { getCachedIconForPackage, queueItemsForIconResolution } from '../components/cards.js';
import { showToast } from '../components/toast.js';
import { isProviderUsable, state } from '../state.js';
import { getI18nLocale, getLocalizedProviderBadge, getLocalizedProviderName, t } from '../utils/i18n.js';
import { escapeHTML, toMediaUrl } from '../utils/sanitize.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';

let activeEditorToken = 0;

export function renderBundleEditorModal({
  bundle = null,
  snapshotDraft = null,
  snapshotStats = null,
  onSaved = null,
} = {}) {
  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();

  const token = ++activeEditorToken;
  const isSnapshotMode = Boolean(snapshotDraft);
  const isEditMode = Boolean(bundle?.id);
  const initialSource = snapshotDraft || bundle || {};

  state.currentModalId = null;
  state.isEditModalOpen = true;

  let draftName = String(initialSource.name || '').trim();
  let draftDesc = String(initialSource.description || '').trim();
  let draftIcon = String(initialSource.icon || '').trim() || DEFAULT_BUNDLE_ICON;
  let draftItems = sortBundleItems(initialSource.items || []);

  // Im Snapshot-Modus behalten wir die Haken pro Item-Key
  const snapshotCheckedKeys = new Set(draftItems.map((it) => getBundleItemKey(it)));
  let snapshotFilterText = '';

  const activeRemoteProviders = filterUsableProviders(state.providers, {
    capability: 'search',
    excludeIds: ['archive'],
  });
  const isArchiveUsable = state.providers.length === 0 || isProviderUsable('archive');

  let activeSource = isArchiveUsable ? 'archive' : activeRemoteProviders[0]?.id || 'archive';
  let searchQuery = '';
  const remoteResultsByProvider = new Map();
  const remoteErrorsByProvider = new Map();
  const remoteHintsByProvider = new Map();
  let lastSearchedQuery = '';
  let hasSearchedRemote = false;
  let isSearchingRemote = false;
  let isSaving = false;
  let dragFromIndex = -1;
  let remoteSearchSeq = 0;
  let searchDebounceTimer = null;
  let renderedSearchEntries = [];
  let pendingSearchIconCandidates = [];
  let pendingItemIconCandidates = [];

  const isStillOpen = () => token === activeEditorToken && !overlay.hidden;

  const getExistingKeysSet = () => new Set(draftItems.map((it) => getBundleItemKey(it)));

  const getVisibleArchiveCount = () =>
    getBundleEditorArchiveCandidates(state.catalog, {
      query: '',
      visibleHiddenCats: state.settings.visibleHiddenCats || [],
      locale: getI18nLocale() || 'en',
    }).length;

  const getKnownCountForProvider = (providerId) =>
    getKnownProviderPackages(state.packages, {
      providerId,
      query: '',
      t,
      locale: getI18nLocale() || 'en',
    }).length;

  const clearPendingDebounce = () => {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  };

  const clearRemoteSearchState = () => {
    remoteResultsByProvider.clear();
    remoteErrorsByProvider.clear();
    remoteHintsByProvider.clear();
    lastSearchedQuery = '';
    hasSearchedRemote = false;
  };

  const getTargetRemoteProviderIds = () => {
    if (activeSource === 'archive') return [];
    if (activeSource === 'all') return activeRemoteProviders.map((p) => p.id);
    return activeRemoteProviders.some((p) => p.id === activeSource) ? [activeSource] : [];
  };

  const getProviderLabel = (providerId) => getLocalizedProviderName(providerId, activeRemoteProviders);

  const buildCombinedSearchView = () => {
    const q = searchQuery.trim();
    const visibleHiddenCats = state.settings.visibleHiddenCats || [];
    const locale = getI18nLocale() || 'en';
    const archiveResults =
      activeSource === 'archive' || activeSource === 'all'
        ? getBundleEditorArchiveCandidates(state.catalog, { query: q, visibleHiddenCats, locale })
        : [];

    const remoteIds = getTargetRemoteProviderIds();
    const remoteEntries = [];
    const remoteMeta = [];

    for (const providerId of remoteIds) {
      const providerName = getProviderLabel(providerId);
      const known = getKnownProviderPackages(state.packages, { providerId, query: q, t, locale });
      const hasFreshRemote = hasSearchedRemote && lastSearchedQuery === q && q.length >= 2;
      const remoteList = hasFreshRemote ? remoteResultsByProvider.get(providerId) || [] : [];
      const merged = mergeProviderEditorResults({
        knownPackages: known,
        remoteResults: remoteList,
        providerId,
      });

      remoteEntries.push(...merged);
      remoteMeta.push({
        providerId,
        providerName,
        knownCount: known.length,
        remoteCount: remoteList.length,
        hasFreshRemote,
        error: remoteErrorsByProvider.get(providerId) || '',
        hint: remoteHintsByProvider.get(providerId) || '',
      });
    }

    return {
      archiveResults,
      remoteEntries,
      remoteMeta,
      combined: [...archiveResults, ...remoteEntries],
    };
  };

  const renderSearchResultsHtml = () => {
    const existingKeys = getExistingKeysSet();
    const q = searchQuery.trim();
    const { archiveResults, remoteMeta, combined } = buildCombinedSearchView();
    renderedSearchEntries = combined;
    pendingSearchIconCandidates = [];

    const parts = [];

    // Kompakte Status-Leiste für die gewählte Quelle
    const statusSegments = [];
    if (activeSource === 'archive' || activeSource === 'all') {
      statusSegments.push(`🗄️ ${t('bundleEditor.statusArchiveCount', { count: archiveResults.length })}`);
    }
    for (const meta of remoteMeta) {
      if (meta.hasFreshRemote) {
        statusSegments.push(
          `⚡ ${t('bundleEditor.statusRemoteFresh', {
            name: meta.providerName,
            remoteCount: meta.remoteCount,
            knownCount: meta.knownCount,
          })}`
        );
      } else {
        statusSegments.push(
          `⚡ ${t('bundleEditor.statusRemoteIdle', {
            name: meta.providerName,
            knownCount: meta.knownCount,
          })}`
        );
      }
    }
    if (statusSegments.length > 0) {
      parts.push(`<div class="bundle-search-group-bar">${escapeHTML(statusSegments.join(' · '))}</div>`);
    }

    for (const meta of remoteMeta) {
      if (meta.error) {
        parts.push(
          `<div class="bundle-search-notice">⚠️ ${escapeHTML(meta.providerName)}: ${escapeHTML(meta.error)}</div>`
        );
      } else if (meta.hasFreshRemote && !isSearchingRemote && meta.remoteCount === 0) {
        const emptyMsg = meta.hint
          ? `${meta.providerName}: ${meta.hint}`
          : t('bundleEditor.remoteEmptyDefault', { name: meta.providerName, query: q });
        parts.push(`<div class="bundle-search-notice">ℹ️ ${escapeHTML(emptyMsg)}</div>`);
      }
    }

    if (isSearchingRemote) {
      const names = remoteMeta.map((m) => m.providerName).join(', ') || 'Winget';
      parts.push(
        `<div class="bundle-search-empty">⏳ ${escapeHTML(t('bundleEditor.searchingRemote', { names, query: q }))}</div>`
      );
    }

    if (combined.length === 0 && !isSearchingRemote) {
      let emptyText = t('bundleEditor.emptyNoMatches');
      if (activeSource === 'archive') {
        emptyText = q ? t('bundleEditor.emptyArchiveQuery', { query: q }) : t('bundleEditor.emptyArchiveAll');
      } else if (!q) {
        emptyText = t('bundleEditor.emptyRemoteIdle');
      } else if (q.length < 2) {
        emptyText = t('bundleEditor.emptyRemoteShort');
      } else {
        emptyText = t('bundleEditor.emptyRemoteQuery', { query: q });
      }
      parts.push(`<div class="bundle-search-empty">${escapeHTML(emptyText)}</div>`);
      return parts.join('');
    }

    parts.push(
      combined
        .map((entry, idx) => {
          const key = getBundleItemKey(entry.editorItem);
          const alreadyAdded = existingKeys.has(key);
          const isArchive = entry.providerId === 'archive';
          const badgeInfo = getLocalizedProviderBadge(entry.providerId, state.providers);
          const providerLabel = badgeInfo?.label || getProviderLabel(entry.providerId);

          const matchedPkg = isArchive
            ? state.packages.find((p) => p.inArchive && p.id === entry.packageId)
            : state.packages.find(
                (p) =>
                  String(p.packageManager || '').toLowerCase() === String(entry.providerId || '').toLowerCase() &&
                  String(p.packageId || p.wingetId || '').toLowerCase() === String(entry.packageId || '').toLowerCase()
              );
          const iconItemId = isArchive ? entry.packageId : `remote:${entry.providerId}:${entry.packageId}`;
          const iconPkgKey =
            !isArchive && entry.packageId
              ? `${String(entry.providerId).toLowerCase()}:${String(entry.packageId).toLowerCase()}`
              : '';
          const iconTarget = matchedPkg || {
            id: iconItemId,
            name: entry.name || entry.packageId,
            packageManager: isArchive ? '' : entry.providerId,
            packageId: isArchive ? entry.linkedPackageId || '' : entry.packageId || '',
            homepage: entry.homepage || '',
          };
          const iconPath = getCachedIconForPackage(iconTarget);
          if (!iconPath) {
            pendingSearchIconCandidates.push(iconTarget);
          }
          const iconHtml = iconPath
            ? `<img class="bundle-item-icon" src="${escapeHTML(toMediaUrl(iconPath))}" loading="lazy" decoding="async" alt="">`
            : `<span class="bundle-item-icon-fallback" data-icon-item-id="${escapeHTML(iconTarget.id)}" data-icon-pkg-key="${escapeHTML(iconPkgKey)}" data-icon-class="bundle-item-icon"></span>`;

          return `
            <div class="bundle-search-row">
              <div class="bundle-search-row-main">
                <div class="bundle-search-row-title">
                  ${iconHtml}
                  <strong>${escapeHTML(entry.name)}</strong>
                  <span class="provider-badge ${escapeHTML(badgeInfo?.badgeClass || (isArchive ? 'is-archive' : ''))}">${escapeHTML(providerLabel)}</span>
                  ${entry.isInstalled ? `<span class="card-chip">💻 ${escapeHTML(t('bundleEditor.badgeInstalled'))}</span>` : ''}
                  ${entry.version ? `<span class="card-chip">v${escapeHTML(entry.version)}</span>` : ''}
                </div>
                <div class="bundle-search-row-meta">
                  ${entry.linkedPackageId ? `<code>${escapeHTML(entry.linkedPackageId)}</code>` : ''}
                  ${!isArchive && entry.packageId ? `<code>${escapeHTML(entry.packageId)}</code>` : ''}
                  ${entry.shortDescription ? `<span class="muted">${escapeHTML(entry.shortDescription)}</span>` : ''}
                </div>
              </div>
              <button
                type="button"
                class="btn ${alreadyAdded ? 'btn-ghost' : 'btn-primary'} btn-xs"
                data-editor-add-idx="${idx}"
                data-editor-add-source="${escapeHTML(entry.providerId)}"
                ${alreadyAdded ? 'disabled' : ''}
              >
                ${alreadyAdded ? `✓ ${escapeHTML(t('bundleEditor.btnAdded'))}` : `➕ ${escapeHTML(t('bundleEditor.btnAdd'))}`}
              </button>
            </div>
          `;
        })
        .join('')
    );

    return parts.join('');
  };

  const updateSearchResultsDom = () => {
    if (!isStillOpen()) return;
    const resultsEl = modal.querySelector('#bundleSearchResults');
    if (resultsEl) {
      resultsEl.innerHTML = renderSearchResultsHtml();
      if (pendingSearchIconCandidates.length > 0) {
        queueItemsForIconResolution(pendingSearchIconCandidates.slice(0, 30), { prioritize: true });
      }
    }
  };

  const runRemoteSearch = async (rawQuery = searchQuery, { explicit = false } = {}) => {
    clearPendingDebounce();
    const q = String(rawQuery || '').trim();
    const targetIds = getTargetRemoteProviderIds();

    if (targetIds.length === 0) {
      clearRemoteSearchState();
      updateSearchResultsDom();
      return;
    }

    if (q.length < 2) {
      clearRemoteSearchState();
      isSearchingRemote = false;
      if (explicit) {
        showToast(t('bundleEditor.minCharsToast'), { type: 'info' });
      }
      updateSearchResultsDom();
      return;
    }

    const seq = ++remoteSearchSeq;
    isSearchingRemote = true;
    remoteErrorsByProvider.clear();
    remoteHintsByProvider.clear();
    updateSearchResultsDom();

    try {
      let byProvider = {};
      if (typeof window.electronAPI?.searchProviders === 'function') {
        const res = await window.electronAPI.searchProviders(q, {
          providerIds: targetIds,
          limit: 0,
        });
        byProvider = res?.byProvider || {};
      } else if (targetIds.includes('winget') && typeof window.electronAPI?.searchWinget === 'function') {
        const wgRes = await window.electronAPI.searchWinget(q, { limit: 0 });
        byProvider = {
          winget: {
            providerId: 'winget',
            providerName: 'Winget',
            success: Boolean(wgRes?.success),
            results: Array.isArray(wgRes?.results) ? wgRes.results : [],
            hint: wgRes?.hint || '',
            error: wgRes?.error || '',
          },
        };
      }

      if (!isStillOpen() || seq !== remoteSearchSeq) return;

      remoteResultsByProvider.clear();
      remoteErrorsByProvider.clear();
      remoteHintsByProvider.clear();

      for (const providerId of targetIds) {
        const provRes = byProvider[providerId];
        if (!provRes) {
          remoteResultsByProvider.set(providerId, []);
          continue;
        }
        remoteResultsByProvider.set(providerId, Array.isArray(provRes.results) ? provRes.results : []);
        if (!provRes.success && provRes.error) {
          remoteErrorsByProvider.set(providerId, provRes.error);
        } else if (provRes.hint) {
          remoteHintsByProvider.set(providerId, provRes.hint);
        }
      }

      isSearchingRemote = false;
      hasSearchedRemote = true;
      lastSearchedQuery = q;
      updateSearchResultsDom();
    } catch (err) {
      if (!isStillOpen() || seq !== remoteSearchSeq) return;
      isSearchingRemote = false;
      hasSearchedRemote = true;
      lastSearchedQuery = q;
      remoteResultsByProvider.clear();
      for (const providerId of targetIds) {
        remoteErrorsByProvider.set(providerId, err?.message || t('bundleEditor.searchErrorDefault'));
      }
      updateSearchResultsDom();
    }
  };

  const addEditorItem = (newItem) => {
    const key = getBundleItemKey(newItem);
    if (!key) return;
    if (getExistingKeysSet().has(key)) {
      showToast(t('bundleEditor.alreadyInBundleToast', { name: newItem.name }), { type: 'info' });
      return;
    }
    draftItems = sortBundleItems([
      ...draftItems,
      {
        ...newItem,
        order: draftItems.length + 1,
      },
    ]);
    snapshotCheckedKeys.add(key);
    render();
  };

  const renderSnapshotBannerHtml = () => {
    if (!isSnapshotMode) return '';
    const sourceCounts = new Map();
    for (const item of draftItems) {
      const src = String(item.source || 'archive').toLowerCase();
      sourceCounts.set(src, (sourceCounts.get(src) || 0) + 1);
    }
    const stats = snapshotStats || {
      includedCount: draftItems.length,
      excludedCount: 0,
    };

    const countParts = [...sourceCounts.entries()].map(([src, cnt]) => {
      const label = getLocalizedProviderBadge(src, state.providers)?.label || getProviderLabel(src);
      return `${cnt} ${label}`;
    });
    if (stats.excludedCount > 0) {
      countParts.push(t('bundleEditor.snapshotExcludedCount', { count: stats.excludedCount }));
    }

    const filterBtnsHtml = [...sourceCounts.keys()]
      .map((src) => {
        const label = getLocalizedProviderBadge(src, state.providers)?.label || getProviderLabel(src);
        return `<button type="button" class="btn btn-ghost btn-xs" data-editor-action="snap-provider" data-snap-provider="${escapeHTML(src)}">${escapeHTML(t('bundleEditor.snapshotFilterOnly', { label }))}</button>`;
      })
      .join('');

    const checkedCount = draftItems.filter((it) => snapshotCheckedKeys.has(getBundleItemKey(it))).length;

    return `
      <div class="bundle-snapshot-banner">
        <div class="bundle-snapshot-info">
          <strong>📸 ${escapeHTML(t('bundleEditor.snapshotBannerTitle'))}</strong>
          <p class="muted">
            ${escapeHTML(t('bundleEditor.snapshotBannerDesc', { count: stats.includedCount, summary: countParts.join(' · ') }))}
          </p>
        </div>
        <div class="bundle-snapshot-controls">
          <input type="text" id="bundleSnapshotFilter" value="${escapeHTML(snapshotFilterText)}" placeholder="${escapeHTML(t('bundleEditor.snapshotFilterPlaceholder'))}">
          <button type="button" class="btn btn-ghost btn-xs" data-editor-action="snap-all">${escapeHTML(t('bundleEditor.snapshotAllBtn', { count: draftItems.length }))}</button>
          <button type="button" class="btn btn-ghost btn-xs" data-editor-action="snap-none">${escapeHTML(t('bundleEditor.snapshotNoneBtn'))}</button>
          ${filterBtnsHtml}
          <span class="bundle-snapshot-counter">${escapeHTML(t('bundleEditor.snapshotCounter', { checked: checkedCount, total: draftItems.length }))}</span>
        </div>
      </div>
    `;
  };

  const renderItemsListHtml = () => {
    pendingItemIconCandidates = [];
    const filterQ = isSnapshotMode ? snapshotFilterText.trim().toLowerCase() : '';
    const visibleItems = draftItems
      .map((item, idx) => ({ item, idx }))
      .filter(({ item }) => {
        if (!filterQ) return true;
        const hay = `${item.name} ${item.packageId} ${item.refId}`.toLowerCase();
        return hay.includes(filterQ);
      });

    if (draftItems.length === 0) {
      return `
        <div class="bundle-items-empty">
          ${escapeHTML(t('bundleEditor.itemsEmpty'))}
        </div>
      `;
    }

    if (visibleItems.length === 0) {
      return `<div class="bundle-items-empty">${escapeHTML(t('bundleEditor.snapshotFilterEmpty'))}</div>`;
    }

    return visibleItems
      .map(({ item, idx }) => {
        const key = getBundleItemKey(item);
        const evalInfo = evaluateBundleItemStatus(item, state.packages, {
          versionCompareDepth: state.settings.versionCompareDepth ?? 3,
          t,
        });
        const isChecked = !isSnapshotMode || snapshotCheckedKeys.has(key);
        const itemBadge = getLocalizedProviderBadge(item.source, state.providers);

        const iconTarget = evalInfo.matchedPackage || {
          id: key,
          name: evalInfo.name || item.name,
          packageManager: item.source === 'archive' ? '' : item.source,
          packageId: item.packageId || '',
        };
        const iconPkgKey =
          item.source !== 'archive' && item.packageId
            ? `${String(item.source).toLowerCase()}:${String(item.packageId).toLowerCase()}`
            : '';
        const iconPath = getCachedIconForPackage(iconTarget);
        if (!iconPath) {
          pendingItemIconCandidates.push(iconTarget);
        }
        const itemIconHtml = iconPath
          ? `<img class="bundle-item-icon" src="${escapeHTML(toMediaUrl(iconPath))}" loading="lazy" decoding="async" alt="">`
          : `<span class="bundle-item-icon-fallback" data-icon-item-id="${escapeHTML(iconTarget.id)}" data-icon-pkg-key="${escapeHTML(iconPkgKey)}" data-icon-class="bundle-item-icon"></span>`;

        let modeHintHtml = '';
        if (evalInfo.adwareProtected) {
          modeHintHtml = `<span class="card-chip chip-install-protected" title="${escapeHTML(t('bundleEditor.chipAdwareTitle'))}">🛡️ ${escapeHTML(t('bundleEditor.chipAdwareLabel'))}</span>`;
        } else if (evalInfo.canRunArchiveSilent) {
          modeHintHtml = `<span class="card-chip chip-install-silent" title="${escapeHTML(t('bundleEditor.chipSilentTitle'))}">⚡ ${escapeHTML(t('bundleEditor.chipSilentLabel'))}</span>`;
        }

        return `
          <div class="bundle-item-row ${isChecked ? '' : 'is-unchecked'}" draggable="true" data-item-index="${idx}">
            ${
              isSnapshotMode
                ? `<label class="bundle-item-snap-check" title="${escapeHTML(t('bundleEditor.snapshotCheckboxTitle'))}"><input type="checkbox" data-snap-check-key="${escapeHTML(key)}" ${isChecked ? 'checked' : ''}></label>`
                : ''
            }
            <span class="bundle-drag-handle" title="${escapeHTML(t('bundleEditor.dragHandleTitle'))}">⠿</span>
            <span class="bundle-item-order">#${idx + 1}</span>
            <div class="bundle-item-main">
              <div class="bundle-item-title">
                ${itemIconHtml}
                <strong>${escapeHTML(evalInfo.name || item.name)}</strong>
                <span class="provider-badge ${escapeHTML(itemBadge?.badgeClass || '')}">${escapeHTML(itemBadge?.label || getProviderLabel(item.source))}</span>
                ${modeHintHtml}
              </div>
              <div class="bundle-item-meta">
                <code>${escapeHTML(item.packageId || item.refId)}</code>
                ${evalInfo.archiveMissing ? `<span class="bundle-warn-inline">⚠️ ${escapeHTML(t('bundleEditor.archiveMissingWarn'))}</span>` : ''}
              </div>
            </div>
            <label class="bundle-optional-toggle" title="${escapeHTML(t('bundleEditor.markOptionalTitle'))}">
              <input type="checkbox" data-optional-index="${idx}" ${item.optional ? 'checked' : ''}>
              <span>${escapeHTML(t('common.optional'))}</span>
            </label>
            <div class="bundle-item-order-btns">
              <button type="button" class="btn btn-ghost btn-xs" data-move-index="${idx}" data-move-dir="up" title="${escapeHTML(t('bundleEditor.moveUpTitle'))}" ${idx === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="btn btn-ghost btn-xs" data-move-index="${idx}" data-move-dir="down" title="${escapeHTML(t('bundleEditor.moveDownTitle'))}" ${idx === draftItems.length - 1 ? 'disabled' : ''}>↓</button>
              <button type="button" class="btn btn-danger btn-xs" data-remove-index="${idx}" title="${escapeHTML(t('bundleEditor.removeItemTitle'))}">✕</button>
            </div>
          </div>
        `;
      })
      .join('');
  };

  const renderSourceTabsHtml = () => {
    const tabs = [];
    if (isArchiveUsable) {
      const archiveTotal = getVisibleArchiveCount();
      tabs.push(`<button type="button" class="source-chip ${activeSource === 'archive' ? 'active' : ''}" data-search-source="archive">
        <span>🗄️</span>
        <span>${escapeHTML(t('bundleEditor.sourceArchiveCount', { count: archiveTotal }))}</span>
      </button>`);
    }
    for (const provider of activeRemoteProviders) {
      const knownCount = getKnownCountForProvider(provider.id);
      tabs.push(`<button type="button" class="source-chip ${activeSource === provider.id ? 'active' : ''}" data-search-source="${escapeHTML(provider.id)}">
        <span>⚡</span>
        <span>${escapeHTML(getLocalizedProviderName(provider))} (${knownCount})</span>
      </button>`);
    }
    if ((isArchiveUsable ? 1 : 0) + activeRemoteProviders.length > 1) {
      tabs.push(`<button type="button" class="source-chip ${activeSource === 'all' ? 'active' : ''}" data-search-source="all">
        <span>🔎</span>
        <span>${escapeHTML(t('bundleEditor.sourceAll'))}</span>
      </button>`);
    }
    if (tabs.length === 0) {
      return `<span class="muted">${escapeHTML(t('bundleEditor.noUsableSources'))}</span>`;
    }
    return tabs.join('');
  };

  const getSearchPlaceholder = () => {
    if (activeSource === 'archive') {
      return t('bundleEditor.placeholderArchive');
    }
    if (activeSource === 'all') {
      return t('bundleEditor.placeholderAll');
    }
    return t('bundleEditor.placeholderProvider', { name: getProviderLabel(activeSource) });
  };

  const render = () => {
    if (!isStillOpen()) return;

    const activeEl = document.activeElement;
    const focusId = activeEl instanceof HTMLElement ? activeEl.id : '';
    const selectionStart =
      activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement ? activeEl.selectionStart : null;
    const selectionEnd =
      activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement ? activeEl.selectionEnd : null;

    const modalTitle = isSnapshotMode
      ? `📸 ${t('bundleEditor.titleSnapshot')}`
      : isEditMode
        ? `✏️ ${t('bundleEditor.titleEdit', { name: draftName || t('bundleEditor.bundleDefaultName') })}`
        : `➕ ${t('bundleEditor.titleNew')}`;

    const saveCount = isSnapshotMode
      ? draftItems.filter((it) => snapshotCheckedKeys.has(getBundleItemKey(it))).length
      : draftItems.length;

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${escapeHTML(modalTitle)}</h2>
          <span class="muted">${escapeHTML(t('bundleEditor.headerSubtitle'))}</span>
        </div>
        <button type="button" class="icon-btn" data-editor-action="cancel" title="${escapeHTML(t('common.cancel'))}" aria-label="${escapeHTML(t('common.cancel'))}">✕</button>
      </div>

      <div class="modal-body bundle-editor-body">
        ${renderSnapshotBannerHtml()}

        <div class="bundle-meta-grid">
          <label class="form-field">
            <span>${escapeHTML(t('bundleEditor.fieldName'))}</span>
            <input type="text" id="bundleNameInput" value="${escapeHTML(draftName)}" placeholder="${escapeHTML(t('bundleEditor.fieldNamePlaceholder'))}">
          </label>
          <div class="form-field">
            <span>${escapeHTML(t('bundleEditor.fieldIcon'))}</span>
            <div class="bundle-icon-row">
              <input type="text" id="bundleIconInput" class="bundle-icon-input" value="${escapeHTML(draftIcon)}" maxlength="8">
              <div class="bundle-icon-presets">
                ${BUNDLE_ICON_PRESETS.map(
                  (em) =>
                    `<button type="button" class="bundle-icon-preset ${draftIcon === em ? 'active' : ''}" data-icon-preset="${escapeHTML(em)}">${escapeHTML(em)}</button>`
                ).join('')}
              </div>
            </div>
          </div>
        </div>

        <label class="form-field">
          <span>${escapeHTML(t('bundleEditor.fieldDescription'))}</span>
          <textarea id="bundleDescInput" rows="2" placeholder="${escapeHTML(t('bundleEditor.fieldDescriptionPlaceholder'))}">${escapeHTML(draftDesc)}</textarea>
        </label>

        <div class="bundle-search-section">
          <div class="bundle-section-head">
            <strong>➕ ${escapeHTML(t('bundleEditor.addProgramsTitle'))}</strong>
            <div class="bundle-source-toggles">
              ${renderSourceTabsHtml()}
            </div>
          </div>
          <div class="bundle-search-bar">
            <input type="text" id="bundleAddSearchInput" value="${escapeHTML(searchQuery)}" placeholder="${escapeHTML(getSearchPlaceholder())}">
            <button type="button" class="btn btn-primary" data-editor-action="search-packages">🔎 ${escapeHTML(t('common.search'))}</button>
          </div>
          <div class="bundle-search-results" id="bundleSearchResults">
            ${renderSearchResultsHtml()}
          </div>
        </div>

        <div class="bundle-items-section">
          <div class="bundle-section-head">
            <strong>📋 ${escapeHTML(t('bundleEditor.itemsSectionTitle', { count: draftItems.length }))}</strong>
            <span class="muted">${escapeHTML(t('bundleEditor.itemsSectionHint'))}</span>
          </div>
          <div class="bundle-items-list" id="bundleItemsList">
            ${renderItemsListHtml()}
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <span class="muted">${escapeHTML(t('bundleEditor.footerSummary', { count: saveCount }))}</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-editor-action="cancel" ${isSaving ? 'disabled' : ''}>${escapeHTML(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-editor-action="save" ${isSaving ? 'disabled' : ''}>
            ${isSaving ? `⏳ ${escapeHTML(t('common.saving'))}` : `💾 ${escapeHTML(t('bundleEditor.saveBtn'))}`}
          </button>
        </div>
      </div>
    `;

    const allIconCandidates = [...pendingItemIconCandidates, ...pendingSearchIconCandidates.slice(0, 30)];
    if (allIconCandidates.length > 0) {
      queueItemsForIconResolution(allIconCandidates, { prioritize: true });
    }

    // Bind input listeners without inline attributes (strict CSP)
    const nameInput = modal.querySelector('#bundleNameInput');
    if (nameInput instanceof HTMLInputElement) {
      nameInput.oninput = () => {
        draftName = nameInput.value;
      };
    }

    const iconInput = modal.querySelector('#bundleIconInput');
    if (iconInput instanceof HTMLInputElement) {
      iconInput.oninput = () => {
        draftIcon = iconInput.value.trim() || DEFAULT_BUNDLE_ICON;
      };
    }

    const descInput = modal.querySelector('#bundleDescInput');
    if (descInput instanceof HTMLTextAreaElement) {
      descInput.oninput = () => {
        draftDesc = descInput.value;
      };
    }

    const snapFilterInput = modal.querySelector('#bundleSnapshotFilter');
    if (snapFilterInput instanceof HTMLInputElement) {
      snapFilterInput.oninput = () => {
        snapshotFilterText = snapFilterInput.value;
        const listEl = modal.querySelector('#bundleItemsList');
        if (listEl) {
          listEl.innerHTML = renderItemsListHtml();
          if (pendingItemIconCandidates.length > 0) {
            queueItemsForIconResolution(pendingItemIconCandidates, { prioritize: true });
          }
        }
      };
    }

    const addSearchInput = modal.querySelector('#bundleAddSearchInput');
    if (addSearchInput instanceof HTMLInputElement) {
      addSearchInput.oninput = () => {
        searchQuery = addSearchInput.value;
        const trimmed = searchQuery.trim();
        clearPendingDebounce();

        if (activeSource !== 'archive') {
          if (trimmed.length >= 2) {
            if (trimmed !== lastSearchedQuery) {
              hasSearchedRemote = false;
            }
            updateSearchResultsDom();
            searchDebounceTimer = setTimeout(() => {
              runRemoteSearch(trimmed);
            }, 450);
          } else {
            clearRemoteSearchState();
            updateSearchResultsDom();
          }
          return;
        }

        updateSearchResultsDom();
      };

      addSearchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (activeSource === 'archive') {
            updateSearchResultsDom();
          } else {
            runRemoteSearch(searchQuery, { explicit: true });
          }
        }
      };
    }

    if (focusId) {
      const targetEl = modal.querySelector(`#${focusId}`);
      if (targetEl instanceof HTMLElement) {
        targetEl.focus();
        if (
          selectionStart !== null &&
          selectionEnd !== null &&
          (targetEl instanceof HTMLInputElement || targetEl instanceof HTMLTextAreaElement)
        ) {
          try {
            targetEl.setSelectionRange(selectionStart, selectionEnd);
          } catch {
            // Ignorieren für Input-Typen ohne SelectionRange
          }
        }
      }
    }
  };

  overlay.hidden = false;

  modal.onchange = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const snapChk = target.closest('[data-snap-check-key]');
    if (snapChk instanceof HTMLInputElement) {
      const key = snapChk.dataset.snapCheckKey;
      if (key) {
        if (snapChk.checked) snapshotCheckedKeys.add(key);
        else snapshotCheckedKeys.delete(key);
      }
      render();
      return;
    }

    const optChk = target.closest('[data-optional-index]');
    if (optChk instanceof HTMLInputElement) {
      const idx = parseInt(optChk.dataset.optionalIndex || '', 10);
      if (draftItems[idx]) {
        draftItems[idx] = { ...draftItems[idx], optional: optChk.checked };
      }
    }
  };

  modal.onclick = async (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const iconPresetBtn = target.closest('[data-icon-preset]');
    if (iconPresetBtn instanceof HTMLElement) {
      draftIcon = iconPresetBtn.dataset.iconPreset || DEFAULT_BUNDLE_ICON;
      render();
      return;
    }

    const sourceBtn = target.closest('[data-search-source]');
    if (sourceBtn instanceof HTMLElement) {
      const src = sourceBtn.dataset.searchSource || 'archive';
      if (src !== activeSource) {
        activeSource = src;
        clearPendingDebounce();
        render();
        const trimmed = searchQuery.trim();
        if (activeSource !== 'archive' && trimmed.length >= 2 && lastSearchedQuery !== trimmed) {
          await runRemoteSearch(trimmed);
        }
      }
      return;
    }

    const addBtn = target.closest('[data-editor-add-idx]');
    if (addBtn instanceof HTMLElement) {
      const idx = parseInt(addBtn.dataset.editorAddIdx || '', 10);
      const chosen = renderedSearchEntries[idx];
      if (chosen?.editorItem) {
        addEditorItem(chosen.editorItem);
      }
      return;
    }

    const moveBtn = target.closest('[data-move-index]');
    if (moveBtn instanceof HTMLElement) {
      const idx = parseInt(moveBtn.dataset.moveIndex || '', 10);
      const dir = moveBtn.dataset.moveDir;
      const targetIdx = dir === 'up' ? idx - 1 : idx + 1;
      draftItems = moveBundleItem(draftItems, idx, targetIdx);
      render();
      return;
    }

    const removeBtn = target.closest('[data-remove-index]');
    if (removeBtn instanceof HTMLElement) {
      const idx = parseInt(removeBtn.dataset.removeIndex || '', 10);
      const removed = draftItems[idx];
      if (removed) {
        snapshotCheckedKeys.delete(getBundleItemKey(removed));
      }
      draftItems = sortBundleItems(draftItems.filter((_, i) => i !== idx));
      render();
      return;
    }

    const actionBtn = target.closest('[data-editor-action]');
    if (!(actionBtn instanceof HTMLElement)) return;
    const action = actionBtn.dataset.editorAction;

    if (action === 'cancel') {
      clearPendingDebounce();
      closeModal();
      return;
    }

    if (action === 'search-packages') {
      if (activeSource === 'archive') {
        updateSearchResultsDom();
      } else {
        await runRemoteSearch(searchQuery, { explicit: true });
      }
      return;
    }

    if (action === 'snap-all') {
      for (const it of draftItems) snapshotCheckedKeys.add(getBundleItemKey(it));
      render();
      return;
    }

    if (action === 'snap-none') {
      snapshotCheckedKeys.clear();
      render();
      return;
    }

    if (action === 'snap-provider') {
      const targetProv = actionBtn.dataset.snapProvider || '';
      snapshotCheckedKeys.clear();
      for (const it of draftItems) {
        if (String(it.source || '').toLowerCase() === targetProv) snapshotCheckedKeys.add(getBundleItemKey(it));
      }
      render();
      return;
    }

    if (action === 'snap-archive') {
      snapshotCheckedKeys.clear();
      for (const it of draftItems) {
        if (it.source === 'archive') snapshotCheckedKeys.add(getBundleItemKey(it));
      }
      render();
      return;
    }

    if (action === 'snap-winget') {
      snapshotCheckedKeys.clear();
      for (const it of draftItems) {
        if (it.source === 'winget') snapshotCheckedKeys.add(getBundleItemKey(it));
      }
      render();
      return;
    }

    if (action === 'save') {
      const finalName = draftName.trim();
      if (!finalName) {
        showToast(t('bundleEditor.missingNameToast'), { type: 'warn' });
        const nameEl = modal.querySelector('#bundleNameInput');
        if (nameEl instanceof HTMLElement) nameEl.focus();
        return;
      }

      const finalItems = isSnapshotMode
        ? draftItems.filter((it) => snapshotCheckedKeys.has(getBundleItemKey(it)))
        : draftItems;

      if (finalItems.length === 0) {
        showToast(t('bundleEditor.missingItemsToast'), { type: 'warn' });
        return;
      }

      clearPendingDebounce();
      isSaving = true;
      render();

      const res = await window.electronAPI.saveBundle({
        id: bundle?.id || '',
        name: finalName,
        description: draftDesc.trim(),
        icon: draftIcon.trim() || DEFAULT_BUNDLE_ICON,
        items: sortBundleItems(finalItems),
      });

      if (!isStillOpen()) return;
      isSaving = false;

      if (res?.success) {
        await triggerCatalogReload();
        closeModal();
        showToast(t('bundleEditor.savedToast', { name: res.bundle?.name || finalName }), { type: 'success' });
        onSaved?.(res.bundle);
      } else {
        showToast(res?.error || t('bundleEditor.saveErrorToast'), { type: 'error', duration: 6000 });
        render();
      }
    }
  };

  // Drag & Drop Sortierung der Paketliste
  modal.ondragstart = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const row = target.closest('.bundle-item-row');
    if (!(row instanceof HTMLElement)) return;
    dragFromIndex = parseInt(row.dataset.itemIndex || '', 10);
    row.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragFromIndex));
    }
  };

  modal.ondragover = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const row = target.closest('.bundle-item-row');
    if (!row || dragFromIndex < 0) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    for (const el of modal.querySelectorAll('.bundle-item-row.is-drag-over')) {
      if (el !== row) el.classList.remove('is-drag-over');
    }
    row.classList.add('is-drag-over');
  };

  modal.ondragleave = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const row = target.closest('.bundle-item-row');
    if (!row) return;
    row.classList.remove('is-drag-over');
  };

  modal.ondrop = (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const row = target.closest('.bundle-item-row');
    if (!(row instanceof HTMLElement) || dragFromIndex < 0) return;
    e.preventDefault();
    const toIndex = parseInt(row.dataset.itemIndex || '', 10);
    row.classList.remove('is-drag-over');
    if (Number.isInteger(toIndex) && toIndex !== dragFromIndex) {
      draftItems = moveBundleItem(draftItems, dragFromIndex, toIndex);
      dragFromIndex = -1;
      render();
    }
  };

  modal.ondragend = () => {
    dragFromIndex = -1;
    for (const el of modal.querySelectorAll('.bundle-item-row.is-dragging, .bundle-item-row.is-drag-over')) {
      el.classList.remove('is-dragging', 'is-drag-over');
    }
  };

  render();
}
