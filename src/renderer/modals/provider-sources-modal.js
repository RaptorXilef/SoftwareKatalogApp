import { showToast } from '../components/toast.js';
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
    badges.push('<span class="provider-source-badge">Standard</span>');
  }
  if (src.active) {
    badges.push('<span class="provider-source-badge is-active">Aktiv</span>');
  }
  if (src.enabled === false) {
    badges.push('<span class="provider-source-badge is-disabled">Deaktiviert</span>');
  }
  if (src.trusted === true) {
    badges.push('<span class="provider-source-badge is-trusted">Vertraut</span>');
  }
  if (src.explicit === true) {
    badges.push('<span class="provider-source-badge">Explizit</span>');
  }
  if (src.adminOnly === true) {
    badges.push('<span class="provider-source-badge is-warn">Admin</span>');
  }
  if (typeof src.manifests === 'number') {
    badges.push(`<span class="provider-source-badge">${src.manifests} Pakete</span>`);
  }
  if (providerId === 'chocolatey' && typeof src.priority === 'number' && src.priority !== 0) {
    badges.push(`<span class="provider-source-badge">Prio ${src.priority}</span>`);
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
  const providerName = provider.name || providerId;
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
        listHtml = '<div class="path-empty">⏳ Lade konfigurierte Quellen...</div>';
      } else if (loadError) {
        listHtml = `<div class="path-empty">${escapeHTML(loadError)}</div>`;
      } else if (sources.length === 0) {
        listHtml = '<div class="path-empty">Noch keine Quellen eingetragen.</div>';
      } else {
        listHtml = `
          <div class="provider-sources-list">
            ${sources
              .map((src) => {
                const badgesHtml = renderSourceMetaBadges(providerId, src);
                const removeBtnHtml = src.builtIn
                  ? '<span class="muted">Standard-Fallback</span>'
                  : `<button type="button" class="btn btn-danger btn-xs" data-source-remove="${escapeHTML(src.name)}" ${isBusy ? 'disabled' : ''}>🗑️ Entfernen</button>`;
                return `
                  <div class="provider-source-row ${src.enabled === false ? 'is-disabled' : ''}">
                    <div class="provider-source-info">
                      <div class="provider-source-head">
                        <strong>${escapeHTML(src.name)}</strong>
                        ${badgesHtml}
                      </div>
                      ${src.url ? `<code class="provider-source-url" title="${escapeHTML(src.url)}">${escapeHTML(src.url)}</code>` : '<span class="muted">Standard-Bucket-Quelle</span>'}
                      ${src.updated ? `<span class="muted">Aktualisiert: ${escapeHTML(src.updated)}</span>` : ''}
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
              <span>Schnellvorlagen (per Klick hinzufuegen)</span>
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
                        title="${escapeHTML(tpl.description || tpl.url || tpl.name)}"
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

      const noticeHtml =
        hintText || requiresAdmin || mode === 'config'
          ? `
            <div class="provider-source-hint">
              ${requiresAdmin ? '<strong>🛡️ Hinweis:</strong> Aenderungen erfordern unter Windows ggf. eine UAC-Admin-Bestaetigung. ' : ''}
              <span>${escapeHTML(hintText || '')}</span>
            </div>
          `
          : '';

      dialog.innerHTML = `
        <div class="modal-header">
          <h2>🌐 Quellen verwalten - ${escapeHTML(providerName)}</h2>
          <button type="button" class="icon-btn" data-sources-action="close" title="Schliessen" aria-label="Schliessen">✕</button>
        </div>

        <div class="modal-body provider-sources-body">
          ${noticeHtml}
          <div class="form-field">
            <span>Aktive Quellen</span>
            ${listHtml}
          </div>

          ${templatesHtml}

          <div class="provider-source-form">
            <h4>Eigene Quelle hinzufuegen</h4>
            <div class="form-grid-2">
              <label class="form-field">
                <span>Name</span>
                <input type="text" id="srcAddName" placeholder="${isScoop ? 'z. B. mein-bucket' : 'z. B. firma-feed'}" ${isBusy ? 'disabled' : ''}>
              </label>
              <label class="form-field">
                <span>${isScoop ? 'Repository-URL (optional)' : 'Quellen-URL'}</span>
                <input type="url" id="srcAddUrl" placeholder="${isScoop ? 'https://github.com/user/scoop-bucket' : 'https://...'}" ${isBusy ? 'disabled' : ''}>
              </label>
            </div>
            ${
              isWinget
                ? `
                  <label class="form-field">
                    <span>Typ (optional, fuer Winget)</span>
                    <input type="text" id="srcAddType" placeholder="z. B. Microsoft.PreIndexed.Package oder Microsoft.Rest" ${isBusy ? 'disabled' : ''}>
                  </label>
                `
                : ''
            }
            <div class="provider-source-form-actions">
              <button type="button" class="btn btn-primary" data-sources-action="add" ${isBusy || isLoading ? 'disabled' : ''}>
                ${isBusy ? '⏳ Arbeite...' : '➕ Quelle hinzufuegen'}
              </button>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-ghost" data-sources-action="refresh" ${isBusy || isLoading ? 'disabled' : ''}>🔄 Aktualisieren</button>
          <button type="button" class="btn btn-primary" data-sources-action="close">Schliessen</button>
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
          loadError = res?.error || 'Quellen konnten nicht geladen werden.';
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
        loadError = err?.message || 'Fehler beim Laden der Quellen.';
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
          showToast('Vorgang abgebrochen.', { type: 'info' });
          render();
          return;
        }
        if (!res?.success) {
          showToast(res?.error || 'Quelle konnte nicht hinzugefuegt werden.', { type: 'error', duration: 6000 });
          render();
          return;
        }
        hasChanged = true;
        showToast(`Quelle "${name}" hinzugefuegt.`, { type: 'success' });
        await loadSources();
      } catch (err) {
        if (settled) return;
        isBusy = false;
        showToast(err?.message || 'Fehler beim Hinzufuegen.', { type: 'error', duration: 6000 });
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
          removeBtn.dataset.origText = removeBtn.textContent || '🗑️ Entfernen';
          removeBtn.textContent = '⚠️ Wirklich entfernen?';
          setTimeout(() => {
            if (removeBtn.isConnected && removeBtn.dataset.armed === 'true') {
              removeBtn.dataset.armed = 'false';
              removeBtn.textContent = removeBtn.dataset.origText || '🗑️ Entfernen';
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
            showToast('Vorgang abgebrochen.', { type: 'info' });
            render();
            return;
          }
          if (!res?.success) {
            showToast(res?.error || 'Quelle konnte nicht entfernt werden.', { type: 'error', duration: 6000 });
            render();
            return;
          }
          hasChanged = true;
          showToast(`Quelle "${sourceName}" entfernt.`, { type: 'info' });
          await loadSources();
        } catch (err) {
          if (settled) return;
          isBusy = false;
          showToast(err?.message || 'Fehler beim Entfernen.', { type: 'error', duration: 6000 });
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
          showToast('Bitte einen Quellennamen angeben.', { type: 'warn' });
          return;
        }
        if (!isScoop && !url) {
          showToast('Bitte eine gueltige URL angeben.', { type: 'warn' });
          return;
        }
        await executeAdd({ name, url, type });
      }
    };

    overlay.hidden = false;
    void loadSources();
  });
}
