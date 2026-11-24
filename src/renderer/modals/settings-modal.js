import { getArchiveRootLabel, normalizePathKey } from '../../shared/multi-archive-logic.js';
import {
  getPolicyEntryKey,
  hasAccessPolicyChanges,
  normalizeAccessPolicy,
  removePolicyEntry,
  updatePolicyEntryExecutionMode,
  upsertPolicyEntry,
} from '../../shared/policy-logic.js';
import { formatProviderStatusBadge, groupProvidersByUiCategory } from '../../shared/provider-lifecycle-logic.js';
import {
  buildSettingsSavePlan,
  createSettingsDraft,
  hasSettingsDraftChanges,
  normalizeSettingsTab,
  parseAutoExtensionsInput,
  SETTINGS_TABS,
  toggleDraftProvider,
} from '../../shared/settings-draft-logic.js';
import { getProviderBadgeInfo } from '../../shared/unified-packages.js';
import { buildArchiveFilename } from '../../shared/version.js';
import { showToast } from '../components/toast.js';
import { renderAdminSessionButton, renderAuthHeaderControls } from '../components/toolbar.js';
import { applyAuthStatus, state } from '../state.js';
import { escapeHTML } from '../utils/sanitize.js';
import { openNestedDialog } from './archive-target-modal.js';
import { closeModal, resetModalContent, triggerCatalogReload } from './index.js';
import { openProviderSourcesModal } from './provider-sources-modal.js';

let activeSettingsToken = 0;

function getInputEl(root, selector) {
  const el = root.querySelector(selector);
  return el instanceof HTMLInputElement ? el : null;
}

function getSelectEl(root, selector) {
  const el = root.querySelector(selector);
  return el instanceof HTMLSelectElement ? el : null;
}

function renderArchiveRootsListHtml(archiveItems) {
  if (!Array.isArray(archiveItems) || archiveItems.length === 0) {
    return '<div class="path-empty">Keine Archiv-Pfade konfiguriert.</div>';
  }

  const canDelete = archiveItems.length > 1;
  return archiveItems
    .map((entry, idx) => {
      const rankLabel = idx === 0 ? '#1 Primär' : `#${idx + 1}`;
      const statusCls = entry.online ? 'is-online' : 'is-offline';
      const statusText = entry.online ? '🟢 Online' : '🔴 Offline';
      const absHint = entry.absPath && entry.absPath !== entry.rawPath ? ` (${entry.absPath})` : '';

      return `
        <div class="archive-path-row" data-archive-idx="${idx}" draggable="${archiveItems.length > 1 ? 'true' : 'false'}">
          <span class="archive-drag-handle" title="Per Drag & Drop verschieben" aria-hidden="true">⋮⋮</span>
          <span class="archive-rank-pill ${idx === 0 ? 'is-primary' : ''}">${escapeHTML(rankLabel)}</span>
          <span class="archive-status-pill ${statusCls}" title="${entry.online ? 'Verzeichnis erreichbar' : 'Verzeichnis aktuell nicht erreichbar'}">${statusText}</span>
          <span class="archive-path-text" title="${escapeHTML(`${entry.rawPath}${absHint}`)}">
            <strong class="archive-path-name">${escapeHTML(entry.label || getArchiveRootLabel(entry.rawPath, idx))}</strong>
            <code class="archive-path-raw">${escapeHTML(entry.rawPath)}</code>
          </span>
          <div class="archive-path-actions">
            <button type="button" class="btn btn-ghost btn-xs" data-archive-move="up" data-archive-idx="${idx}" ${idx === 0 ? 'disabled' : ''} title="Priorität erhöhen">↑</button>
            <button type="button" class="btn btn-ghost btn-xs" data-archive-move="down" data-archive-idx="${idx}" ${idx === archiveItems.length - 1 ? 'disabled' : ''} title="Priorität verringern">↓</button>
            <button type="button" class="btn btn-ghost btn-xs" data-archive-remove="${idx}" ${canDelete ? '' : 'disabled'} title="${canDelete ? 'Archiv-Pfad entfernen' : 'Mindestens ein Archiv-Pfad ist erforderlich'}">🗑️</button>
          </div>
        </div>
      `;
    })
    .join('');
}

