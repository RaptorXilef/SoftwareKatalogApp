import {
  BUNDLE_ICON_PRESETS,
  DEFAULT_BUNDLE_ICON,
  evaluateBundleItemStatus,
  getBundleItemKey,
  moveBundleItem,
  sortBundleItems,
} from '../../shared/bundles-logic.js';
import { scoreCatalogItem } from '../../shared/search.js';
import { showToast } from '../components/toast.js';
import { state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';

let activeEditorToken = 0;

function toEditorItemFromCatalog(catItem) {
  return {
    source: 'archive',
    refId: catItem.id,
    packageId: catItem.packageId || catItem.wingetId || '',
    name: catItem.name,
    optional: false,
  };
}

function toEditorItemFromProvider(pkg) {
  const providerId = pkg.providerId || pkg.packageManager || 'winget';
  if (providerId === 'archive') {
    return {
      source: 'archive',
      refId: pkg.packageId || pkg.id,
      packageId: pkg.linkedPackageId || '',
      name: pkg.name || pkg.packageId,
      optional: false,
    };
  }
  return {
    source: 'winget',
    refId: '',
    packageId: pkg.packageId || pkg.id,
    name: pkg.name || pkg.packageId,
    optional: false,
  };
}

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

  let searchQuery = '';
  const searchSources = new Set(['archive', 'winget']);
  let remoteWingetResults = [];
  let isSearchingWinget = false;
  let searchError = '';
  let isSaving = false;
  let dragFromIndex = -1;
  let wingetSearchSeq = 0;

  const isStillOpen = () => token === activeEditorToken && !overlay.hidden;

  const getExistingKeysSet = () => new Set(draftItems.map((it) => getBundleItemKey(it)));

  const buildArchiveQuickMatches = () => {
    if (!searchSources.has('archive')) return [];
    const q = searchQuery.trim();
    const scored = [];
    for (const item of state.catalog) {
      const res = scoreCatalogItem(item, q);
      if (res.matched) {
        scored.push({ score: res.score, item });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'de'));
    return scored.slice(0, 20).map((entry) => ({
      providerId: 'archive',
      packageId: entry.item.id,
      linkedPackageId: entry.item.packageId || entry.item.wingetId || '',
      name: entry.item.name,
      version: entry.item.webVersion || '',
      shortDescription: entry.item.mainCategory || '',
      editorItem: toEditorItemFromCatalog(entry.item),
    }));
  };

  const runCombinedSearch = async () => {
    const q = searchQuery.trim();
    searchError = '';

    if (searchSources.size === 0) {
      showToast('Bitte mindestens eine Suchquelle (Archiv oder Winget) auswählen.', { type: 'warn' });
      return;
    }

    if (searchSources.has('winget')) {
      if (q.length < 2) {
        remoteWingetResults = [];
        if (!searchSources.has('archive')) {
          showToast('Bitte mindestens 2 Zeichen für die Winget-Suche eingeben.', { type: 'info' });
        }
        render();
        return;
      }

      const seq = ++wingetSearchSeq;
      isSearchingWinget = true;
      render();

      try {
        const res = await window.electronAPI.searchProviders(q, {
          providerIds: ['winget'],
          limit: 20,
        });
        if (!isStillOpen() || seq !== wingetSearchSeq) return;
        isSearchingWinget = false;
        const wgRes = res?.byProvider?.winget;
        if (wgRes && !wgRes.success && wgRes.error) {
          searchError = wgRes.error;
        }
        remoteWingetResults = Array.isArray(wgRes?.results) ? wgRes.results : [];
      } catch (err) {
        if (!isStillOpen() || seq !== wingetSearchSeq) return;
        isSearchingWinget = false;
        remoteWingetResults = [];
        searchError = err.message;
      }
      render();
      return;
    }

    remoteWingetResults = [];
    render();
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

  const renderSearchResultsHtml = () => {
    const existingKeys = getExistingKeysSet();
    const archiveResults = buildArchiveQuickMatches();
    const wingetResults = searchSources.has('winget')
      ? remoteWingetResults.map((pkg) => ({
          providerId: 'winget',
          packageId: pkg.packageId || pkg.id,
          name: pkg.name || pkg.packageId,
          version: pkg.version || '',
          shortDescription: pkg.shortDescription || '',
          editorItem: toEditorItemFromProvider({ ...pkg, providerId: 'winget' }),
        }))
      : [];

    const combined = [...archiveResults, ...wingetResults];
    const parts = [];

    if (searchError) {
      parts.push(`<div class="bundle-search-notice">Winget: ${escapeHTML(searchError)}</div>`);
    }
    if (isSearchingWinget) {
      parts.push('<div class="bundle-search-empty">⏳ Durchsuche Winget...</div>');
    }

    if (combined.length === 0 && !isSearchingWinget) {
      parts.push(
        `<div class="bundle-search-empty">${
          searchQuery.trim()
            ? 'Keine passenden Programme gefunden. Bei Winget Enter oder „Suchen“ drücken.'
            : 'Tippe einen Programmnamen ein (Archiv wird live gefiltert, Winget per Enter / Suchen).'
        }</div>`
      );
      return parts.join('');
    }

    parts.push(
      combined
        .map((entry, idx) => {
          const key = getBundleItemKey(entry.editorItem);
          const alreadyAdded = existingKeys.has(key);
          const isArchive = entry.providerId === 'archive';
          return `
            <div class="bundle-search-row">
              <div class="bundle-search-row-main">
                <div class="bundle-search-row-title">
                  <strong>${escapeHTML(entry.name)}</strong>
                  <span class="provider-badge ${isArchive ? 'is-archive' : ''}">${isArchive ? 'Archiv' : 'Winget'}</span>
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
            '<span class="card-chip chip-install-protected" title="Adware-Schutz aktiv – wird immer interaktiv am Ende ausgeführt">🛡️ Adware-Schutz</span>';
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
                <span class="provider-badge ${isArchive ? 'is-archive' : ''}">${isArchive ? 'Archiv' : 'Winget'}</span>
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

  const render = () => {
    if (!isStillOpen()) return;

    const focusId = document.activeElement?.id || '';
    const selectionStart = document.activeElement?.selectionStart ?? null;
    const selectionEnd = document.activeElement?.selectionEnd ?? null;

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
            <strong>➕ Programme hinzufügen (Archiv + Winget)</strong>
            <div class="bundle-source-toggles">
              <button type="button" class="source-chip ${searchSources.has('archive') ? 'active' : ''}" data-search-source="archive">
                <span>${searchSources.has('archive') ? '✓' : '+'}</span>
                <span>Archiv</span>
              </button>
              <button type="button" class="source-chip ${searchSources.has('winget') ? 'active' : ''}" data-search-source="winget">
                <span>${searchSources.has('winget') ? '✓' : '+'}</span>
                <span>Winget</span>
              </button>
            </div>
          </div>
          <div class="bundle-search-bar">
            <input type="text" id="bundleAddSearchInput" value="${escapeHTML(searchQuery)}" placeholder="Programmname oder Winget-ID eingeben (Enter für Winget-Suche)...">
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
    if (nameInput) {
      nameInput.oninput = () => {
        draftName = nameInput.value;
      };
    }

    const iconInput = modal.querySelector('#bundleIconInput');
    if (iconInput) {
      iconInput.oninput = () => {
        draftIcon = iconInput.value.trim() || DEFAULT_BUNDLE_ICON;
      };
    }

    const descInput = modal.querySelector('#bundleDescInput');
    if (descInput) {
      descInput.oninput = () => {
        draftDesc = descInput.value;
      };
    }

    const snapFilterInput = modal.querySelector('#bundleSnapshotFilter');
    if (snapFilterInput) {
      snapFilterInput.oninput = () => {
        snapshotFilterText = snapFilterInput.value;
        const listEl = modal.querySelector('#bundleItemsList');
        if (listEl) listEl.innerHTML = renderItemsListHtml();
      };
    }

    const addSearchInput = modal.querySelector('#bundleAddSearchInput');
    if (addSearchInput) {
      addSearchInput.oninput = () => {
        searchQuery = addSearchInput.value;
        const resultsEl = modal.querySelector('#bundleSearchResults');
        if (resultsEl) resultsEl.innerHTML = renderSearchResultsHtml();
      };
      addSearchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          runCombinedSearch();
        }
      };
    }

    if (focusId) {
      const targetEl = modal.querySelector(`#${focusId}`);
      if (targetEl && typeof targetEl.focus === 'function') {
        targetEl.focus();
        if (selectionStart !== null && typeof targetEl.setSelectionRange === 'function') {
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
    const snapChk = e.target.closest('[data-snap-check-key]');
    if (snapChk) {
      const key = snapChk.dataset.snapCheckKey;
      if (snapChk.checked) snapshotCheckedKeys.add(key);
      else snapshotCheckedKeys.delete(key);
      render();
      return;
    }

    const optChk = e.target.closest('[data-optional-index]');
    if (optChk) {
      const idx = parseInt(optChk.dataset.optionalIndex, 10);
      if (draftItems[idx]) {
        draftItems[idx] = { ...draftItems[idx], optional: optChk.checked };
      }
    }
  };

  modal.onclick = async (e) => {
    const iconPresetBtn = e.target.closest('[data-icon-preset]');
    if (iconPresetBtn) {
      draftIcon = iconPresetBtn.dataset.iconPreset || DEFAULT_BUNDLE_ICON;
      render();
      return;
    }

    const sourceBtn = e.target.closest('[data-search-source]');
    if (sourceBtn) {
      const src = sourceBtn.dataset.searchSource;
      if (searchSources.has(src)) searchSources.delete(src);
      else searchSources.add(src);
      render();
      return;
    }

    const addBtn = e.target.closest('[data-editor-add-idx]');
    if (addBtn) {
      const idx = parseInt(addBtn.dataset.editorAddIdx, 10);
      const combined = [
        ...buildArchiveQuickMatches(),
        ...(searchSources.has('winget')
          ? remoteWingetResults.map((pkg) => ({
              editorItem: toEditorItemFromProvider({ ...pkg, providerId: 'winget' }),
            }))
          : []),
      ];
      const chosen = combined[idx];
      if (chosen?.editorItem) {
        addEditorItem(chosen.editorItem);
      }
      return;
    }

    const moveBtn = e.target.closest('[data-move-index]');
    if (moveBtn) {
      const idx = parseInt(moveBtn.dataset.moveIndex, 10);
      const dir = moveBtn.dataset.moveDir;
      const targetIdx = dir === 'up' ? idx - 1 : idx + 1;
      draftItems = moveBundleItem(draftItems, idx, targetIdx);
      render();
      return;
    }

    const removeBtn = e.target.closest('[data-remove-index]');
    if (removeBtn) {
      const idx = parseInt(removeBtn.dataset.removeIndex, 10);
      const removed = draftItems[idx];
      if (removed) {
        snapshotCheckedKeys.delete(getBundleItemKey(removed));
      }
      draftItems = sortBundleItems(draftItems.filter((_, i) => i !== idx));
      render();
      return;
    }

    const actionBtn = e.target.closest('[data-editor-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.editorAction;

    if (action === 'cancel') {
      closeModal();
      return;
    }

    if (action === 'search-packages') {
      await runCombinedSearch();
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
        modal.querySelector('#bundleNameInput')?.focus();
        return;
      }

      const finalItems = isSnapshotMode
        ? draftItems.filter((it) => snapshotCheckedKeys.has(getBundleItemKey(it)))
        : draftItems;

      if (finalItems.length === 0) {
        showToast('Bitte mindestens ein Programm im Bündel auswählen.', { type: 'warn' });
        return;
      }

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
    const row = e.target.closest('.bundle-item-row');
    if (!row) return;
    dragFromIndex = parseInt(row.dataset.itemIndex, 10);
    row.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragFromIndex));
    }
  };

  modal.ondragover = (e) => {
    const row = e.target.closest('.bundle-item-row');
    if (!row || dragFromIndex < 0) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    for (const el of modal.querySelectorAll('.bundle-item-row.is-drag-over')) {
      if (el !== row) el.classList.remove('is-drag-over');
    }
    row.classList.add('is-drag-over');
  };

  modal.ondragleave = (e) => {
    const row = e.target.closest('.bundle-item-row');
    if (!row) return;
    row.classList.remove('is-drag-over');
  };

  modal.ondrop = (e) => {
    const row = e.target.closest('.bundle-item-row');
    if (!row || dragFromIndex < 0) return;
    e.preventDefault();
    const toIndex = parseInt(row.dataset.itemIndex, 10);
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
