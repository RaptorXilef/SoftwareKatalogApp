import {
  detectAdwareSignals,
  normalizeInstallMode,
  sanitizeInnoInfFileName,
  sanitizeSilentArgs,
} from '../../shared/installer-logic.js';
import { filterUsableProviders } from '../../shared/provider-lifecycle-logic.js';
import { showToast } from '../components/toast.js';
import { getBaseName, getCatalogItemById, getItemById, state } from '../state.js';
import { closestButton, closestEl, qs, qsa, qsButton, qsInput, qsSelect, qsTextarea } from '../utils/dom.js';
import { getLocalizedProviderName, t } from '../utils/i18n.js';
import { escapeHTML, sanitizeRichHtml, toMediaUrl } from '../utils/sanitize.js';
import { openDetailModal, resetModalContent, triggerCatalogReload } from './index.js';

function getInstallModeDescription(mode) {
  if (mode === 'silent') {
    return t('edit.modeSilentDesc');
  }
  if (mode === 'interactive-required') {
    return `🛡️ ${t('edit.modeProtectedDesc')}`;
  }
  return t('edit.modeInteractiveDesc');
}

function detectInitialSourceType(item) {
  const src = String(item.webSourceType || '')
    .trim()
    .toLowerCase();
  if (src === 'github' || src === 'web') return src;
  if (src === 'winget' || src === 'provider') return 'provider';
  if (item.wingetId || (item.packageManager && item.packageManager !== 'archive' && item.packageId)) {
    return 'provider';
  }
  if (item.webVersionUrl?.toLowerCase().includes('github.com')) return 'github';
  if (item.webVersionUrl) return 'web';
  return 'none';
}

function getSelectableProviders(item) {
  const usable = filterUsableProviders(state.providers, { excludeIds: ['archive', 'msi'] }).filter(
    (p) => p.capabilities?.show || p.capabilities?.search
  );
  const existingPm = String(item.packageManager || (item.wingetId ? 'winget' : ''))
    .trim()
    .toLowerCase();
  if (existingPm && existingPm !== 'archive' && existingPm !== 'msi' && !usable.some((p) => p.id === existingPm)) {
    const raw = state.providers.find((p) => p.id === existingPm);
    usable.push({
      id: existingPm,
      name: `${raw ? getLocalizedProviderName(raw) : existingPm}${t('edit.providerUnavailableSuffix')}`,
      capabilities: raw?.capabilities || { show: true, search: true },
    });
  }
  if (usable.length === 0) {
    usable.push({
      id: 'winget',
      name: 'Winget',
      capabilities: { show: true, search: true, supportsArchiveDownload: true },
    });
  }
  return usable;
}

function getProviderHintText(providerId) {
  const cleanId = String(providerId || '')
    .trim()
    .toLowerCase();
  if (cleanId === 'winget') {
    return t('edit.wingetHint');
  }
  const prov = state.providers.find((p) => p.id === cleanId);
  const label = prov ? getLocalizedProviderName(prov) : cleanId || t('detail.sourceProvider');
  return t('edit.providerHintGeneric', { name: label });
}

