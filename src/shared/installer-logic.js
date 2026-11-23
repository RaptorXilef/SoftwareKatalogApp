export const INSTALL_MODES = Object.freeze(['interactive', 'silent', 'interactive-required']);

export const INSTALLER_TYPE_PRESETS = Object.freeze({
  msi: Object.freeze({
    type: 'msi',
    label: 'Windows Installer (MSI)',
    suggestedArgs: '/qn /norestart',
    supportsInf: false,
    hint: 'Standard-MSI-Parameter für stille Installation ohne Neustart.',
  }),
  inno: Object.freeze({
    type: 'inno',
    label: 'Inno Setup',
    suggestedArgs: '/VERYSILENT /NORESTART /SP-',
    supportsInf: true,
    hint: 'Hinweis: Unterstützt eine .inf-Antwortdatei (/LOADINF), um deine Setup-Häkchen einmalig sauber aufzuzeichnen.',
  }),
  nsis: Object.freeze({
    type: 'nsis',
    label: 'NSIS (Nullsoft)',
    suggestedArgs: '/S',
    supportsInf: false,
    hint: 'Bei NSIS ist Groß-/Kleinschreibung wichtig (/S muss großgeschrieben werden).',
  }),
  wix: Object.freeze({
    type: 'wix',
    label: 'WiX Burn',
    suggestedArgs: '/quiet /norestart',
    supportsInf: false,
    hint: 'WiX Burn Bootstrapper-Parameter für stille Installation ohne Neustart.',
  }),
  installshield: Object.freeze({
    type: 'installshield',
    label: 'InstallShield',
    suggestedArgs: '',
    supportsInf: false,
    hint: 'InstallShield erfordert meist eine herstellerspezifische .iss-Antwortdatei – Parameter bitte manuell prüfen.',
  }),
  unknown: Object.freeze({
    type: 'unknown',
    label: 'Unbekannt',
    suggestedArgs: '',
    supportsInf: false,
    hint: 'Installer-Typ nicht eindeutig erkannt – Parameter bitte manuell prüfen oder interaktiv lassen.',
  }),
});

const INSTALLER_SIGNATURES = [
  {
    type: 'inno',
    markers: [
      'Inno Setup Setup Data',
      'Inno Setup Messages',
      'InnoSetupLdrWindow',
      'JR.Inno.Setup',
      '<description>Inno Setup</description>',
      'Inno Setup',
    ],
  },
  {
    type: 'nsis',
    markers: ['Nullsoft.NSIS.exehead', 'Nullsoft Install System', 'NullsoftInst', 'NSIS Error'],
  },
  {
    type: 'wix',
    markers: ['.wixburn', 'WixStandardBootstrapperApplication', 'WixBundle', 'WiX Toolset'],
  },
  {
    type: 'installshield',
    markers: ['InstallShield Wizard', 'ISSetupStream', 'InstallShield'],
  },
];

const ADWARE_TEXT_PATTERNS = [
  { label: 'IObit', pattern: /\biobit\b/i },
  { label: 'Driver Booster', pattern: /\bdriver\s*booster\b/i },
  { label: 'Advanced SystemCare', pattern: /\badvanced\s*systemcare\b/i },
  { label: 'Smart Defrag', pattern: /\bsmart\s*defrag\b/i },
  { label: 'CCleaner', pattern: /\bccleaner\b/i },
  { label: 'Piriform-Suite', pattern: /\b(?:recuva|defraggler|speccy|piriform)\b/i },
  { label: 'µTorrent / BitTorrent', pattern: /(?:^|[^a-z0-9])(?:utorrent|[µμ]torrent|bittorrent)(?:$|[^a-z0-9])/i },
  { label: 'DAEMON Tools', pattern: /\bdaemon\s*tools\b/i },
  { label: 'Driver-Updater-Wrapper', pattern: /\bdriver\s*(?:easy|pack|updater|fix)\b/i },
  { label: 'ImgBurn', pattern: /\bimgburn\b/i },
  { label: 'CDBurnerXP', pattern: /\bcdburnerxp\b/i },
  { label: 'Cheat Engine', pattern: /\bcheat\s*engine\b/i },
  { label: 'PDFCreator', pattern: /\bpdfcreator\b/i },
  { label: 'Download-Portal-Wrapper', pattern: /\b(?:softonic|chip[-_\s]*installer|cnet[-_\s]*download)\b/i },
  { label: 'FileZilla Sponsored', pattern: /\bfilezilla\b.*\bsponsor/i },
];

