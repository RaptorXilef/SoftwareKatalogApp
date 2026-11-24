/**
 * @typedef {'pending' | 'running' | 'done' | 'error'} ScanSourceStatus
 * @typedef {'system' | 'provider'} ScanSourceKind
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   kind: ScanSourceKind,
 *   status: ScanSourceStatus,
 *   error: string,
 * }} ScanSourceItem
 *
 * @typedef {{
 *   active: boolean,
 *   phase: 'checking-providers' | 'scanning' | 'merging' | 'done',
 *   total: number,
 *   completed: number,
 *   percent: number | null,
 *   sources: ScanSourceItem[],
 *   startedAt: number,
 * }} ScanProgressState
 *
 * @typedef {{
 *   visible: boolean,
 *   headline: string,
 *   subtext: string,
 *   percent: number | null,
 *   indeterminate: boolean,
 *   completed: number,
 *   total: number,
 *   chips: ScanSourceItem[],
 * }} ScanProgressBannerModel
 */

/**
 * Erzeugt den initialen Fortschrittszustand fuer einen PC-/Provider-Scan.
 * @param {Array<{ id: string, label?: string, kind?: ScanSourceKind }>} [sources]
 * @param {{ startedAt?: number }} [options]
 * @returns {ScanProgressState}
 */
export function createScanProgressState(sources = [], { startedAt = Date.now() } = {}) {
  const seen = new Set();
  /** @type {ScanSourceItem[]} */
  const list = [];

  for (const raw of Array.isArray(sources) ? sources : []) {
    const id = String(raw?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = String(raw?.label || id).trim() || id;
    const kind = raw?.kind === 'system' ? 'system' : 'provider';
    list.push({
      id,
      label,
      kind,
      status: 'running',
      error: '',
    });
  }

  return {
    active: true,
    phase: 'scanning',
    total: list.length,
    completed: 0,
    percent: list.length > 0 ? 8 : null,
    sources: list,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
  };
}

/**
 * Markiert eine einzelne Quelle (z. B. Winget oder MS Store) als abgeschlossen oder fehlgeschlagen.
 * @param {ScanProgressState | null | undefined} state
 * @param {string} sourceId
 * @param {{ ok?: boolean, error?: string }} [outcome]
 * @returns {ScanProgressState}
 */
export function markScanSourceDone(state, sourceId, { ok = true, error = '' } = {}) {
  if (!state || typeof state !== 'object') {
    return createScanProgressState([]);
  }

  const targetId = String(sourceId || '').trim();
  const nextSources = (state.sources || []).map((src) => {
    if (src.id !== targetId) return { ...src };
    return {
      ...src,
      status: ok ? /** @type {ScanSourceStatus} */ ('done') : /** @type {ScanSourceStatus} */ ('error'),
      error: ok ? '' : String(error || '').trim(),
    };
  });

  const total = nextSources.length;
  const completed = nextSources.filter((src) => src.status === 'done' || src.status === 'error').length;
  const percent = total === 0 ? null : Math.min(90, Math.max(8, Math.round(10 + (completed / total) * 80)));

  return {
    ...state,
    total,
    completed,
    percent,
    sources: nextSources,
  };
}

/**
 * Wechselt in die abschliessende Abgleich-Phase mit dem lokalen Archiv.
 * @param {ScanProgressState} state
 * @returns {ScanProgressState}
 */
export function markScanPhaseMerging(state) {
  return {
    ...state,
    active: true,
    phase: 'merging',
    percent: 94,
  };
}

/**
 * Schliesst den Scan-Fortschritt vollstaendig ab.
 * @param {ScanProgressState} state
 * @returns {ScanProgressState}
 */
export function markScanFinished(state) {
  return {
    ...state,
    active: false,
    phase: 'done',
    percent: 100,
  };
}

/**
 * Formatiert eine natuerliche deutsche Aufzaehlung aktiver Quellen.
 * @param {string[]} labels
 * @returns {string}
 */
export function formatSourceNameList(labels) {
  const clean = (Array.isArray(labels) ? labels : []).map((l) => String(l || '').trim()).filter(Boolean);
  if (clean.length === 0) return '';
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} und ${clean[1]}`;
  if (clean.length === 3) return `${clean[0]}, ${clean[1]} und ${clean[2]}`;
  return `${clean[0]}, ${clean[1]} und ${clean.length - 2} weitere Quellen`;
}

/**
 * Berechnet die UI-Anzeige (Headline, Untertitel, Fortschritt, Chips) fuer den Live-Scan-Banner.
 * @param {ScanProgressState | null | undefined} progressState
 * @param {{ tab?: string, isCheckingProviders?: boolean }} [options]
 * @returns {ScanProgressBannerModel}
 */
export function formatScanProgressBanner(progressState, { tab = 'updates', isCheckingProviders = false } = {}) {
  if (isCheckingProviders && !progressState?.active) {
    return {
      visible: true,
      headline: 'Prüfe aktive Paketmanager...',
      subtext: 'Ermittle verfügbare Update-Quellen',
      percent: null,
      indeterminate: true,
      completed: 0,
      total: 0,
      chips: [],
    };
  }

  if (!progressState?.active) {
    return {
      visible: false,
      headline: '',
      subtext: '',
      percent: null,
      indeterminate: false,
      completed: 0,
      total: 0,
      chips: [],
    };
  }

  const allSources = Array.isArray(progressState.sources) ? progressState.sources : [];
  const providerSources = allSources.filter((s) => s.kind === 'provider');
  const systemSources = allSources.filter((s) => s.kind === 'system');
  const chips = [...providerSources, ...systemSources];

  if (progressState.phase === 'merging') {
    const headline =
      tab === 'installed'
        ? 'Verknüpfe installierte Programme mit dem Archiv...'
        : 'Vergleiche gefundene Updates mit dem Archiv...';
    const subtext =
      progressState.total > 0 ? `${progressState.completed} / ${progressState.total} Quellen geprüft` : 'Läuft...';
    return {
      visible: true,
      headline,
      subtext,
      percent: 94,
      indeterminate: false,
      completed: progressState.completed,
      total: progressState.total,
      chips,
    };
  }

  const runningProviders = providerSources.filter((s) => s.status === 'running');
  const runningSystem = systemSources.filter((s) => s.status === 'running');

  let headline = 'Update-Informationen werden verarbeitet...';
  if (runningProviders.length === 1) {
    headline =
      tab === 'installed'
        ? `${runningProviders[0].label} wird eingelesen...`
        : `${runningProviders[0].label} wird auf Updates geprüft...`;
  } else if (runningProviders.length >= 2) {
    const names = formatSourceNameList(runningProviders.map((s) => s.label));
    headline = tab === 'installed' ? `${names} werden eingelesen...` : `${names} werden auf Updates geprüft...`;
  } else if (runningSystem.length > 0) {
    headline =
      tab === 'installed'
        ? 'Installierte PC-Programme werden eingelesen...'
        : 'Installierte PC-Programme werden auf Updates geprüft...';
  }

  const subtext =
    progressState.total > 0
      ? `${progressState.completed} von ${progressState.total} Quellen abgeschlossen`
      : 'Läuft...';
  const percent = typeof progressState.percent === 'number' ? progressState.percent : null;

  return {
    visible: true,
    headline,
    subtext,
    percent,
    indeterminate: percent === null,
    completed: progressState.completed,
    total: progressState.total,
    chips,
  };
}
