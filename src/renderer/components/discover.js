import { filterUsableProviders } from '../../shared/provider-lifecycle-logic.js';
import { state } from '../state.js';
import { closestButton, closestEl, qsInput } from '../utils/dom.js';
import { escapeHTML } from '../utils/sanitize.js';
import { showToast } from './toast.js';

let searchRequestSeq = 0;

function getSearchableProviders() {
  return filterUsableProviders(state.providers, { capability: 'search' });
}

function getProviderCapability(providerId, capKey) {
  const provider = state.providers.find((p) => p.id === providerId);
  return Boolean(provider?.capabilities?.[capKey]);
}

function findMatchingArchivePackage(pkg) {
  if (pkg.providerId === 'archive' && pkg.packageId) {
    return state.packages.find((p) => p.inArchive && p.id === pkg.packageId) || null;
  }
  const cleanPid = String(pkg.packageId || '')
    .trim()
    .toLowerCase();
  const cleanPm = String(pkg.packageManager || pkg.providerId || '')
    .trim()
    .toLowerCase();
  if (!cleanPid) return null;

  return (
    state.packages.find((p) => {
      if (!p.inArchive) return false;
      const pId = String(p.packageId || p.wingetId || '')
        .trim()
        .toLowerCase();
      const pPm = String(p.packageManager || (p.wingetId ? 'winget' : ''))
        .trim()
        .toLowerCase();
      if (!pId) return false;
      return cleanPm ? pPm === cleanPm && pId === cleanPid : pId === cleanPid;
    }) || null
  );
}

function findMatchingInstalledPackage(pkg) {
  if (pkg.isInstalled) return true;
  const cleanPid = String(pkg.packageId || '')
    .trim()
    .toLowerCase();
  const cleanPm = String(pkg.packageManager || pkg.providerId || '')
    .trim()
    .toLowerCase();
  if (!cleanPid) return false;

  return state.packages.some((p) => {
    if (!p.isInstalled) return false;
    const pId = String(p.packageId || p.wingetId || '')
      .trim()
      .toLowerCase();
    const pPm = String(p.packageManager || (p.wingetId ? 'winget' : ''))
      .trim()
      .toLowerCase();
    return pId === cleanPid && (!cleanPm || pPm === cleanPm);
  });
}

function renderSourceChips() {
  const container = document.getElementById('discoverSourceChips');
  if (!container) return;

  const searchable = getSearchableProviders();
  if (searchable.length === 0) {
    container.innerHTML =
      '<span class="muted">Keine aktiven &amp; installierten Quellen verfügbar (in den Einstellungen aktivieren/installieren).</span>';
    return;
  }

  container.innerHTML = searchable
    .map((p) => {
      const active = state.discoverSelectedProviders.includes(p.id);
      return `
        <button
          type="button"
          class="source-chip ${active ? 'active' : ''}"
          data-discover-provider="${escapeHTML(p.id)}"
          aria-pressed="${active ? 'true' : 'false'}"
          title="${escapeHTML(p.description || p.name)}"
        >
          <span>${active ? '✓' : '+'}</span>
          <span>${escapeHTML(p.name)}</span>
        </button>
      `;
    })
    .join('');
}

function renderNotice() {
  const notice = document.getElementById('discoverNotice');
  if (!notice) return;

  const errors = Object.values(state.discoverByProvider || {})
    .filter((entry) => entry && !entry.success && entry.error)
    .map((entry) => `${entry.providerName || entry.providerId}: ${entry.error}`);

  if (errors.length === 0) {
    notice.hidden = true;
    notice.textContent = '';
    return;
  }

  notice.hidden = false;
  notice.textContent = errors.join(' · ');
}

