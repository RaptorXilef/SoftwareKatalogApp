import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { detectInstallerFile } from '../src/main/installer-detector.js';
import {
  DETAIL_SILENT_LOCK_TOOLTIP,
  detectAdwareSignals,
  detectInstallerFromBuffer,
  getInstallModeBadge,
  normalizeInstallMode,
  resolveDetailInstallMode,
  resolveInstallExecutionPlan,
  sanitizeInnoInfFileName,
  sanitizeSilentArgs,
} from '../src/shared/installer-logic.js';

describe('installer-logic: Installer-Typ-Erkennung', () => {
  it('erkennt .msi direkt anhand der Dateiendung', () => {
    const res = detectInstallerFromBuffer('7z2409-x64.msi', null);
    assert.equal(res.type, 'msi');
    assert.equal(res.suggestedArgs, '/qn /norestart');
    assert.equal(res.supportsInf, false);
  });

  it('erkennt Inno Setup (ASCII und UTF-16LE Marker) inkl. .inf-Hinweis', () => {
    const asciiBuf = Buffer.from('MZ...Inno Setup Setup Data (6.2.0)...', 'latin1');
    const resAscii = detectInstallerFromBuffer('setup.exe', asciiBuf);
    assert.equal(resAscii.type, 'inno');
    assert.equal(resAscii.suggestedArgs, '/VERYSILENT /NORESTART /SP-');
    assert.equal(resAscii.supportsInf, true);

    const utf16Buf = Buffer.from('Inno Setup Messages', 'utf16le');
    const resUtf16 = detectInstallerFromBuffer('app-installer.exe', utf16Buf);
    assert.equal(resUtf16.type, 'inno');
    assert.equal(resUtf16.suggestedArgs, '/VERYSILENT /NORESTART /SP-');
  });

  it('erkennt NSIS, WiX Burn, InstallShield und unbekannte Setups', () => {
    const nsis = detectInstallerFromBuffer('vlc-setup.exe', Buffer.from('...Nullsoft.NSIS.exehead...', 'latin1'));
    assert.equal(nsis.type, 'nsis');
    assert.equal(nsis.suggestedArgs, '/S');

    const wix = detectInstallerFromBuffer(
      'dotnet-sdk.exe',
      Buffer.from('...WixStandardBootstrapperApplication...', 'latin1')
    );
    assert.equal(wix.type, 'wix');
    assert.equal(wix.suggestedArgs, '/quiet /norestart');

    const installShield = detectInstallerFromBuffer('driver.exe', Buffer.from('...ISSetupStream...', 'latin1'));
    assert.equal(installShield.type, 'installshield');
    assert.equal(installShield.suggestedArgs, '');
    assert.match(installShield.hint, /manuell/i);

    const unknown = detectInstallerFromBuffer('custom.exe', Buffer.from('MZ...random binary...', 'latin1'));
    assert.equal(unknown.type, 'unknown');
    assert.equal(unknown.suggestedArgs, '');
  });

  it('detectInstallerFile liest reale Temp-Dateien sicher ohne Ausführung', async () => {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sk-detector-'));
    try {
      const nsisFile = path.join(tmpDir, 'notepadpp_installer.exe');
      await fs.promises.writeFile(nsisFile, Buffer.from('MZ\x90\x00...NullsoftInst...', 'latin1'));

      const msiFile = path.join(tmpDir, 'package.msi');
      await fs.promises.writeFile(msiFile, Buffer.from('dummy msi', 'latin1'));

      const resNsis = await detectInstallerFile(nsisFile, { name: 'Notepad++' });
      assert.equal(resNsis.success, true);
      assert.equal(resNsis.type, 'nsis');
      assert.equal(resNsis.suggestedArgs, '/S');
      assert.equal(resNsis.adwareWarning.flagged, false);

      const resMsi = await detectInstallerFile(msiFile, { name: '7-Zip' });
      assert.equal(resMsi.success, true);
      assert.equal(resMsi.type, 'msi');
      assert.equal(resMsi.suggestedArgs, '/qn /norestart');

      const missing = await detectInstallerFile(path.join(tmpDir, 'nicht-da.exe'));
      assert.equal(missing.success, false);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('installer-logic: Adware-Heuristik', () => {
  it('warnt bei typischen Adware-Wrapper-Namen und PE-Markern', () => {
    for (const candidate of [
      { name: 'IObit Uninstaller' },
      { name: 'Driver Booster 12' },
      { name: 'CCleaner Free' },
      { name: 'µTorrent' },
      { name: 'DAEMON Tools Lite' },
      { fileName: 'chip-installer-vlc.exe' },
    ]) {
      const warn = detectAdwareSignals(candidate);
      assert.equal(warn.flagged, true, `Erwartete Warnung für ${JSON.stringify(candidate)}`);
      assert.equal(warn.recommendedMode, 'interactive-required');
    }

    const peWarn = detectAdwareSignals({
      name: 'Harmloses Tool',
      buffer: Buffer.from('...OpenCandy_Setup_Offer...', 'latin1'),
    });
    assert.equal(peWarn.flagged, true);
    assert.equal(peWarn.matchedLabel, 'OpenCandy');
  });

  it('meldet keine Fehlalarme bei sauberen Standardprogrammen', () => {
    for (const clean of [
      { name: 'VLC media player', fileName: 'vlc-3.0.21-win64.exe', packageId: 'VideoLAN.VLC' },
      { name: '7-Zip', fileName: '7z2409-x64.msi', packageId: '7zip.7zip' },
      { name: 'Notepad++', fileName: 'npp.8.7.Installer.x64.exe', packageId: 'Notepad++.Notepad++' },
      { name: 'Visual Studio Code', fileName: 'VSCodeUserSetup-x64.exe', packageId: 'Microsoft.VisualStudioCode' },
    ]) {
      const warn = detectAdwareSignals(clean);
      assert.equal(warn.flagged, false, `Kein Fehlalarm erwartet für ${clean.name}`);
      assert.equal(warn.recommendedMode, null);
    }
  });
});

describe('installer-logic: interactive-required Sperre & Ausführungsplan', () => {
  it('ignoriert bei interactive-required IMMER sämtliche Silent-Parameter und .inf-Dateien', () => {
    const plan = resolveInstallExecutionPlan({
      installMode: 'interactive-required',
      silentArgs: '/VERYSILENT /NORESTART /SP-',
      innoInfPath: 'C:\\Temp\\silent.inf',
      ext: '.exe',
      allowSilent: true,
    });

    assert.equal(plan.mode, 'interactive-required');
    assert.equal(plan.effectiveSilent, false);
    assert.equal(plan.adwareProtected, true);
    assert.equal(plan.usedInf, false);
    assert.equal(plan.extraArgs, '');
    assert.match(plan.bannerHint, /🛡️ Interaktiv \(Adware-Schutz\)/);
  });

  it('hält interactive als Standard auch bei allowSilent=true und gesetzten silentArgs interaktiv', () => {
    const plan = resolveInstallExecutionPlan({
      installMode: 'interactive',
      silentArgs: '/S',
      allowSilent: true,
    });

    assert.equal(plan.effectiveSilent, false);
    assert.equal(plan.adwareProtected, false);
    assert.equal(plan.extraArgs, '');
  });

  it('bleibt bei silent ohne allowSilent oder ohne silentArgs interaktiv (opt-in)', () => {
    const noAllow = resolveInstallExecutionPlan({
      installMode: 'silent',
      silentArgs: '/S',
      allowSilent: false,
    });
    assert.equal(noAllow.effectiveSilent, false);
    assert.equal(noAllow.extraArgs, '');

    const noArgs = resolveInstallExecutionPlan({
      installMode: 'silent',
      silentArgs: '   ',
      allowSilent: true,
    });
    assert.equal(noArgs.effectiveSilent, false);
    assert.equal(noArgs.extraArgs, '');
  });

  it('aktiviert silent nur mit allowSilent=true und gesetzten silentArgs und hängt /LOADINF an', () => {
    const plan = resolveInstallExecutionPlan({
      installMode: 'silent',
      silentArgs: '/VERYSILENT /NORESTART /SP-',
      innoInfPath: 'C:\\Temp\\silent.inf',
      allowSilent: true,
    });

    assert.equal(plan.effectiveSilent, true);
    assert.equal(plan.adwareProtected, false);
    assert.equal(plan.usedInf, true);
    assert.equal(plan.extraArgs, '/VERYSILENT /NORESTART /SP- /LOADINF="C:\\Temp\\silent.inf"');

    const alreadyHasLoadInf = resolveInstallExecutionPlan({
      installMode: 'silent',
      silentArgs: '/VERYSILENT /LOADINF="custom.inf"',
      innoInfPath: 'C:\\Temp\\silent.inf',
      allowSilent: true,
    });
    assert.equal(alreadyHasLoadInf.usedInf, false);
    assert.equal(alreadyHasLoadInf.extraArgs, '/VERYSILENT /LOADINF="custom.inf"');
  });

  it('erzeugt im Inno-Aufzeichnungsmodus immer interaktives /SAVEINF', () => {
    const plan = resolveInstallExecutionPlan({
      installMode: 'interactive-required',
      silentArgs: '/VERYSILENT',
      allowSilent: true,
      recordInfPath: 'C:\\Temp\\sk_saveinf.inf',
    });

    assert.equal(plan.effectiveSilent, false);
    assert.equal(plan.isRecordingInf, true);
    assert.equal(plan.extraArgs, '/SAVEINF="C:\\Temp\\sk_saveinf.inf"');
  });
});

describe('installer-logic: Sanitizer & UI-Badges', () => {
  it('bereinigt Modi, Parameter und .inf-Dateinamen sicher', () => {
    assert.equal(normalizeInstallMode('silent'), 'silent');
    assert.equal(normalizeInstallMode('interactive-required'), 'interactive-required');
    assert.equal(normalizeInstallMode('ungültig'), 'interactive');

    assert.equal(sanitizeSilentArgs(' /S \n /D=C:\\App  '), '/S /D=C:\\App');
    assert.equal(sanitizeInnoInfFileName('silent.inf'), 'silent.inf');
    assert.equal(sanitizeInnoInfFileName('..\\..\\evil.inf'), '');
    assert.equal(sanitizeInnoInfFileName('C:\\foo\\custom.INF'), 'custom.INF');
    assert.equal(sanitizeInnoInfFileName('not-an-inf.txt'), '');
  });

  it('liefert passende UI-Badges für Silent und Interaktiv-Schutz', () => {
    assert.equal(getInstallModeBadge({ installMode: 'interactive', silentArgs: '/S' }), null);
    assert.equal(getInstallModeBadge({ installMode: 'silent', silentArgs: '' }), null);

    const silentBadge = getInstallModeBadge({ installMode: 'silent', silentArgs: '/S' });
    assert.equal(silentBadge.type, 'silent');
    assert.equal(silentBadge.label, '⚡ Silent');

    const protBadge = getInstallModeBadge({ installMode: 'interactive-required', silentArgs: '/S' });
    assert.equal(protBadge.type, 'protected');
    assert.equal(protBadge.label, '🛡️ Interaktiv-Schutz');
  });

  it('steuert Detail-Modal-Vorauswahl und Adware-Schutz-Sperre (resolveDetailInstallMode)', () => {
    const defSilent = resolveDetailInstallMode('silent');
    assert.deepEqual(defSilent, {
      selected: 'silent',
      silent: true,
      silentLocked: false,
      lockTooltip: '',
    });

    const defInteractive = resolveDetailInstallMode('interactive');
    assert.deepEqual(defInteractive, {
      selected: 'interactive',
      silent: false,
      silentLocked: false,
      lockTooltip: '',
    });

    const toggledSilent = resolveDetailInstallMode('interactive', 'silent');
    assert.equal(toggledSilent.selected, 'silent');
    assert.equal(toggledSilent.silent, true);
    assert.equal(toggledSilent.silentLocked, false);

    const locked = resolveDetailInstallMode('interactive-required', 'silent');
    assert.deepEqual(locked, {
      selected: 'interactive',
      silent: false,
      silentLocked: true,
      lockTooltip: DETAIL_SILENT_LOCK_TOOLTIP,
    });
  });

  it('unterstützt explizites forceSilent im Detail-Modal, blockiert aber interactive-required strikt', () => {
    const msiForced = resolveInstallExecutionPlan({
      installMode: 'interactive',
      silentArgs: '',
      ext: '.msi',
      allowSilent: true,
      forceSilent: true,
    });
    assert.equal(msiForced.effectiveSilent, true);
    assert.equal(msiForced.extraArgs, '/qn /norestart');

    const exeForced = resolveInstallExecutionPlan({
      installMode: 'interactive',
      silentArgs: '/S',
      ext: '.exe',
      allowSilent: true,
      forceSilent: true,
    });
    assert.equal(exeForced.effectiveSilent, true);
    assert.equal(exeForced.extraArgs, '/S');

    const lockedForced = resolveInstallExecutionPlan({
      installMode: 'interactive-required',
      silentArgs: '/S',
      ext: '.exe',
      allowSilent: true,
      forceSilent: true,
    });
    assert.equal(lockedForced.effectiveSilent, false);
    assert.equal(lockedForced.adwareProtected, true);
    assert.equal(lockedForced.extraArgs, '');
  });
});