const ADWARE_PE_MARKERS = ['OpenCandy', 'InstallCore', 'InstallIQ', 'FusionInstaller', 'InstallMonetizer'];

/**
 * Normalisiert den Installationsmodus auf einen der drei erlaubten Werte.
 */
export function normalizeInstallMode(mode) {
  if (mode === 'silent' || mode === 'interactive-required') return mode;
  return 'interactive';
}

/**
 * Bereinigt benutzerdefinierte Silent-Parameter einzeilig.
 */
export function sanitizeSilentArgs(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bereinigt den Dateinamen einer .inf-Antwortdatei im _metadata/-Ordner.
 */
export function sanitizeInnoInfFileName(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed || trimmed.includes('..')) return '';
  const base = trimmed.split('\\').pop().split('/').pop().trim();
  if (!base || base.includes('..') || !/\.inf$/i.test(base)) return '';
  return base;
}

function toSearchableStrings(buffer) {
  if (!buffer) return null;
  let rawLatin1;
  if (typeof buffer === 'string') {
    rawLatin1 = buffer;
  } else if (Buffer.isBuffer(buffer)) {
    rawLatin1 = buffer.toString('latin1');
  } else if (buffer instanceof Uint8Array) {
    rawLatin1 = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString('latin1');
  } else {
    return null;
  }

  const collapsed = rawLatin1.replace(/\0/g, '');
  return {
    rawLower: rawLatin1.toLowerCase(),
    collapsedLower: collapsed.toLowerCase(),
  };
}

/**
 * Erkennt den Installer-Typ anhand Dateiendung und PE-Strings/Metadaten-Markern ohne Ausführung.
 */
export function detectInstallerFromBuffer(fileName = '', buffer = null) {
  const lowerName = String(fileName || '')
    .trim()
    .toLowerCase();

  if (lowerName.endsWith('.msi')) {
    return { ...INSTALLER_TYPE_PRESETS.msi, matchedSignature: 'extension:.msi' };
  }

  const searchable = toSearchableStrings(buffer);
  if (searchable) {
    for (const sig of INSTALLER_SIGNATURES) {
      for (const marker of sig.markers) {
        const needle = marker.toLowerCase();
        if (searchable.rawLower.includes(needle) || searchable.collapsedLower.includes(needle)) {
          return { ...INSTALLER_TYPE_PRESETS[sig.type], matchedSignature: marker };
        }
      }
    }
  }

  return { ...INSTALLER_TYPE_PRESETS.unknown, matchedSignature: null };
}

/**
 * Prüft Name, Dateiname, Paket-ID, Herausgeber und optional PE-Strings auf bekannte Adware-Wrapper.
 */
