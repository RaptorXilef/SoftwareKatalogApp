import { showToast } from '../components/toast.js';
import { getLocalizedProviderName, getLocalizedSourceTemplateDescription, t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';

function getDialogElements() {
  const overlay = document.getElementById('dialogOverlay');
  const dialog = document.getElementById('dialogContent');
  if (!overlay || !dialog) return null;
  return { overlay, dialog };
}

function renderSourceMetaBadges(providerId, src) {
  const badges = [];
  if (src.builtIn) {
    badges.push(`<span class="provider-source-badge">${escapeHTML(t('providerSources.badgeBuiltIn'))}</span>`);
  }
  if (src.active) {
    badges.push(`<span class="provider-source-badge is-active">${escapeHTML(t('providerSources.badgeActive'))}</span>`);
  }
  if (src.enabled === false) {
    badges.push(
      `<span class="provider-source-badge is-disabled">${escapeHTML(t('providerSources.badgeDisabled'))}</span>`
    );
  }
  if (src.trusted === true) {
    badges.push(
      `<span class="provider-source-badge is-trusted">${escapeHTML(t('providerSources.badgeTrusted'))}</span>`
    );
  }
  if (src.explicit === true) {
    badges.push(`<span class="provider-source-badge">${escapeHTML(t('providerSources.badgeExplicit'))}</span>`);
  }
  if (src.adminOnly === true) {
    badges.push(`<span class="provider-source-badge is-warn">${escapeHTML(t('providerSources.badgeAdmin'))}</span>`);
  }
  if (typeof src.manifests === 'number') {
    badges.push(
      `<span class="provider-source-badge">${escapeHTML(t('providerSources.badgeManifests', { count: src.manifests }))}</span>`
    );
  }
  if (providerId === 'chocolatey' && typeof src.priority === 'number' && src.priority !== 0) {
    badges.push(
      `<span class="provider-source-badge">${escapeHTML(t('providerSources.badgePriority', { priority: src.priority }))}</span>`
    );
  }
  return badges.join('');
}

/**
 * Oeffnet ein uebersichtliches In-App-Modal zur Verwaltung von Bezugsquellen (Sources/Buckets/Repositories)
 * eines Paketmanagers direkt ueber dem Einstellungs-Modal.
 * @param {{ id: string, name?: string }} provider
 * @returns {Promise<{ changed: boolean }>}
 */
export function openProviderSourcesModal(provider) {
  const els = getDialogElements();
  if (!els || !provider?.id) return Promise.resolve({ changed: false });

  const { overlay, dialog } = els;
  const providerId = String(provider.id).trim().toLowerCase();
  const providerName = getLocalizedProviderName(provider);
  const isScoop = providerId === 'scoop';
  const isWinget = providerId === 'winget';

  let sources = [];
  let templates = [];
  let mode = 'cli';
  let requiresAdmin = false;
  let hintText = '';
  let loadError = '';
  let isLoading = true;
  let isBusy = false;
  let hasChanged = false;
  let settled = false;

  dialog.classList.add('modal-sources');

  return new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      overlay.hidden = true;
      dialog.innerHTML = '';
      dialog.classList.remove('modal-sources');
      dialog.onclick = null;
      overlay.onclick = null;
      document.removeEventListener('keydown', onKeyDown, true);
      resolve({ changed: hasChanged });
    };

    const render = () => {
      if (settled) return;
      const existingNames = new Set(sources.map((s) => String(s.name || '').toLowerCase()));

      let listHtml = '';
      if (isLoading) {
        listHtml = `<div class="path-empty">⏳ ${escapeHTML(t('providerSources.loading'))}</div>`;
      } else if (loadError) {
        listHtml = `<div class="path-empty">${escapeHTML(loadError)}</div>`;
      } else if (sources.length === 0) {
        listHtml = `<div class="path-empty">${escapeHTML(t('providerSources.empty'))}</div>`;
      } else {
        listHtml = `
          <div class="provider-sources-list">
            ${sources
              .map((src) => {
                const badgesHtml = renderSourceMetaBadges(providerId, src);
                const removeBtnHtml = src.builtIn
                  ? `<span class="muted">${escapeHTML(t('providerSources.builtInFallback'))}</span>`
                  : `<button type="button" class="btn btn-danger btn-xs" data-source-remove="${escapeHTML(src.name)}" ${isBusy ? 'disabled' : ''}>🗑️ ${escapeHTML(t('common.remove'))}</button>`;
                return `
                  <div class="provider-source-row ${src.enabled === false ? 'is-disabled' : ''}">
                    <div class="provider-source-info">
                      <div class="provider-source-head">
                        <strong>${escapeHTML(src.name)}</strong>
                        ${badgesHtml}
                      </div>
                      ${src.url ? `<code class="provider-source-url" title="${escapeHTML(src.url)}">${escapeHTML(src.url)}</code>` : `<span class="muted">${escapeHTML(t('providerSources.defaultBucketSource'))}</span>`}
                      ${src.updated ? `<span class="muted">${escapeHTML(t('providerSources.updatedLabel', { value: src.updated }))}</span>` : ''}
                    </div>
                    <div class="provider-source-actions">${removeBtnHtml}</div>
                  </div>
                `;
              })
              .join('')}
          </div>
        `;
      }

      const templatesHtml =
        templates.length > 0
          ? `
            <div class="form-field">
              <span>${escapeHTML(t('providerSources.templatesLabel'))}</span>
              <div class="provider-source-templates">
                ${templates
                  .map((tpl, idx) => {
                    const alreadyPresent = existingNames.has(String(tpl.name || '').toLowerCase());
                    return `
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs provider-template-btn ${alreadyPresent ? 'is-present' : ''}"
                        data-source-template-idx="${idx}"
                        ${alreadyPresent || isBusy || isLoading ? 'disabled' : ''}
                        title="${escapeHTML(getLocalizedSourceTemplateDescription(providerId, tpl))}"
                      >
                        ${alreadyPresent ? '✓' : '+'} ${escapeHTML(tpl.name)}
                      </button>
                    `;
                  })
                  .join('')}
              </div>
            </div>
          `
          : '';

      const effectiveHint = mode === 'config' ? t('providerSources.configModeHint') : hintText;
      const noticeHtml =
        effectiveHint || requiresAdmin || mode === 'config'
          ? `
            <div class="provider-source-hint">
              ${requiresAdmin ? `<strong>🛡️ ${escapeHTML(t('providerSources.adminNoticeTitle'))}</strong> ${escapeHTML(t('providerSources.adminNoticeBody'))} ` : ''}
              <span>${escapeHTML(effectiveHint || '')}</span>
            </div>
          `
          : '';

      dialog.innerHTML = `
        <div class="modal-header">
          <h2>🌐 ${escapeHTML(t('providerSources.title', { name: providerName }))}</h2>
          <button type="button" class="icon-btn" data-sources-action="close" title="${escapeHTML(t('common.close'))}" aria-label="${escapeHTML(t('common.close'))}">✕</button>
        </div>

        <div class="modal-body provider-sources-body">
          ${noticeHtml}
          <div class="form-field">
            <span>${escapeHTML(t('providerSources.activeSourcesLabel'))}</span>
            ${listHtml}
          </div>

          ${templatesHtml}

          <div class="provider-source-form">
            <h4>${escapeHTML(t('providerSources.addFormTitle'))}</h4>
            <div class="form-grid-2">
              <label class="form-field">
                <span>${escapeHTML(t('providerSources.nameLabel'))}</span>
                <input type="text" id="srcAddName" placeholder="${escapeHTML(isScoop ? t('providerSources.namePlaceholderScoop') : t('providerSources.namePlaceholderGeneric'))}" ${isBusy ? 'disabled' : ''}>
              </label>
              <label class="form-field">
                <span>${escapeHTML(isScoop ? t('providerSources.urlLabelScoop') : t('providerSources.urlLabelGeneric'))}</span>
                <input type="url" id="srcAddUrl" placeholder="${escapeHTML(isScoop ? t('providerSources.urlPlaceholderScoop') : t('providerSources.urlPlaceholderGeneric'))}" ${isBusy ? 'disabled' : ''}>
              </label>
            </div>
            ${
              isWinget
                ? `
                  <label class="form-field">
                    <span>${escapeHTML(t('providerSources.typeLabel'))}</span>
                    <input type="text" id="srcAddType" placeholder="${escapeHTML(t('providerSources.typePlaceholder'))}" ${isBusy ? 'disabled' : ''}>
                  </label>
                `
                : ''
            }
            <div class="provider-source-form-actions">
              <button type="button" class="btn btn-primary" data-sources-action="add" ${isBusy || isLoading ? 'disabled' : ''}>
                ${isBusy ? `⏳ ${escapeHTML(t('common.working'))}` : `➕ ${escapeHTML(t('providerSources.addBtn'))}`}
              </button>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" data-sources-action="refresh" ${isBusy || isLoading ? 'disabled' : ''}>🔄 ${escapeHTML(t('common.refresh'))}</button>
          <button type="button" class="btn btn-primary" data-sources-action="close">${escapeHTML(t('common.close'))}</button>
        </div>
      `;
    };

    const loadSources = async () => {
      isLoading = true;
      loadError = '';
      render();
      try {
        const res = await window.electronAPI.listProviderSources(providerId);
        if (settled) return;
        isLoading = false;
        if (!res?.success) {
          sources = [];
          templates = Array.isArray(res?.templates) ? res.templates : [];
          requiresAdmin = Boolean(res?.requiresAdmin);
          mode = res?.mode || 'cli';
          hintText = res?.hint || '';
          loadError = res?.error || t('providerSources.loadFailed');
        } else {
          sources = Array.isArray(res.sources) ? res.sources : [];
          templates = Array.isArray(res.templates) ? res.templates : [];
          requiresAdmin = Boolean(res.requiresAdmin);
          mode = res.mode || 'cli';
          hintText = res.hint || '';
          loadError = '';
        }
      } catch (err) {
        if (settled) return;
        isLoading = false;
        loadError = err?.message || t('providerSources.loadError');
      }
      render();
    };

    const executeAdd = async ({ name, url, type = '' }) => {
      if (isBusy) return;
      isBusy = true;
      render();
      try {
        const res = await window.electronAPI.addProviderSource(providerId, { name, url, type });
        if (settled) return;
        isBusy = false;
        if (res?.canceled) {
          showToast(t('common.operationCanceled'), { type: 'info' });
          render();
          return;
        }
        if (!res?.success) {
          showToast(res?.error || t('providerSources.addFailed'), { type: 'error', duration: 6000 });
          render();
          return;
        }
        hasChanged = true;
        showToast(t('providerSources.addedToast', { name }), { type: 'success' });
        await loadSources();
      } catch (err) {
        if (settled) return;
        isBusy = false;
        showToast(err?.message || t('providerSources.addError'), { type: 'error', duration: 6000 });
        render();
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish();
        return;
      }
      if (
        e.key === 'Enter' &&
        e.target instanceof HTMLInputElement &&
        ['srcAddName', 'srcAddUrl', 'srcAddType'].includes(e.target.id)
      ) {
        e.preventDefault();
        const addBtn = dialog.querySelector('[data-sources-action="add"]');
        if (addBtn instanceof HTMLButtonElement && !addBtn.disabled) {
          addBtn.click();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        finish();
      }
    };

    dialog.onclick = async (e) => {
      if (!(e.target instanceof Element)) return;

      const tplBtn = e.target.closest('[data-source-template-idx]');
      if (tplBtn instanceof HTMLButtonElement) {
        const idx = Number.parseInt(tplBtn.dataset.sourceTemplateIdx || '-1', 10);
        const tpl = templates[idx];
        if (!tpl) return;
        await executeAdd({ name: tpl.name, url: tpl.url || '', type: tpl.type || '' });
        return;
      }

      const removeBtn = e.target.closest('[data-source-remove]');
      if (removeBtn instanceof HTMLButtonElement) {
        const sourceName = removeBtn.dataset.sourceRemove || '';
        if (!sourceName || isBusy) return;

        if (removeBtn.dataset.armed !== 'true') {
          removeBtn.dataset.armed = 'true';
          removeBtn.dataset.origText = removeBtn.textContent || `🗑️ ${t('common.remove')}`;
          removeBtn.textContent = `⚠️ ${t('common.confirmRemoveArmed')}`;
          setTimeout(() => {
            if (removeBtn.isConnected && removeBtn.dataset.armed === 'true') {
              removeBtn.dataset.armed = 'false';
              removeBtn.textContent = removeBtn.dataset.origText || `🗑️ ${t('common.remove')}`;
            }
          }, 4000);
          return;
        }

        removeBtn.dataset.armed = 'false';
        isBusy = true;
        render();
        try {
          const res = await window.electronAPI.removeProviderSource(providerId, sourceName);
          if (settled) return;
          isBusy = false;
          if (res?.canceled) {
            showToast(t('common.operationCanceled'), { type: 'info' });
            render();
            return;
          }
          if (!res?.success) {
            showToast(res?.error || t('providerSources.removeFailed'), { type: 'error', duration: 6000 });
            render();
            return;
          }
          hasChanged = true;
          showToast(t('providerSources.removedToast', { name: sourceName }), { type: 'info' });
          await loadSources();
        } catch (err) {
          if (settled) return;
          isBusy = false;
          showToast(err?.message || t('providerSources.removeError'), { type: 'error', duration: 6000 });
          render();
        }
        return;
      }

      const actBtn = e.target.closest('[data-sources-action]');
      if (!(actBtn instanceof HTMLElement)) return;
      const act = actBtn.dataset.sourcesAction;

      if (act === 'close') {
        finish();
      } else if (act === 'refresh') {
        await loadSources();
      } else if (act === 'add') {
        const nameEl = dialog.querySelector('#srcAddName');
        const urlEl = dialog.querySelector('#srcAddUrl');
        const typeEl = dialog.querySelector('#srcAddType');
        const name = nameEl instanceof HTMLInputElement ? nameEl.value.trim() : '';
        const url = urlEl instanceof HTMLInputElement ? urlEl.value.trim() : '';
        const type = typeEl instanceof HTMLInputElement ? typeEl.value.trim() : '';

        if (!name) {
          showToast(t('providerSources.missingNameToast'), { type: 'warn' });
          return;
        }
        if (!isScoop && !url) {
          showToast(t('providerSources.missingUrlToast'), { type: 'warn' });
          return;
        }
        await executeAdd({ name, url, type });
      }
    };

    overlay.hidden = false;
    void loadSources();
  });
}