function renderResults() {
  const container = document.getElementById('discoverResults');
  if (!container) return;

  if (state.discoverLoading) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>⏳ Durchsuche ausgewählte Quellen...</h3>
        <p>Bitte einen Moment Geduld.</p>
      </div>
    `;
    return;
  }

  if (!state.discoverHasSearched) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>Neue Software entdecken & installieren</h3>
        <p>Gib oben einen Programmnamen oder eine Paket-ID ein und wähle die gewünschten Quellen (z. B. Winget oder Archiv).</p>
      </div>
    `;
    return;
  }

  if (state.discoverResults.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>Keine Pakete gefunden</h3>
        <p>Prüfe den Suchbegriff oder aktiviere weitere Quellen.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = state.discoverResults
    .map((pkg, idx) => {
      const providerId = pkg.providerId || pkg.packageManager || 'winget';
      const providerLabel = pkg.providerName || (providerId === 'archive' ? 'Archiv' : 'Winget');
      const isArchiveSource = providerId === 'archive';
      const archiveMatch = findMatchingArchivePackage(pkg);
      const isInstalled = findMatchingInstalledPackage(pkg);
      const canDownloadToArchive =
        !isArchiveSource && !archiveMatch && getProviderCapability(providerId, 'supportsArchiveDownload');

      const archiveActionHtml = archiveMatch
        ? `<button type="button" class="btn btn-ghost" data-discover-action="open-archive" data-archive-id="${escapeHTML(archiveMatch.id)}">📂 Im Archiv öffnen</button>`
        : canDownloadToArchive
          ? `<button type="button" class="btn btn-archive" data-discover-action="link-archive" data-result-idx="${idx}">🗄️ Ins Archiv laden</button>`
          : '';

      return `
        <article class="discover-card">
          <div class="discover-card-main">
            <div class="discover-card-title">
              <strong>${escapeHTML(pkg.name || pkg.packageId)}</strong>
              <span class="provider-badge ${isArchiveSource ? 'is-archive' : ''}">${escapeHTML(providerLabel)}</span>
              ${pkg.version ? `<span class="card-chip">v${escapeHTML(pkg.version)}</span>` : ''}
              ${archiveMatch && !isArchiveSource ? '<span class="discover-status-badge">Im Archiv</span>' : ''}
              ${isInstalled ? '<span class="discover-status-badge">Installiert</span>' : ''}
            </div>
            <div class="discover-card-meta">
              <code>${escapeHTML(pkg.packageId || pkg.id || '')}</code>
              ${pkg.source && pkg.source !== providerId ? `<span>Quelle: ${escapeHTML(pkg.source)}</span>` : ''}
            </div>
            ${pkg.shortDescription ? `<p class="discover-card-desc">${escapeHTML(pkg.shortDescription)}</p>` : ''}
          </div>
          <div class="discover-card-actions">
            <button type="button" class="btn btn-ghost" data-discover-action="details" data-result-idx="${idx}">ℹ️ Details</button>
            <button type="button" class="btn btn-primary" data-discover-action="install" data-result-idx="${idx}">⬇️ Installieren</button>
            ${archiveActionHtml}
          </div>
        </article>
      `;
    })
    .join('');
}

export function renderDiscoverView() {
  const input = qsInput(document, '#discoverSearchInput');
  const clearBtn = document.getElementById('clearDiscoverSearchBtn');
  if (input && input.value !== state.discoverQuery) {
    input.value = state.discoverQuery;
  }
  if (clearBtn) {
    clearBtn.hidden = state.discoverQuery.length === 0;
  }

  renderSourceChips();
  renderNotice();
  renderResults();
}

