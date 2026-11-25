import {
  buildDevBundleDraftFromProject,
  DEFAULT_DEV_BUNDLE_ICON,
  DEV_BUNDLE_ICON_PRESETS,
  DEV_BUNDLE_MANAGERS,
  dedupeDevBundlePackages,
  getDevBundleRegistryLabel,
  moveDevBundlePackage,
  normalizeDevBundlePkgKey,
} from '../../shared/dev-bundles-logic.js';
import { isValidDevPackageName } from '../../shared/dev-projects-logic.js';
import { getDevManagerMeta } from '../../shared/dev-ui-logic.js';
import { showToast } from '../components/toast.js';
import { refreshDevBundles, state } from '../state.js';
import { closestEl, closestInput, qs, qsInput, qsTextarea } from '../utils/dom.js';
import { t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';
import { closeModal, resetModalContent } from './index.js';

let activeEditorToken = 0;

/**
 * Oeffnet das Modal zum Erstellen, Bearbeiten oder Snapshot-Erzeugen eines Dev-Buendels.
 * @param {{
 *   bundle?: Record<string, any> | null,
 *   snapshotDraft?: Record<string, any> | null,
 *   snapshotStats?: Record<string, any> | null,
 *   project?: Record<string, any> | null,
 *   projectScan?: Record<string, any> | null,
 *   defaultManager?: string,
 *   onSaved?: ((bundle: any) => void) | null,
 * }} [options]
 */
export function renderDevBundleEditorModal({
  bundle = null,
  snapshotDraft = null,
  snapshotStats = null,
  project = null,
  projectScan = null,
  defaultManager = 'npm',
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

  const initMgrRaw = String(initialSource.manager || defaultManager || 'npm')
    .trim()
    .toLowerCase();
  let draftManager = DEV_BUNDLE_MANAGERS.includes(initMgrRaw) ? initMgrRaw : 'npm';
  let draftName = String(initialSource.name || '').trim();
  let draftDesc = String(initialSource.description || '').trim();
  let draftIcon = String(initialSource.icon || '').trim() || DEFAULT_DEV_BUNDLE_ICON;
  let draftPackages = dedupeDevBundlePackages(initialSource.packages || [], draftManager);

  const snapshotCheckedKeys = new Set(
    draftPackages.map((p) => normalizeDevBundlePkgKey(draftManager, p.name)).filter(Boolean)
  );
  let snapshotFilterText = '';
  let activeSnapshotStats = snapshotStats || null;

  let searchQuery = '';
  let searchAddAsDev = false;
  let searchResults = [];
  let searchError = '';
  let lastSearchedKey = '';
  let hasSearched = false;
  let isSearching = false;
  let isSaving = false;
  let dragFromIndex = -1;
  let searchSeq = 0;
  let searchDebounceTimer = null;

  const isStillOpen = () => token === activeEditorToken && !overlay.hidden;

  const clearPendingDebounce = () => {
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
  };

  const getExistingPkgKeys = () =>
    new Set(draftPackages.map((p) => normalizeDevBundlePkgKey(draftManager, p.name)).filter(Boolean));

  const renderManagerChipsHtml = () => {
    const detectedSet = new Set(
      (Array.isArray(projectScan?.managers) ? projectScan.managers : []).map((m) => {
        const clean = String(m || '').toLowerCase();
        return clean === 'yarn' ? 'npm' : clean;
      })
    );
    return DEV_BUNDLE_MANAGERS.map((mgr) => {
      const meta = getDevManagerMeta(mgr);
      const registryLabel = getDevBundleRegistryLabel(mgr);
      const isDetected = detectedSet.has(mgr);
      return `
        <button
          type="button"
          class="source-chip ${mgr === draftManager ? 'active' : ''}"
          data-dev-bundle-mgr="${escapeHTML(mgr)}"
          ${isEditMode ? 'disabled' : ''}
          title="${escapeHTML(`${meta.label} (${registryLabel})`)}"
        >
          <span>${escapeHTML(meta.label)}</span>
          <span class="dev-bundle-mgr-registry">${escapeHTML(registryLabel)}</span>
          ${isDetected ? `<span class="dev-chip-detected-tag">${escapeHTML(t('dev.workspace.discoverInProjectTag'))}</span>` : ''}
        </button>
      `;
    }).join('');
  };

  const renderSearchResultsHtml = () => {
    const mgrMeta = getDevManagerMeta(draftManager);
    const registryLabel = getDevBundleRegistryLabel(draftManager);
    const q = searchQuery.trim();
    const existingKeys = getExistingPkgKeys();
    const parts = [];

    if (q && isValidDevPackageName(draftManager, q)) {
      const directKey = normalizeDevBundlePkgKey(draftManager, q);
      const already = existingKeys.has(directKey);
      parts.push(`
        <div class="bundle-search-row dev-bundle-direct-add-row">
          <div class="bundle-search-row-main">
            <div class="bundle-search-row-title">
              <strong>${escapeHTML(q)}</strong>
              <span class="provider-badge ${escapeHTML(mgrMeta.badgeClass)}">${escapeHTML(mgrMeta.label)}</span>
              <span class="card-chip">${escapeHTML(t('dev.bundleEditor.directAddBadge'))}</span>
            </div>
          </div>
          <button
            type="button"
            class="btn ${already ? 'btn-ghost' : 'btn-primary'} btn-xs"
            data-dev-editor-direct-add="${escapeHTML(q)}"
            ${already ? 'disabled' : ''}
          >${already ? `✓ ${escapeHTML(t('bundleEditor.btnAdded'))}` : `➕ ${escapeHTML(t('bundleEditor.btnAdd'))}`}</button>
        </div>
      `);
    }

    if (isSearching) {
      parts.push(
        `<div class="bundle-search-empty">⏳ ${escapeHTML(t('dev.bundleEditor.searchingRegistry', { registry: registryLabel, query: q }))}</div>`
      );
      return parts.join('');
    }

    if (searchError) {
      parts.push(`<div class="bundle-search-notice">⚠️ ${escapeHTML(searchError)}</div>`);
    }

    if (searchResults.length === 0) {
      if (!q) {
        parts.push(
          `<div class="bundle-search-empty">${escapeHTML(t('dev.bundleEditor.searchIdle', { registry: registryLabel }))}</div>`
        );
      } else if (q.length < 2) {
        parts.push(`<div class="bundle-search-empty">${escapeHTML(t('bundleEditor.emptyRemoteShort'))}</div>`);
      } else if (hasSearched) {
        parts.push(
          `<div class="bundle-search-empty">${escapeHTML(t('bundleEditor.emptyRemoteQuery', { query: q }))}</div>`
        );
      }
      return parts.join('');
    }

    parts.push(
      searchResults
        .map((pkg, idx) => {
          const pkgName = String(pkg.packageId || pkg.id || pkg.name || '').trim();
          const key = normalizeDevBundlePkgKey(draftManager, pkgName);
          const alreadyAdded = existingKeys.has(key);
          return `
            <div class="bundle-search-row">
              <div class="bundle-search-row-main">
                <div class="bundle-search-row-title">
                  <strong>${escapeHTML(pkg.name || pkgName)}</strong>
                  <span class="provider-badge ${escapeHTML(mgrMeta.badgeClass)}">${escapeHTML(mgrMeta.label)}</span>
                  ${pkg.version ? `<span class="card-chip">v${escapeHTML(pkg.version)}</span>` : ''}
                </div>
                <div class="bundle-search-row-meta">
                  <code>${escapeHTML(pkgName)}</code>
                  ${pkg.shortDescription ? `<span class="muted">${escapeHTML(pkg.shortDescription)}</span>` : ''}
                </div>
              </div>
              <button
                type="button"
                class="btn ${alreadyAdded ? 'btn-ghost' : 'btn-primary'} btn-xs"
                data-dev-editor-add-idx="${idx}"
                ${alreadyAdded ? 'disabled' : ''}
              >${alreadyAdded ? `✓ ${escapeHTML(t('bundleEditor.btnAdded'))}` : `➕ ${escapeHTML(t('bundleEditor.btnAdd'))}`}</button>
            </div>
          `;
        })
        .join('')
    );

    return parts.join('');
  };

  const updateSearchResultsDom = () => {
    if (!isStillOpen()) return;
    const host = qs(modal, '#devBundleSearchResults');
    if (host) {
      host.innerHTML = renderSearchResultsHtml();
    }
  };

  const runRegistrySearch = async (rawQuery = searchQuery, { explicit = false } = {}) => {
    clearPendingDebounce();
    const q = String(rawQuery || '').trim();
    if (q.length < 2) {
      isSearching = false;
      hasSearched = false;
      searchResults = [];
      searchError = '';
      lastSearchedKey = '';
      if (explicit) {
        showToast(t('bundleEditor.minCharsToast'), { type: 'info' });
      }
      updateSearchResultsDom();
      return;
    }

    const reqKey = `${draftManager}:${q}`;
    const seq = ++searchSeq;
    isSearching = true;
    searchError = '';
    updateSearchResultsDom();

    try {
      const res = await window.electronAPI.devSearchPackages(draftManager, q, { limit: 25 });
      if (!isStillOpen() || seq !== searchSeq) return;
      isSearching = false;
      hasSearched = true;
      lastSearchedKey = reqKey;
      if (res?.success) {
        searchResults = Array.isArray(res.results) ? res.results : [];
        searchError = '';
      } else if (!res?.canceled) {
        searchResults = [];
        searchError = res?.error || t('bundleEditor.searchErrorDefault');
      }
      updateSearchResultsDom();
    } catch (err) {
      if (!isStillOpen() || seq !== searchSeq) return;
      isSearching = false;
      hasSearched = true;
      lastSearchedKey = reqKey;
      searchResults = [];
      searchError = err?.message || t('bundleEditor.searchErrorDefault');
      updateSearchResultsDom();
    }
  };

  const addPackageToDraft = (rawName, version = '') => {
    const cleanName = String(rawName || '').trim();
    if (!isValidDevPackageName(draftManager, cleanName)) {
      showToast(t('dev.bundleEditor.invalidPackageToast', { name: cleanName, manager: draftManager }), {
        type: 'warn',
      });
      return;
    }
    const key = normalizeDevBundlePkgKey(draftManager, cleanName);
    if (getExistingPkgKeys().has(key)) {
      showToast(t('bundleEditor.alreadyInBundleToast', { name: cleanName }), { type: 'info' });
      return;
    }
    const supportsDev = getDevManagerMeta(draftManager).supportsDevScope;
    const nextPkg = {
      name: cleanName,
      version: String(version || '').trim(),
      isDev: Boolean(supportsDev && searchAddAsDev),
      optional: false,
    };
    draftPackages = dedupeDevBundlePackages([...draftPackages, nextPkg], draftManager);
    snapshotCheckedKeys.add(key);
    render();
  };

  const renderSnapshotBannerHtml = () => {
    if (!isSnapshotMode) return '';
    const stats = activeSnapshotStats || {
      totalCount: draftPackages.length,
      prodCount: draftPackages.filter((p) => !p.isDev).length,
      devCount: draftPackages.filter((p) => p.isDev).length,
    };
    const checkedCount = draftPackages.filter((p) =>
      snapshotCheckedKeys.has(normalizeDevBundlePkgKey(draftManager, p.name))
    ).length;

    return `
      <div class="bundle-snapshot-banner">
        <div class="bundle-snapshot-info">
          <strong>📸 ${escapeHTML(t('dev.bundleEditor.snapshotBannerTitle'))}</strong>
          <p class="muted">
            ${escapeHTML(
              t('dev.bundleEditor.snapshotBannerDesc', {
                total: stats.totalCount ?? draftPackages.length,
                prod: stats.prodCount ?? 0,
                dev: stats.devCount ?? 0,
              })
            )}
          </p>
        </div>
        <div class="bundle-snapshot-controls">
          <input type="text" id="devBundleSnapshotFilter" value="${escapeHTML(snapshotFilterText)}" placeholder="${escapeHTML(t('bundleEditor.snapshotFilterPlaceholder'))}">
          <button type="button" class="btn btn-ghost btn-xs" data-dev-editor-action="snap-all">${escapeHTML(t('bundleEditor.snapshotAllBtn', { count: draftPackages.length }))}</button>
          <button type="button" class="btn btn-ghost btn-xs" data-dev-editor-action="snap-none">${escapeHTML(t('bundleEditor.snapshotNoneBtn'))}</button>
          <button type="button" class="btn btn-ghost btn-xs" data-dev-editor-action="snap-prod">${escapeHTML(t('dev.bundleEditor.snapshotOnlyProd'))}</button>
          <button type="button" class="btn btn-ghost btn-xs" data-dev-editor-action="snap-dev">${escapeHTML(t('dev.bundleEditor.snapshotOnlyDev'))}</button>
          <span class="bundle-snapshot-counter">${escapeHTML(t('bundleEditor.snapshotCounter', { checked: checkedCount, total: draftPackages.length }))}</span>
        </div>
      </div>
    `;
  };

  const renderPackagesListHtml = () => {
    const filterQ = isSnapshotMode ? snapshotFilterText.trim().toLowerCase() : '';
    const visible = draftPackages
      .map((pkg, idx) => ({ pkg, idx }))
      .filter(({ pkg }) => !filterQ || pkg.name.toLowerCase().includes(filterQ));

    if (draftPackages.length === 0) {
      return `<div class="bundle-items-empty">${escapeHTML(t('dev.bundleEditor.packagesEmpty'))}</div>`;
    }
    if (visible.length === 0) {
      return `<div class="bundle-items-empty">${escapeHTML(t('bundleEditor.snapshotFilterEmpty'))}</div>`;
    }

    const mgrMeta = getDevManagerMeta(draftManager);
    const supportsDev = mgrMeta.supportsDevScope;

    return visible
      .map(({ pkg, idx }) => {
        const key = normalizeDevBundlePkgKey(draftManager, pkg.name);
        const isChecked = !isSnapshotMode || snapshotCheckedKeys.has(key);
        return `
          <div class="bundle-item-row ${isChecked ? '' : 'is-unchecked'}" draggable="true" data-dev-pkg-index="${idx}">
            ${
              isSnapshotMode
                ? `<label class="bundle-item-snap-check" title="${escapeHTML(t('bundleEditor.snapshotCheckboxTitle'))}"><input type="checkbox" data-dev-snap-key="${escapeHTML(key)}" ${isChecked ? 'checked' : ''}></label>`
                : ''
            }
            <span class="bundle-drag-handle" title="${escapeHTML(t('bundleEditor.dragHandleTitle'))}">⠿</span>
            <span class="bundle-item-order">#${idx + 1}</span>
            <div class="bundle-item-main">
              <div class="bundle-item-title">
                <strong>${escapeHTML(pkg.name)}</strong>
                <span class="dev-scope-badge ${pkg.isDev ? 'is-dev' : 'is-prod'}">${escapeHTML(pkg.isDev ? t('dev.workspace.scopeBadgeDev') : t('dev.workspace.scopeBadgeProd'))}</span>
              </div>
            </div>
            <input
              type="text"
              class="dev-bundle-ver-input"
              data-pkg-version-index="${idx}"
              value="${escapeHTML(pkg.version || '')}"
              placeholder="${escapeHTML(t('dev.bundleEditor.versionPlaceholder'))}"
              title="${escapeHTML(t('dev.bundleEditor.versionTitle'))}"
              autocomplete="off"
            >
            <div class="dev-bundle-scope-mini" role="group" aria-label="${escapeHTML(t('dev.workspace.discoverScopeAria'))}">
              <button
                type="button"
                class="dev-scope-btn ${!pkg.isDev ? 'active' : ''}"
                data-pkg-scope-index="${idx}"
                data-pkg-scope-val="prod"
                ${supportsDev ? '' : 'disabled'}
                title="${escapeHTML(supportsDev ? t('dev.workspace.discoverScopeProd') : t('dev.workspace.discoverScopeUnsupportedHint'))}"
              >${escapeHTML(t('dev.workspace.scopeBadgeProd'))}</button>
              <button
                type="button"
                class="dev-scope-btn ${pkg.isDev ? 'active' : ''}"
                data-pkg-scope-index="${idx}"
                data-pkg-scope-val="dev"
                ${supportsDev ? '' : 'disabled'}
                title="${escapeHTML(supportsDev ? t('dev.workspace.discoverScopeDev') : t('dev.workspace.discoverScopeUnsupportedHint'))}"
              >${escapeHTML(t('dev.workspace.scopeBadgeDev'))}</button>
            </div>
            <label class="bundle-optional-toggle" title="${escapeHTML(t('bundleEditor.markOptionalTitle'))}">
              <input type="checkbox" data-pkg-optional-index="${idx}" ${pkg.optional ? 'checked' : ''}>
              <span>${escapeHTML(t('common.optional'))}</span>
            </label>
            <div class="bundle-item-order-btns">
              <button type="button" class="btn btn-ghost btn-xs" data-dev-move-index="${idx}" data-dev-move-dir="up" title="${escapeHTML(t('bundleEditor.moveUpTitle'))}" ${idx === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="btn btn-ghost btn-xs" data-dev-move-index="${idx}" data-dev-move-dir="down" title="${escapeHTML(t('bundleEditor.moveDownTitle'))}" ${idx === draftPackages.length - 1 ? 'disabled' : ''}>↓</button>
              <button type="button" class="btn btn-danger btn-xs" data-dev-remove-index="${idx}" title="${escapeHTML(t('bundleEditor.removeItemTitle'))}">✕</button>
            </div>
          </div>
        `;
      })
      .join('');
  };

  const render = () => {
    if (!isStillOpen()) return;

    const activeEl = document.activeElement;
    const focusId = activeEl instanceof HTMLElement ? activeEl.id : '';
    const selectionStart =
      activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement ? activeEl.selectionStart : null;
    const selectionEnd =
      activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement ? activeEl.selectionEnd : null;

    const mgrMeta = getDevManagerMeta(draftManager);
    if (!mgrMeta.supportsDevScope && searchAddAsDev) {
      searchAddAsDev = false;
    }
    const registryLabel = getDevBundleRegistryLabel(draftManager);

    const modalTitle = isSnapshotMode
      ? `📸 ${t('dev.bundleEditor.titleSnapshot')}`
      : isEditMode
        ? `✏️ ${t('dev.bundleEditor.titleEdit', { name: draftName || t('dev.bundleEditor.defaultName') })}`
        : `➕ ${t('dev.bundleEditor.titleNew')}`;

    const saveCount = isSnapshotMode
      ? draftPackages.filter((p) => snapshotCheckedKeys.has(normalizeDevBundlePkgKey(draftManager, p.name))).length
      : draftPackages.length;

    modal.innerHTML = `
      <div class="modal-header">
        <div>
          <h2>${escapeHTML(modalTitle)}</h2>
          <span class="muted">${escapeHTML(t('dev.bundleEditor.headerSubtitle'))}</span>
        </div>
        <button type="button" class="icon-btn" data-dev-editor-action="cancel" title="${escapeHTML(t('common.cancel'))}" aria-label="${escapeHTML(t('common.cancel'))}">✕</button>
      </div>

      <div class="modal-body bundle-editor-body">
        ${renderSnapshotBannerHtml()}

        <div class="bundle-meta-grid">
          <label class="form-field">
            <span>${escapeHTML(t('dev.bundleEditor.fieldName'))}</span>
            <input type="text" id="devBundleNameInput" value="${escapeHTML(draftName)}" placeholder="${escapeHTML(t('dev.bundleEditor.fieldNamePlaceholder'))}">
          </label>
          <div class="form-field">
            <span>${escapeHTML(t('bundleEditor.fieldIcon'))}</span>
            <div class="bundle-icon-row">
              <input type="text" id="devBundleIconInput" class="bundle-icon-input" value="${escapeHTML(draftIcon)}" maxlength="8">
              <div class="bundle-icon-presets">
                ${DEV_BUNDLE_ICON_PRESETS.map(
                  (em) =>
                    `<button type="button" class="bundle-icon-preset ${draftIcon === em ? 'active' : ''}" data-dev-icon-preset="${escapeHTML(em)}">${escapeHTML(em)}</button>`
                ).join('')}
              </div>
            </div>
          </div>
        </div>

        <label class="form-field">
          <span>${escapeHTML(t('bundleEditor.fieldDescription'))}</span>
          <textarea id="devBundleDescInput" rows="2" placeholder="${escapeHTML(t('dev.bundleEditor.fieldDescriptionPlaceholder'))}">${escapeHTML(draftDesc)}</textarea>
        </label>

        <div class="form-field">
          <span>${escapeHTML(t('dev.bundleEditor.fieldManager'))}</span>
          <div class="dev-bundle-manager-chips">
            ${renderManagerChipsHtml()}
          </div>
        </div>

        <div class="bundle-search-section">
          <div class="bundle-section-head">
            <strong>➕ ${escapeHTML(t('dev.bundleEditor.addPackagesTitle', { registry: registryLabel }))}</strong>
            <div class="dev-scope-switcher" role="group" aria-label="${escapeHTML(t('dev.workspace.discoverScopeAria'))}">
              <button
                type="button"
                class="dev-scope-btn ${!searchAddAsDev ? 'active' : ''}"
                data-dev-editor-add-scope="prod"
              >📦 ${escapeHTML(t('dev.workspace.discoverScopeProd'))}</button>
              <button
                type="button"
                class="dev-scope-btn ${searchAddAsDev ? 'active' : ''}"
                data-dev-editor-add-scope="dev"
                ${mgrMeta.supportsDevScope ? '' : 'disabled'}
              >🛠️ ${escapeHTML(t('dev.workspace.discoverScopeDev'))}</button>
            </div>
          </div>
          <div class="bundle-search-bar">
            <input type="text" id="devBundleAddSearchInput" value="${escapeHTML(searchQuery)}" placeholder="${escapeHTML(t('dev.bundleEditor.searchPlaceholder', { manager: mgrMeta.label, registry: registryLabel }))}" autocomplete="off">
            <button type="button" class="btn btn-primary" data-dev-editor-action="search">🔎 ${escapeHTML(t('common.search'))}</button>
          </div>
          <div class="bundle-search-results" id="devBundleSearchResults">
            ${renderSearchResultsHtml()}
          </div>
        </div>

        <div class="bundle-items-section">
          <div class="bundle-section-head">
            <strong>📋 ${escapeHTML(t('dev.bundleEditor.packagesSectionTitle', { count: draftPackages.length }))}</strong>
            <span class="muted">${escapeHTML(t('dev.bundleEditor.packagesSectionHint'))}</span>
          </div>
          <div class="bundle-items-list" id="devBundlePackagesList">
            ${renderPackagesListHtml()}
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <span class="muted">${escapeHTML(t('dev.bundleEditor.footerSummary', { count: saveCount }))}</span>
        <div class="footer-group">
          <button type="button" class="btn btn-ghost" data-dev-editor-action="cancel" ${isSaving ? 'disabled' : ''}>${escapeHTML(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-dev-editor-action="save" ${isSaving ? 'disabled' : ''}>
            ${isSaving ? `⏳ ${escapeHTML(t('common.saving'))}` : `💾 ${escapeHTML(t('dev.bundleEditor.saveBtn'))}`}
          </button>
        </div>
      </div>
    `;

    const nameInput = qsInput(modal, '#devBundleNameInput');
    if (nameInput) {
      nameInput.oninput = () => {
        draftName = nameInput.value;
      };
    }

    const iconInput = qsInput(modal, '#devBundleIconInput');
    if (iconInput) {
      iconInput.oninput = () => {
        draftIcon = iconInput.value.trim() || DEFAULT_DEV_BUNDLE_ICON;
      };
    }

    const descInput = qsTextarea(modal, '#devBundleDescInput');
    if (descInput) {
      descInput.oninput = () => {
        draftDesc = descInput.value;
      };
    }

    const snapFilterInput = qsInput(modal, '#devBundleSnapshotFilter');
    if (snapFilterInput) {
      snapFilterInput.oninput = () => {
        snapshotFilterText = snapFilterInput.value;
        const listEl = qs(modal, '#devBundlePackagesList');
        if (listEl) listEl.innerHTML = renderPackagesListHtml();
      };
    }

    const addSearchInput = qsInput(modal, '#devBundleAddSearchInput');
    if (addSearchInput) {
      addSearchInput.oninput = () => {
        searchQuery = addSearchInput.value;
        const trimmed = searchQuery.trim();
        clearPendingDebounce();

        if (trimmed.length >= 2) {
          if (`${draftManager}:${trimmed}` !== lastSearchedKey) {
            hasSearched = false;
          }
          updateSearchResultsDom();
          searchDebounceTimer = setTimeout(() => {
            void runRegistrySearch(trimmed);
          }, 400);
        } else {
          searchResults = [];
          searchError = '';
          hasSearched = false;
          lastSearchedKey = '';
          updateSearchResultsDom();
        }
      };

      addSearchInput.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void runRegistrySearch(searchQuery, { explicit: true });
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
            // Ignorieren
          }
        }
      }
    }
  };

  overlay.hidden = false;

  modal.oninput = (e) => {
    const verInput = closestInput(e.target, '[data-pkg-version-index]');
    if (!verInput) return;
    const idx = Number.parseInt(verInput.dataset.pkgVersionIndex || '', 10);
    if (draftPackages[idx]) {
      draftPackages[idx] = { ...draftPackages[idx], version: verInput.value.trim() };
    }
  };

  modal.onchange = (e) => {
    const snapChk = closestInput(e.target, '[data-dev-snap-key]');
    if (snapChk) {
      const key = snapChk.dataset.devSnapKey;
      if (key) {
        if (snapChk.checked) snapshotCheckedKeys.add(key);
        else snapshotCheckedKeys.delete(key);
      }
      render();
      return;
    }

    const optChk = closestInput(e.target, '[data-pkg-optional-index]');
    if (optChk) {
      const idx = Number.parseInt(optChk.dataset.pkgOptionalIndex || '', 10);
      if (draftPackages[idx]) {
        draftPackages[idx] = { ...draftPackages[idx], optional: optChk.checked };
      }
    }
  };

  modal.onclick = async (e) => {
    const iconBtn = closestEl(e.target, '[data-dev-icon-preset]');
    if (iconBtn) {
      draftIcon = iconBtn.dataset.devIconPreset || DEFAULT_DEV_BUNDLE_ICON;
      render();
      return;
    }

    const mgrBtn = closestEl(e.target, '[data-dev-bundle-mgr]');
    if (mgrBtn && !isEditMode) {
      const nextMgr = mgrBtn.dataset.devBundleMgr || '';
      if (nextMgr && nextMgr !== draftManager) {
        draftManager = nextMgr;
        clearPendingDebounce();
        searchResults = [];
        searchError = '';
        hasSearched = false;
        lastSearchedKey = '';
        if (isSnapshotMode && projectScan) {
          const rebuilt = buildDevBundleDraftFromProject({
            project,
            scan: projectScan,
            manager: draftManager,
            includeProd: true,
            includeDev: true,
            t,
          });
          draftPackages = rebuilt.draft.packages;
          activeSnapshotStats = rebuilt;
          snapshotCheckedKeys.clear();
          for (const p of draftPackages) {
            snapshotCheckedKeys.add(normalizeDevBundlePkgKey(draftManager, p.name));
          }
        } else {
          draftPackages = dedupeDevBundlePackages(draftPackages, draftManager);
        }
        render();
        if (searchQuery.trim().length >= 2) {
          void runRegistrySearch(searchQuery.trim());
        }
      }
      return;
    }

    const addScopeBtn = closestEl(e.target, '[data-dev-editor-add-scope]');
    if (addScopeBtn instanceof HTMLButtonElement && !addScopeBtn.disabled) {
      searchAddAsDev = addScopeBtn.dataset.devEditorAddScope === 'dev';
      render();
      return;
    }

    const directAddBtn = closestEl(e.target, '[data-dev-editor-direct-add]');
    if (directAddBtn) {
      const pkgName = directAddBtn.dataset.devEditorDirectAdd || '';
      if (pkgName) addPackageToDraft(pkgName, '');
      return;
    }

    const addBtn = closestEl(e.target, '[data-dev-editor-add-idx]');
    if (addBtn) {
      const idx = Number.parseInt(addBtn.dataset.devEditorAddIdx || '', 10);
      const chosen = searchResults[idx];
      if (chosen) {
        const pkgName = String(chosen.packageId || chosen.id || chosen.name || '').trim();
        addPackageToDraft(pkgName, '');
      }
      return;
    }

    const pkgScopeBtn = closestEl(e.target, '[data-pkg-scope-index]');
    if (pkgScopeBtn instanceof HTMLButtonElement && !pkgScopeBtn.disabled) {
      const idx = Number.parseInt(pkgScopeBtn.dataset.pkgScopeIndex || '', 10);
      if (draftPackages[idx]) {
        draftPackages[idx] = {
          ...draftPackages[idx],
          isDev: pkgScopeBtn.dataset.pkgScopeVal === 'dev',
        };
        render();
      }
      return;
    }

    const moveBtn = closestEl(e.target, '[data-dev-move-index]');
    if (moveBtn) {
      const idx = Number.parseInt(moveBtn.dataset.devMoveIndex || '', 10);
      const dir = moveBtn.dataset.devMoveDir;
      const targetIdx = dir === 'up' ? idx - 1 : idx + 1;
      draftPackages = moveDevBundlePackage(draftPackages, idx, targetIdx);
      render();
      return;
    }

    const removeBtn = closestEl(e.target, '[data-dev-remove-index]');
    if (removeBtn) {
      const idx = Number.parseInt(removeBtn.dataset.devRemoveIndex || '', 10);
      const removed = draftPackages[idx];
      if (removed) {
        snapshotCheckedKeys.delete(normalizeDevBundlePkgKey(draftManager, removed.name));
      }
      draftPackages = draftPackages.filter((_, i) => i !== idx);
      render();
      return;
    }

    const actionBtn = closestEl(e.target, '[data-dev-editor-action]');
    if (!actionBtn) return;
    const action = actionBtn.dataset.devEditorAction;

    if (action === 'cancel') {
      clearPendingDebounce();
      closeModal();
      return;
    }

    if (action === 'search') {
      await runRegistrySearch(searchQuery, { explicit: true });
      return;
    }

    if (action === 'snap-all') {
      for (const p of draftPackages) snapshotCheckedKeys.add(normalizeDevBundlePkgKey(draftManager, p.name));
      render();
      return;
    }

    if (action === 'snap-none') {
      snapshotCheckedKeys.clear();
      render();
      return;
    }

    if (action === 'snap-prod' || action === 'snap-dev') {
      const wantDev = action === 'snap-dev';
      snapshotCheckedKeys.clear();
      for (const p of draftPackages) {
        if (Boolean(p.isDev) === wantDev) {
          snapshotCheckedKeys.add(normalizeDevBundlePkgKey(draftManager, p.name));
        }
      }
      render();
      return;
    }

    if (action === 'save') {
      const finalName = draftName.trim();
      if (!finalName) {
        showToast(t('dev.bundleEditor.missingNameToast'), { type: 'warn' });
        qsInput(modal, '#devBundleNameInput')?.focus();
        return;
      }

      const finalPackages = isSnapshotMode
        ? draftPackages.filter((p) => snapshotCheckedKeys.has(normalizeDevBundlePkgKey(draftManager, p.name)))
        : draftPackages;

      if (finalPackages.length === 0) {
        showToast(t('dev.bundleEditor.missingPackagesToast'), { type: 'warn' });
        return;
      }

      clearPendingDebounce();
      isSaving = true;
      render();

      const res = await window.electronAPI.saveDevBundle({
        id: bundle?.id || '',
        name: finalName,
        description: draftDesc.trim(),
        icon: draftIcon.trim() || DEFAULT_DEV_BUNDLE_ICON,
        manager: draftManager,
        packages: dedupeDevBundlePackages(finalPackages, draftManager),
      });

      if (!isStillOpen()) return;
      isSaving = false;

      if (res?.success) {
        await refreshDevBundles();
        closeModal();
        showToast(t('dev.bundleEditor.savedToast', { name: res.bundle?.name || finalName }), { type: 'success' });
        onSaved?.(res.bundle);
      } else {
        showToast(res?.error || t('dev.bundleEditor.saveErrorToast'), { type: 'error', duration: 6000 });
        render();
      }
    }
  };

  modal.ondragstart = (e) => {
    const row = closestEl(e.target, '.bundle-item-row');
    if (!row) return;
    dragFromIndex = Number.parseInt(row.dataset.devPkgIndex || '', 10);
    row.classList.add('is-dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(dragFromIndex));
    }
  };

  modal.ondragover = (e) => {
    const row = closestEl(e.target, '.bundle-item-row');
    if (!row || dragFromIndex < 0) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    for (const el of modal.querySelectorAll('.bundle-item-row.is-drag-over')) {
      if (el !== row) el.classList.remove('is-drag-over');
    }
    row.classList.add('is-drag-over');
  };

  modal.ondragleave = (e) => {
    const row = closestEl(e.target, '.bundle-item-row');
    if (row) row.classList.remove('is-drag-over');
  };

  modal.ondrop = (e) => {
    const row = closestEl(e.target, '.bundle-item-row');
    if (!row || dragFromIndex < 0) return;
    e.preventDefault();
    const toIndex = Number.parseInt(row.dataset.devPkgIndex || '', 10);
    row.classList.remove('is-drag-over');
    if (Number.isInteger(toIndex) && toIndex !== dragFromIndex) {
      draftPackages = moveDevBundlePackage(draftPackages, dragFromIndex, toIndex);
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