export async function renderSettingsModal(initialTab = 'general') {
  state.currentModalId = null;
  state.isEditModalOpen = false;

  const overlay = document.getElementById('modalOverlay');
  const modal = document.getElementById('modalContent');
  if (!overlay || !modal) return;
  resetModalContent();
  const modalToken = ++activeSettingsToken;
  let activeTab = normalizeSettingsTab(initialTab);

  const [s, info, providersInfo, cacheStats, initialAdminStatus, initialAuthStatus] = await Promise.all([
    window.electronAPI.getSettings(),
    window.electronAPI.getAppInfo(),
    window.electronAPI.listProviders(),
    window.electronAPI.getProviderCacheStats(),
    typeof window.electronAPI?.getAdminSessionStatus === 'function'
      ? window.electronAPI.getAdminSessionStatus()
      : Promise.resolve(state.adminSession),
    typeof window.electronAPI?.getAuthStatus === 'function'
      ? window.electronAPI.getAuthStatus()
      : Promise.resolve(state.authStatus),
  ]);

  if (modalToken !== activeSettingsToken) return;

  let currentAuthStatus = applyAuthStatus(initialAuthStatus || state.authStatus);
  renderAuthHeaderControls();

  let savedPolicy = normalizeAccessPolicy(currentAuthStatus?.accessPolicy);
  let draftPolicy = normalizeAccessPolicy(currentAuthStatus?.accessPolicy);
  let activePolicyScopeTab = 'updates';
  let policySearchSource = 'all';
  let policySearchQuery = '';
  let policyWingetResults = [];
  let policyWingetLoading = false;
  let policyWingetError = '';
  let policyManualMatchType = 'packageId';
  let policyManualValue = '';
  let policyManualLabel = '';

  const isPolicyEditable = () => !currentAuthStatus?.isReadOnlyPolicy;
  const hasPolicyDraftChanges = () => isPolicyEditable() && hasAccessPolicyChanges(savedPolicy, draftPolicy);

  const getActivePolicyScopeKey = () =>
    draftPolicy.scopeMode === 'separate' ? (activePolicyScopeTab === 'install' ? 'install' : 'updates') : 'shared';

  const getActivePolicyRuleSet = () => draftPolicy[getActivePolicyScopeKey()];

  const updateActivePolicyRuleSet = (updater) => {
    const key = getActivePolicyScopeKey();
    const currentSet = draftPolicy[key];
    const nextSet = updater(currentSet);
    draftPolicy = normalizeAccessPolicy({
      ...draftPolicy,
      [key]: nextSet,
    });
  };

  const getPolicyMatchTypeBadge = (matchType) => {
    if (matchType === 'packageId') return 'Paket-ID';
    if (matchType === 'archiveId') return 'Archiv-ID';
    if (matchType === 'provider') return 'Paketmanager';
    return 'Name';
  };

  const buildCandidateFromPackage = (pkg) => {
    const pm = String(pkg?.packageManager || (pkg?.wingetId ? 'winget' : ''))
      .trim()
      .toLowerCase();
    const pid = String(pkg?.packageId || pkg?.wingetId || '').trim();
    if (pid) {
      return {
        matchType: 'packageId',
        value: pid,
        label: String(pkg?.name || pid).trim(),
        meta: `${pm || 'Paket'} · ${pid}`,
        badge: pkg?.inArchive ? 'Archiv & PC' : 'Installiert',
      };
    }
    if (pkg?.inArchive && pkg?.id) {
      return {
        matchType: 'archiveId',
        value: String(pkg.id).trim(),
        label: String(pkg?.name || pkg.id).trim(),
        meta: `Archiv-ID · ${pkg.id}`,
        badge: 'Archiv',
      };
    }
    return {
      matchType: 'name',
      value: String(pkg?.name || '').trim(),
      label: String(pkg?.name || '').trim(),
      meta: 'Name-Abgleich',
      badge: pkg?.inArchive ? 'Archiv' : 'Installiert',
    };
  };

  const getPolicyCandidateRows = () => {
    const queryWords = policySearchQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matchesQuery = (text) => {
      if (queryWords.length === 0) return true;
      const hay = String(text || '').toLowerCase();
      return queryWords.every((w) => hay.includes(w));
    };

    if (policySearchSource === 'provider') {
      const list = [
        { id: 'archive', name: 'Archiv (lokal)', description: 'Programme aus dem lokalen Archiv' },
        ...providers.filter((p) => p.id !== 'archive'),
      ];
      return list
        .filter((p) => matchesQuery(`${p.name} ${p.id} ${p.description || ''}`))
        .map((p) => ({
          matchType: 'provider',
          value: p.id,
          label: p.name,
          meta: `Provider · ${p.id}`,
          badge: 'Paketmanager',
        }));
    }

    if (policySearchSource === 'winget') {
      return policyWingetResults.map((pkg) => {
        const pid = String(pkg.packageId || pkg.id || '').trim();
        return {
          matchType: 'packageId',
          value: pid,
          label: String(pkg.name || pid).trim(),
          meta: `Winget · ${pid}${pkg.version ? ` (v${pkg.version})` : ''}`,
          badge: 'Winget',
        };
      });
    }

    const seen = new Set();
    const candidates = [];
    for (const pkg of state.packages || []) {
      if (!pkg) continue;
      if (policySearchSource === 'archive' && !pkg.inArchive) continue;
      if (policySearchSource === 'installed' && !pkg.isInstalled) continue;

      const cand = buildCandidateFromPackage(pkg);
      if (!cand.value) continue;
      if (!matchesQuery(`${cand.label} ${cand.value} ${cand.meta} ${pkg.publisher || ''}`)) continue;

      const key = getPolicyEntryKey(cand);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      candidates.push(cand);
    }

    candidates.sort((a, b) => a.label.localeCompare(b.label, 'de', { sensitivity: 'base' }));
    return candidates.slice(0, 40);
  };

  const renderPolicyCandidateListHtml = () => {
    const isReadOnly = Boolean(currentAuthStatus?.isReadOnlyPolicy);
    const ruleSet = getActivePolicyRuleSet();
    const existingKeys = new Set((ruleSet.entries || []).map((entry) => getPolicyEntryKey(entry)));

    if (policySearchSource === 'manual') {
      return `
        <div class="policy-manual-form">
          <div class="policy-manual-grid">
            <label class="form-field">
              <span>Regel-Typ</span>
              <select id="cfgPolicyManualType" ${isReadOnly ? 'disabled' : ''}>
                <option value="packageId" ${policyManualMatchType === 'packageId' ? 'selected' : ''}>Paket-ID (z. B. VideoLAN.VLC)</option>
                <option value="archiveId" ${policyManualMatchType === 'archiveId' ? 'selected' : ''}>Archiv-ID</option>
                <option value="name" ${policyManualMatchType === 'name' ? 'selected' : ''}>Programmname (Wildcard * moeglich)</option>
                <option value="provider" ${policyManualMatchType === 'provider' ? 'selected' : ''}>Paketmanager (winget, scoop, archive...)</option>
              </select>
            </label>
            <label class="form-field">
              <span>Wert / Muster</span>
              <input type="text" id="cfgPolicyManualValue" value="${escapeHTML(policyManualValue)}" placeholder="z. B. VideoLAN.VLC oder *Adobe*" ${isReadOnly ? 'disabled' : ''}>
            </label>
            <label class="form-field">
              <span>Anzeigename (optional)</span>
              <input type="text" id="cfgPolicyManualLabel" value="${escapeHTML(policyManualLabel)}" placeholder="z. B. VLC Media Player" ${isReadOnly ? 'disabled' : ''}>
            </label>
          </div>
          <div class="policy-manual-actions">
            <button type="button" class="btn btn-primary btn-xs" data-policy-action="add-manual" ${isReadOnly ? 'disabled' : ''}>➕ Regel hinzufuegen</button>
          </div>
        </div>
      `;
    }

    if (policySearchSource === 'winget') {
      if (policyWingetLoading) {
        return '<div class="policy-candidate-empty">⏳ Suche in Winget-Quellen...</div>';
      }
      if (policyWingetError) {
        return `<div class="policy-candidate-empty">${escapeHTML(policyWingetError)}</div>`;
      }
      if (policyWingetResults.length === 0) {
        return '<div class="policy-candidate-empty">Gib oben einen Programmnamen ein und klicke auf "🔎 Winget suchen".</div>';
      }
    }

    const candidates = getPolicyCandidateRows();
    if (candidates.length === 0) {
      return '<div class="policy-candidate-empty">Keine passenden Programme gefunden.</div>';
    }

    return candidates
      .map((cand) => {
        const key = getPolicyEntryKey(cand);
        const inList = existingKeys.has(key);
        const badgeInfo = cand.matchType === 'provider' ? getProviderBadgeInfo(cand.value, providers) : null;
        return `
          <div class="policy-candidate-row">
            <div class="policy-candidate-main">
              <div class="policy-candidate-title">
                <strong>${escapeHTML(cand.label)}</strong>
                <span class="policy-match-badge">${escapeHTML(badgeInfo?.label || cand.badge)}</span>
              </div>
              <span class="policy-candidate-meta"><code>${escapeHTML(cand.meta)}</code></span>
            </div>
            <button
              type="button"
              class="btn btn-xs ${inList ? 'btn-danger' : 'btn-primary'}"
              data-policy-toggle-candidate
              data-match-type="${escapeHTML(cand.matchType)}"
              data-match-value="${escapeHTML(cand.value)}"
              data-match-label="${escapeHTML(cand.label)}"
              ${isReadOnly ? 'disabled' : ''}
            >
              ${inList ? '✓ Entfernen' : '+ Hinzufuegen'}
            </button>
          </div>
        `;
      })
      .join('');
  };

  const renderPolicyEntriesHtml = () => {
    const isReadOnly = Boolean(currentAuthStatus?.isReadOnlyPolicy);
    const ruleSet = getActivePolicyRuleSet();
    const entries = ruleSet.entries || [];
    const isBlacklist = ruleSet.listType === 'blacklist';

    if (entries.length === 0) {
      const emptyHint =
        ruleSet.listType === 'whitelist'
          ? 'Whitelist ist leer - fuer normale Nutzer sind aktuell alle Programme dieses Bereichs ausgeblendet.'
          : ruleSet.listType === 'blacklist'
            ? 'Blacklist ist leer - aktuell ist kein Programm explizit gesperrt.'
            : 'Noch keine Einzelregeln hinterlegt. Du kannst oben Programme zur Liste hinzufuegen.';
      return `<div class="policy-candidate-empty">${escapeHTML(emptyHint)}</div>`;
    }

    return entries
      .map((entry) => {
        const modeSelectHtml = isBlacklist
          ? '<span class="policy-match-badge is-blacklist">🚫 Blockiert</span>'
          : `
            <select
              class="policy-entry-mode-select"
              data-policy-entry-mode
              data-match-type="${escapeHTML(entry.matchType)}"
              data-match-value="${escapeHTML(entry.value)}"
              title="Ausfuehrungsmodus fuer diesen Eintrag"
              ${isReadOnly ? 'disabled' : ''}
            >
              <option value="inherit" ${entry.executionMode === 'inherit' ? 'selected' : ''}>Standard uebernehmen</option>
              <option value="silent-only" ${entry.executionMode === 'silent-only' ? 'selected' : ''}>⚡ Nur Silent</option>
              <option value="allow-interactive" ${entry.executionMode === 'allow-interactive' ? 'selected' : ''}>🖱️ Silent &amp; Interaktiv</option>
            </select>
          `;

        return `
          <div class="policy-entry-row">
            <div class="policy-entry-main">
              <div class="policy-entry-head">
                <span class="policy-match-badge">${escapeHTML(getPolicyMatchTypeBadge(entry.matchType))}</span>
                <strong>${escapeHTML(entry.label)}</strong>
              </div>
              <code>${escapeHTML(entry.value)}</code>
            </div>
            <div class="policy-entry-controls">
              ${modeSelectHtml}
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                data-policy-remove-entry
                data-match-type="${escapeHTML(entry.matchType)}"
                data-match-value="${escapeHTML(entry.value)}"
                title="Eintrag entfernen"
                ${isReadOnly ? 'disabled' : ''}
              >
                🗑️
              </button>
            </div>
          </div>
        `;
      })
      .join('');
  };

  const renderPolicySectionHtml = () => {
    const isReadOnly = Boolean(currentAuthStatus?.isReadOnlyPolicy);
    const isDirty = hasPolicyDraftChanges();
    const activeRuleSet = getActivePolicyRuleSet();
    const isSeparate = draftPolicy.scopeMode === 'separate';
    const scopeLabel = !isSeparate
      ? 'Gemeinsame Regeln (Updates & Installieren)'
      : activePolicyScopeTab === 'install'
        ? 'Regeln fuer Neu-Installationen'
        : 'Regeln fuer Updates';

    const sourceTabs = [
      { id: 'all', label: '📦 Archiv & PC' },
      { id: 'archive', label: '🗄️ Archiv' },
      { id: 'installed', label: '💻 Installiert' },
      { id: 'winget', label: '🪽 Winget (Online)' },
      { id: 'provider', label: '🧩 Paketmanager' },
      { id: 'manual', label: '✏️ Manuell' },
    ];

    const subtabsHtml = isSeparate
      ? `
        <div class="policy-subtabs" role="tablist" aria-label="Richtlinien-Bereich">
          <button
            type="button"
            class="policy-subtab-btn ${activePolicyScopeTab === 'updates' ? 'active' : ''}"
            data-policy-scope-tab="updates"
          >
            ⬆️ Updates (${draftPolicy.updates.entries.length})
          </button>
          <button
            type="button"
            class="policy-subtab-btn ${activePolicyScopeTab === 'install' ? 'active' : ''}"
            data-policy-scope-tab="install"
          >
            ⬇️ Neu installieren (${draftPolicy.install.entries.length})
          </button>
        </div>
      `
      : '';

    const searchRowHtml =
      policySearchSource === 'manual'
        ? ''
        : `
          <div class="policy-search-row">
            <input
              type="text"
              id="cfgPolicyCandidateSearch"
              value="${escapeHTML(policySearchQuery)}"
              placeholder="${policySearchSource === 'winget' ? 'Winget-Paket suchen (z. B. 7zip, VLC)...' : 'Programme nach Name, Paket-ID oder Herausgeber filtern...'}"
            >
            ${
              policySearchSource === 'winget'
                ? '<button type="button" class="btn btn-primary btn-xs" data-policy-action="search-winget">🔎 Winget suchen</button>'
                : ''
            }
          </div>
        `;

    return `
      <div class="policy-header-row">
        <div>
          <h3>🛡️ Zugriffsrichtlinien (Whitelist / Blacklist &amp; Modus)</h3>
          <p class="panel-hint">
            Steuert fuer Endnutzer, welche Programme sichtbar sind und ob Setups nur still (<code>Nur Silent</code>) oder auch interaktiv laufen duerfen.
          </p>
        </div>
        <div class="policy-header-actions">
          ${isDirty ? '<span class="settings-dirty-badge">● Ungespeichert</span>' : ''}
          <button type="button" class="btn btn-ghost btn-xs" data-policy-action="export">📤 Exportieren</button>
          <button type="button" class="btn btn-ghost btn-xs" data-policy-action="import" ${isReadOnly ? 'disabled' : ''}>📥 Importieren</button>
        </div>
      </div>

      ${
        isReadOnly
          ? '<div class="auth-integrity-banner is-warn" role="status">🔒 Die Policy-Datei ist schreibgeschuetzt. Zugriffsrichtlinien koennen hier nicht geaendert werden.</div>'
          : ''
      }

      <div class="policy-editor-card">
        <div class="policy-master-toggles">
          <label class="check-row">
            <input type="checkbox" id="cfgPolicyEnabled" ${draftPolicy.enabled ? 'checked' : ''} ${isReadOnly ? 'disabled' : ''}>
            <span><strong>Zugriffsrichtlinien aktivieren</strong></span>
          </label>
          <label class="check-row">
            <input type="checkbox" id="cfgPolicyApplyToAdmin" ${draftPolicy.applyToAdmin ? 'checked' : ''} ${isReadOnly ? 'disabled' : ''}>
            <span>Richtlinien auch auf angemeldete Administratoren anwenden (Standard: Aus - Admin sieht &amp; verwaltet immer alles)</span>
          </label>
        </div>

        <div class="policy-scope-row">
          <span class="policy-field-title">Geltungsbereich:</span>
          <div class="policy-scope-switcher" role="group" aria-label="Geltungsbereich">
            <button
              type="button"
              class="policy-scope-btn ${!isSeparate ? 'active' : ''}"
              data-policy-scope-mode="shared"
              ${isReadOnly ? 'disabled' : ''}
            >
              🔗 Gemeinsam (Updates &amp; Installieren)
            </button>
            <button
              type="button"
              class="policy-scope-btn ${isSeparate ? 'active' : ''}"
              data-policy-scope-mode="separate"
              ${isReadOnly ? 'disabled' : ''}
            >
              🔀 Getrennt (Updates / Installieren)
            </button>
          </div>
        </div>

        ${subtabsHtml}

        <div class="policy-ruleset-box">
          <div class="policy-ruleset-head">
            <strong>${escapeHTML(scopeLabel)}</strong>
          </div>

          <div class="form-grid-2">
            <label class="form-field">
              <span>Listen-Modus</span>
              <select id="cfgPolicyListType" ${isReadOnly ? 'disabled' : ''}>
                <option value="none" ${activeRuleSet.listType === 'none' ? 'selected' : ''}>Keine Listen-Filterung (alle sichtbar)</option>
                <option value="whitelist" ${activeRuleSet.listType === 'whitelist' ? 'selected' : ''}>Whitelist (nur ausgewaehlte Programme erlauben)</option>
                <option value="blacklist" ${activeRuleSet.listType === 'blacklist' ? 'selected' : ''}>Blacklist (ausgewaehlte Programme sperren)</option>
              </select>
            </label>
            <label class="form-field">
              <span>Standard-Ausfuehrungsmodus</span>
              <select id="cfgPolicyExecMode" ${isReadOnly ? 'disabled' : ''}>
                <option value="allow-interactive" ${activeRuleSet.defaultExecutionMode === 'allow-interactive' ? 'selected' : ''}>🖱️ Silent &amp; Interaktiv erlaubt</option>
                <option value="silent-only" ${activeRuleSet.defaultExecutionMode === 'silent-only' ? 'selected' : ''}>⚡ Nur Silent (Adware-geschuetzte Setups werden blockiert)</option>
              </select>
            </label>
          </div>

          <div class="policy-picker-box">
            <div class="policy-source-chips">
              ${sourceTabs
                .map(
                  (src) =>
                    `<button type="button" class="origin-chip ${policySearchSource === src.id ? 'active' : ''}" data-policy-source="${src.id}">${escapeHTML(src.label)}</button>`
                )
                .join('')}
            </div>
            ${searchRowHtml}
            <div id="policyCandidateList" class="policy-candidate-list">
              ${renderPolicyCandidateListHtml()}
            </div>
          </div>

          <div class="policy-entries-box">
            <div class="policy-entries-head">
              <strong>Aktive Eintraege (${activeRuleSet.entries.length})</strong>
              ${
                activeRuleSet.entries.length > 0
                  ? `<button type="button" class="btn btn-ghost btn-xs" data-policy-action="clear-ruleset" ${isReadOnly ? 'disabled' : ''}>🗑️ Liste leeren</button>`
                  : ''
              }
            </div>
            <div id="policyEntriesList" class="policy-entries-list">
              ${renderPolicyEntriesHtml()}
            </div>
          </div>
        </div>

        <div class="auth-form-actions">
          <span class="muted">Speicherung erfolgt manipulationssicher zusammen mit der Admin-Policy in <code>admin-policy.json</code>.</span>
          <button type="button" class="btn btn-primary" data-policy-action="save" ${isReadOnly ? 'disabled' : ''}>🛡️ Zugriffsrichtlinien speichern</button>
        </div>
      </div>
    `;
  };

  let currentAdminStatus = initialAdminStatus || state.adminSession || { mode: 'off', supported: true };
  if (initialAdminStatus) {
    state.adminSession = { ...state.adminSession, ...initialAdminStatus };
    renderAdminSessionButton();
  }

  const renderAuthSectionHtml = (authSt) => {
    const auth = authSt || {};
    const isEnabled = Boolean(auth.enabled);
    const isHklmLocked = Boolean(auth.isHklmLocked);
    const isReadOnly = Boolean(auth.isReadOnlyPolicy);
    const integrityValid = auth.integrityValid !== false;
    const checksumShort = auth.integrityChecksum ? String(auth.integrityChecksum).slice(0, 12) : '';
    const sourceLabel =
      auth.pathSource === 'hklm'
        ? 'Windows-Registry (HKLM)'
        : auth.pathSource === 'config'
          ? 'Benutzerdefiniert (config.json)'
          : 'Standard (data/admin-policy.json)';

    const storageBadge = isHklmLocked
      ? '<span class="auth-storage-badge is-hklm" title="Pfad durch Windows HKLM-Policy gesperrt">🏛️ Per HKLM gesperrt</span>'
      : isReadOnly
        ? '<span class="auth-storage-badge is-readonly" title="Nur-Lese-Zugriff auf die Policy-Datei">🔒 Schreibgeschützt</span>'
        : '<span class="auth-storage-badge is-writable" title="Policy-Datei ist beschreibbar">🟢 Schreibbar</span>';

    const readOnlySecondaryBadge =
      isHklmLocked && isReadOnly
        ? '<span class="auth-storage-badge is-readonly" title="Nur-Lese-Zugriff auf die Policy-Datei">🔒 Schreibgeschützt</span>'
        : '';

    const integrityBadge = integrityValid
      ? checksumShort
        ? `<span class="auth-storage-badge is-integrity-ok" title="SHA-256 Integrität geprüft: ${escapeHTML(auth.integrityChecksum || '')}">✓ Integrität OK (${escapeHTML(checksumShort)}...)</span>`
        : ''
      : '<span class="auth-storage-badge is-integrity-bad" title="Integritätsprüfung fehlgeschlagen">⚠️ Integrität ungültig</span>';

    const timeoutVal = Number(auth.sessionTimeoutMinutes) || 0;
    const hklmDisabled = auth.platformSupportedForHklm === false;

    return `
      <h3>🔐 Admin-Modus & Authentifizierung</h3>

      <div class="auth-status-card">
        <div class="auth-status-top">
          <div class="auth-badges-row">
            <span class="admin-session-status-badge ${isEnabled ? 'is-active' : 'is-off'}">
              ${isEnabled ? `🔒 Schutz aktiv (${escapeHTML(auth.username || 'Admin')})` : '🔓 Schutz deaktiviert'}
            </span>
            ${storageBadge}
            ${readOnlySecondaryBadge}
            ${integrityBadge}
          </div>
          <span class="muted">Quelle: <strong>${escapeHTML(sourceLabel)}</strong></span>
        </div>

        ${
          !integrityValid && auth.integrityWarning
            ? `<div class="auth-integrity-banner is-error" role="alert">⚠️ ${escapeHTML(auth.integrityWarning)}</div>`
            : ''
        }

        ${
          isReadOnly
            ? '<div class="auth-integrity-banner is-warn" role="status">🔒 Die Policy-Datei liegt schreibgeschützt (Nur-Lese-Zugriff). Lokale Änderungen an Benutzer/Passwort werden blockiert und müssen direkt durch einen Administrator am geschützten Speicherort erfolgen.</div>'
            : ''
        }
      </div>

      <div class="auth-policy-box">
        <h4>👤 Admin-Konto & Zugriffsschutz</h4>
        <label class="check-row">
          <input type="checkbox" id="cfgAuthEnabled" ${isEnabled ? 'checked' : ''} ${isReadOnly ? 'disabled' : ''}>
          <span>Admin-Schutz für Einstellungen & Bearbeiten aktivieren</span>
        </label>

        <div class="form-grid-2">
          <label class="form-field">
            <span>Admin-Benutzername</span>
            <input type="text" id="cfgAuthUsername" value="${escapeHTML(auth.username || '')}" placeholder="z. B. admin" ${isReadOnly ? 'disabled' : ''}>
          </label>
          <label class="form-field">
            <span>Inaktivitäts-Timeout</span>
            <select id="cfgAuthTimeout" ${isReadOnly ? 'disabled' : ''}>
              <option value="0" ${timeoutVal === 0 ? 'selected' : ''}>Kein Timeout (bis Logout / App-Ende)</option>
              <option value="15" ${timeoutVal === 15 ? 'selected' : ''}>15 Minuten</option>
              <option value="30" ${timeoutVal === 30 ? 'selected' : ''}>30 Minuten</option>
              <option value="60" ${timeoutVal === 60 ? 'selected' : ''}>60 Minuten</option>
              <option value="240" ${timeoutVal === 240 ? 'selected' : ''}>4 Stunden</option>
            </select>
          </label>
          <label class="form-field">
            <span>${auth.policyExists && isEnabled ? 'Neues Passwort (leer = beibehalten)' : 'Passwort (mind. 6 Zeichen)'}</span>
            <input type="password" id="cfgAuthPassword" value="" placeholder="${auth.policyExists && isEnabled ? 'Leer lassen zum Beibehalten' : 'Sicheres Passwort vergeben'}" autocomplete="new-password" ${isReadOnly ? 'disabled' : ''}>
          </label>
          <label class="form-field">
            <span>Passwort bestätigen</span>
            <input type="password" id="cfgAuthPasswordConfirm" value="" placeholder="Passwort wiederholen" autocomplete="new-password" ${isReadOnly ? 'disabled' : ''}>
          </label>
        </div>

        <div class="auth-form-actions">
          <span class="muted">Passwörter werden ausschließlich als <code>scrypt</code>-Hash mit 16-Byte-Salt gespeichert.</span>
          <button type="button" class="btn btn-primary" data-settings-action="auth-save-config" ${isReadOnly ? 'disabled' : ''}>🔐 Zugangsdaten & Schutz speichern</button>
        </div>
      </div>

      <div class="auth-policy-box">
        <h4>📁 Speicherort der Policy-Datei & Manipulationsschutz</h4>
        <div class="auth-effective-path">
          <span class="muted">Aktive Policy-Datei:</span>
          <code>${escapeHTML(auth.policyPath || '')}</code>
        </div>

        <label class="form-field">
          <span>Benutzerdefinierter Pfad (z. B. schreibgeschütztes Netzlaufwerk / Archiv-Share)</span>
          <div class="input-action-row">
            <input type="text" id="cfgAuthPolicyPath" value="${escapeHTML(auth.configuredPolicyPath || auth.policyPath || '')}" placeholder="Standard: data/admin-policy.json" ${isHklmLocked ? 'disabled' : ''}>
            <button type="button" class="btn btn-ghost btn-xs" data-settings-action="auth-browse-file" ${isHklmLocked ? 'disabled' : ''}>📂 Datei...</button>
            <button type="button" class="btn btn-ghost btn-xs" data-settings-action="auth-browse-dir" ${isHklmLocked ? 'disabled' : ''}>📁 Ordner...</button>
          </div>
        </label>

        <label class="check-row">
          <input type="checkbox" id="cfgAuthCopyPolicy" checked ${isHklmLocked ? 'disabled' : ''}>
          <span>Aktuelle Policy-Datei automatisch an den neuen Ort kopieren (falls dort noch nicht vorhanden)</span>
        </label>

        <div class="inline-btn-group">
          <button type="button" class="btn btn-ghost" data-settings-action="auth-save-path" ${isHklmLocked ? 'disabled' : ''}>💾 Pfad übernehmen</button>
          <button type="button" class="btn btn-ghost" data-settings-action="auth-reset-path" ${isHklmLocked || auth.pathSource === 'default' ? 'disabled' : ''}>↩️ Standardpfad</button>
        </div>

        <div class="auth-hklm-box">
          <div class="auth-hklm-info">
            <strong>🏛️ Firmen- / Admin-Modus (HKLM-Registry-Sperre)</strong>
            <p class="panel-hint">
              Schreibt den <code>PolicyFilePath</code> per UAC fest in <code>HKLM\\SOFTWARE\\Policies\\SoftwareKatalog</code>.
              Normale Windows-Benutzer können diesen Pfad ohne Adminrechte weder in der App noch in der Config umbiegen.
            </p>
          </div>
          <div class="auth-hklm-actions">
            <button type="button" class="btn btn-primary" data-settings-action="auth-lock-hklm" ${hklmDisabled ? 'disabled' : ''} title="${hklmDisabled ? 'Nur unter Windows verfügbar' : 'Aktuellen oder gewählten Pfad per HKLM-Policy sperren'}">
              🔒 Pfad per HKLM-Policy sperren (Admin)
            </button>
            ${
              isHklmLocked
                ? `<button type="button" class="btn btn-danger" data-settings-action="auth-unlock-hklm" ${hklmDisabled ? 'disabled' : ''} title="HKLM-Sperre entfernen (2x klicken)">🔓 HKLM-Sperre aufheben (Admin)</button>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
  };

  const getAdminUiMeta = (adminSt) => {
    if (adminSt?.supported === false) {
      return {
        badgeCls: 'is-off',
        badgeText: 'Nicht unterstützt',
        desc: 'Der sitzungsbasierte Admin-Modus steht nur unter Windows zur Verfügung.',
        btnCls: 'btn-ghost',
        btnText: 'Nicht verfügbar',
        btnDisabled: true,
      };
    }
    if (adminSt?.mode === 'elevated' || adminSt?.isProcessElevated) {
      return {
        badgeCls: 'is-elevated',
        badgeText: '🛡️ Läuft als Administrator',
        desc: 'Die App läuft bereits als Administrator. Alle Befehle und Installer werden direkt erhöht ausgeführt.',
        btnCls: 'btn-ghost',
        btnText: '🛡️ Läuft als Administrator',
        btnDisabled: true,
      };
    }
    if (adminSt?.mode === 'active' || adminSt?.isSessionActive) {
      return {
        badgeCls: 'is-active',
        badgeText: '🛡️ Admin-Sitzung aktiv',
        desc: 'Hintergrund-Helper aktiv - Updates, Installer, Deinstallationen und Quellen laufen ohne weitere UAC-Abfragen.',
        btnCls: 'btn-danger',
        btnText: '🛡️ Admin-Sitzung beenden',
        btnDisabled: false,
      };
    }
    return {
      badgeCls: 'is-off',
      badgeText: '🛡️ Admin-Modus: Aus',
      desc: 'Startet auf Wunsch einmalig per UAC einen geschützten Hintergrund-Helper, sodass nachfolgende Updates ohne weitere UAC-Popups laufen.',
      btnCls: 'btn-primary',
      btnText: '🛡️ Admin-Sitzung aktivieren (Einmalig UAC)',
      btnDisabled: false,
    };
  };
  const initialAdminMeta = getAdminUiMeta(currentAdminStatus);

  let providers = Array.isArray(providersInfo?.providers) ? providersInfo.providers : [];
  const plannedProviders = Array.isArray(providersInfo?.planned) ? providersInfo.planned : [];
  const initialDraft = createSettingsDraft(s);
  let draftSettings = createSettingsDraft(s);
  const availabilityById = new Map();
  for (const p of providers) {
    if (p.availability) availabilityById.set(p.id, p.availability);
  }
  const busyProviderIds = new Set();

  const totalCacheEntries = Number(cacheStats?.totalEntries) || 0;
  const expiredCacheEntries = Number(cacheStats?.expiredEntries) || 0;

  const initialStatusMap = new Map(
    (Array.isArray(s.archiveRootsStatus) ? s.archiveRootsStatus : []).map((st) => [st.rawPath, st])
  );
  /** @type {Array<{ rawPath: string, absPath: string, label: string, online: boolean }>} */
  const archiveItems = draftSettings.archivePaths.map((rawPath, idx) => {
    const st = initialStatusMap.get(rawPath);
    return {
      rawPath,
      absPath: st?.absPath || rawPath,
      label: st?.label || getArchiveRootLabel(rawPath, idx),
      online: Boolean(st?.online),
    };
  });

  const getDraftEnabledSet = () => new Set(draftSettings.enabledProviders);

  const renderProvidersHtml = () => {
    const groups = groupProvidersByUiCategory(providers);
    if (groups.length === 0) {
      return '<div class="path-empty">Keine Paketmanager registriert.</div>';
    }

    const enabledSet = getDraftEnabledSet();

    return groups
      .map((group) => {
        const rowsHtml = group.providers
          .map((p) => {
            const isEnabled = enabledSet.has(p.id);
            const checked = isEnabled ? 'checked' : '';
            const avail = availabilityById.get(p.id) || p.availability || null;
            const badge = formatProviderStatusBadge(p, avail);
            const isBusy = busyProviderIds.has(p.id);
            const showAdminPill = Boolean(
              avail && !avail.available && p.canInstallManager && p.requiresAdminForBootstrap
            );

            const actionBtns = [];
            const isConfigSourceMgr = ['npm', 'bun', 'pnpm', 'pip', 'uv'].includes(p.id);
            if (p.capabilities?.manageSources) {
              const sourcesDisabled = isBusy || (!isConfigSourceMgr && Boolean(avail && !avail.available));
              actionBtns.push(
                `<button type="button" class="btn btn-ghost btn-xs" data-provider-sources="${escapeHTML(p.id)}" ${sourcesDisabled ? 'disabled' : ''} title="Bezugsquellen verwalten">🌐 Quellen</button>`
              );
            }
            if (isBusy) {
              actionBtns.push('<button type="button" class="btn btn-ghost btn-xs" disabled>⏳ Läuft...</button>');
            } else if (avail && !avail.available && p.canInstallManager) {
              actionBtns.push(
                `<button type="button" class="btn btn-primary btn-xs" data-provider-install="${escapeHTML(p.id)}" title="Paketmanager direkt installieren">⬇️ Installieren</button>`
              );
            } else if (avail?.available && p.canUninstallManager) {
              actionBtns.push(
                `<button type="button" class="btn btn-danger btn-xs" data-provider-uninstall="${escapeHTML(p.id)}" title="Paketmanager deinstallieren (2x klicken)">🗑️ Deinstallieren</button>`
              );
            }
            const actionHtml = actionBtns.join('');

            const extraSettingHtml =
              p.id === 'vcpkg'
                ? `
                  <div class="provider-extra-setting">
                    <span class="provider-extra-label"><code>VCPKG_ROOT</code> Ordner:</span>
                    <div class="provider-extra-input-row">
                      <input type="text" id="cfgVcpkgRoot" data-vcpkg-root-input value="${escapeHTML(draftSettings.vcpkgRoot)}" placeholder="Pfad zum vcpkg-Ordner (leer = %VCPKG_ROOT% / PATH)">
                      <button type="button" class="btn btn-ghost btn-xs" data-settings-action="browse-vcpkg-root">📂 Ordner...</button>
                    </div>
                  </div>
                `
                : '';

            return `
              <div class="provider-setting-row ${isEnabled ? '' : 'is-disabled'}" data-provider-row="${escapeHTML(p.id)}">
                <label class="provider-toggle-switch" title="${isEnabled ? 'Quelle deaktivieren' : 'Quelle aktivieren'}">
                  <input type="checkbox" name="enabledProviderCheck" data-provider-toggle="${escapeHTML(p.id)}" value="${escapeHTML(p.id)}" ${checked}>
                  <span class="provider-toggle-slider" aria-hidden="true"></span>
                </label>
                <div class="provider-setting-info">
                  <div class="provider-setting-head">
                    <strong>${escapeHTML(p.name)}</strong>
                    <span class="provider-status-badge is-${escapeHTML(badge.kind)}" title="${escapeHTML(badge.title)}">${escapeHTML(badge.text)}</span>
                    ${showAdminPill ? '<span class="provider-admin-pill" title="Erfordert Administratorrechte (UAC)">🛡️ Admin</span>' : ''}
                  </div>
                  ${p.description ? `<span class="muted">${escapeHTML(p.description)}</span>` : ''}
                  ${extraSettingHtml}
                </div>
                ${actionHtml ? `<div class="provider-setting-actions">${actionHtml}</div>` : ''}
              </div>
            `;
          })
          .join('');

        return `
          <div class="provider-category-group">
            <h4 class="provider-category-title">${escapeHTML(group.label)}</h4>
            <div class="provider-settings-list">${rowsHtml}</div>
          </div>
        `;
      })
      .join('');
  };

  const plannedHintText =
    plannedProviders.length > 0
      ? `Künftig erweiterbar um weitere Quellen wie ${plannedProviders
          .slice(0, 5)
          .map((p) => p.name)
          .join(', ')} u. a.`
      : '';

  const hiddenCheckboxes =
    state.availableHiddenCats.length === 0
      ? '<span class="muted">Keine versteckten Kategorien im Katalog vorhanden.</span>'
      : state.availableHiddenCats
          .map((cat) => {
            const checked = draftSettings.visibleHiddenCats.includes(cat) ? 'checked' : '';
            return `<label class="check-row"><input type="checkbox" name="hiddenCatCheck" value="${escapeHTML(cat)}" ${checked}><span>${escapeHTML(cat)}</span></label>`;
          })
          .join('');

  const tabsNavHtml = SETTINGS_TABS.map(
    (tab) => `
      <button
        type="button"
        class="tab-btn settings-tab-btn ${tab.id === activeTab ? 'active' : ''}"
        role="tab"
        aria-selected="${tab.id === activeTab ? 'true' : 'false'}"
        data-settings-tab="${tab.id}"
      >${escapeHTML(tab.label)}</button>
    `
  ).join('');

  modal.innerHTML = `
    <div class="modal-header">
      <h2>Einstellungen</h2>
      <button type="button" class="icon-btn" data-settings-action="close" title="Schließen" aria-label="Schließen">✕</button>
    </div>

    <nav class="modal-tabs settings-tabs" role="tablist" aria-label="Einstellungs-Bereiche">
      ${tabsNavHtml}
    </nav>

    <div class="modal-body settings-body">
      <!-- TAB 1: ALLGEMEIN -->
      <section class="tab-panel" role="tabpanel" data-settings-panel="general" ${activeTab === 'general' ? '' : 'hidden'}>
        <section class="settings-section">
          <h3>⚙️ Startverhalten & Darstellung</h3>
          <div class="form-grid-2">
            <label class="form-field">
              <span>Start-Tab beim Öffnen der App</span>
              <select id="cfgStartTab">
                <option value="updates" ${draftSettings.startTab === 'updates' ? 'selected' : ''}>⬆️ Updates (Standard)</option>
                <option value="installed" ${draftSettings.startTab === 'installed' ? 'selected' : ''}>💻 Installiert</option>
                <option value="archive" ${draftSettings.startTab === 'archive' ? 'selected' : ''}>🗄️ Archiv</option>
                <option value="bundles" ${draftSettings.startTab === 'bundles' ? 'selected' : ''}>📦 Bündel</option>
                <option value="discover" ${draftSettings.startTab === 'discover' ? 'selected' : ''}>🛍️ Neu installieren</option>
              </select>
            </label>
            <label class="form-field">
              <span>"NEU"-Hinweis anzeigen für (Tage, 0 = aus)</span>
              <input type="number" id="cfgNewBadgeDays" value="${draftSettings.newBadgeDays}" min="0" max="365">
            </label>
            <label class="form-field">
              <span>Versionsvergleich-Genauigkeit (Stellen, z. B. 3 = X.X.X)</span>
              <input type="number" id="cfgVersionDepth" value="${draftSettings.versionCompareDepth}" min="1" max="10">
            </label>
          </div>
        </section>

        <section class="settings-section">
          <h3>👁️ Versteckte Kategorien</h3>
          <div class="form-field">
            <span>Versteckte Kategorien im Katalog einblenden</span>
            <div class="hidden-cats-wrap">${hiddenCheckboxes}</div>
          </div>
        </section>
      </section>

      <!-- TAB 2: ARCHIV & DOWNLOADS -->
      <section class="tab-panel" role="tabpanel" data-settings-panel="archive" ${activeTab === 'archive' ? '' : 'hidden'}>
        <section class="settings-section">
          <div class="field-header-row">
            <h3>🗄️ Multi-Archiv-Pfade</h3>
            <button type="button" class="btn btn-ghost btn-xs" data-settings-action="add-archive-path">➕ Archiv-Pfad hinzufügen</button>
          </div>
          <div class="form-field">
            <span>Archiv-Orte (Priorität von oben nach unten)</span>
            <div id="archivePathsList" class="archive-paths-list">
              ${renderArchiveRootsListHtml(archiveItems)}
            </div>
            <p class="panel-hint">
              Eintrag #1 hat höchste Priorität. Duplikate über mehrere Archiv-Orte werden automatisch zusammengeführt; nicht erreichbare Quellen bleiben im Cache erhalten.
            </p>
          </div>
        </section>

        <section class="settings-section">
          <h3>🔍 Scanner & Setup-Erkennung</h3>
          <div class="form-grid-2">
            <label class="form-field">
              <span>Setup-Dateiendungen (Priorität von links nach rechts)</span>
              <input type="text" id="cfgAutoExt" value="${escapeHTML(draftSettings.autoExtensions.join(', '))}">
            </label>
            <label class="form-field">
              <span>Maximale Verschachtelungstiefe</span>
              <input type="number" id="cfgNestedDepth" value="${draftSettings.nestedDepth}" min="1" max="5">
            </label>
          </div>
          <label class="check-row">
            <input type="checkbox" id="cfgScanNested" ${draftSettings.scanNested ? 'checked' : ''}>
            <span>Nach Fund eines <code>_metadata</code>-Ordners auch tiefere Unterordner durchsuchen</span>
          </label>
        </section>

        <section class="settings-section">
          <h3>⬇️ Downloads, Dateibenennung & Archiv-Speichermodus</h3>
          <label class="form-field">
            <span>Archiv-Speichermodus bei Erstinstallation/Update</span>
            <select id="cfgArchiveSaveMode">
              <option value="ask" ${draftSettings.archiveSaveMode === 'ask' ? 'selected' : ''}>Nachfragen (Standard)</option>
              <option value="auto-id" ${draftSettings.archiveSaveMode === 'auto-id' ? 'selected' : ''}>Automatisch im Archiv speichern (Ordnername = Paket-ID, Anzeigename = Softwarename)</option>
              <option value="none" ${draftSettings.archiveSaveMode === 'none' ? 'selected' : ''}>Nicht automatisch im Archiv speichern</option>
            </select>
          </label>
          <label class="check-row">
            <input type="checkbox" id="cfgAutoSave" ${draftSettings.autoSaveDownloads ? 'checked' : ''}>
            <span>Updates automatisch im Software-Ordner speichern (ohne "Speichern unter"-Dialog)</span>
          </label>
          <label class="check-row">
            <input type="checkbox" id="cfgKeepOriginal" ${draftSettings.keepOriginalNameIfVersioned ? 'checked' : ''}>
            <span>Original-Dateinamen behalten, falls die Versionsnummer bereits enthalten ist</span>
          </label>
          <div class="form-grid-2">
            <label class="form-field">
              <span>Benennungs-Schema (bei fehlender Version)</span>
              <input type="text" id="cfgFilenamePattern" value="${escapeHTML(draftSettings.filenamePattern)}">
            </label>
            <div class="form-field">
              <span>Live-Vorschau (für "setup-x64.exe")</span>
              <div id="filenamePreview" class="filename-preview"></div>
            </div>
          </div>
          <p class="panel-hint">Platzhalter: <code>{Name}</code>, <code>{Version}</code>, <code>{Arch}</code>, <code>{Ext}</code></p>
        </section>
      </section>

      <!-- TAB 3: PAKETMANAGER -->
      <section class="tab-panel" role="tabpanel" data-settings-panel="providers" ${activeTab === 'providers' ? '' : 'hidden'}>
        <section class="settings-section">
          <div class="field-header-row">
            <h3>📦 Registrierte Paketmanager</h3>
            <button type="button" class="btn btn-ghost btn-xs" id="btnRecheckProviders" data-settings-action="recheck-providers">🔄 Status prüfen</button>
          </div>
          <p class="panel-hint">
            Änderungen an Ein-/Aus-Schaltern und <code>VCPKG_ROOT</code> werden erst mit "Speichern & Anwenden" übernommen.
          </p>
          <div class="form-field">
            <div id="providerSettingsContainer" class="provider-groups-wrap">${renderProvidersHtml()}</div>
            ${plannedHintText ? `<p class="planned-providers-hint">${escapeHTML(plannedHintText)}</p>` : ''}
          </div>
        </section>

        <section class="settings-section">
          <h3>🧹 Provider-Cache</h3>
          <div class="cache-status-bar">
            <div class="cache-status-text">
              <strong>Provider-Offline-Cache (7 Tage)</strong>
              <span id="providerCacheCount" class="muted">
                ${totalCacheEntries} ${totalCacheEntries === 1 ? 'Eintrag' : 'Einträge'} gespeichert${expiredCacheEntries > 0 ? ` (${expiredCacheEntries} abgelaufen, offline verfügbar)` : ''}
              </span>
            </div>
            <button type="button" class="btn btn-ghost btn-xs" id="btnClearProviderCache" data-settings-action="clear-provider-cache" ${totalCacheEntries === 0 ? 'disabled' : ''}>
              🧹 Cache leeren
            </button>
          </div>
        </section>
      </section>

      <!-- TAB 4: HINTERGRUND & UPDATES -->
      <section class="tab-panel" role="tabpanel" data-settings-panel="updates" ${activeTab === 'updates' ? '' : 'hidden'}>
        <section class="settings-section">
          <h3>🚀 App-Updates</h3>
          <div class="form-grid-2">
            <label class="form-field">
              <span>Automatisch nach App-Updates suchen</span>
              <select id="cfgUpdateInterval">
                <option value="0" ${draftSettings.updateInterval === 0 ? 'selected' : ''}>Bei jedem Start</option>
                <option value="24" ${draftSettings.updateInterval === 24 ? 'selected' : ''}>Täglich (24h)</option>
                <option value="168" ${draftSettings.updateInterval === 168 ? 'selected' : ''}>Wöchentlich</option>
                <option value="720" ${draftSettings.updateInterval === 720 ? 'selected' : ''}>Monatlich</option>
                <option value="-1" ${draftSettings.updateInterval === -1 ? 'selected' : ''}>Nie</option>
              </select>
            </label>
            <div class="form-field">
              <span>Installierte App-Version</span>
              <div class="app-update-box">
                <strong>v${escapeHTML(info.version)}</strong>
                <span id="appUpdateStatus" class="muted">Prüfe...</span>
                <button type="button" class="btn btn-ghost btn-xs" id="btnCheckAppUpdate" data-settings-action="check-app-update">🔄 Jetzt prüfen</button>
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section" id="settingsBackgroundSection">
          <h3>🔔 Hintergrundbetrieb & Automatisierung</h3>
          <div class="settings-placeholder-card">
            <div class="settings-placeholder-head">
              <strong>System-Tray, Autostart & Hintergrund-Updates</strong>
              <span class="settings-placeholder-badge">Vorbereitet (P9)</span>
            </div>
            <p class="panel-hint">
              Dieser Bereich ist für die kommenden Hintergrund-Funktionen reserviert:
            </p>
            <ul class="settings-placeholder-list">
              <li>Minimieren in den Windows-Infobereich (System-Tray) statt vollständigem Beenden</li>
              <li>Automatischer Start mit Windows inklusive stillem Hintergrund-Check</li>
              <li>Automatische Hintergrund-Suche nach App- und Paket-Updates mit Benachrichtigungen</li>
            </ul>
          </div>
        </section>
      </section>

      <!-- TAB 5: SICHERHEIT & RICHTLINIEN -->
      <section class="tab-panel" role="tabpanel" data-settings-panel="security" ${activeTab === 'security' ? '' : 'hidden'}>
        <section class="settings-section" id="settingsElevationSection">
          <h3>🛡️ Sitzungsbasierter Admin-Ausführungsmodus (UAC)</h3>
          <div class="admin-session-card" id="settingsAdminSessionCard">
            <div class="admin-session-card-info">
              <div class="admin-session-head">
                <strong>Aktueller Status</strong>
                <span id="settingsAdminStatusBadge" class="admin-session-status-badge ${initialAdminMeta.badgeCls}">${escapeHTML(initialAdminMeta.badgeText)}</span>
              </div>
              <p id="settingsAdminStatusDesc" class="panel-hint">${escapeHTML(initialAdminMeta.desc)}</p>
            </div>
            <button
              type="button"
              class="btn ${initialAdminMeta.btnCls}"
              id="btnSettingsToggleAdminSession"
              data-settings-action="toggle-admin-session"
              ${initialAdminMeta.btnDisabled ? 'disabled' : ''}
            >${escapeHTML(initialAdminMeta.btnText)}</button>
          </div>
          <label class="check-row">
            <input type="checkbox" id="cfgAutoRequestAdminForBatch" ${draftSettings.autoRequestAdminForBatch ? 'checked' : ''}>
            <span>Bei Massen-Updates automatisch einmalig Admin-Sitzung anfragen</span>
          </label>
        </section>

        <section class="settings-section" id="settingsAdminSection">
          ${renderAuthSectionHtml(currentAuthStatus)}
        </section>

        <section class="settings-section" id="settingsPolicySection">
          ${renderPolicySectionHtml()}
        </section>
      </section>

      <!-- TAB 6: WARTUNG & ÜBER -->
      <section class="tab-panel" role="tabpanel" data-settings-panel="maintenance" ${activeTab === 'maintenance' ? '' : 'hidden'}>
        <section class="settings-section">
          <h3>💾 Backup & Speicherorte</h3>
          <div class="inline-btn-group">
            <button type="button" class="btn btn-primary" data-settings-action="backup-create">💾 Backup erstellen</button>
            <button type="button" class="btn btn-ghost" data-settings-action="backup-restore">📂 Backup wiederherstellen</button>
          </div>
          <div class="inline-btn-group">
            <button type="button" class="btn btn-ghost" data-settings-action="open-data-dir">📁 Datenordner (data/)</button>
            <button type="button" class="btn btn-ghost" data-settings-action="open-state">📁 Lokaler State (Favoriten)</button>
          </div>
        </section>

        <section class="settings-section">
          <h3>⚠️ Zurücksetzen (Gefahrenzone)</h3>
          <div class="settings-danger-box">
            <p class="panel-hint">Sicherheitsabfrage: Zum Ausführen der folgenden Aktionen bitte zweimal klicken.</p>
            <div class="inline-btn-group">
              <button type="button" class="btn btn-danger" data-danger-action="reset-auto-paths">Auto-Pfade zurücksetzen</button>
              <button type="button" class="btn btn-danger" data-danger-action="reset-manual-paths">Manuelle Pfade zurücksetzen</button>
              <button type="button" class="btn btn-danger" data-danger-action="reset-local-ver">PC-Versionen zurücksetzen</button>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h3>ℹ️ Über Software Katalog</h3>
          <div class="settings-about-row">
            <div>
              <strong>Software Katalog v${escapeHTML(info.version)}</strong>
              <div class="muted">Software Katalog by © Felix Maywald</div>
            </div>
            <button type="button" class="btn btn-ghost" data-settings-action="open-github">GitHub Repository</button>
          </div>
        </section>
      </section>
    </div>

    <div class="modal-footer settings-footer">
      <div class="settings-footer-status">
        <span class="muted">Software Katalog by © Felix Maywald</span>
        <span id="settingsDirtyBadge" class="settings-dirty-badge" hidden>● Ungespeicherte Änderungen</span>
      </div>
      <div class="footer-group">
        <button type="button" class="btn btn-ghost" data-settings-action="close">Abbrechen</button>
        <button type="button" class="btn btn-primary" id="btnSettingsSave" data-settings-action="save">💾 Speichern & Anwenden</button>
      </div>
    </div>
  `;

  overlay.hidden = false;

  const updateDirtyUi = () => {
    const badge = modal.querySelector('#settingsDirtyBadge');
    if (badge instanceof HTMLElement) {
      badge.hidden = !hasSettingsDraftChanges(initialDraft, draftSettings) && !hasPolicyDraftChanges();
    }
  };

  const switchTab = (tabId) => {
    activeTab = normalizeSettingsTab(tabId);
    modal.querySelectorAll('[data-settings-tab]').forEach((tabBtn) => {
      if (!(tabBtn instanceof HTMLElement)) return;
      const isSelected = tabBtn.dataset.settingsTab === activeTab;
      tabBtn.classList.toggle('active', isSelected);
      tabBtn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    });
    modal.querySelectorAll('[data-settings-panel]').forEach((panel) => {
      if (!(panel instanceof HTMLElement)) return;
      panel.hidden = panel.dataset.settingsPanel !== activeTab;
    });
  };

  const syncDraftFromDom = () => {
    const checkedCats = Array.from(modal.querySelectorAll('input[name="hiddenCatCheck"]:checked'))
      .filter((cb) => cb instanceof HTMLInputElement)
      .map((cb) => cb.value);

    const rawNewDays = getInputEl(modal, '#cfgNewBadgeDays')?.value ?? '';
    const parsedNewDays = Number.parseInt(rawNewDays, 10);
    const rawVersionDepth = getInputEl(modal, '#cfgVersionDepth')?.value ?? '';
    const parsedVersionDepth = Number.parseInt(rawVersionDepth, 10);
    const rawNestedDepth = getInputEl(modal, '#cfgNestedDepth')?.value ?? '';
    const parsedNestedDepth = Number.parseInt(rawNestedDepth, 10);
    const rawUpdateInterval = getSelectEl(modal, '#cfgUpdateInterval')?.value ?? '';
    const parsedUpdateInterval = Number.parseInt(rawUpdateInterval, 10);
    const rawAutoExt = getInputEl(modal, '#cfgAutoExt')?.value ?? '';
    const vcpkgInput = getInputEl(modal, '#cfgVcpkgRoot');

    draftSettings = createSettingsDraft({
      startTab: getSelectEl(modal, '#cfgStartTab')?.value || draftSettings.startTab,
      newBadgeDays: Number.isFinite(parsedNewDays) ? parsedNewDays : draftSettings.newBadgeDays,
      versionCompareDepth: Number.isFinite(parsedVersionDepth) ? parsedVersionDepth : draftSettings.versionCompareDepth,
      visibleHiddenCats: checkedCats,
      archivePaths: draftSettings.archivePaths,
      autoExtensions: rawAutoExt.trim() ? parseAutoExtensionsInput(rawAutoExt) : draftSettings.autoExtensions,
      nestedDepth: Number.isFinite(parsedNestedDepth) ? parsedNestedDepth : draftSettings.nestedDepth,
      scanNested: Boolean(getInputEl(modal, '#cfgScanNested')?.checked),
      autoSaveDownloads: Boolean(getInputEl(modal, '#cfgAutoSave')?.checked),
      keepOriginalNameIfVersioned: Boolean(getInputEl(modal, '#cfgKeepOriginal')?.checked),
      filenamePattern: getInputEl(modal, '#cfgFilenamePattern')?.value.trim() || draftSettings.filenamePattern,
      archiveSaveMode: getSelectEl(modal, '#cfgArchiveSaveMode')?.value || draftSettings.archiveSaveMode,
      enabledProviders: draftSettings.enabledProviders,
      vcpkgRoot: vcpkgInput ? vcpkgInput.value.trim() : draftSettings.vcpkgRoot,
      updateInterval: Number.isFinite(parsedUpdateInterval) ? parsedUpdateInterval : draftSettings.updateInterval,
      autoRequestAdminForBatch: Boolean(getInputEl(modal, '#cfgAutoRequestAdminForBatch')?.checked),
    });
    updateDirtyUi();
  };

  const refreshPolicySectionUi = () => {
    if (modalToken !== activeSettingsToken || overlay.hidden) return;
    const sec = modal.querySelector('#settingsPolicySection');
    if (sec instanceof HTMLElement) {
      sec.innerHTML = renderPolicySectionHtml();
    }
    updateDirtyUi();
  };

  const refreshPolicyListsInPlace = () => {
    const candList = modal.querySelector('#policyCandidateList');
    if (candList instanceof HTMLElement) {
      candList.innerHTML = renderPolicyCandidateListHtml();
    }
    const entriesList = modal.querySelector('#policyEntriesList');
    if (entriesList instanceof HTMLElement) {
      entriesList.innerHTML = renderPolicyEntriesHtml();
    }
  };

  const runWingetPolicySearch = async () => {
    const q = policySearchQuery.trim();
    if (q.length < 2) {
      policyWingetError = 'Bitte mindestens 2 Zeichen fuer die Winget-Suche eingeben.';
      policyWingetResults = [];
      refreshPolicyListsInPlace();
      return;
    }
    policyWingetLoading = true;
    policyWingetError = '';
    refreshPolicyListsInPlace();
    try {
      const res = await window.electronAPI.searchProviders(q, { providerIds: ['winget'], limit: 25 });
      if (modalToken !== activeSettingsToken || overlay.hidden) return;
      policyWingetLoading = false;
      policyWingetResults = Array.isArray(res?.results) ? res.results : [];
      if (res?.byProvider?.winget?.success === false && res.byProvider.winget.error) {
        policyWingetError = res.byProvider.winget.error;
      }
      refreshPolicyListsInPlace();
    } catch (err) {
      if (modalToken !== activeSettingsToken || overlay.hidden) return;
      policyWingetLoading = false;
      policyWingetResults = [];
      policyWingetError = err?.message || 'Winget-Suche fehlgeschlagen.';
      refreshPolicyListsInPlace();
    }
  };

  const refreshAuthSectionUi = (nextStatus, { syncPolicy = false } = {}) => {
    const hadUnsavedPolicy = hasPolicyDraftChanges();
    if (nextStatus) {
      currentAuthStatus = applyAuthStatus(nextStatus);
      renderAuthHeaderControls();
      if (syncPolicy || !hadUnsavedPolicy) {
        savedPolicy = normalizeAccessPolicy(currentAuthStatus?.accessPolicy);
        draftPolicy = normalizeAccessPolicy(currentAuthStatus?.accessPolicy);
      }
    }
    if (modalToken !== activeSettingsToken || overlay.hidden) return;
    const sec = modal.querySelector('#settingsAdminSection');
    if (sec instanceof HTMLElement) {
      sec.innerHTML = renderAuthSectionHtml(currentAuthStatus);
    }
    refreshPolicySectionUi();
  };

  const refreshProvidersSectionUi = () => {
    if (modalToken !== activeSettingsToken || overlay.hidden) return;
    const container = modal.querySelector('#providerSettingsContainer');
    if (container) {
      container.innerHTML = renderProvidersHtml();
    }
  };

  const runProvidersAvailabilityCheck = async () => {
    const recheckBtn = modal.querySelector('#btnRecheckProviders');
    if (recheckBtn instanceof HTMLButtonElement) recheckBtn.disabled = true;
    try {
      const res = await window.electronAPI.checkAllProvidersAvailability();
      if (modalToken !== activeSettingsToken || overlay.hidden) return;
      if (Array.isArray(res?.providers)) {
        providers = res.providers;
      }
      if (res?.results && typeof res.results === 'object') {
        for (const [id, status] of Object.entries(res.results)) {
          availabilityById.set(id, status);
        }
      }
      refreshProvidersSectionUi();
    } catch {
      // Status-Anzeige bleibt unverändert
    } finally {
      if (recheckBtn instanceof HTMLButtonElement) recheckBtn.disabled = false;
    }
  };

  void runProvidersAvailabilityCheck();

  const refreshArchivePathsUi = () => {
    const listEl = modal.querySelector('#archivePathsList');
    if (listEl) {
      listEl.innerHTML = renderArchiveRootsListHtml(archiveItems);
    }
    draftSettings = {
      ...draftSettings,
      archivePaths: archiveItems.map((entry) => entry.rawPath),
    };
    updateDirtyUi();
  };

  // Drag & Drop zum Umsortieren der Archiv-Priorität
  const listEl = modal.querySelector('#archivePathsList');
  let draggedIdx = -1;
  if (listEl instanceof HTMLElement) {
    listEl.addEventListener('dragstart', (e) => {
      if (!(e.target instanceof Element)) return;
      const row = e.target.closest('.archive-path-row');
      if (!(row instanceof HTMLElement)) return;
      draggedIdx = parseInt(row.dataset.archiveIdx || '-1', 10);
      row.classList.add('is-dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(draggedIdx));
      }
    });

    listEl.addEventListener('dragover', (e) => {
      if (draggedIdx < 0 || !(e.target instanceof Element)) return;
      const row = e.target.closest('.archive-path-row');
      if (!(row instanceof HTMLElement)) return;
      e.preventDefault();
      listEl.querySelectorAll('.archive-path-row').forEach((el) => {
        el.classList.remove('is-drag-over');
      });
      row.classList.add('is-drag-over');
    });

    listEl.addEventListener('dragleave', (e) => {
      if (!(e.target instanceof Element)) return;
      const row = e.target.closest('.archive-path-row');
      if (row instanceof HTMLElement) row.classList.remove('is-drag-over');
    });

    listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!(e.target instanceof Element)) return;
      const targetRow = e.target.closest('.archive-path-row');
      const targetIdx = targetRow instanceof HTMLElement ? parseInt(targetRow.dataset.archiveIdx || '-1', 10) : -1;
      if (draggedIdx >= 0 && targetIdx >= 0 && draggedIdx !== targetIdx) {
        const [moved] = archiveItems.splice(draggedIdx, 1);
        archiveItems.splice(targetIdx, 0, moved);
        refreshArchivePathsUi();
      }
      draggedIdx = -1;
    });

    listEl.addEventListener('dragend', () => {
      draggedIdx = -1;
      listEl.querySelectorAll('.archive-path-row').forEach((el) => {
        el.classList.remove('is-dragging', 'is-drag-over');
      });
    });
  }

  // Live-Vorschau für Dateinamen-Schema
  const updatePreview = () => {
    const patternInput = getInputEl(modal, '#cfgFilenamePattern');
    const pattern = patternInput?.value || '{Name}_v{Version}{Arch}{Ext}';
    const preview = buildArchiveFilename({
      softwareName: 'VLC Media Player',
      version: '3.0.21',
      originalFilename: 'setup-x64.exe',
      pattern,
      keepIfVersionPresent: false,
    });
    const el = modal.querySelector('#filenamePreview');
    if (el) el.textContent = preview;
  };
  updatePreview();

  const runAppUpdateCheck = async ({ manual = false } = {}) => {
    const checkBtn = modal.querySelector('#btnCheckAppUpdate');
    const box = modal.querySelector('#appUpdateStatus');
    if (checkBtn instanceof HTMLButtonElement) checkBtn.disabled = true;
    if (manual && box) box.textContent = 'Prüfe...';
    try {
      const res = await window.electronAPI.checkAppUpdate();
      if (modalToken !== activeSettingsToken || overlay.hidden) return;
      const liveBox = modal.querySelector('#appUpdateStatus');
      if (!liveBox) return;
      if (res?.error) {
        liveBox.textContent = 'Prüfung fehlgeschlagen';
        if (manual) showToast('App-Update-Prüfung fehlgeschlagen.', { type: 'error' });
      } else if (res?.updateAvailable && res.updateAssetUrl) {
        liveBox.innerHTML = `<button type="button" class="btn btn-local btn-xs" data-install-app-url="${escapeHTML(res.updateAssetUrl)}" data-portable="${res.isPortable}">⬆️ Auf v${escapeHTML(res.latestVersion)} updaten</button>`;
        if (manual) showToast(`Neue Version v${res.latestVersion} verfügbar.`, { type: 'info' });
      } else if (res?.updateAvailable) {
        liveBox.innerHTML = `<button type="button" class="btn btn-local btn-xs" data-open-release="${escapeHTML(res.releaseUrl)}">🎁 v${escapeHTML(res.latestVersion)} auf GitHub</button>`;
        if (manual) showToast(`Neue Version v${res.latestVersion} auf GitHub verfügbar.`, { type: 'info' });
      } else {
        liveBox.innerHTML = '<span class="text-ok">✓ Aktuell</span>';
        if (manual) showToast('App ist auf dem neuesten Stand.', { type: 'success' });
      }
    } catch {
      if (modalToken !== activeSettingsToken || overlay.hidden) return;
      const liveBox = modal.querySelector('#appUpdateStatus');
      if (liveBox) liveBox.textContent = 'Prüfung fehlgeschlagen';
    } finally {
      if (checkBtn instanceof HTMLButtonElement) checkBtn.disabled = false;
    }
  };

  void runAppUpdateCheck();

  modal.oninput = (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.id === 'cfgPolicyCandidateSearch' && e.target instanceof HTMLInputElement) {
      policySearchQuery = e.target.value;
      refreshPolicyListsInPlace();
      return;
    }
    if (e.target.id === 'cfgPolicyManualValue' && e.target instanceof HTMLInputElement) {
      policyManualValue = e.target.value;
      return;
    }
    if (e.target.id === 'cfgPolicyManualLabel' && e.target instanceof HTMLInputElement) {
      policyManualLabel = e.target.value;
      return;
    }
    if (e.target.id === 'cfgFilenamePattern') {
      updatePreview();
    }
    if (e.target instanceof HTMLInputElement && e.target.matches('[data-vcpkg-root-input]')) {
      draftSettings = {
        ...draftSettings,
        vcpkgRoot: e.target.value.trim(),
      };
    }
    syncDraftFromDom();
  };

  modal.onkeydown = (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.id === 'cfgPolicyCandidateSearch') {
      if (policySearchSource === 'winget') {
        e.preventDefault();
        void runWingetPolicySearch();
      }
    }
  };

  modal.onchange = (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.id === 'cfgPolicyEnabled' && e.target instanceof HTMLInputElement) {
      draftPolicy = normalizeAccessPolicy({ ...draftPolicy, enabled: e.target.checked });
      refreshPolicySectionUi();
      return;
    }
    if (e.target.id === 'cfgPolicyApplyToAdmin' && e.target instanceof HTMLInputElement) {
      draftPolicy = normalizeAccessPolicy({ ...draftPolicy, applyToAdmin: e.target.checked });
      refreshPolicySectionUi();
      return;
    }
    if (e.target.id === 'cfgPolicyListType' && e.target instanceof HTMLSelectElement) {
      const nextListType = e.target.value;
      updateActivePolicyRuleSet((rs) => ({ ...rs, listType: nextListType }));
      refreshPolicySectionUi();
      return;
    }
    if (e.target.id === 'cfgPolicyExecMode' && e.target instanceof HTMLSelectElement) {
      const nextExecMode = e.target.value;
      updateActivePolicyRuleSet((rs) => ({ ...rs, defaultExecutionMode: nextExecMode }));
      refreshPolicySectionUi();
      return;
    }
    if (e.target.id === 'cfgPolicyManualType' && e.target instanceof HTMLSelectElement) {
      policyManualMatchType = e.target.value;
      return;
    }
    const entryModeSel = e.target.closest('[data-policy-entry-mode]');
    if (entryModeSel instanceof HTMLSelectElement) {
      const mType = entryModeSel.dataset.matchType;
      const mVal = entryModeSel.dataset.matchValue;
      updateActivePolicyRuleSet((rs) => ({
        ...rs,
        entries: updatePolicyEntryExecutionMode(rs.entries, mType, mVal, entryModeSel.value),
      }));
      refreshPolicySectionUi();
      return;
    }

    const toggle = e.target.closest('[data-provider-toggle]');
    if (toggle instanceof HTMLInputElement) {
      const providerId = toggle.dataset.providerToggle;
      if (!providerId) return;

      draftSettings = toggleDraftProvider(draftSettings, providerId, toggle.checked);
      const row = toggle.closest('.provider-setting-row');
      if (row) row.classList.toggle('is-disabled', !toggle.checked);
      const switchLabel = toggle.closest('.provider-toggle-switch');
      if (switchLabel instanceof HTMLElement) {
        switchLabel.title = toggle.checked ? 'Quelle deaktivieren' : 'Quelle aktivieren';
      }
      updateDirtyUi();
      return;
    }

    syncDraftFromDom();
  };

  modal.onclick = async (e) => {
    if (!(e.target instanceof Element)) return;

    const tabBtn = e.target.closest('[data-settings-tab]');
    if (tabBtn instanceof HTMLElement) {
      switchTab(tabBtn.dataset.settingsTab);
      return;
    }

    const policyScopeBtn = e.target.closest('[data-policy-scope-mode]');
    if (policyScopeBtn instanceof HTMLElement) {
      const nextScope = policyScopeBtn.dataset.policyScopeMode;
      if (nextScope === 'shared' || nextScope === 'separate') {
        draftPolicy = normalizeAccessPolicy({ ...draftPolicy, scopeMode: nextScope });
        refreshPolicySectionUi();
      }
      return;
    }

    const policyScopeTabBtn = e.target.closest('[data-policy-scope-tab]');
    if (policyScopeTabBtn instanceof HTMLElement) {
      activePolicyScopeTab = policyScopeTabBtn.dataset.policyScopeTab === 'install' ? 'install' : 'updates';
      refreshPolicySectionUi();
      return;
    }

    const policySourceBtn = e.target.closest('[data-policy-source]');
    if (policySourceBtn instanceof HTMLElement) {
      policySearchSource = policySourceBtn.dataset.policySource || 'all';
      refreshPolicySectionUi();
      return;
    }

    const toggleCandBtn = e.target.closest('[data-policy-toggle-candidate]');
    if (toggleCandBtn instanceof HTMLElement) {
      const matchType = toggleCandBtn.dataset.matchType || '';
      const value = toggleCandBtn.dataset.matchValue || '';
      const label = toggleCandBtn.dataset.matchLabel || value;
      const targetKey = getPolicyEntryKey({ matchType, value });
      const activeSet = getActivePolicyRuleSet();
      const exists = activeSet.entries.some((entry) => getPolicyEntryKey(entry) === targetKey);
      updateActivePolicyRuleSet((rs) => ({
        ...rs,
        entries: exists
          ? removePolicyEntry(rs.entries, matchType, value)
          : upsertPolicyEntry(rs.entries, { matchType, value, label, executionMode: 'inherit' }),
      }));
      refreshPolicySectionUi();
      return;
    }

    const removeEntryBtn = e.target.closest('[data-policy-remove-entry]');
    if (removeEntryBtn instanceof HTMLElement) {
      const matchType = removeEntryBtn.dataset.matchType || '';
      const value = removeEntryBtn.dataset.matchValue || '';
      updateActivePolicyRuleSet((rs) => ({
        ...rs,
        entries: removePolicyEntry(rs.entries, matchType, value),
      }));
      refreshPolicySectionUi();
      return;
    }

    const policyActionBtn = e.target.closest('[data-policy-action]');
    if (policyActionBtn instanceof HTMLElement) {
      const pAct = policyActionBtn.dataset.policyAction;
      if (pAct === 'search-winget') {
        await runWingetPolicySearch();
      } else if (pAct === 'add-manual') {
        const cleanVal = policyManualValue.trim();
        if (!cleanVal) {
          showToast('Bitte einen Wert oder ein Muster eingeben.', { type: 'warn' });
          return;
        }
        updateActivePolicyRuleSet((rs) => ({
          ...rs,
          entries: upsertPolicyEntry(rs.entries, {
            matchType: policyManualMatchType,
            value: cleanVal,
            label: policyManualLabel.trim() || cleanVal,
            executionMode: 'inherit',
          }),
        }));
        policyManualValue = '';
        policyManualLabel = '';
        refreshPolicySectionUi();
      } else if (pAct === 'clear-ruleset') {
        updateActivePolicyRuleSet((rs) => ({ ...rs, entries: [] }));
        refreshPolicySectionUi();
      } else if (pAct === 'save') {
        if (policyActionBtn instanceof HTMLButtonElement) policyActionBtn.disabled = true;
        try {
          const res = await window.electronAPI.updateAccessPolicy(draftPolicy);
          if (modalToken !== activeSettingsToken) return;
          if (res?.status) {
            savedPolicy = normalizeAccessPolicy(res.status.accessPolicy);
            draftPolicy = normalizeAccessPolicy(res.status.accessPolicy);
            refreshAuthSectionUi(res.status);
          }
          if (res?.success) {
            await triggerCatalogReload();
            showToast('Zugriffsrichtlinien gespeichert.', { type: 'success' });
          } else {
            showToast(res?.error || 'Zugriffsrichtlinien konnten nicht gespeichert werden.', {
              type: 'error',
              duration: 6000,
            });
          }
        } finally {
          if (policyActionBtn instanceof HTMLButtonElement && policyActionBtn.isConnected) {
            policyActionBtn.disabled = false;
          }
        }
      } else if (pAct === 'export') {
        const res = await window.electronAPI.exportAccessPolicy();
        if (res?.success) {
          showToast('Zugriffsrichtlinien erfolgreich exportiert.', { type: 'success' });
        } else if (res?.error && !res.canceled) {
          showToast(res.error, { type: 'error', duration: 6000 });
        }
      } else if (pAct === 'import') {
        const res = await window.electronAPI.importAccessPolicy();
        if (modalToken !== activeSettingsToken) return;
        if (res?.status) {
          savedPolicy = normalizeAccessPolicy(res.status.accessPolicy);
          draftPolicy = normalizeAccessPolicy(res.status.accessPolicy);
          refreshAuthSectionUi(res.status);
        }
        if (res?.success) {
          await triggerCatalogReload();
          showToast('Zugriffsrichtlinien importiert und aktiviert.', { type: 'success' });
        } else if (res?.error && !res.canceled) {
          showToast(res.error, { type: 'error', duration: 6000 });
        }
      }
      return;
    }

    const sourcesBtn = e.target.closest('[data-provider-sources]');
    if (sourcesBtn instanceof HTMLButtonElement) {
      const providerId = sourcesBtn.dataset.providerSources;
      if (!providerId || busyProviderIds.has(providerId)) return;
      const providerObj = providers.find((p) => p.id === providerId) || { id: providerId, name: providerId };
      const res = await openProviderSourcesModal(providerObj);
      if (modalToken !== activeSettingsToken) return;
      if (res?.changed) {
        const refreshedSettings = await window.electronAPI.getSettings();
        if (modalToken !== activeSettingsToken) return;
        s.providerSettings = refreshedSettings?.providerSettings || s.providerSettings;
      }
      return;
    }

    const installProviderBtn = e.target.closest('[data-provider-install]');
    if (installProviderBtn instanceof HTMLButtonElement) {
      const providerId = installProviderBtn.dataset.providerInstall;
      if (!providerId || busyProviderIds.has(providerId)) return;
      const providerName = providers.find((p) => p.id === providerId)?.name || providerId;

      busyProviderIds.add(providerId);
      refreshProvidersSectionUi();
      showToast(`Installiere ${providerName}...`, { type: 'info' });

      const res = await window.electronAPI.installProviderManager(providerId);
      if (modalToken !== activeSettingsToken) return;
      busyProviderIds.delete(providerId);
      if (providerId === 'vcpkg') {
        const refreshedSettings = await window.electronAPI.getSettings();
        if (modalToken !== activeSettingsToken) return;
        const nextVcpkgRoot = String(refreshedSettings?.providerSettings?.vcpkgRoot || '').trim();
        s.providerSettings = { ...(s.providerSettings || {}), vcpkgRoot: nextVcpkgRoot };
        if (draftSettings.vcpkgRoot === initialDraft.vcpkgRoot) {
          initialDraft.vcpkgRoot = nextVcpkgRoot;
          draftSettings = { ...draftSettings, vcpkgRoot: nextVcpkgRoot };
          updateDirtyUi();
        }
      }
      if (res?.availability) {
        availabilityById.set(providerId, res.availability);
      }
      refreshProvidersSectionUi();
      await triggerCatalogReload({ rescanInstalled: Boolean(res?.success) });

      if (res?.canceled) {
        showToast(`${providerName}-Installation abgebrochen.`, { type: 'info' });
      } else if (res?.success) {
        showToast(`${providerName} erfolgreich installiert.`, { type: 'success' });
      } else {
        showToast(res?.error || `${providerName} konnte nicht installiert werden.`, { type: 'error', duration: 6000 });
      }
      return;
    }

    const uninstallProviderBtn = e.target.closest('[data-provider-uninstall]');
    if (uninstallProviderBtn instanceof HTMLButtonElement) {
      const providerId = uninstallProviderBtn.dataset.providerUninstall;
      if (!providerId || busyProviderIds.has(providerId)) return;

      const providerObj = providers.find((p) => p.id === providerId);
      const providerName = providerObj?.name || providerId;
      const customWarning = providerObj?.uninstallWarning || '';

      if (customWarning) {
        const decision = await openNestedDialog({
          defaultAction: 'cancel',
          html: `
            <div class="modal-header">
              <h2>⚠️ ${escapeHTML(providerName)} deinstallieren</h2>
              <button type="button" class="icon-btn" data-dialog-action="cancel" title="Abbrechen" aria-label="Abbrechen">✕</button>
            </div>
            <div class="modal-body collision-warning-body">
              <p>${escapeHTML(customWarning)}</p>
              <div class="collision-actions-grid">
                <button type="button" class="btn btn-ghost" data-dialog-action="cancel">Abbrechen</button>
                <button type="button" class="btn btn-danger" data-dialog-action="confirm">🗑️ Trotzdem deinstallieren</button>
              </div>
            </div>
          `,
          onAction: (act) => (act === 'confirm' ? 'confirm' : 'cancel'),
        });
        if (decision !== 'confirm') return;
      } else {
        if (uninstallProviderBtn.dataset.armed !== 'true') {
          uninstallProviderBtn.dataset.armed = 'true';
          uninstallProviderBtn.dataset.origText = uninstallProviderBtn.textContent || '';
          uninstallProviderBtn.textContent = '⚠️ Wirklich deinstallieren?';
          setTimeout(() => {
            if (uninstallProviderBtn.isConnected && uninstallProviderBtn.dataset.armed === 'true') {
              uninstallProviderBtn.dataset.armed = 'false';
              uninstallProviderBtn.textContent = uninstallProviderBtn.dataset.origText || '🗑️ Deinstallieren';
            }
          }, 4000);
          return;
        }
        uninstallProviderBtn.dataset.armed = 'false';
      }

      busyProviderIds.add(providerId);
      refreshProvidersSectionUi();
      showToast(`Deinstalliere ${providerName}...`, { type: 'info' });

      const res = await window.electronAPI.uninstallProviderManager(providerId);
      if (modalToken !== activeSettingsToken) return;
      busyProviderIds.delete(providerId);
      if (providerId === 'vcpkg') {
        const refreshedSettings = await window.electronAPI.getSettings();
        if (modalToken !== activeSettingsToken) return;
        const nextVcpkgRoot = String(refreshedSettings?.providerSettings?.vcpkgRoot || '').trim();
        s.providerSettings = { ...(s.providerSettings || {}), vcpkgRoot: nextVcpkgRoot };
        if (draftSettings.vcpkgRoot === initialDraft.vcpkgRoot) {
          initialDraft.vcpkgRoot = nextVcpkgRoot;
          draftSettings = { ...draftSettings, vcpkgRoot: nextVcpkgRoot };
          updateDirtyUi();
        }
      }
      if (res?.availability) {
        availabilityById.set(providerId, res.availability);
      }
      refreshProvidersSectionUi();
      await triggerCatalogReload({ rescanInstalled: Boolean(res?.success) });

      if (res?.canceled) {
        showToast(`${providerName}-Deinstallation abgebrochen.`, { type: 'info' });
      } else if (res?.success) {
        showToast(`${providerName} erfolgreich deinstalliert.`, { type: 'success' });
      } else {
        showToast(res?.error || `${providerName} konnte nicht deinstalliert werden.`, {
          type: 'error',
          duration: 6000,
        });
      }
      return;
    }

    const moveBtn = e.target.closest('[data-archive-move]');
    if (moveBtn instanceof HTMLButtonElement) {
      const idx = parseInt(moveBtn.dataset.archiveIdx || '-1', 10);
      const dir = moveBtn.dataset.archiveMove;
      if (dir === 'up' && idx > 0) {
        [archiveItems[idx - 1], archiveItems[idx]] = [archiveItems[idx], archiveItems[idx - 1]];
        refreshArchivePathsUi();
      } else if (dir === 'down' && idx >= 0 && idx < archiveItems.length - 1) {
        [archiveItems[idx], archiveItems[idx + 1]] = [archiveItems[idx + 1], archiveItems[idx]];
        refreshArchivePathsUi();
      }
      return;
    }

    const removeBtn = e.target.closest('[data-archive-remove]');
    if (removeBtn instanceof HTMLButtonElement) {
      if (archiveItems.length <= 1) return;
      const idx = parseInt(removeBtn.dataset.archiveRemove || '-1', 10);
      if (idx >= 0 && idx < archiveItems.length) {
        archiveItems.splice(idx, 1);
        refreshArchivePathsUi();
      }
      return;
    }

    const installAppBtn = e.target.closest('[data-install-app-url]');
    if (installAppBtn instanceof HTMLButtonElement) {
      installAppBtn.disabled = true;
      closeModal();
      showToast('App-Update wird im Hintergrund geladen...', { type: 'info' });
      const res = await window.electronAPI.installAppUpdate(
        installAppBtn.dataset.installAppUrl,
        installAppBtn.dataset.portable === 'true'
      );
      if (!res.success && !res.canceled) {
        showToast(`App-Update fehlgeschlagen: ${res.error}`, { type: 'error', duration: 6000 });
      }
      return;
    }

    const releaseBtn = e.target.closest('[data-open-release]');
    if (releaseBtn instanceof HTMLElement) {
      window.electronAPI.openUrl(releaseBtn.dataset.openRelease);
      return;
    }

    // Zwei-Klick-Bestätigung für destruktive Wartungsaktionen (kein confirm()!)
    const dangerBtn = e.target.closest('[data-danger-action]');
    if (dangerBtn instanceof HTMLButtonElement) {
      if (dangerBtn.dataset.armed !== 'true') {
        dangerBtn.dataset.armed = 'true';
        dangerBtn.dataset.origText = dangerBtn.textContent || '';
        dangerBtn.textContent = '⚠️ Wirklich ausführen?';
        setTimeout(() => {
          if (dangerBtn.dataset.armed === 'true') {
            dangerBtn.dataset.armed = 'false';
            dangerBtn.textContent = dangerBtn.dataset.origText || '';
          }
        }, 4000);
        return;
      }

      dangerBtn.dataset.armed = 'false';
      dangerBtn.disabled = true;
      const dAct = dangerBtn.dataset.dangerAction;

      if (dAct === 'reset-auto-paths' || dAct === 'reset-manual-paths') {
        const res = await window.electronAPI.resetPaths(dAct === 'reset-auto-paths' ? 'auto' : 'manual');
        if (res.success) {
          await triggerCatalogReload();
          showToast(`${res.count} Programme bereinigt.`, { type: 'success' });
        }
      } else if (dAct === 'reset-local-ver') {
        await window.electronAPI.resetLocalVersions();
        await triggerCatalogReload();
        showToast('Lokale PC-Versionen zurückgesetzt.', { type: 'success' });
      }

      dangerBtn.disabled = false;
      dangerBtn.textContent = dangerBtn.dataset.origText || '';
      return;
    }

    const btn = e.target.closest('[data-settings-action]');
    if (!(btn instanceof HTMLElement)) return;
    const act = btn.dataset.settingsAction;

    if (act === 'close') closeModal();
    else if (act === 'auth-save-config') {
      const enabledChk = getInputEl(modal, '#cfgAuthEnabled');
      const userInp = getInputEl(modal, '#cfgAuthUsername');
      const passInp = getInputEl(modal, '#cfgAuthPassword');
      const passConfirmInp = getInputEl(modal, '#cfgAuthPasswordConfirm');
      const timeoutSel = getSelectEl(modal, '#cfgAuthTimeout');

      const enabled = Boolean(enabledChk?.checked);
      const username = userInp?.value.trim() || '';
      const password = passInp?.value || '';
      const passwordConfirm = passConfirmInp?.value || '';
      const sessionTimeoutMinutes = Number.parseInt(timeoutSel?.value || '0', 10) || 0;

      if (enabled && (password || passwordConfirm) && password !== passwordConfirm) {
        showToast('Die eingegebenen Passwörter stimmen nicht überein.', { type: 'error' });
        return;
      }

      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      try {
        const res = await window.electronAPI.updateAuthConfig({
          enabled,
          username,
          password,
          sessionTimeoutMinutes,
        });
        if (res?.status) refreshAuthSectionUi(res.status);
        if (modalToken !== activeSettingsToken) return;
        if (res?.success) {
          showToast(enabled ? 'Admin-Schutz und Zugangsdaten gespeichert.' : 'Admin-Schutz wurde deaktiviert.', {
            type: 'success',
          });
        } else {
          showToast(res?.error || 'Auth-Konfiguration konnte nicht gespeichert werden.', {
            type: 'error',
            duration: 6000,
          });
        }
      } finally {
        if (btn instanceof HTMLButtonElement && btn.isConnected) btn.disabled = false;
      }
    } else if (act === 'auth-browse-file') {
      const picked = await window.electronAPI.selectFile([{ name: 'Policy JSON', extensions: ['json'] }], true);
      if (!picked || modalToken !== activeSettingsToken) return;
      const pathInp = getInputEl(modal, '#cfgAuthPolicyPath');
      if (pathInp) pathInp.value = picked;
    } else if (act === 'auth-browse-dir') {
      const dir = await window.electronAPI.selectDir({ title: 'Ordner für Admin-Policy auswählen' });
      if (!dir || modalToken !== activeSettingsToken) return;
      const sep = dir.includes('\\') ? '\\' : '/';
      const cleanDir = dir.endsWith('\\') || dir.endsWith('/') ? dir.slice(0, -1) : dir;
      const pathInp = getInputEl(modal, '#cfgAuthPolicyPath');
      if (pathInp) pathInp.value = `${cleanDir}${sep}admin-policy.json`;
    } else if (act === 'auth-save-path') {
      const pathInp = getInputEl(modal, '#cfgAuthPolicyPath');
      const copyChk = getInputEl(modal, '#cfgAuthCopyPolicy');
      const targetPath = pathInp?.value.trim() || '';
      const copyCurrentPolicy = copyChk ? copyChk.checked : true;
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      try {
        const res = await window.electronAPI.setAuthPolicyPath(targetPath, { copyCurrentPolicy });
        if (res?.status) refreshAuthSectionUi(res.status, { syncPolicy: true });
        if (modalToken !== activeSettingsToken) return;
        if (res?.success) {
          showToast('Speicherort der Policy-Datei wurde aktualisiert.', { type: 'success' });
        } else {
          showToast(res?.error || 'Policy-Pfad konnte nicht geändert werden.', { type: 'error', duration: 6000 });
        }
      } finally {
        if (btn instanceof HTMLButtonElement && btn.isConnected) btn.disabled = false;
      }
    } else if (act === 'auth-reset-path') {
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      try {
        const res = await window.electronAPI.setAuthPolicyPath('', { copyCurrentPolicy: false });
        if (res?.status) refreshAuthSectionUi(res.status, { syncPolicy: true });
        if (modalToken !== activeSettingsToken) return;
        if (res?.success) {
          showToast('Auf Standardpfad (data/admin-policy.json) zurückgesetzt.', { type: 'info' });
        } else {
          showToast(res?.error || 'Standardpfad konnte nicht gesetzt werden.', { type: 'error', duration: 6000 });
        }
      } finally {
        if (btn instanceof HTMLButtonElement && btn.isConnected) btn.disabled = false;
      }
    } else if (act === 'auth-lock-hklm') {
      const pathInp = getInputEl(modal, '#cfgAuthPolicyPath');
      const candidatePath = !currentAuthStatus?.isHklmLocked ? pathInp?.value.trim() || '' : '';
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      try {
        const res = await window.electronAPI.lockAuthPolicyInHklm(candidatePath);
        if (res?.status) refreshAuthSectionUi(res.status, { syncPolicy: true });
        if (modalToken !== activeSettingsToken) return;
        if (res?.success) {
          showToast('Policy-Pfad fest in HKLM-Registry gesperrt.', { type: 'success' });
        } else if (res?.canceled) {
          showToast('UAC-Abfrage abgebrochen - HKLM-Policy nicht gesetzt.', { type: 'info' });
        } else {
          showToast(res?.error || 'HKLM-Sperre konnte nicht gesetzt werden.', { type: 'error', duration: 6000 });
        }
      } finally {
        if (btn instanceof HTMLButtonElement && btn.isConnected) btn.disabled = false;
      }
    } else if (act === 'auth-unlock-hklm') {
      if (btn instanceof HTMLButtonElement) {
        if (btn.dataset.armed !== 'true') {
          btn.dataset.armed = 'true';
          btn.dataset.origText = btn.textContent || '';
          btn.textContent = '⚠️ Sperre wirklich aufheben?';
          setTimeout(() => {
            if (btn.isConnected && btn.dataset.armed === 'true') {
              btn.dataset.armed = 'false';
              btn.textContent = btn.dataset.origText || '🔓 HKLM-Sperre aufheben (Admin)';
            }
          }, 4000);
          return;
        }
        btn.dataset.armed = 'false';
        btn.disabled = true;
      }
      try {
        const res = await window.electronAPI.unlockAuthPolicyInHklm();
        if (res?.status) refreshAuthSectionUi(res.status, { syncPolicy: true });
        if (modalToken !== activeSettingsToken) return;
        if (res?.success) {
          showToast('HKLM-Policy-Sperre wurde entfernt.', { type: 'success' });
        } else if (res?.canceled) {
          showToast('UAC-Abfrage abgebrochen - HKLM-Sperre bleibt aktiv.', { type: 'info' });
        } else {
          showToast(res?.error || 'HKLM-Sperre konnte nicht aufgehoben werden.', { type: 'error', duration: 6000 });
        }
      } finally {
        if (btn instanceof HTMLButtonElement && btn.isConnected) btn.disabled = false;
      }
    } else if (act === 'toggle-admin-session') {
      if (currentAdminStatus?.mode === 'elevated' || currentAdminStatus?.isProcessElevated) return;
      const toggleBtn = modal.querySelector('#btnSettingsToggleAdminSession');
      if (toggleBtn instanceof HTMLButtonElement) toggleBtn.disabled = true;
      state.adminSessionBusy = true;
      renderAdminSessionButton();
      try {
        const isCurrentlyActive = currentAdminStatus?.mode === 'active' || currentAdminStatus?.isSessionActive;
        const res = isCurrentlyActive
          ? await window.electronAPI.stopAdminSession()
          : await window.electronAPI.startAdminSession();
        if (modalToken !== activeSettingsToken) return;

        if (res?.status) {
          currentAdminStatus = res.status;
          state.adminSession = { ...state.adminSession, ...res.status };
        }
        const meta = getAdminUiMeta(currentAdminStatus);
        const badgeEl = modal.querySelector('#settingsAdminStatusBadge');
        const descEl = modal.querySelector('#settingsAdminStatusDesc');
        if (badgeEl instanceof HTMLElement) {
          badgeEl.className = `admin-session-status-badge ${meta.badgeCls}`;
          badgeEl.textContent = meta.badgeText;
        }
        if (descEl instanceof HTMLElement) {
          descEl.textContent = meta.desc;
        }
        if (toggleBtn instanceof HTMLButtonElement) {
          toggleBtn.className = `btn ${meta.btnCls}`;
          toggleBtn.textContent = meta.btnText;
          toggleBtn.disabled = meta.btnDisabled;
        }

        if (isCurrentlyActive) {
          showToast('Admin-Sitzung wurde beendet.', { type: 'info' });
        } else if (res?.alreadyElevated) {
          showToast('App läuft bereits als Administrator.', { type: 'info' });
        } else if (res?.success) {
          showToast('Admin-Sitzung aktiv - weitere Updates laufen ohne UAC-Abfragen.', { type: 'success' });
        } else if (res?.canceled) {
          showToast('UAC-Abfrage abgebrochen - Admin-Modus bleibt aus.', { type: 'info' });
        } else {
          showToast(`Admin-Sitzung konnte nicht gestartet werden: ${res?.error || 'Unbekannter Fehler'}`, {
            type: 'error',
            duration: 6000,
          });
        }
      } finally {
        state.adminSessionBusy = false;
        renderAdminSessionButton();
      }
    } else if (act === 'browse-vcpkg-root') {
      const dir = await window.electronAPI.selectDir({
        title: 'VCPKG_ROOT Ordner auswählen',
        defaultPath: draftSettings.vcpkgRoot || undefined,
      });
      if (!dir || modalToken !== activeSettingsToken) return;
      draftSettings = {
        ...draftSettings,
        vcpkgRoot: dir.trim(),
      };
      const vcpkgInput = getInputEl(modal, '#cfgVcpkgRoot');
      if (vcpkgInput) vcpkgInput.value = draftSettings.vcpkgRoot;
      updateDirtyUi();
    } else if (act === 'recheck-providers') {
      await runProvidersAvailabilityCheck();
      showToast('Paketmanager-Status aktualisiert.', { type: 'info' });
    } else if (act === 'check-app-update') {
      await runAppUpdateCheck({ manual: true });
    } else if (act === 'open-github') window.electronAPI.openUrl('https://github.com/RaptorXilef/SoftwareKatalogApp');
    else if (act === 'open-data-dir') window.electronAPI.openPath(s.dataDir);
    else if (act === 'open-state') window.electronAPI.openPath(s.statePath);
    else if (act === 'add-archive-path') {
      const dir = await window.electronAPI.selectDir({ title: 'Archiv-Pfad hinzufügen' });
      if (!dir || modalToken !== activeSettingsToken) return;
      const newKey = normalizePathKey(dir);
      const duplicate = archiveItems.some(
        (item) => normalizePathKey(item.rawPath) === newKey || normalizePathKey(item.absPath) === newKey
      );
      if (duplicate) {
        showToast('Dieser Archiv-Pfad ist bereits in der Liste enthalten.', { type: 'info' });
        return;
      }
      const checked = await window.electronAPI.checkArchivePath(dir, archiveItems.length);
      if (modalToken !== activeSettingsToken) return;
      archiveItems.push({
        rawPath: dir,
        absPath: checked?.absPath || dir,
        label: checked?.label || getArchiveRootLabel(dir, archiveItems.length),
        online: checked?.online ?? true,
      });
      refreshArchivePathsUi();
    } else if (act === 'clear-provider-cache') {
      if (btn instanceof HTMLButtonElement) btn.disabled = true;
      const res = await window.electronAPI.clearProviderCache();
      if (res?.success) {
        const countEl = modal.querySelector('#providerCacheCount');
        if (countEl) countEl.textContent = '0 Einträge gespeichert';
        showToast('Provider-Cache wurde geleert.', { type: 'success' });
      } else {
        if (btn instanceof HTMLButtonElement) btn.disabled = false;
        showToast('Cache konnte nicht geleert werden.', { type: 'error' });
      }
    } else if (act === 'backup-create') {
      const res = await window.electronAPI.createBackup();
      if (res.success) showToast('Backup erfolgreich gespeichert.', { type: 'success' });
      else if (res.error) showToast(res.error, { type: 'error' });
    } else if (act === 'backup-restore') {
      const res = await window.electronAPI.restoreBackup();
      if (res.success) {
        closeModal();
        await triggerCatalogReload();
        showToast('Backup wiederhergestellt.', { type: 'success' });
      } else if (res.error) {
        showToast(res.error, { type: 'error' });
      }
    } else if (act === 'save') {
      syncDraftFromDom();
      const settingsChanged = hasSettingsDraftChanges(initialDraft, draftSettings);
      const policyChanged = hasPolicyDraftChanges();
      const plan = buildSettingsSavePlan(initialDraft, draftSettings, s.providerSettings);
      const saveBtn = modal.querySelector('#btnSettingsSave');
      if (saveBtn instanceof HTMLButtonElement) saveBtn.disabled = true;

      if (policyChanged) {
        const policyRes = await window.electronAPI.updateAccessPolicy(draftPolicy);
        if (modalToken !== activeSettingsToken) return;
        if (policyRes?.status) {
          refreshAuthSectionUi(policyRes.status, { syncPolicy: true });
        }
        if (!policyRes?.success) {
          if (saveBtn instanceof HTMLButtonElement && saveBtn.isConnected) saveBtn.disabled = false;
          showToast(policyRes?.error || 'Zugriffsrichtlinien konnten nicht gespeichert werden.', {
            type: 'error',
            duration: 6000,
          });
          return;
        }
      }

      if (settingsChanged) {
        const res = await window.electronAPI.saveSettings(plan.payload);
        if (modalToken !== activeSettingsToken) return;
        if (!res?.success) {
          if (saveBtn instanceof HTMLButtonElement && saveBtn.isConnected) saveBtn.disabled = false;
          showToast(`Speicherfehler: ${res?.error || 'Unbekannter Fehler'}`, { type: 'error' });
          return;
        }
      }

      closeModal();
      if (settingsChanged && plan.needsRescan) {
        showToast(
          policyChanged
            ? 'Einstellungen & Zugriffsrichtlinien gespeichert - aktualisiere Archiv...'
            : 'Einstellungen gespeichert - aktualisiere Archiv...',
          { type: 'info' }
        );
        await window.electronAPI.runScan('smart');
      } else if (policyChanged && settingsChanged) {
        showToast('Einstellungen & Zugriffsrichtlinien gespeichert.', { type: 'success' });
      } else if (policyChanged) {
        showToast('Zugriffsrichtlinien gespeichert.', { type: 'success' });
      } else {
        showToast('Einstellungen gespeichert.', { type: 'success' });
      }

      await triggerCatalogReload({
        rescanInstalled: settingsChanged && plan.rescanInstalled,
      });
    }
  };
}
