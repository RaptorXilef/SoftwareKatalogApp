import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildArchiveFilename, compareVersions, extractVersion, sanitizeFileName } from '../src/shared/version.js';

describe('extractVersion', () => {
  it('extrahiert 1-, 2-, 3- und 4-stellige Versionsnummern aus Dateinamen und Texten', () => {
    assert.equal(extractVersion('1'), '1');
    assert.equal(extractVersion('v2'), '2');
    assert.equal(extractVersion('App_v1.exe'), '1');
    assert.equal(extractVersion('Version 3 (64-bit)'), '3');
    assert.equal(extractVersion('Blender_4_x64.msi'), '4');
    assert.equal(extractVersion('1.3'), '1.3');
    assert.equal(extractVersion('setup_v2.10.exe'), '2.10');
    assert.equal(extractVersion('1.3.5'), '1.3.5');
    assert.equal(extractVersion('vlc-3.0.21-win64.exe'), '3.0.21');
    assert.equal(extractVersion('Release 4.5.1 (64-bit)'), '4.5.1');
    assert.equal(extractVersion('1.3.4.21'), '1.3.4.21');
    assert.equal(extractVersion('App_v1.3.4.21_x64.exe'), '1.3.4.21');
  });

  it('normalisiert Komma-getrennte Windows-Versionen', () => {
    assert.equal(extractVersion('3, 0, 24, 0'), '3.0.24.0');
  });

  it('gibt null zurück, wenn keine gültige Version vorhanden ist (keine False-Positives bei Architekturen)', () => {
    assert.equal(extractVersion('setup.exe'), null);
    assert.equal(extractVersion('setup-x64.exe'), null);
    assert.equal(extractVersion('app_win64_64-bit.msi'), null);
    assert.equal(extractVersion('7-Zip_setup.exe'), null);
    assert.equal(extractVersion(''), null);
    assert.equal(extractVersion(null), null);
  });
});

describe('compareVersions', () => {
  it('vergleicht numerisch statt alphabetisch (2.10 > 2.9 und 26.13.1 > 26.5.1)', () => {
    assert.equal(compareVersions('2.10.0', '2.9.0'), 1);
    assert.equal(compareVersions('2.9.0', '2.10.0'), -1);
    assert.equal(compareVersions('26.5.1', '26.13.1'), -1);
    assert.equal(compareVersions('26.13.1', '26.5.1'), 1);
    assert.equal(compareVersions('3.0.21', '3.0.21'), 0);
    assert.equal(compareVersions('1', '2'), -1);
    assert.equal(compareVersions('2', '1.9.9'), 1);
    assert.equal(compareVersions('1.3', '1.3.0'), 0);
    assert.equal(compareVersions('v1.3.5', '1.3.4'), 1);
  });

  it('respektiert die konfigurierbare Vergleichstiefe (maxDepth)', () => {
    assert.equal(compareVersions('3.0.21.5', '3.0.21.1', 3), 0);
    assert.equal(compareVersions('3.0.21.5', '3.0.21.1', 4), 1);
    assert.equal(compareVersions('3.0.21.5', '3.0.21.1', 0), 1);
    assert.equal(compareVersions('1.3.4.21', '1.3.4.20', 4), 1);
  });

  it('behandelt unterschiedliche Längen und leere Eingaben stabil', () => {
    assert.equal(compareVersions('1.2', '1.2.0', 3), 0);
    assert.equal(compareVersions(null, '1.0'), 0);
  });
});

describe('sanitizeFileName', () => {
  it('entfernt ungültige Windows-Zeichen und ersetzt Leerzeichen', () => {
    assert.equal(sanitizeFileName('VLC: Media / Player?'), 'VLC_Media_Player');
    assert.equal(sanitizeFileName('  7-Zip  (x64)  '), '7-Zip_(x64)');
    assert.equal(sanitizeFileName(''), 'Software');
  });
});

describe('buildArchiveFilename', () => {
  it('erzeugt sauberen Namen mit Version und erhaltener Architektur', () => {
    const name = buildArchiveFilename({
      softwareName: 'VLC Media Player',
      version: '3.0.21',
      originalFilename: 'setup-x64.exe',
    });
    assert.equal(name, 'VLC_Media_Player_v3.0.21_x64.exe');
  });

  it('behält Originalnamen, wenn die Version bereits enthalten ist', () => {
    const name = buildArchiveFilename({
      softwareName: 'VLC Media Player',
      version: '3.0.21',
      originalFilename: 'vlc-3.0.21-win64.exe',
    });
    assert.equal(name, 'vlc-3.0.21-win64.exe');
  });

  it('erzwingt das Schema, wenn keepIfVersionPresent deaktiviert ist', () => {
    const name = buildArchiveFilename({
      softwareName: 'VLC Media Player',
      version: '3.0.21',
      originalFilename: 'vlc-3.0.21-win64.exe',
      keepIfVersionPresent: false,
    });
    assert.equal(name, 'VLC_Media_Player_v3.0.21_win64.exe');
  });

  it('unterstützt zusammengesetzte Archiv-Endungen wie .tar.gz und benutzerdefinierte Muster', () => {
    assert.equal(
      buildArchiveFilename({
        softwareName: 'MyTool',
        version: '1.4.2',
        originalFilename: 'release-arm64.tar.gz',
      }),
      'MyTool_v1.4.2_arm64.tar.gz'
    );

    assert.equal(
      buildArchiveFilename({
        softwareName: '7-Zip',
        version: '24.09',
        originalFilename: '7z-x64.msi',
        pattern: '{Name}-{Version}{Arch}{Ext}',
      }),
      '7-Zip-24.09_x64.msi'
    );
  });

  it('fällt sauber auf Namen ohne Version zurück, falls keine bekannt ist', () => {
    const name = buildArchiveFilename({
      softwareName: 'My App',
      version: '',
      originalFilename: 'installer_x86.msi',
    });
    assert.equal(name, 'My_App_x86.msi');
  });
});