export function initDiscoverView({ onReload, onOpenArchiveDetail, onOpenPackageDetail, onLinkToArchive }) {
  const searchInput = qsInput(document, '#discoverSearchInput');
  const clearBtn = document.getElementById('clearDiscoverSearchBtn');
  const searchBtn = document.getElementById('btnDiscoverSearch');
  const chipsContainer = document.getElementById('discoverSourceChips');
  const resultsContainer = document.getElementById('discoverResults');

  const executeSearch = async () => {
    const query = (searchInput?.value ?? state.discoverQuery).trim();
    state.discoverQuery = query;

    if (state.discoverSelectedProviders.length === 0) {
      showToast('Bitte mindestens eine Quelle auswählen.', { type: 'warn' });
      return;
    }

    const onlyArchive =
      state.discoverSelectedProviders.length === 1 && state.discoverSelectedProviders[0] === 'archive';
    if (!onlyArchive && query.length < 2) {
      showToast('Bitte mindestens 2 Zeichen für die Suche eingeben.', { type: 'info' });
      return;
    }

    const reqId = ++searchRequestSeq;
    state.discoverLoading = true;
    state.discoverHasSearched = true;
    state.discoverByProvider = {};
    renderDiscoverView();

    try {
      const res = await window.electronAPI.searchProviders(query, {
        providerIds: [...state.discoverSelectedProviders],
        limit: 30,
      });

      if (reqId !== searchRequestSeq) return;

      state.discoverLoading = false;
      state.discoverResults = Array.isArray(res?.results) ? res.results : [];
      state.discoverByProvider = res?.byProvider || {};
      renderDiscoverView();
    } catch (err) {
      if (reqId !== searchRequestSeq) return;
      state.discoverLoading = false;
      state.discoverResults = [];
      state.discoverByProvider = { error: { success: false, providerName: 'Suche', error: err.message } };
      renderDiscoverView();
    }
  };

  searchInput?.addEventListener('input', () => {
    state.discoverQuery = searchInput.value;
    if (clearBtn) clearBtn.hidden = state.discoverQuery.length === 0;
  });

  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeSearch();
    }
  });

  clearBtn?.addEventListener('click', () => {
    if (!searchInput) return;
    searchInput.value = '';
    state.discoverQuery = '';
    state.discoverHasSearched = false;
    state.discoverResults = [];
    state.discoverByProvider = {};
    clearBtn.hidden = true;
    renderDiscoverView();
    searchInput.focus();
  });

  searchBtn?.addEventListener('click', () => executeSearch());

  chipsContainer?.addEventListener('click', (e) => {
    const chip = closestEl(e.target, '[data-discover-provider]');
    if (!chip) return;
    const providerId = chip.dataset.discoverProvider;
    const idx = state.discoverSelectedProviders.indexOf(providerId);
    if (idx > -1) {
      state.discoverSelectedProviders.splice(idx, 1);
    } else {
      state.discoverSelectedProviders.push(providerId);
    }
    renderSourceChips();

    if (state.discoverHasSearched && state.discoverSelectedProviders.length > 0) {
      executeSearch();
    }
  });

  resultsContainer?.addEventListener('click', async (e) => {
    const btn = closestButton(e.target, '[data-discover-action]');
    if (!btn) return;

    const action = btn.dataset.discoverAction;
    if (action === 'open-archive') {
      onOpenArchiveDetail?.(btn.dataset.archiveId);
      return;
    }

    const idx = parseInt(btn.dataset.resultIdx, 10);
    const pkg = state.discoverResults[idx];
    if (!pkg) return;

    const providerId = pkg.providerId || pkg.packageManager || 'winget';
    const packageId = pkg.packageId || pkg.id;

    if (action === 'details') {
      if (providerId === 'archive') {
        onOpenArchiveDetail?.(packageId);
      } else {
        onOpenPackageDetail?.(providerId, packageId, pkg);
      }
      return;
    }

    if (action === 'link-archive') {
      onLinkToArchive?.({
        packageManager: providerId,
        packageId,
        name: pkg.name || packageId,
        version: pkg.version || '',
        shortDescription: pkg.shortDescription || '',
      });
      return;
    }

    if (action === 'install') {
      const archiveMatch = findMatchingArchivePackage(pkg);
      const canDownloadToArchive =
        providerId !== 'archive' && !archiveMatch && getProviderCapability(providerId, 'supportsArchiveDownload');
      const saveMode = state.settings.archiveSaveMode || 'ask';

      const linkPayload = {
        packageManager: providerId,
        packageId,
        name: pkg.name || packageId,
        version: pkg.version || '',
        shortDescription: pkg.shortDescription || '',
      };

      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = '⏳ Installiere...';
      showToast(`Starte Installation für ${pkg.name || packageId}...`, { type: 'info' });

      const res = await window.electronAPI.installPackage(providerId, packageId, {
        silent: false,
        itemName: pkg.name || packageId,
      });

      btn.disabled = false;
      btn.textContent = origText;

      if (res?.alreadyRunning) {
        showToast('Für dieses Paket läuft bereits eine Installation.', { type: 'warn' });
      } else if (res?.canceled) {
        showToast('Installation wurde abgebrochen.', { type: 'info' });
      } else if (res?.success) {
        await onReload?.({ rescanInstalled: true });
        if (canDownloadToArchive && saveMode === 'auto-id') {
          showToast(`${pkg.name || packageId} installiert - speichere automatisch im Archiv...`, { type: 'info' });
          await onLinkToArchive?.(linkPayload, { mode: 'auto-id', downloadSetup: true });
        } else if (canDownloadToArchive && saveMode === 'ask') {
          showToast(`${pkg.name || packageId} erfolgreich installiert!`, {
            type: 'success',
            duration: 6000,
            action: {
              label: '📥 Ins Archiv',
              onClick: () => onLinkToArchive?.(linkPayload, { mode: 'ask', downloadSetup: true }),
            },
          });
        } else {
          showToast(`${pkg.name || packageId} erfolgreich installiert!`, { type: 'success' });
        }
      } else {
        showToast(`Installationsfehler: ${res?.error || 'Unbekannter Fehler'}`, { type: 'error', duration: 6000 });
      }
    }
  });
}