export function renderEditModal(id, initialTab = 'general') {
  const item = getCatalogItemById(id);
  if (!item) return;

  state.currentModalId = id;
  state.isEditModalOpen = true;

  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();

  const unifiedItem = getItemById(id);
  const itemPublisher = unifiedItem?.publisher || item.publisher || '';

  // Lokaler Arbeitszustand für Pfade & Quelle (bleibt beim Tab-Wechsel erhalten)
  const draftPaths = [
    ...(item.autoPaths || []).map((p) => ({ path: p, origin: 'auto' })),
    ...(item.installPaths || []).map((p) => ({ path: p, origin: 'manual' })),
  ];
  let currentSourceType = detectInitialSourceType(item);
  const selectableProviders = getSelectableProviders(item);
  const existingPm = String(item.packageManager || (item.wingetId ? 'winget' : ''))
    .trim()
    .toLowerCase();
  let selectedPackageManager =
    existingPm && existingPm !== 'archive' && existingPm !== 'msi'
      ? existingPm
      : selectableProviders.some((p) => p.id === 'winget')
        ? 'winget'
        : selectableProviders[0]?.id || 'winget';
  const initialPackageId = item.packageId || item.wingetId || '';
  let currentInstallMode = normalizeInstallMode(item.installMode);
  let detectedInstallerType = '';
  let infExists = Boolean(item.innoInfExists);
  let recordedInfName = item.innoInfFile || '';
  const primarySetupFile = item.lastFiles?.[0] || '';
  const currentAdwareWarning = detectAdwareSignals({
    name: item.name,
    fileName: primarySetupFile ? getBaseName(primarySetupFile) : '',
    packageId: initialPackageId,
    publisher: itemPublisher,
    t,
  });
  const linksStr = (item.links || []).map((l) => `${l.label} | ${l.url}`).join('\n');
  const cleanDesc = sanitizeRichHtml(item.description || '');

  modal.innerHTML = `
    <div class="modal-header">
      <div>
        <h2>${escapeHTML(t('edit.titlePrefix'))} <span class="text-accent">${escapeHTML(item.name)}</span></h2>
      </div>
      <button type="button" class="icon-btn" data-edit-action="cancel" title="${escapeHTML(t('common.cancel'))}" aria-label="${escapeHTML(t('common.cancel'))}">✕</button>
    </div>

    <nav class="modal-tabs" role="tablist">
      <button type="button" class="tab-btn ${initialTab === 'general' ? 'active' : ''}" data-tab="general">📝 ${escapeHTML(t('edit.tabGeneral'))}</button>
      <button type="button" class="tab-btn ${initialTab === 'online' ? 'active' : ''}" data-tab="online">🌐 ${escapeHTML(t('edit.tabOnline'))}</button>
      <button type="button" class="tab-btn ${initialTab === 'local' ? 'active' : ''}" data-tab="local">💻 ${escapeHTML(t('edit.tabLocal'))}</button>
      <button type="button" class="tab-btn ${initialTab === 'media' ? 'active' : ''}" data-tab="media">🖼️ ${escapeHTML(t('edit.tabMedia'))}</button>
    </nav>

    <div class="modal-body edit-body">
      <!-- TAB 1: ALLGEMEIN -->
      <section class="tab-panel" data-panel="general" ${initialTab === 'general' ? '' : 'hidden'}>
      <div class="autofill-bar">
        <span class="muted">${escapeHTML(t('edit.autofillHint'))}</span>
        <button type="button" class="btn btn-ghost" data-edit-action="autofill-fetch">✨ ${escapeHTML(t('edit.autofillBtn'))}</button>
      </div>
      <div id="autofillPreviewBox" class="autofill-preview" hidden></div>
        <div class="form-grid-2">
          <label class="form-field">
            <span>${escapeHTML(t('edit.fieldName'))}</span>
            <input type="text" id="editName" value="${escapeHTML(item.name)}">
          </label>
          <label class="form-field">
            <span>${escapeHTML(t('edit.fieldSoftwareType'))}</span>
            <select id="editSoftwareType">
              <option value="default" ${!item.softwareType || item.softwareType === 'default' ? 'selected' : ''}>${escapeHTML(t('edit.typeDefault'))}</option>
              <option value="portable" ${item.softwareType === 'portable' ? 'selected' : ''}>${escapeHTML(t('edit.typePortable'))}</option>
              <option value="driver" ${item.softwareType === 'driver' ? 'selected' : ''}>${escapeHTML(t('edit.typeDriver'))}</option>
            </select>
          </label>
          <label class="form-field">
            <span>${escapeHTML(t('edit.fieldMainCategory'))}</span>
            <input type="text" id="editCat" value="${escapeHTML(item.mainCategory || '')}" placeholder="${escapeHTML(t('edit.fieldMainCategoryPlaceholder'))}">
          </label>
          <label class="form-field">
            <span>${escapeHTML(t('edit.fieldHiddenCategory'))}</span>
            <input type="text" id="editHidden" value="${escapeHTML(item.hiddenCategory || '')}" placeholder="${escapeHTML(t('edit.fieldHiddenCategoryPlaceholder'))}">
          </label>
          <label class="form-field">
            <span>${escapeHTML(t('edit.fieldTags'))}</span>
            <input type="text" id="editTags" value="${escapeHTML((item.subCategories || []).join(', '))}" placeholder="${escapeHTML(t('edit.fieldTagsPlaceholder'))}">
          </label>
          <label class="form-field">
            <span>${escapeHTML(t('edit.fieldFormats'))}</span>
            <input type="text" id="editFormats" value="${escapeHTML((item.formats || []).join(', '))}" placeholder="${escapeHTML(t('edit.fieldFormatsPlaceholder'))}">
          </label>
        </div>

        <label class="form-field">
          <span>${escapeHTML(t('edit.fieldOs'))}</span>
          <input type="text" id="editOS" value="${escapeHTML((item.os || []).join(', '))}" placeholder="${escapeHTML(t('edit.fieldOsPlaceholder'))}">
        </label>

        <label class="check-row edit-keep-versions-row">
          <input type="checkbox" id="editKeepAllVersions" ${item.keepAllVersions ? 'checked' : ''}>
          <span>🔒 ${escapeHTML(t('edit.keepAllVersions'))}</span>
        </label>

        <div class="form-field">
          <span>${escapeHTML(t('edit.fieldDescription'))}</span>
          <div class="editor-toolbar" id="descToolbar">
            <button type="button" data-cmd="bold" title="${escapeHTML(t('edit.toolbarBoldTitle'))}"><b>B</b></button>
            <button type="button" data-cmd="italic" title="${escapeHTML(t('edit.toolbarItalicTitle'))}"><i>I</i></button>
            <button type="button" data-cmd="underline" title="${escapeHTML(t('edit.toolbarUnderlineTitle'))}"><u>U</u></button>
            <button type="button" data-cmd="insertUnorderedList" title="${escapeHTML(t('edit.toolbarListTitle'))}">• ${escapeHTML(t('edit.toolbarListLabel'))}</button>
            <button type="button" data-cmd="toggleLinkBar" title="${escapeHTML(t('edit.toolbarLinkTitle'))}">🔗 ${escapeHTML(t('edit.toolbarLinkLabel'))}</button>
          </div>
          <div id="inlineLinkBar" class="inline-link-bar" hidden>
            <input type="url" id="inlineLinkUrl" placeholder="https://...">
            <button type="button" class="btn btn-primary" data-edit-action="apply-link">${escapeHTML(t('edit.inlineLinkInsert'))}</button>
            <button type="button" class="btn btn-ghost" data-edit-action="cancel-link">✕</button>
          </div>
          <div id="editDesc" class="rich-editor" contenteditable="true">${cleanDesc}</div>
        </div>

        <label class="form-field">
          <span>${escapeHTML(t('edit.fieldLinks'))}</span>
          <textarea id="editLinks" rows="3" placeholder="${escapeHTML(t('edit.fieldLinksPlaceholder'))}">${escapeHTML(linksStr)}</textarea>
        </label>
      </section>

      <!-- TAB 2: ONLINE-UPDATES -->
      <section class="tab-panel" data-panel="online" ${initialTab === 'online' ? '' : 'hidden'}>
        <div class="form-field">
          <span>${escapeHTML(t('edit.onlineSourceField'))}</span>
          <div class="source-switcher" id="sourceSwitcher">
            <button type="button" class="source-opt ${currentSourceType === 'none' ? 'active' : ''}" data-source="none">${escapeHTML(t('edit.sourceNone'))}</button>
            <button type="button" class="source-opt ${currentSourceType === 'provider' ? 'active' : ''}" data-source="provider">📦 ${escapeHTML(t('edit.sourceProvider'))}</button>
            <button type="button" class="source-opt ${currentSourceType === 'github' ? 'active' : ''}" data-source="github">🐙 ${escapeHTML(t('edit.sourceGithub'))}</button>
            <button type="button" class="source-opt ${currentSourceType === 'web' ? 'active' : ''}" data-source="web">🌐 ${escapeHTML(t('edit.sourceWeb'))}</button>
          </div>
        </div>

        <!-- PAKETMANAGER PANEL -->
        <div class="source-panel" data-source-panel="provider" ${currentSourceType === 'provider' ? '' : 'hidden'}>
          <p class="panel-hint" id="providerPanelHint">${escapeHTML(getProviderHintText(selectedPackageManager))}</p>
          <label class="form-field">
            <span>${escapeHTML(t('edit.providerLabel'))}</span>
            <select id="editPackageManager" class="provider-select-row">
              ${selectableProviders
                .map(
                  (p) =>
                    `<option value="${escapeHTML(p.id)}" ${p.id === selectedPackageManager ? 'selected' : ''}>${escapeHTML(p.name)}</option>`
                )
                .join('')}
            </select>
          </label>
          <div class="input-action-row">
            <input type="text" id="providerQueryInput" value="${escapeHTML(item.name)}" placeholder="${escapeHTML(t('edit.providerSearchPlaceholder'))}">
            <button type="button" class="btn btn-primary" data-edit-action="search-provider">🔎 ${escapeHTML(t('common.search'))}</button>
          </div>
          <div id="providerResults" class="winget-results" hidden></div>

          <label class="form-field">
            <span>${escapeHTML(t('edit.providerPackageIdLabel'))}</span>
            <input type="text" id="editPackageId" value="${escapeHTML(initialPackageId)}" placeholder="${escapeHTML(t('edit.providerPackageIdPlaceholder'))}">
          </label>
        </div>

        <!-- GITHUB PANEL -->
        <div class="source-panel" data-source-panel="github" ${currentSourceType === 'github' ? '' : 'hidden'}>
          <p class="panel-hint">${escapeHTML(t('edit.githubHint'))}</p>
          <label class="form-field">
            <span>${escapeHTML(t('edit.githubUrlLabel'))}</span>
            <input type="url" id="editGithubUrl" value="${escapeHTML(currentSourceType === 'github' ? item.webVersionUrl || '' : '')}" placeholder="${escapeHTML(t('edit.githubUrlPlaceholder'))}">
          </label>
          <label class="form-field">
            <span>${escapeHTML(t('edit.githubPatternLabel'))}</span>
            <input type="text" id="editGithubAssetPattern" value="${escapeHTML(item.githubAssetPattern || '')}" placeholder="${escapeHTML(t('edit.githubPatternPlaceholder'))}">
          </label>
        </div>

        <!-- WEBSEITE / VISUELLER ASSISTENT PANEL -->
        <div class="source-panel" data-source-panel="web" ${currentSourceType === 'web' ? '' : 'hidden'}>
          <div class="wizard-step">
            <div class="wizard-step-head">
              <span class="step-num">1</span>
              <strong>${escapeHTML(t('edit.webStep1Title'))}</strong>
            </div>
            <div class="input-action-row">
              <input type="url" id="editWebUrl" value="${escapeHTML(currentSourceType === 'web' ? item.webVersionUrl || '' : '')}" placeholder="${escapeHTML(t('edit.webUrlPlaceholder'))}">
              <button type="button" class="btn btn-online" data-edit-action="visual-scrape">🎯 ${escapeHTML(t('edit.webStep1Btn'))}</button>
            </div>
          </div>

          <div class="wizard-step">
            <div class="wizard-step-head">
              <span class="step-num">2</span>
              <strong>${escapeHTML(t('edit.webStep2Title'))}</strong>
              <span class="muted">${escapeHTML(t('edit.webStep2HintPrefix'))}<code>{version}</code>${escapeHTML(t('edit.webStep2HintSuffix'))}</span>
            </div>
            <div class="input-action-row">
              <input type="url" id="editDownloadUrl" value="${escapeHTML(item.downloadUrl || '')}" placeholder="${escapeHTML(t('edit.webDownloadPlaceholder'))}">
              <button type="button" class="btn btn-primary" data-edit-action="visual-link-pick">🎯 ${escapeHTML(t('edit.webStep2Btn'))}</button>
            </div>
          </div>

          <details class="advanced-box">
            <summary>${escapeHTML(t('edit.webAdvancedSummary'))}</summary>
            <div class="form-grid-2">
              <label class="form-field">
                <span>${escapeHTML(t('edit.webPrefixLabel'))}</span>
                <input type="text" id="editWebPrefix" value="${escapeHTML(item.webVersionPrefix || '')}">
              </label>
              <label class="form-field">
                <span>${escapeHTML(t('edit.webSuffixLabel'))}</span>
                <input type="text" id="editWebSuffix" value="${escapeHTML(item.webVersionSuffix || '')}">
              </label>
              <label class="form-field">
                <span>${escapeHTML(t('edit.dlPrefixLabel'))}</span>
                <input type="text" id="editDlPrefix" value="${escapeHTML(item.dlPrefix || '')}">
              </label>
              <label class="form-field">
                <span>${escapeHTML(t('edit.dlSuffixLabel'))}</span>
                <input type="text" id="editDlSuffix" value="${escapeHTML(item.dlSuffix || '')}">
              </label>
            </div>
          </details>
        </div>

        <!-- LIVE-TEST LEISTE -->
        <div class="online-test-bar" id="onlineTestBar" ${currentSourceType === 'none' ? 'hidden' : ''}>
          <div class="test-bar-info">
            <label class="inline-ver-field">
              <span>${escapeHTML(t('edit.detectedWebVersion'))}</span>
              <input type="text" id="editWebVersion" value="${escapeHTML(item.webVersion || '')}" placeholder="${escapeHTML(t('edit.notCheckedYet'))}" readonly>
            </label>
            <span id="onlineTestFeedback" class="test-feedback"></span>
          </div>
          <button type="button" class="btn btn-ghost" data-edit-action="test-online">🔄 ${escapeHTML(t('edit.testNowBtn'))}</button>
        </div>
      </section>

      <!-- TAB 3: PC-ERKENNUNG -->
      <section class="tab-panel" data-panel="local" ${initialTab === 'local' ? '' : 'hidden'}>
        <p class="panel-hint">${escapeHTML(t('edit.localHint'))}</p>

        <div class="form-field">
          <span>${escapeHTML(t('edit.searchNamesLabel'))}</span>
          <div class="input-action-row">
            <input type="text" id="editSearchNames" value="${escapeHTML((item.searchNames || []).join(', '))}" placeholder="${escapeHTML(t('edit.searchNamesPlaceholder'))}">
            <div id="installedAppsSlot">
              <button type="button" class="btn btn-ghost" data-edit-action="load-installed-apps">📋 ${escapeHTML(t('edit.loadInstalledAppsBtn'))}</button>
            </div>
          </div>
        </div>

        <div class="form-field">
          <div class="field-header-row">
            <span>${escapeHTML(t('edit.assignedPathsLabel'))}</span>
            <div class="field-header-btns">
              <button type="button" class="btn btn-primary" data-edit-action="auto-detect-path">✨ ${escapeHTML(t('edit.autoDetectPathBtn'))}</button>
              <button type="button" class="btn btn-ghost" data-edit-action="browse-path">📂 ${escapeHTML(t('edit.browsePathBtn'))}</button>
            </div>
          </div>
          <div id="unifiedPathList" class="path-list"></div>
        </div>

        <div class="install-mode-section">
          <div class="field-header-row">
            <span>⚙️ ${escapeHTML(t('edit.installModeHeading'))}</span>
          </div>

          <div id="adwareWarningBox" class="adware-warning-banner" ${currentAdwareWarning.flagged ? '' : 'hidden'}>
            <div class="adware-warning-text">
              <strong class="adware-warning-title">⚠️ ${escapeHTML(t('edit.adwareBannerTitle'))}</strong>
              <span id="adwareWarningReason">${escapeHTML(currentAdwareWarning.reason || '')}</span>
            </div>
            <button type="button" class="btn btn-ghost btn-xs" data-edit-action="apply-adware-protection" id="btnApplyAdwareProtection" ${currentInstallMode === 'interactive-required' ? 'hidden' : ''}>🛡️ ${escapeHTML(t('edit.applyAdwareBtn'))}</button>
          </div>

          <div class="install-mode-switcher" id="installModeSwitcher">
            <button type="button" class="install-mode-opt ${currentInstallMode === 'interactive' ? 'active' : ''}" data-install-mode="interactive">🖱️ ${escapeHTML(t('edit.modeInteractiveBtn'))}</button>
            <button type="button" class="install-mode-opt ${currentInstallMode === 'silent' ? 'active' : ''}" data-install-mode="silent">⚡ ${escapeHTML(t('edit.modeSilentBtn'))}</button>
            <button type="button" class="install-mode-opt is-protected ${currentInstallMode === 'interactive-required' ? 'active' : ''}" data-install-mode="interactive-required">🛡️ ${escapeHTML(t('edit.modeProtectedBtn'))}</button>
          </div>
          <p class="panel-hint" id="installModeDesc">${escapeHTML(getInstallModeDescription(currentInstallMode))}</p>

          <div id="silentConfigBox" class="silent-config-box ${currentInstallMode === 'interactive-required' ? 'is-ignored' : ''}">
            <div class="silent-setup-meta">
              <span class="muted">${primarySetupFile ? `${escapeHTML(t('edit.setupFilePrefix'))} <code>${escapeHTML(getBaseName(primarySetupFile))}</code>` : escapeHTML(t('edit.setupFileNone'))}</span>
              <span id="silentIgnoredHint" class="silent-ignored-hint" ${currentInstallMode === 'interactive-required' ? '' : 'hidden'}>🛡️ ${escapeHTML(t('edit.silentIgnoredHint'))}</span>
            </div>

            <div class="form-field">
              <span>${escapeHTML(t('edit.silentArgsPrefix'))} <code>/VERYSILENT /NORESTART /SP-</code>)</span>
              <div class="input-action-row">
                <input type="text" id="editSilentArgs" value="${escapeHTML(item.silentArgs || '')}" placeholder="${escapeHTML(t('edit.silentArgsPlaceholder'))}">
                <button type="button" class="btn btn-ghost" data-edit-action="detect-installer">🔍 ${escapeHTML(t('edit.detectInstallerBtn'))}</button>
                <button type="button" class="btn btn-ghost" data-edit-action="test-installer">▶️ ${escapeHTML(t('edit.testInstallerBtn'))}</button>
              </div>
            </div>

            <div id="installerDetectFeedback" class="installer-detect-feedback" hidden></div>

            <div id="innoInfBox" class="inno-inf-box" ${item.innoInfFile || currentInstallMode === 'silent' ? '' : 'hidden'}>
              <div class="form-field">
                <span>${escapeHTML(t('edit.innoInfLabelPrefix'))}<code>.inf</code>${escapeHTML(t('edit.innoInfLabelMid'))}<code>_metadata/</code>${escapeHTML(t('edit.innoInfLabelSuffix'))}</span>
                <div class="input-action-row">
                  <input type="text" id="editInnoInfFile" value="${escapeHTML(item.innoInfFile || '')}" placeholder="silent.inf">
                  <button type="button" class="btn btn-ghost" data-edit-action="record-inno-inf">📝 ${escapeHTML(t('edit.recordInnoInfBtn'))}</button>
                </div>
              </div>
              <span id="innoInfStatus" class="muted"></span>
            </div>
          </div>
        </div>
      </section>

      <!-- TAB 4: MEDIEN -->
      <section class="tab-panel" data-panel="media" ${initialTab === 'media' ? '' : 'hidden'}>
        <div class="media-editor-grid">
          <div class="media-card">
            <h4>${escapeHTML(t('edit.mediaIconTitle'))}</h4>
            <div class="icon-preview-row">
              <div id="editIconPreview" class="icon-preview-box"></div>
              <div class="icon-preview-actions">
                <div class="media-dropzone" data-drop-type="icon">
                  🖼️ ${escapeHTML(t('edit.dropIconHint'))}
                </div>
                <button type="button" class="btn btn-ghost" data-edit-action="extract-icon">🪄 ${escapeHTML(t('edit.extractIconBtn'))}</button>
              </div>
            </div>
          </div>

          <div class="media-card">
            <h4>${escapeHTML(t('edit.mediaGalleryTitle'))}</h4>
            <div class="media-dropzone" data-drop-type="media">
              📷 ${escapeHTML(t('edit.dropMediaHint'))}
            </div>
            <div id="editMediaGallery" class="edit-media-gallery"></div>
          </div>
        </div>
      </section>
    </div>

    <div class="modal-footer">
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-edit-action="open-meta-dir">📂 ${escapeHTML(t('edit.openMetaDirBtn'))}</button>
      </div>
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-edit-action="cancel">${escapeHTML(t('common.cancel'))}</button>
        <button type="button" class="btn btn-primary" data-edit-action="save">💾 ${escapeHTML(t('common.save'))}</button>
      </div>
    </div>
  `;

  overlay.hidden = false;

  // Hilfs-Renderer für Pfadliste & Medien (aktualisieren nur ihren Teilbereich!)
  const renderPathList = () => {
    const listEl = modal.querySelector('#unifiedPathList');
    if (!listEl) return;
    if (draftPaths.length === 0) {
      listEl.innerHTML = `<div class="path-empty">${escapeHTML(t('edit.pathsEmptyPrefix'))}<strong>✨ ${escapeHTML(t('edit.autoDetectPathBtn'))}</strong>${escapeHTML(t('edit.pathsEmptySuffix'))}</div>`;
      return;
    }
    listEl.innerHTML = draftPaths
      .map(
        (entry, idx) => `
        <div class="path-row">
          <span class="path-origin-pill is-${entry.origin}">${escapeHTML(entry.origin === 'auto' ? t('edit.pathOriginAuto') : t('edit.pathOriginManual'))}</span>
          <code class="path-text" title="${escapeHTML(entry.path)}">${escapeHTML(entry.path)}</code>
          <button type="button" class="icon-btn path-remove-btn" data-remove-path="${idx}" title="${escapeHTML(t('common.remove'))}">✕</button>
        </div>
      `
      )
      .join('');
  };

  const renderMediaSection = () => {
    const freshItem = getCatalogItemById(id) || item;
    const iconBox = modal.querySelector('#editIconPreview');
    const galleryEl = modal.querySelector('#editMediaGallery');
    const bust = Date.now();

    if (iconBox) {
      iconBox.innerHTML = freshItem.icon
        ? `<img src="${escapeHTML(toMediaUrl(freshItem.icon))}&t=${bust}" alt="Icon">`
        : `<span class="muted">${escapeHTML(t('edit.noIcon'))}</span>`;
    }

    if (galleryEl) {
      if (!freshItem.screenshots?.length) {
        galleryEl.innerHTML = `<p class="muted">${escapeHTML(t('edit.noMedia'))}</p>`;
      } else {
        galleryEl.innerHTML = freshItem.screenshots
          .map((s) => {
            const url = `${escapeHTML(toMediaUrl(s))}&t=${bust}`;
            const isVid = /\.(mp4|webm|ogg|mov|avi)$/i.test(s);
            return `
              <div class="edit-media-item">
                ${isVid ? `<video src="${url}#t=1" muted preload="metadata"></video>` : `<img src="${url}" alt="">`}
                <button type="button" class="media-delete-btn" data-delete-media="${escapeHTML(s)}" title="${escapeHTML(t('edit.deleteMediaTitle', { name: getBaseName(s) }))}">🗑️</button>
              </div>
            `;
          })
          .join('');
      }
    }
  };

  const updateInnoInfStatus = () => {
    const statusEl = modal.querySelector('#innoInfStatus');
    const infInput = qsInput(modal, '#editInnoInfFile');
    if (!statusEl || !infInput) return;
    const val = sanitizeInnoInfFileName(infInput.value.trim());
    if (!val) {
      statusEl.textContent = t('edit.infStatusEmpty');
      return;
    }
    if (infExists && val.toLowerCase() === recordedInfName.toLowerCase()) {
      statusEl.textContent = `✓ ${t('edit.infStatusPresent', { name: val })}`;
    } else {
      statusEl.textContent = `⚠️ ${t('edit.infStatusMissing', { name: val })}`;
    }
  };

  const switchInstallMode = (mode) => {
    currentInstallMode = normalizeInstallMode(mode);
    qsa(modal, '.install-mode-opt').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.installMode === currentInstallMode);
    });
    const descEl = modal.querySelector('#installModeDesc');
    if (descEl) descEl.textContent = getInstallModeDescription(currentInstallMode);

    const configBox = modal.querySelector('#silentConfigBox');
    if (configBox) configBox.classList.toggle('is-ignored', currentInstallMode === 'interactive-required');

    const ignoredHint = qs(modal, '#silentIgnoredHint');
    if (ignoredHint) ignoredHint.hidden = currentInstallMode !== 'interactive-required';

    const applyAdwareBtn = qsButton(modal, '#btnApplyAdwareProtection');
    if (applyAdwareBtn) applyAdwareBtn.hidden = currentInstallMode === 'interactive-required';

    const innoBox = qs(modal, '#innoInfBox');
    const infVal = qsInput(modal, '#editInnoInfFile')?.value.trim();
    if (innoBox) {
      innoBox.hidden = !(detectedInstallerType === 'inno' || Boolean(infVal) || currentInstallMode === 'silent');
    }
  };

  const resolveTargetSetupFile = async () => {
    if (primarySetupFile) return primarySetupFile;
    return window.electronAPI.selectFile([{ name: t('edit.installerPickerFilter'), extensions: ['exe', 'msi'] }], true);
  };

  const refreshAdwareBanner = () => {
    const signal = detectAdwareSignals({
      name: qsInput(modal, '#editName')?.value.trim() || item.name,
      fileName: primarySetupFile ? getBaseName(primarySetupFile) : '',
      packageId: qsInput(modal, '#editPackageId')?.value.trim() || item.packageId || '',
      publisher: itemPublisher,
      t,
    });
    const warnBox = qs(modal, '#adwareWarningBox');
    const warnReason = modal.querySelector('#adwareWarningReason');
    const applyBtn = qsButton(modal, '#btnApplyAdwareProtection');
    if (signal.flagged) {
      if (warnReason) warnReason.textContent = signal.reason;
      if (warnBox) warnBox.hidden = false;
      if (applyBtn) applyBtn.hidden = currentInstallMode === 'interactive-required';
    } else if (warnBox) {
      warnBox.hidden = true;
    }
  };

  modal.querySelector('#editInnoInfFile')?.addEventListener('input', updateInnoInfStatus);
  modal.querySelector('#editName')?.addEventListener('input', refreshAdwareBanner);
  modal.querySelector('#editPackageId')?.addEventListener('input', refreshAdwareBanner);
  modal.querySelector('#providerQueryInput')?.addEventListener('keydown', (ev) => {
    if (ev instanceof KeyboardEvent && ev.key === 'Enter') {
      ev.preventDefault();
      qsButton(modal, '[data-edit-action="search-provider"]')?.click();
    }
  });

  renderPathList();
  renderMediaSection();
  updateInnoInfStatus();

  // Tab-Wechsel
  const switchTab = (tabName) => {
    qsa(modal, '.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    qsa(modal, '.tab-panel').forEach((p) => {
      p.hidden = p.dataset.panel !== tabName;
    });
  };

  // Quell-Wechsel in Tab 2
  const switchSource = (src) => {
    currentSourceType = src;
    qsa(modal, '.source-opt').forEach((b) => {
      b.classList.toggle('active', b.dataset.source === src);
    });
    qsa(modal, '.source-panel').forEach((p) => {
      p.hidden = p.dataset.sourcePanel !== src;
    });
    const testBar = qs(modal, '#onlineTestBar');
    if (testBar) testBar.hidden = src === 'none';
  };

  // Drag & Drop für Icon & Medien im Tab 4
  qsa(modal, '.media-dropzone').forEach((zone) => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dragover');
    });
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dragover');

      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length === 0) return;
      const paths = files.map((f) => window.electronAPI.getFilePath(f)).filter(Boolean);
      if (paths.length === 0) return;

      const dropType = zone.dataset.dropType;
      const res =
        dropType === 'icon'
          ? await window.electronAPI.addIcon(item.path, paths[0])
          : await window.electronAPI.addMedia(item.path, paths);

      if (res.success) {
        await triggerCatalogReload();
        renderMediaSection();
        showToast(
          dropType === 'icon' ? t('edit.toastIconUpdated') : t('edit.toastMediaAdded', { count: paths.length }),
          {
            type: 'success',
          }
        );
      } else {
        showToast(res.error || t('edit.toastAddError'), { type: 'error' });
      }
    });
  });

  // Rich-Text-Selection merken, falls Link eingefügt wird
  let savedSelectionRange = null;

  modal.onchange = (e) => {
    if (e.target instanceof HTMLSelectElement && e.target.id === 'editPackageManager') {
      selectedPackageManager = String(e.target.value || 'winget')
        .trim()
        .toLowerCase();
      const hintEl = modal.querySelector('#providerPanelHint');
      if (hintEl) hintEl.textContent = getProviderHintText(selectedPackageManager);
      const resultsBox = modal.querySelector('#providerResults');
      if (resultsBox instanceof HTMLElement) {
        resultsBox.hidden = true;
        resultsBox.innerHTML = '';
      }
      return;
    }

    if (e.target instanceof HTMLSelectElement && e.target.id === 'installedAppsSelect') {
      const val = e.target.value;
      if (!val) return;
      const input = qsInput(modal, '#editSearchNames');
      const list = input.value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!list.includes(val)) {
        list.push(val);
        input.value = list.join(', ');
      }
      e.target.value = '';
    }
  };

  modal.onclick = async (e) => {
    // Tab Klick
    const tabBtn = closestEl(e.target, '.tab-btn');
    if (tabBtn) {
      switchTab(tabBtn.dataset.tab);
      return;
    }

    // Online-Quelle Klick
    const srcBtn = closestEl(e.target, '.source-opt');
    if (srcBtn) {
      switchSource(srcBtn.dataset.source);
      return;
    }

    // Installationsmodus Klick
    const modeBtn = closestEl(e.target, '[data-install-mode]');
    if (modeBtn) {
      switchInstallMode(modeBtn.dataset.installMode);
      return;
    }

    // Paketmanager-Treffer uebernehmen
    const pkgPick = closestEl(e.target, '[data-provider-pick]');
    if (pkgPick) {
      const pickedId = pkgPick.dataset.providerPick || '';
      qsInput(modal, '#editPackageId').value = pickedId;
      if (pkgPick.dataset.providerVer) {
        qsInput(modal, '#editWebVersion').value = pkgPick.dataset.providerVer;
      }
      qs(modal, '#providerResults').hidden = true;
      refreshAdwareBanner();
      showToast(t('edit.toastPkgIdApplied', { id: pickedId }), { type: 'success' });
      return;
    }

    // Pfad entfernen
    const rmPath = closestEl(e.target, '[data-remove-path]');
    if (rmPath) {
      draftPaths.splice(parseInt(rmPath.dataset.removePath, 10), 1);
      renderPathList();
      return;
    }

    // Medium löschen
    const delMedia = closestEl(e.target, '[data-delete-media]');
    if (delMedia) {
      const res = await window.electronAPI.deleteMedia(item.path, delMedia.dataset.deleteMedia);
      if (res.success) {
        await triggerCatalogReload();
        renderMediaSection();
        showToast(t('edit.toastFileRemoved'), { type: 'info' });
      } else {
        showToast(res.error || t('edit.toastDeleteMediaFailed'), { type: 'error' });
      }
      return;
    }

    // Rich-Text-Toolbar
    const cmdBtn = closestEl(e.target, '#descToolbar button');
    if (cmdBtn) {
      e.preventDefault();
      const cmd = cmdBtn.dataset.cmd;
      if (cmd === 'toggleLinkBar') {
        const sel = window.getSelection();
        if (sel?.rangeCount > 0) savedSelectionRange = sel.getRangeAt(0).cloneRange();
        const bar = qs(modal, '#inlineLinkBar');
        bar.hidden = !bar.hidden;
        if (!bar.hidden) qsInput(modal, '#inlineLinkUrl')?.focus();
      } else {
        document.execCommand(cmd, false, null);
      }
      return;
    }

    const actionBtn = closestButton(e.target, '[data-edit-action]');
    if (!actionBtn) return;
    const act = actionBtn.dataset.editAction;

    if (act === 'cancel') {
      openDetailModal(item.id);
      return;
    }

    if (act === 'open-meta-dir') {
      window.electronAPI.openPath(`${item.path}\\_metadata`);
      return;
    }

    if (act === 'apply-link') {
      const url = qsInput(modal, '#inlineLinkUrl').value.trim();
      qs(modal, '#inlineLinkBar').hidden = true;
      if (url) {
        const editor = qs(modal, '#editDesc');
        editor.focus();
        if (savedSelectionRange) {
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(savedSelectionRange);
        }
        document.execCommand('createLink', false, url);
      }
      return;
    }

    if (act === 'cancel-link') {
      qs(modal, '#inlineLinkBar').hidden = true;
      return;
    }

    // Live-Suche ueber gewaehlten Paketmanager
    if (act === 'search-provider') {
      const query = qsInput(modal, '#providerQueryInput').value.trim();
      const box = qs(modal, '#providerResults');
      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = `⏳ ${t('edit.btnSearching')}`;

      const res = await window.electronAPI.searchProviders(query, {
        providerIds: [selectedPackageManager],
        limit: 25,
      });
      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      const providerRes = res?.byProvider?.[selectedPackageManager];
      if (!res?.success || (providerRes && !providerRes.success)) {
        showToast(providerRes?.error || res?.error || t('edit.toastProviderSearchFailed'), { type: 'error' });
        return;
      }

      const items = Array.isArray(providerRes?.results) ? providerRes.results : res.results || [];
      box.hidden = false;
      if (!items.length) {
        box.innerHTML = `<div class="winget-empty">${escapeHTML(providerRes?.hint || t('edit.providerNoResults'))}</div>`;
      } else {
        box.innerHTML = items
          .map((r) => {
            const pid = r.packageId || r.id || '';
            const verText = [r.version ? `v${r.version}` : '', r.bucket || ''].filter(Boolean).join(' · ');
            return `
            <button type="button" class="winget-row" data-provider-pick="${escapeHTML(pid)}" data-provider-ver="${escapeHTML(r.version || '')}">
              <strong>${escapeHTML(r.name || pid)}</strong>
              <code>${escapeHTML(pid)}</code>
              <span class="muted">${escapeHTML(verText)}</span>
            </button>
          `;
          })
          .join('');
      }
      return;
    }

    // Visueller Versions-Highlighter
    if (act === 'visual-scrape') {
      const url = qsInput(modal, '#editWebUrl').value.trim();
      if (!url) return showToast(t('edit.toastEnterUrlFirst'), { type: 'warn' });

      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = `⏳ ${t('edit.btnWindowOpen')}`;
      const res = await window.electronAPI.openVisualScraper(url);
      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (res.success) {
        qsInput(modal, '#editWebPrefix').value = res.prefix || '';
        qsInput(modal, '#editWebSuffix').value = res.suffix || '';
        qsInput(modal, '#editWebVersion').value = res.version || '';
        showToast(t('edit.toastVersionHighlighted', { version: res.version }), { type: 'success' });
      } else if (!res.canceled) {
        showToast(res.error || t('edit.toastHighlightFailed'), { type: 'error' });
      }
      return;
    }

    // Gefixter Visueller Link-Picker (mit will-download Abfangnetz!)
    if (act === 'visual-link-pick') {
      const dlInput = qsInput(modal, '#editDownloadUrl');
      const webInput = qsInput(modal, '#editWebUrl');
      const startUrl = dlInput.value.trim() || webInput.value.trim();
      if (!startUrl) {
        return showToast(t('edit.toastEnterStartUrl'), { type: 'warn' });
      }

      const knownVer = qsInput(modal, '#editWebVersion').value.trim();
      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = `⏳ ${t('edit.btnWindowOpen')}`;
      const res = await window.electronAPI.openVisualLinkPicker(startUrl, knownVer);
      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (res.success) {
        dlInput.value = res.url || '';
        qsInput(modal, '#editDlPrefix').value = res.prefix || '';
        qsInput(modal, '#editDlSuffix').value = res.suffix || '';

        if (res.mode === 'template') {
          showToast(t('edit.toastDownloadTemplateSaved', { version: '{version}' }), { type: 'success' });
        } else if (res.mode === 'direct-intercept') {
          showToast(t('edit.toastDownloadIntercepted'), { type: 'success' });
        } else {
          showToast(t('edit.toastDownloadButtonDetected'), { type: 'success' });
        }
      } else if (!res.canceled) {
        showToast(res.error || t('edit.toastLinkPickFailed'), { type: 'error' });
      }
      return;
    }

    // Live-Test Online-Quelle (kein alert, direktes Inline-Feedback!)
    if (act === 'test-online') {
      const fb = modal.querySelector('#onlineTestFeedback');
      const pkgIdVal = qsInput(modal, '#editPackageId').value.trim();
      const isProvider = currentSourceType === 'provider';
      const payload = {
        itemId: item.id,
        sourceType: isProvider ? (selectedPackageManager === 'winget' ? 'winget' : 'provider') : currentSourceType,
        packageManager: isProvider ? selectedPackageManager : '',
        packageId: isProvider ? pkgIdVal : '',
        wingetId: isProvider && selectedPackageManager === 'winget' ? pkgIdVal : '',
        githubAssetPattern: qsInput(modal, '#editGithubAssetPattern').value.trim(),
        url:
          currentSourceType === 'github'
            ? qsInput(modal, '#editGithubUrl').value.trim()
            : qsInput(modal, '#editWebUrl').value.trim(),
        prefix: qsInput(modal, '#editWebPrefix').value,
        suffix: qsInput(modal, '#editWebSuffix').value,
        persist: false,
      };

      actionBtn.disabled = true;
      fb.className = 'test-feedback';
      fb.textContent = t('edit.testRunning');

      const res = await window.electronAPI.checkSingleWeb(payload);
      actionBtn.disabled = false;

      if (res.success) {
        qsInput(modal, '#editWebVersion').value = res.version;
        const dlInfo = res.downloadUrl ? t('edit.testOkDirectDl') : '';
        fb.className = 'test-feedback is-ok';
        fb.textContent = `✓ ${t('edit.testOk', { version: res.version, dlInfo })}`;
      } else {
        fb.className = 'test-feedback is-err';
        fb.textContent = `✕ ${res.error || t('edit.testFailed')}`;
      }
      return;
    }

    // PC-Programme für Suchnamen laden
    if (act === 'load-installed-apps') {
      actionBtn.disabled = true;
      actionBtn.textContent = `⏳ ${t('edit.btnLoading')}`;
      const apps = await window.electronAPI.getInstalledApps();
      const slot = modal.querySelector('#installedAppsSlot');
      if (apps?.length > 0 && slot) {
        slot.innerHTML = `
          <select id="installedAppsSelect" class="apps-select">
            <option value="">${escapeHTML(t('edit.selectAppPlaceholder'))}</option>
            ${apps.map((a) => `<option value="${escapeHTML(a)}">${escapeHTML(a)}</option>`).join('')}
          </select>
        `;
      } else {
        actionBtn.disabled = false;
        actionBtn.textContent = `📋 ${t('edit.loadInstalledAppsBtn')}`;
        showToast(t('edit.toastNoAppsFound'), { type: 'warn' });
      }
      return;
    }

    // Auto-Detect Pfad
    if (act === 'auto-detect-path') {
      const mainName = qsInput(modal, '#editName').value.trim();
      const extras = qsInput(modal, '#editSearchNames')
        .value.split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = `⏳ ${t('edit.btnSearching')}`;
      const res = await window.electronAPI.autoDetectPath([mainName, ...extras]);
      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (res.success && res.path) {
        if (!draftPaths.some((p) => p.path.toLowerCase() === res.path.toLowerCase())) {
          draftPaths.unshift({ path: res.path, origin: 'auto' });
          renderPathList();
        }
        showToast(t('edit.toastPathFound'), { type: 'success' });
      } else {
        showToast(t('edit.toastNoPathFound'), { type: 'warn' });
      }
      return;
    }

    // Manuellen Pfad wählen
    if (act === 'browse-path') {
      const selected = await window.electronAPI.selectFile(
        [{ name: t('edit.executablePickerFilter'), extensions: ['exe', 'bat', 'cmd', 'ps1'] }],
        true
      );
      if (selected && !draftPaths.some((p) => p.path.toLowerCase() === selected.toLowerCase())) {
        draftPaths.push({ path: selected, origin: 'manual' });
        renderPathList();
      }
      return;
    }

    if (act === 'apply-adware-protection') {
      switchInstallMode('interactive-required');
      showToast(t('edit.toastAdwareEnabled'), { type: 'success' });
      return;
    }

    // Setup-Typ automatisch erkennen
    if (act === 'detect-installer') {
      const targetFile = await resolveTargetSetupFile();
      if (!targetFile) return;

      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = `⏳ ${t('edit.btnAnalyzing')}`;

      const res = await window.electronAPI.detectInstaller({
        filePath: targetFile,
        name: qsInput(modal, '#editName').value.trim() || item.name,
        packageId: qsInput(modal, '#editPackageId')?.value.trim() || item.packageId || '',
        publisher: itemPublisher,
      });

      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (!res?.success) {
        showToast(res?.error || t('edit.toastDetectFailed'), { type: 'error' });
        return;
      }

      detectedInstallerType = res.type || 'unknown';
      const argsInput = qsInput(modal, '#editSilentArgs');
      if (argsInput && res.suggestedArgs) {
        argsInput.value = res.suggestedArgs;
      }

      const fb = qs(modal, '#installerDetectFeedback');
      if (fb) {
        fb.hidden = false;
        fb.innerHTML = `
          <strong>${escapeHTML(t('edit.detectedSetupTypeTitle', { label: res.label }))}</strong>
          ${res.matchedSignature ? `<code>${escapeHTML(res.matchedSignature)}</code>` : ''}
          <p class="muted">${escapeHTML(res.hint || '')}</p>
        `;
      }

      if (res.type === 'inno') {
        const innoBox = qs(modal, '#innoInfBox');
        if (innoBox) innoBox.hidden = false;
      }

      if (res.adwareWarning?.flagged) {
        const warnBox = qs(modal, '#adwareWarningBox');
        const warnReason = modal.querySelector('#adwareWarningReason');
        const applyBtn = qsButton(modal, '#btnApplyAdwareProtection');
        if (warnReason) warnReason.textContent = res.adwareWarning.reason;
        if (warnBox) warnBox.hidden = false;
        if (applyBtn) applyBtn.hidden = currentInstallMode === 'interactive-required';
      }

      if (res.suggestedArgs) {
        showToast(t('edit.toastDetectedWithArgs', { label: res.label }), { type: 'success' });
      } else {
        showToast(t('edit.toastDetectedNoArgs', { label: res.label }), { type: 'info' });
      }
      return;
    }

    // Installer mit aktuellem Modus testen
    if (act === 'test-installer') {
      const argsVal = qsInput(modal, '#editSilentArgs')?.value.trim() || '';
      if (currentInstallMode === 'silent' && !argsVal) {
        return showToast(t('edit.toastNeedSilentArgs'), {
          type: 'warn',
        });
      }

      const targetFile = await resolveTargetSetupFile();
      if (!targetFile) return;

      const infVal = sanitizeInnoInfFileName(qsInput(modal, '#editInnoInfFile')?.value.trim() || '');
      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = `⏳ ${t('edit.btnRunning')}`;

      const res = await window.electronAPI.executeInstaller({
        itemId: item.id,
        itemName: qsInput(modal, '#editName').value.trim() || item.name,
        sourcePath: targetFile,
        itemPath: item.path,
        allowSilent: currentInstallMode === 'silent',
        installMode: currentInstallMode,
        silentArgs: argsVal,
        innoInfFile: infVal,
      });

      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (res?.alreadyRunning) {
        showToast(t('detail.toastAlreadyRunning'), { type: 'warn' });
      } else if (res?.canceled) {
        showToast(t('edit.toastTestCanceled'), { type: 'info' });
      } else if (res?.success) {
        await triggerCatalogReload({ rescanInstalled: true });
        const msg = res.adwareProtected
          ? t('edit.toastTestProtected')
          : res.effectiveSilent
            ? t('edit.toastTestSilent')
            : t('edit.toastTestInteractive');
        showToast(msg, { type: 'success' });
      } else if (res?.error) {
        showToast(t('edit.toastTestFailed', { error: res.error }), { type: 'error', duration: 6000 });
      }
      return;
    }

    // Inno Setup Antwortdatei (.inf) aufzeichnen
    if (act === 'record-inno-inf') {
      const targetFile = await resolveTargetSetupFile();
      if (!targetFile) return;

      if (!targetFile.toLowerCase().endsWith('.exe')) {
        return showToast(t('edit.toastInfOnlyExe'), { type: 'warn' });
      }

      const infInput = qsInput(modal, '#editInnoInfFile');
      const desiredName = sanitizeInnoInfFileName(infInput?.value.trim() || '') || 'silent.inf';

      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = `⏳ ${t('edit.btnRecording')}`;

      const res = await window.electronAPI.recordInnoInf({
        itemId: item.id,
        itemName: qsInput(modal, '#editName').value.trim() || item.name,
        itemPath: item.path,
        sourcePath: targetFile,
        infFileName: desiredName,
      });

      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (res?.alreadyRunning) {
        showToast(t('detail.toastAlreadyRunning'), { type: 'warn' });
      } else if (res?.success) {
        if (infInput) infInput.value = res.infFile;
        infExists = true;
        recordedInfName = res.infFile;
        updateInnoInfStatus();
        await triggerCatalogReload();
        showToast(t('edit.toastInfSaved', { name: res.infFile }), { type: 'success' });
      } else if (res?.canceled) {
        showToast(t('edit.toastInfCanceled'), { type: 'info' });
      } else {
        showToast(res?.error || t('edit.toastInfFailed'), { type: 'error', duration: 6000 });
      }
      return;
    }

    // Icon aus .exe extrahieren
    if (act === 'extract-icon') {
      const exeEntry = draftPaths.find((p) => p.path.toLowerCase().endsWith('.exe'));
      if (!exeEntry) {
        return showToast(t('edit.toastNeedExeForIcon'), { type: 'warn' });
      }
      actionBtn.disabled = true;
      const res = await window.electronAPI.extractExeIcon(exeEntry.path, item.path);
      actionBtn.disabled = false;
      if (res.success) {
        await triggerCatalogReload();
        renderMediaSection();
        showToast(t('edit.toastIconExtracted'), { type: 'success' });
      } else {
        showToast(res.error || t('edit.toastIconExtractFailed'), { type: 'error' });
      }
      return;
    }

    // Auto-Fill abrufen (überschreibt nichts automatisch -> zeigt Checkliste!)
    if (act === 'autofill-fetch') {
      const pkgIdVal = qsInput(modal, '#editPackageId').value.trim();
      const isProvider = currentSourceType === 'provider';
      const payload = {
        sourceType: isProvider ? (selectedPackageManager === 'winget' ? 'winget' : 'provider') : currentSourceType,
        packageManager: isProvider ? selectedPackageManager : '',
        packageId: isProvider ? pkgIdVal : '',
        wingetId: isProvider && selectedPackageManager === 'winget' ? pkgIdVal : '',
        url:
          currentSourceType === 'github'
            ? qsInput(modal, '#editGithubUrl').value.trim()
            : qsInput(modal, '#editWebUrl').value.trim(),
      };

      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = `⏳ ${t('edit.btnLoadingInfo')}`;
      const res = await window.electronAPI.fetchSoftwareMetadata(payload);
      actionBtn.disabled = false;
      actionBtn.textContent = orig;

      if (!res.success) {
        return showToast(res.error || t('edit.toastDetailsLoadFailed'), { type: 'warn', duration: 5000 });
      }

      const m = res.metadata;
      const box = qs(modal, '#autofillPreviewBox');
      const hasDesc = Boolean(modal.querySelector('#editDesc').textContent.trim());
      const hasTags = Boolean(qsInput(modal, '#editTags').value.trim());
      const hasLinks = Boolean(qsTextarea(modal, '#editLinks').value.trim());

      const rows = [];
      if (m.description) {
        rows.push(`
      <label class="autofill-row">
        <input type="checkbox" data-af-field="description" ${hasDesc ? '' : 'checked'}>
        <div>
          <strong>${escapeHTML(t('edit.afDescTitle'))}</strong> ${hasDesc ? `<span class="muted">${escapeHTML(t('edit.afExistingOverwrite'))}</span>` : `<span class="text-ok">${escapeHTML(t('edit.afEmpty'))}</span>`}
          <p class="autofill-snippet">${escapeHTML(m.description)}</p>
        </div>
      </label>
    `);
      }
      if (m.tags?.length) {
        rows.push(`
      <label class="autofill-row">
        <input type="checkbox" data-af-field="tags" ${hasTags ? '' : 'checked'}>
        <div>
          <strong>${escapeHTML(t('edit.afAddTags'))}</strong>
          <p class="autofill-snippet">${escapeHTML(m.tags.join(', '))}</p>
        </div>
      </label>
    `);
      }
      if (m.links && Object.keys(m.links).length > 0) {
        const linkSummary = Object.entries(m.links)
          .map(([k, v]) => `${k} | ${v}`)
          .join(' · ');
        rows.push(`
      <label class="autofill-row">
        <input type="checkbox" data-af-field="links" ${hasLinks ? '' : 'checked'}>
        <div>
          <strong>${escapeHTML(t('edit.afAddLinks'))}</strong>
          <p class="autofill-snippet">${escapeHTML(linkSummary)}</p>
        </div>
      </label>
    `);
      }

      if (rows.length === 0) {
        return showToast(t('edit.toastNoExtraDetails', { source: res.sourceLabel }), { type: 'info' });
      }

      box.dataset.payload = JSON.stringify(m);
      box.hidden = false;
      box.innerHTML = `
    <div class="autofill-head">
      <strong>${escapeHTML(t('edit.afPreviewTitle', { source: res.sourceLabel }))}</strong>
      <div class="footer-group">
        <button type="button" class="btn btn-primary btn-xs" data-edit-action="autofill-apply">${escapeHTML(t('edit.afApplySelected'))}</button>
        <button type="button" class="btn btn-ghost btn-xs" data-edit-action="autofill-close">${escapeHTML(t('common.close'))}</button>
      </div>
    </div>
    <div class="autofill-list">${rows.join('')}</div>
  `;
      return;
    }

    if (act === 'autofill-close') {
      const box = qs(modal, '#autofillPreviewBox');
      if (box) box.hidden = true;
      return;
    }

    if (act === 'autofill-apply') {
      const box = qs(modal, '#autofillPreviewBox');
      if (!box?.dataset.payload) return;
      const m = JSON.parse(box.dataset.payload);
      let applied = 0;

      if (qsInput(box, '[data-af-field="description"]')?.checked && m.description) {
        modal.querySelector('#editDesc').textContent = m.description;
        applied++;
      }

      if (qsInput(box, '[data-af-field="tags"]')?.checked && m.tags?.length) {
        const tagsInput = qsInput(modal, '#editTags');
        const existing = tagsInput.value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const merged = [...existing];
        for (const t of m.tags) {
          if (!merged.some((e) => e.toLowerCase() === t.toLowerCase())) merged.push(t);
        }
        tagsInput.value = merged.join(', ');
        applied++;
      }

      if (qsInput(box, '[data-af-field="links"]')?.checked && m.links) {
        const linksEl = qsTextarea(modal, '#editLinks');
        const currentLines = linksEl.value
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        for (const [label, url] of Object.entries(m.links)) {
          if (!currentLines.some((l) => l.includes(url))) {
            currentLines.push(`${label} | ${url}`);
          }
        }
        linksEl.value = currentLines.join('\n');
        applied++;
      }

      box.hidden = true;
      showToast(applied > 0 ? t('edit.toastAutofillApplied', { count: applied }) : t('edit.toastAutofillNone'), {
        type: applied > 0 ? 'success' : 'info',
      });
      return;
    }

    // SPEICHERN
    if (act === 'save') {
      actionBtn.disabled = true;
      const orig = actionBtn.textContent;
      actionBtn.textContent = `⏳ ${t('common.saving')}`;

      const linksObj = {};
      for (const line of qsTextarea(modal, '#editLinks').value.split('\n')) {
        const parts = line.split('|');
        if (parts.length >= 2) {
          const label = parts[0].trim();
          const url = parts.slice(1).join('|').trim();
          if (label && url) linksObj[label] = url;
        }
      }

      const webUrl =
        currentSourceType === 'github'
          ? qsInput(modal, '#editGithubUrl').value.trim()
          : currentSourceType === 'web'
            ? qsInput(modal, '#editWebUrl').value.trim()
            : '';

      const isProviderSource = currentSourceType === 'provider';
      const enteredPkgId = isProviderSource ? qsInput(modal, '#editPackageId').value.trim() : '';
      const nextPackageManager = isProviderSource && enteredPkgId ? selectedPackageManager : '';
      const nextPackageId = isProviderSource && enteredPkgId ? enteredPkgId : '';
      const savedWingetId = nextPackageManager === 'winget' ? nextPackageId : '';
      const nextWebSourceType = isProviderSource
        ? nextPackageManager === 'winget'
          ? 'winget'
          : 'provider'
        : currentSourceType;

      const payload = {
        name: qsInput(modal, '#editName').value.trim() || item.name,
        softwareType: qsSelect(modal, '#editSoftwareType').value,
        category: qsInput(modal, '#editCat').value.trim(),
        hiddenCategory: qsInput(modal, '#editHidden').value.trim(),
        tags: qsInput(modal, '#editTags')
          .value.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        formats: qsInput(modal, '#editFormats')
          .value.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        os: qsInput(modal, '#editOS')
          .value.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        keepAllVersions: Boolean(qsInput(modal, '#editKeepAllVersions')?.checked),
        description: sanitizeRichHtml(modal.querySelector('#editDesc').innerHTML.trim()),
        searchNames: qsInput(modal, '#editSearchNames')
          .value.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        autoPaths: draftPaths.filter((p) => p.origin === 'auto').map((p) => p.path),
        installPaths: draftPaths.filter((p) => p.origin === 'manual').map((p) => p.path),
        installMode: currentInstallMode,
        silentArgs: sanitizeSilentArgs(qsInput(modal, '#editSilentArgs')?.value || ''),
        innoInfFile: sanitizeInnoInfFileName(qsInput(modal, '#editInnoInfFile')?.value.trim() || ''),
        webSourceType: nextWebSourceType,
        packageManager: nextPackageManager,
        packageId: nextPackageId,
        wingetId: savedWingetId,
        githubAssetPattern:
          currentSourceType === 'github' ? qsInput(modal, '#editGithubAssetPattern').value.trim() : '',
        webVersionUrl: webUrl,
        webVersionPrefix: currentSourceType === 'web' ? qsInput(modal, '#editWebPrefix').value : '',
        webVersionSuffix: currentSourceType === 'web' ? qsInput(modal, '#editWebSuffix').value : '',
        downloadUrl: currentSourceType === 'web' ? qsInput(modal, '#editDownloadUrl').value.trim() : '',
        dlPrefix: currentSourceType === 'web' ? qsInput(modal, '#editDlPrefix').value : '',
        dlSuffix: currentSourceType === 'web' ? qsInput(modal, '#editDlSuffix').value : '',
        webVersion: currentSourceType === 'none' ? '' : qsInput(modal, '#editWebVersion').value.trim(),
        links: linksObj,
      };

      const res = await window.electronAPI.saveMetaJson(item.path, payload);
      if (res.success) {
        await window.electronAPI.scanLocalVersions({ itemIds: [item.id], silent: true });
        await triggerCatalogReload();
        showToast(t('edit.toastSaved'), { type: 'success' });
        openDetailModal(item.id);
      } else {
        actionBtn.disabled = false;
        actionBtn.textContent = orig;
        showToast(t('edit.toastSaveError', { error: res.error }), { type: 'error', duration: 6000 });
      }
    }
  };
}
