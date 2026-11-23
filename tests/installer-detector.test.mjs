import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { detectInstallerFile } from '../src/main/installer-detector.js';
import { planBundleExecution } from '../src/shared/bundles-logic.js';
import {
  detectAdwareSignals,
  detectInstallerFromBuffer,
  resolveInstallExecutionPlan,
} from '../src/shared/installer-logic.js';

describe('installer-detector: Typ-Erkennung & Adware-Heuristik', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sk-inst-det-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it('erkennt .msi, Inno Setup, NSIS und WiX Burn aus realen Dateien', async () => {
    const msiPath = path.join(tempDir, '7z2606-x64.msi');
    const innoPath = path.join(tempDir, 'inno-setup.exe');
    const nsisPath = path.join(tempDir, 'nsis-setup.exe');
    const wixPath = path.join(tempDir, 'wix-bundle.exe');

    await fs.promises.writeFile(msiPath, Buffer.from('MSI binary header', 'latin1'));
    await fs.promises.writeFile(innoPath, Buffer.from('MZ...Inno Setup Setup Data (6.3.0)...', 'latin1'));
    await fs.promises.writeFile(nsisPath, Buffer.from('MZ...Nullsoft.NSIS.exehead...', 'latin1'));
    await fs.promises.writeFile(wixPath, Buffer.from('MZ...WixStandardBootstrapperApplication...', 'latin1'));

    const msi = await detectInstallerFile(msiPath, { name: '7-Zip' });
    assert.equal(msi.success, true);
    assert.equal(msi.type, 'msi');
    assert.equal(msi.suggestedArgs, '/qn /norestart');

    const inno = await detectInstallerFile(innoPath, { name: 'Inno App' });
    assert.equal(inno.type, 'inno');
    assert.equal(inno.suggestedArgs, '/VERYSILENT /NORESTART /SP-');
    assert.equal(inno.supportsInf, true);

    const nsis = await detectInstallerFile(nsisPath, { name: 'NSIS App' });
    assert.equal(nsis.type, 'nsis');
    assert.equal(nsis.suggestedArgs, '/S');

    const wix = await detectInstallerFile(wixPath, { name: 'WiX App' });
    assert.equal(wix.type, 'wix');
    assert.equal(wix.suggestedArgs, '/quiet /norestart');

    const bufDirect = detectInstallerFromBuffer('setup.exe', Buffer.from('NullsoftInst', 'latin1'));
    assert.equal(bufDirect.type, 'nsis');
  });

  it('warnt zuverlässig bei Adware-Kandidaten (z. B. IObit Uninstaller) und schont saubere Installer', async () => {
    const iobitFile = path.join(tempDir, 'iobit-uninstaller-setup.exe');
    await fs.promises.writeFile(iobitFile, Buffer.from('MZ...Inno Setup Setup Data...', 'latin1'));

    const iobitRes = await detectInstallerFile(iobitFile, { name: 'IObit Uninstaller' });
    assert.equal(iobitRes.adwareWarning.flagged, true);
    assert.equal(iobitRes.adwareWarning.matchedLabel, 'IObit');
    assert.equal(iobitRes.adwareWarning.recommendedMode, 'interactive-required');

    const openCandy = detectAdwareSignals({
      name: 'Generic Tool',
      buffer: Buffer.from('...OpenCandy_Offer...', 'latin1'),
    });
    assert.equal(openCandy.flagged, true);

    const clean = detectAdwareSignals({
      name: 'VLC Media Player',
      fileName: 'vlc-3.0.24-win64.exe',
      packageId: 'VideoLAN.VLC',
    });
    assert.equal(clean.flagged, false);
  });
});

describe('installer-detector: Strikte interactive-required-Sperre bei Batch & Bündeln', () => {
  it('unterdrückt Silent-Flags und .inf bei interactive-required auch wenn allowSilent=true gefordert wird', () => {
    const plan = resolveInstallExecutionPlan({
      installMode: 'interactive-required',
      silentArgs: '/VERYSILENT /NORESTART /SP-',
      innoInfPath: 'C:\\Temp\\silent.inf',
      ext: '.exe',
      allowSilent: true,
    });

    assert.equal(plan.effectiveSilent, false);
    assert.equal(plan.adwareProtected, true);
    assert.equal(plan.usedInf, false);
    assert.equal(plan.extraArgs, '');
  });

  it('plant interactive-required auch bei stillen Bündel-Optionen zwingend als nicht-still am Ende ein', () => {
    const bundlePlan = planBundleExecution(
      [
        {
          order: 1,
          source: 'archive',
          refId: 'iobit',
          name: 'IObit Uninstaller',
          installMode: 'interactive-required',
          silentArgs: '/VERYSILENT',
          adwareProtected: true,
          canRunArchiveSilent: false,
        },
        {
          order: 2,
          source: 'archive',
          refId: '7zip',
          name: '7-Zip',
          installMode: 'silent',
          silentArgs: '/qn /norestart',
          adwareProtected: false,
          canRunArchiveSilent: true,
        },
      ],
      { allowSilent: true, silentWinget: true }
    );

    assert.deepEqual(
      bundlePlan.silentItems.map((i) => i.name),
      ['7-Zip']
    );
    assert.deepEqual(
      bundlePlan.interactiveItems.map((i) => i.name),
      ['IObit Uninstaller']
    );
    assert.equal(bundlePlan.interactiveItems[0].willRunSilent, false);
  });
});
