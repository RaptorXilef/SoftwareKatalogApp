const GUID_REGEX = /\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?/;

/**
 * Normalisiert einen MSI-ProductCode auf das kanonische `{GUID}`-Format in Großbuchstaben.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeMsiProductCode(raw) {
  if (typeof raw !== 'string') return '';
  const match = raw.match(GUID_REGEX);
  if (!match) return '';
  return `{${match[1].toUpperCase()}}`;
}

/**
 * Prüft, ob ein Wert einen gültigen MSI-ProductCode darstellt.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isMsiProductCode(raw) {
  return Boolean(normalizeMsiProductCode(raw));
}

/**
 * Extrahiert den MSI-ProductCode aus einem Registry-Uninstall-Eintrag.
 * @param {Record<string, any> | null | undefined} entry
 * @returns {string}
 */
export function extractMsiProductCodeFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const candidates = [
    entry.productCode,
    entry.registryKey,
    entry.PSChildName,
    entry.uninstallString,
    entry.UninstallString,
    entry.quietUninstallString,
    entry.QuietUninstallString,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeMsiProductCode(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function msiEntryRichnessScore(entry) {
  let score = 0;
  if (entry.quietUninstallString) score += 4;
  if (entry.uninstallString) score += 3;
  if (entry.displayIcon) score += 2;
  if (entry.installLocation) score += 2;
  if (entry.publisher) score += 1;
  return score;
}

/**
 * Filtert und normalisiert Registry-Uninstall-Einträge auf echte MSI-Pakete (`WindowsInstaller == 1`).
 * @param {Array<Record<string, any>>} entries
 * @param {{ includeSystemComponents?: boolean }} [options]
 */
export function parseMsiRegistryEntries(entries, { includeSystemComponents = false } = {}) {
  const byCode = new Map();

  for (const raw of entries || []) {
    if (!raw || typeof raw !== 'object') continue;
    const wiFlag = Number(raw.windowsInstaller ?? raw.WindowsInstaller ?? 0);
    if (wiFlag !== 1) continue;

    const name = String(raw.displayName ?? raw.DisplayName ?? '').trim();
    if (!name) continue;

    const systemComponent = Number(raw.systemComponent ?? raw.SystemComponent ?? 0);
    const parentKeyName = String(raw.parentKeyName ?? raw.ParentKeyName ?? '').trim();
    if (!includeSystemComponents && (systemComponent === 1 || parentKeyName)) {
      continue;
    }

    const productCode = extractMsiProductCodeFromEntry(raw);
    if (!productCode) continue;

    const version = String(raw.displayVersion ?? raw.DisplayVersion ?? '').trim();
    const publisher = String(raw.publisher ?? raw.Publisher ?? '').trim();
    const installLocation = String(raw.installLocation ?? raw.InstallLocation ?? '').trim();
    const displayIcon = String(raw.displayIcon ?? raw.DisplayIcon ?? '').trim();
    const uninstallString =
      String(raw.uninstallString ?? raw.UninstallString ?? '').trim() || `msiexec.exe /X${productCode}`;
    const quietUninstallString =
      String(raw.quietUninstallString ?? raw.QuietUninstallString ?? '').trim() ||
      `msiexec.exe /X${productCode} /qn /norestart`;
    const registryKey = String(raw.registryKey ?? raw.PSChildName ?? productCode).trim();

    const item = {
      packageManager: 'msi',
      packageId: productCode,
      id: productCode,
      productCode,
      name,
      version,
      installedVersion: version,
      publisher,
      installLocation,
      displayIcon,
      uninstallString,
      quietUninstallString,
      registryKey,
      windowsInstaller: 1,
      source: 'msi',
      canUninstall: true,
    };

    const existing = byCode.get(productCode);
    if (!existing || msiEntryRichnessScore(item) > msiEntryRichnessScore(existing)) {
      byCode.set(productCode, item);
    }
  }

  return [...byCode.values()];
}

/**
 * Erzeugt sichere `msiexec.exe`-Argumente zur Deinstallation anhand einer MSI-GUID.
 * @param {string} productCode
 * @param {{ silent?: boolean }} [options]
 * @returns {string[] | null}
 */
export function buildMsiUninstallArgs(productCode, { silent = false } = {}) {
  const normalized = normalizeMsiProductCode(productCode);
  if (!normalized) return null;
  return silent ? ['/x', normalized, '/qn', '/norestart'] : ['/x', normalized];
}

/**
 * Erzeugt sichere `msiexec.exe`-Argumente zur Installation einer lokalen `.msi`-Datei.
 * @param {string} msiFilePath
 * @param {{ silent?: boolean }} [options]
 * @returns {string[] | null}
 */
export function buildMsiInstallArgs(msiFilePath, { silent = false } = {}) {
  const cleanPath = String(msiFilePath || '').trim();
  if (!cleanPath || !/\.msi$/i.test(cleanPath)) return null;
  return silent ? ['/i', cleanPath, '/qn', '/norestart'] : ['/i', cleanPath];
}