export function detectAdwareSignals({ name = '', fileName = '', packageId = '', publisher = '', buffer = null } = {}) {
  const combinedText = [name, fileName, packageId, publisher].filter(Boolean).join(' ');

  if (combinedText) {
    for (const entry of ADWARE_TEXT_PATTERNS) {
      if (entry.pattern.test(combinedText)) {
        return {
          flagged: true,
          matchedLabel: entry.label,
          reason: `Bekannter Adware-/Bundle-Kandidat erkannt (${entry.label}). Empfohlen wird „Immer Interaktiv (Adware-Schutz)“, damit Zusatzangebote im Setup sicher abgewählt werden können.`,
          recommendedMode: 'interactive-required',
        };
      }
    }
  }

  const searchable = toSearchableStrings(buffer);
  if (searchable) {
    for (const marker of ADWARE_PE_MARKERS) {
      const needle = marker.toLowerCase();
      if (searchable.rawLower.includes(needle) || searchable.collapsedLower.includes(needle)) {
        return {
          flagged: true,
          matchedLabel: marker,
          reason: `Verdächtiger Adware-Wrapper-Marker in Setup-Datei erkannt (${marker}). Empfohlen wird „Immer Interaktiv (Adware-Schutz)“.`,
          recommendedMode: 'interactive-required',
        };
      }
    }
  }

  return {
    flagged: false,
    matchedLabel: null,
    reason: '',
    recommendedMode: null,
  };
}

/**
 * Ermittelt den sicheren Ausführungsplan für ein Setup.
 * `interactive-required` erzwingt immer interaktive Ausführung und ignoriert sämtliche Silent-Parameter.
 */
export function resolveInstallExecutionPlan({
  installMode = 'interactive',
  silentArgs = '',
  innoInfPath = '',
  ext = '.exe',
  allowSilent = false,
  recordInfPath = '',
} = {}) {
  const mode = normalizeInstallMode(installMode);
  const cleanArgs = sanitizeSilentArgs(silentArgs);
  const cleanInfPath = String(innoInfPath || '').trim();
  const cleanRecordPath = String(recordInfPath || '').trim();
  void ext;

  if (cleanRecordPath) {
    return {
      mode,
      effectiveSilent: false,
      adwareProtected: mode === 'interactive-required',
      isRecordingInf: true,
      usedInf: false,
      extraArgs: `/SAVEINF="${cleanRecordPath}"`,
      bannerHint: '📝 Zeichne Inno-Antwortdatei (.inf) auf - bitte Optionen im Setup wählen...',
    };
  }

  if (mode === 'interactive-required') {
    return {
      mode,
      effectiveSilent: false,
      adwareProtected: true,
      isRecordingInf: false,
      usedInf: false,
      extraArgs: '',
      bannerHint: '🛡️ Interaktiv (Adware-Schutz) - Silent-Parameter ignoriert, Setup bitte manuell prüfen...',
    };
  }

  if (mode === 'silent' && allowSilent === true && cleanArgs.length > 0) {
    let extraArgs = cleanArgs;
    let usedInf = false;

    if (cleanInfPath && !/\/LOADINF=/i.test(extraArgs)) {
      extraArgs = `${extraArgs} /LOADINF="${cleanInfPath}"`;
      usedInf = true;
    }

    return {
      mode,
      effectiveSilent: true,
      adwareProtected: false,
      isRecordingInf: false,
      usedInf,
      extraArgs,
      bannerHint: usedInf
        ? '⚡ Stille Installation läuft (mit .inf-Antwortdatei)...'
        : '⚡ Stille Installation läuft...',
    };
  }

  return {
    mode,
    effectiveSilent: false,
    adwareProtected: false,
    isRecordingInf: false,
    usedInf: false,
    extraArgs: '',
    bannerHint: 'Installer läuft - bitte Setup-Assistent abschließen...',
  };
}

/**
 * Liefert ein UI-Badge für Detail-Modal und Massen-Updates, falls Silent oder Adware-Schutz konfiguriert ist.
 */
export function getInstallModeBadge(item) {
  if (!item) return null;
  if (item.installMode === 'interactive-required') {
    return {
      type: 'protected',
      label: '🛡️ Interaktiv-Schutz',
      title: 'Immer interaktiv (Adware-Schutz) – Silent-Parameter werden immer ignoriert',
    };
  }
  const cleanArgs = sanitizeSilentArgs(item.silentArgs);
  if (item.installMode === 'silent' && cleanArgs) {
    return {
      type: 'silent',
      label: '⚡ Silent',
      title: `Stille Installation konfiguriert: ${cleanArgs}`,
    };
  }
  return null;
}
