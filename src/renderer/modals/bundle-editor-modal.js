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
import { showToast } from '../components/toast.js';
import { isProviderUsable, state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';
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

  const isStillOpen = () => token === activeEditorToken && !overlay.hidden;

  const getExistingKeysSet = () => new Set(draftItems.map((it) => getBundleItemKey(it)));

  const getVisibleArchiveCount = () =>
    getBundleEditorArchiveCandidates(state.catalog, {
      query: '',
      visibleHiddenCats: state.settings.visibleHiddenCats || [],
    }).length;

  const getKnownCountForProvider = (providerId) =>
    getKnownProviderPackages(state.packages, { providerId, query: '' }).length;

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

  const getProviderLabel = (providerId) => {
    if (providerId === 'archive') return 'Archiv';
    const found = activeRemoteProviders.find((p) => p.id === providerId);
    return found?.name || (providerId === 'winget' ? 'Winget' : providerId);
  };

  const buildCombinedSearchView = () => {
    const q = searchQuery.trim();
    const visibleHiddenCats = state.settings.visibleHiddenCats || [];
    const archiveResults =
      activeSource === 'archive' || activeSource === 'all'
        ? getBundleEditorArchiveCandidates(state.catalog, { query: q, visibleHiddenCats })
        : [];

    const remoteIds = getTargetRemoteProviderIds();
    const remoteEntries = [];
    const remoteMeta = [];

    for (const providerId of remoteIds) {
      const providerName = getProviderLabel(providerId);
      const known = getKnownProviderPackages(state.packages, { providerId, query: q });
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

    const parts = [];

    // Kompakte Status-Leiste für die gewählte Quelle
    const statusSegments = [];
    if (activeSource === 'archive' || activeSource === 'all') {
      statusSegments.push(`🗄️ Archiv: ${archiveResults.length} Programme`);
    }
    for (const meta of remoteMeta) {
      if (meta.hasFreshRemote) {
        statusSegments.push(`⚡ ${meta.providerName}: ${meta.remoteCount} Suchtreffer (${meta.knownCount} bekannt)`);
      } else {
        statusSegments.push(
          `⚡ ${meta.providerName}: ${meta.knownCount} bekannte/installierte Pakete · Suchbegriff eingeben für Online-Suche`
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
          : `${meta.providerName} hat für "${q}" keine Pakete gefunden.`;
        parts.push(`<div class="bundle-search-notice">ℹ️ ${escapeHTML(emptyMsg)}</div>`);
      }
    }

    if (isSearchingRemote) {
      const names = remoteMeta.map((m) => m.providerName).join(', ') || 'Winget';
      parts.push(
        `<div class="bundle-search-empty">⏳ Durchsuche ${escapeHTML(names)} nach "${escapeHTML(q)}"...</div>`
      );
    }

    if (combined.length === 0 && !isSearchingRemote) {
      let emptyText = 'Keine passenden Programme gefunden.';
      if (activeSource === 'archive') {
        emptyText = q ? `Keine Archiv-Programme für "${q}" gefunden.` : 'Keine Programme im Archiv vorhanden.';
      } else if (!q) {
        emptyText = 'Noch keine bekannten Pakete vorhanden. Tippe mindestens 2 Zeichen für die Online-Suche.';
      } else if (q.length < 2) {
        emptyText = 'Bitte mindestens 2 Zeichen für die Online-Suche eingeben.';
      } else {
        emptyText = `Keine Treffer für "${q}" gefunden.`;
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
          const providerLabel = getProviderLabel(entry.providerId);
          return `
            <div class="bundle-search-row">
              <div class="bundle-search-row-main">
                <div class="bundle-search-row-title">
                  <strong>${escapeHTML(entry.name)}</strong>
                  <span class="provider-badge ${isArchive ? 'is-archive' : ''}">${escapeHTML(providerLabel)}</span>
                  ${entry.isInstalled ? '<span class="card-chip">💻 Installiert</span>' : ''}
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
                ${alreadyAdded ? '✓ Enthalten' : '➕ Hinzufügen'}
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
        showToast('Bitte mindestens 2 Zeichen für die Paketmanager-Suche eingeben.', { type: 'info' });
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
        remoteErrorsByProvider.set(providerId, err?.message || 'Suchfehler');
      }
      updateSearchResultsDom();
    }
  };

  const addEditorItem = (newItem) => {
    const key = getBundleItemKey(newItem);
    if (!key) return;
    if (getExistingKeysSet().has(key)) {
      showToast(`"${newItem.name}" ist bereits im Bündel enthalten.`, { type: 'info' });
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
    const stats = snapshotStats || {
      includedCount: draftItems.length,
      archiveCount: draftItems.filter((i) => i.source === 'archive').length,
      wingetCount: draftItems.filter((i) => i.source === 'winget').length,
      excludedCount: 0,
    };

    const checkedCount = draftItems.filter((it) => snapshotCheckedKeys.has(getBundleItemKey(it))).length;

    return `
      <div class="bundle-snapshot-banner">
        <div class="bundle-snapshot-info">
          <strong>📸 1-Klick-Snapshot dieses PCs</strong>
          <p class="muted">
            ${stats.includedCount} übernehmbare Programme erkannt (${stats.archiveCount} Archiv · ${stats.wingetCount} Winget${
              stats.excludedCount > 0 ? ` · ${stats.excludedCount} ohne Quelle ausgelassen` : ''
            }). Hake ab, was ins Bündel soll.
          </p>
        </div>
        <div class="bundle-snapshot-controls">
          <input type="text" id="bundleSnapshotFilter" value="${escapeHTML(snapshotFilterText)}" placeholder="Snapshot-Liste filtern...">
          <button type="button" class="btn btn-ghost btn-xs" data-editor-action="snap-all">Alle (${draftItems.length})</button>
          <button type="button" class="btn btn-ghost btn-xs" data-editor-action="snap-none">Keine</button>
          <button type="button" class="btn btn-ghost btn-xs" data-editor-action="snap-archive">Nur Archiv</button>
          <button type="button" class="btn btn-ghost btn-xs" data-editor-action="snap-winget">Nur Winget</button>
          <span class="bundle-snapshot-counter"><strong>${checkedCount}</strong> von ${draftItems.length} gewählt</span>
        </div>
      </div>
    `;
  };

  const renderItemsListHtml = () => {
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
          Noch keine Programme im Bündel. Füge oben Programme über die Archiv- &amp; Winget-Suche hinzu.
        </div>
      `;
    }

    if (visibleItems.length === 0) {
      return '<div class="bundle-items-empty">Keine Programme im Snapshot entsprechen dem Filter.</div>';
    }

    return visibleItems
      .map(({ item, idx }) => {
        const key = getBundleItemKey(item);
        const evalInfo = evaluateBundleItemStatus(item, state.packages, {
          versionCompareDepth: state.settings.versionCompareDepth ?? 3,
        });
        const isChecked = !isSnapshotMode || snapshotCheckedKeys.has(key);
        const isArchive = item.source === 'archive';

        let modeHintHtml = '';
        if (evalInfo.adwareProtected) {
          modeHintHtml =
            '<span class="card-chip chip-install-protected" title="Adware-Schutz aktiv - wird immer interaktiv am Ende ausgeführt">🛡️ Adware-Schutz</span>';
        } else if (evalInfo.canRunArchiveSilent) {
          modeHintHtml =
            '<span class="card-chip chip-install-silent" title="Stille Archiv-Installation konfiguriert">⚡ Silent</span>';
        }

        return `
          <div class="bundle-item-row ${isChecked ? '' : 'is-unchecked'}" draggable="true" data-item-index="${idx}">
            ${
              isSnapshotMode
                ? `<label class="bundle-item-snap-check" title="Ins Bündel übernehmen"><input type="checkbox" data-snap-check-key="${escapeHTML(key)}" ${isChecked ? 'checked' : ''}></label>`
                : ''
            }
            <span class="bundle-drag-handle" title="Per Drag & Drop oder Pfeiltasten sortieren">⠿</span>
            <span class="bundle-item-order">#${idx + 1}</span>
            <div class="bundle-item-main">
              <div class="bundle-item-title">
                <strong>${escapeHTML(item.name)}</strong>
                <span class="provider-badge ${isArchive ? 'is-archive' : ''}">${isArchive ? 'Archiv' : escapeHTML(getProviderLabel(item.source))}</span>
                ${modeHintHtml}
              </div>
              <div class="bundle-item-meta">
                <code>${escapeHTML(item.packageId || item.refId)}</code>
                ${evalInfo.archiveMissing ? '<span class="bundle-warn-inline">⚠️ Nicht im lokalen Archiv gefunden</span>' : ''}
              </div>
            </div>
            <label class="bundle-optional-toggle" title="Als optional markieren">
              <input type="checkbox" data-optional-index="${idx}" ${item.optional ? 'checked' : ''}>
              <span>Optional</span>
            </label>
            <div class="bundle-item-order-btns">
              <button type="button" class="btn btn-ghost btn-xs" data-move-index="${idx}" data-move-dir="up" title="Nach oben (früher installieren)" ${idx === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="btn btn-ghost btn-xs" data-move-index="${idx}" data-move-dir="down" title="Nach unten (später installieren)" ${idx === draftItems.length - 1 ? 'disabled' : ''}>↓</button>
              <button type="button" class="btn btn-danger btn-xs" data-remove-index="${idx}" title="Aus Bündel entfernen">✕</button>
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
        <span>Archiv (${archiveTotal})</span>
      </button>`);
    }
    for (const provider of activeRemoteProviders) {
      const knownCount = getKnownCountForProvider(provider.id);
      tabs.push(`<button type="button" class="source-chip ${activeSource === provider.id ? 'active' : ''}" data-search-source="${escapeHTML(provider.id)}">
        <span>⚡</span>
        <span>${escapeHTML(provider.name)} (${knownCount})</span>
      </button>`);
    }
    if ((isArchiveUsable ? 1 : 0) + activeRemoteProviders.length > 1) {
      tabs.push(`<button type="button" class="source-chip ${activeSource === 'all' ? 'active' : ''}" data-search-source="all">
        <span>🔎</span>
        <span>Alle Quellen</span>
      </button>`);
    }
    if (tabs.length === 0) {
      return '<span class="muted">Keine aktiven &amp; installierten Paketquellen verfügbar.</span>';
    }
    return tabs.join('');
  };

  const getSearchPlaceholder = () => {
    if (activeSource === 'archive') {
      return 'Archiv-Programme filtern (Name, Kategorie, Winget-ID)...';
    }
    if (activeSource === 'all') {
      return 'Archiv filtern & Online-Suche in Paketmanagern starten (z. B. vlc, 7zip)...';
    }
    return `In ${getProviderLabel(activeSource)} suchen (z. B. vlc, firefox, VideoLAN.VLC)...`;
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
      ? '📸 Bündel aus diesem PC erstellen'
      : isEditMode
        ? `✏️ Bündel bearbeiten: ${draftName || 'Bündel'}`
        : '➕ Neues Bündel erstellen';

    const saveCount = isSnapshotMode
      ? draftItems.filter((it) => snapshotCheckedKeys.has(getBundleItemKey(it))).length
      : draftItems.length;

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${escapeHTML(modalTitle)}</h2>
          <span class="muted">Reihenfolge anpassen (z. B. Runtimes nach oben) · Gespeichert in <code>data/bundles.json</code></span>
        </div>
        <button type="button" class="icon-btn" data-editor-action="cancel" title="Abbrechen" aria-label="Abbrechen">✕</button>
      </div>

      <div class="modal-body bundle-editor-body">
        ${renderSnapshotBannerHtml()}

        <div class="bundle-meta-grid">
          <label class="form-field">
            <span>Bündel-Name</span>
            <input type="text" id="bundleNameInput" value="${escapeHTML(draftName)}" placeholder="z. B. Basis-Setup neuer PC">
          </label>
          <div class="form-field">
            <span>Icon</span>
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
          <span>Beschreibung (optional)</span>
          <textarea id="bundleDescInput" rows="2" placeholder="Wofür ist dieses Bündel gedacht?">${escapeHTML(draftDesc)}</textarea>
        </label>

        <div class="bundle-search-section">
          <div class="bundle-section-head">
            <strong>➕ Programme hinzufügen</strong>
            <div class="bundle-source-toggles">
              ${renderSourceTabsHtml()}
            </div>
          </div>
          <div class="bundle-search-bar">
            <input type="text" id="bundleAddSearchInput" value="${escapeHTML(searchQuery)}" placeholder="${escapeHTML(getSearchPlaceholder())}">
            <button type="button" class="btn btn-primary" data-editor-action="search-packages">🔎 Suchen</button>
          </div>
          <div class="bundle-search-results" id="bundleSearchResults">
            ${renderSearchResultsHtml()}
          </div>
        </div>

        <div class="bundle-items-section">
          <div class="bundle-section-head">
            <strong>📋 Reihenfolge &amp; enthaltene Programme (${draftItems.length})</strong>
            <span class="muted">Per ↑/↓ oder Drag &amp; Drop sortieren · Stille Pakete laufen bei Installation zuerst</span>
          </div>
          <div class="bundle-items-list" id="bundleItemsList">
            ${renderItemsListHtml()}
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <span class="muted">${saveCount} Paket(e) werden im Bündel gespeichert</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-editor-action="cancel" ${isSaving ? 'disabled' : ''}>Abbrechen</button>
          <button type="button" class="btn btn-primary" data-editor-action="save" ${isSaving ? 'disabled' : ''}>
            ${isSaving ? '⏳ Speichere...' : '💾 Bündel speichern'}
          </button>
        </div>
      </div>
    `;

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
        if (listEl) listEl.innerHTML = renderItemsListHtml();
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
        showToast('Bitte einen Bündel-Namen eingeben.', { type: 'warn' });
        const nameEl = modal.querySelector('#bundleNameInput');
        if (nameEl instanceof HTMLElement) nameEl.focus();
        return;
      }

      const finalItems = isSnapshotMode
        ? draftItems.filter((it) => snapshotCheckedKeys.has(getBundleItemKey(it)))
        : draftItems;

      if (finalItems.length === 0) {
        showToast('Bitte mindestens ein Programm im Bündel auswählen.', { type: 'warn' });
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
        showToast(`Bündel "${res.bundle?.name || finalName}" gespeichert.`, { type: 'success' });
        onSaved?.(res.bundle);
      } else {
        showToast(res?.error || 'Bündel konnte nicht gespeichert werden.', { type: 'error', duration: 6000 });
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
