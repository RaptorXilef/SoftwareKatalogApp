import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildIconCacheKey,
  deriveGitHubAvatarUrl,
  extractCandidateHomepageUrls,
  isGenericIconSource,
  isIgnoredExecutableName,
  parseDisplayIcon,
  parseFaviconLinksFromHtml,
  resolvePackageIcon,
  scoreExecutableCandidate,
} from '../src/shared/icon-logic.js';

describe('icon-logic: parseDisplayIcon & Pfadbereinigung', () => {
  it('bereinigt DisplayIcon mit ,0, negativen Indizes, Anführungszeichen und %ENV%-Variablen', () => {
    const quotedWithComma = parseDisplayIcon('"C:\\Program Files\\7-Zip\\7zFM.exe",0');
    assert.equal(quotedWithComma.path, 'C:\\Program Files\\7-Zip\\7zFM.exe');
    assert.equal(quotedWithComma.index, 0);
    assert.equal(quotedWithComma.ext, '.exe');
    assert.equal(quotedWithComma.isExecutableResource, true);
    assert.equal(quotedWithComma.isDirectImage, false);
    assert.equal(quotedWithComma.isGeneric, false);

    const dllNegativeIdx = parseDisplayIcon('"C:\\Program Files\\App\\icons.dll", -101');
    assert.equal(dllNegativeIdx.path, 'C:\\Program Files\\App\\icons.dll');
    assert.equal(dllNegativeIdx.index, -101);
    assert.equal(dllNegativeIdx.ext, '.dll');
    assert.equal(dllNegativeIdx.isExecutableResource, true);

    const indexInsideQuotes = parseDisplayIcon('"C:\\Program Files\\App\\res.dll,-15"');
    assert.equal(indexInsideQuotes.path, 'C:\\Program Files\\App\\res.dll');
    assert.equal(indexInsideQuotes.index, -15);
    assert.equal(indexInsideQuotes.ext, '.dll');

    const unquotedExe = parseDisplayIcon('C:\\Tools\\Audacity\\audacity.exe,0');
    assert.equal(unquotedExe.path, 'C:\\Tools\\Audacity\\audacity.exe');
    assert.equal(unquotedExe.index, 0);

    const directIco = parseDisplayIcon('@"%LOCALAPPDATA%\\WeMod\\app.ico"', {
      LocalAppData: 'C:\\Users\\Max\\AppData\\Local',
    });
    assert.equal(directIco.path, 'C:\\Users\\Max\\AppData\\Local\\WeMod\\app.ico');
    assert.equal(directIco.index, null);
    assert.equal(directIco.ext, '.ico');
    assert.equal(directIco.isDirectImage, true);
    assert.equal(directIco.isExecutableResource, false);

    const directSvg = parseDisplayIcon('C:\\Apps\\Logo\\brand.svg');
    assert.equal(directSvg.isDirectImage, true);
    assert.equal(directSvg.ext, '.svg');

    const directPng = parseDisplayIcon('"C:\\Apps\\Logo\\icon.png"');
    assert.equal(directPng.isDirectImage, true);
    assert.equal(directPng.ext, '.png');
  });

  it('erkennt generische Windows-Installer-Icons (z. B. msiexec.exe) zuverlässig', () => {
    const msi = parseDisplayIcon('C:\\Windows\\System32\\msiexec.exe,0');
    assert.equal(msi.isGeneric, true);
    assert.equal(isGenericIconSource('msiexec.exe'), true);
    assert.equal(isGenericIconSource('C:\\Program Files\\Audacity\\audacity.exe'), false);
  });
});

describe('icon-logic: Cache-Schlüssel & Executable-Bewertung', () => {
  it('erzeugt kollisionsfreie Cache-Schlüssel pro App-Key, Quelltyp und Index', () => {
    const keyA = buildIconCacheKey({
      appKey: 'winget:wemod.wemod',
      sourceType: 'display-icon',
      sourcePath: 'C:\\Windows\\System32\\shell32.dll',
      iconIndex: 1,
    });
    const keyB = buildIconCacheKey({
      appKey: 'winget:audacity.audacity',
      sourceType: 'display-icon',
      sourcePath: 'C:\\Windows\\System32\\shell32.dll',
      iconIndex: 1,
    });
    const keyC = buildIconCacheKey({
      appKey: 'winget:wemod.wemod',
      sourceType: 'display-icon',
      sourcePath: 'C:\\Windows\\System32\\shell32.dll',
      iconIndex: 2,
    });

    assert.notEqual(keyA, keyB);
    assert.notEqual(keyA, keyC);
  });

  it('bevorzugt die Haupt-EXE gegenüber Hilfs-, Updater- und Uninstaller-Binaries', () => {
    assert.equal(isIgnoredExecutableName('unins000.exe'), true);
    assert.equal(isIgnoredExecutableName('Update.exe'), true);
    assert.equal(isIgnoredExecutableName('crashpad_handler.exe'), true);
    assert.equal(isIgnoredExecutableName('helper.exe'), true);
    assert.equal(isIgnoredExecutableName('audacity.exe'), false);

    const rootDir = 'C:\\Program Files\\Audacity';
    const mainScore = scoreExecutableCandidate('C:\\Program Files\\Audacity\\audacity.exe', {
      appName: 'Audacity 4.0',
      packageId: 'Audacity.Audacity',
      rootDir,
    });
    const helperScore = scoreExecutableCandidate('C:\\Program Files\\Audacity\\crashpad_handler.exe', {
      appName: 'Audacity 4.0',
      packageId: 'Audacity.Audacity',
      rootDir,
    });
    const nestedToolScore = scoreExecutableCandidate('C:\\Program Files\\Audacity\\tools\\ffmpeg.exe', {
      appName: 'Audacity 4.0',
      packageId: 'Audacity.Audacity',
      rootDir,
    });

    assert.equal(helperScore, -1);
    assert.ok(mainScore > nestedToolScore);
  });
});

describe('icon-logic: Icon-Priorität & Online-Favicon-Fallback', () => {
  it('hält strikt die Priorität _metadata/icon.* > PC-Icon > Cache-Icon > Platzhalter ein', () => {
    const metadataWins = resolvePackageIcon({
      archiveIcon: 'Z:\\software\\VLC\\_metadata\\icon.png',
      pcIcon: 'C:\\cache\\pc-vlc.png',
      cachedIcon: 'C:\\cache\\web-vlc.png',
      origin: 'both',
    });
    assert.deepEqual(metadataWins, {
      icon: 'Z:\\software\\VLC\\_metadata\\icon.png',
      source: 'archive',
      placeholder: '📦',
    });

    const pcFallback = resolvePackageIcon({
      archiveIcon: null,
      pcIcon: 'C:\\cache\\pc-vlc.png',
      cachedIcon: 'C:\\cache\\web-vlc.png',
      origin: 'both',
    });
    assert.deepEqual(pcFallback, {
      icon: 'C:\\cache\\pc-vlc.png',
      source: 'pc',
      placeholder: '📦',
    });

    const webCacheFallback = resolvePackageIcon({
      archiveIcon: null,
      pcIcon: null,
      cachedIcon: 'C:\\cache\\web-vlc.png',
      origin: 'archive',
    });
    assert.deepEqual(webCacheFallback, {
      icon: 'C:\\cache\\web-vlc.png',
      source: 'cache',
      placeholder: '📦',
    });

    const placeholderArchive = resolvePackageIcon({ origin: 'archive' });
    assert.deepEqual(placeholderArchive, { icon: null, source: 'placeholder', placeholder: '📦' });

    const placeholderPc = resolvePackageIcon({ origin: 'pc' });
    assert.deepEqual(placeholderPc, { icon: null, source: 'placeholder', placeholder: '💻' });
  });

  it('extrahiert Homepage-URLs, GitHub-Avatare und priorisiert hochauflösende Favicons aus HTML', () => {
    const urls = extractCandidateHomepageUrls({
      homepage: 'https://www.audacityteam.org/',
      publisherUrl: 'https://github.com/audacity/audacity',
      webVersionUrl: 'https://github.com/audacity/audacity/releases/latest/audacity.exe',
      links: [
        { label: 'Download', url: 'https://example.com/setup.exe' },
        { label: 'Webseite', url: 'https://audacityteam.org/docs' },
      ],
    });
    assert.equal(urls[0], 'https://www.audacityteam.org/');
    assert.ok(urls.includes('https://audacityteam.org/docs'));
    assert.ok(!urls.some((u) => u.endsWith('.exe')));

    assert.equal(
      deriveGitHubAvatarUrl('https://github.com/audacity/audacity'),
      'https://github.com/audacity.png?size=128'
    );
    assert.equal(deriveGitHubAvatarUrl('https://github.com/features/actions'), null);

    const icons = parseFaviconLinksFromHtml(
      `
      <html>
        <head>
          <link rel="icon" href="/favicon.ico" sizes="16x16">
          <link rel="icon" href="/assets/logo.png" sizes="64x64">
          <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
        </head>
      </html>
      `,
      'https://example.org/app'
    );
    assert.equal(icons[0], 'https://example.org/apple-touch-icon.png');
    assert.equal(icons[1], 'https://example.org/assets/logo.png');
    assert.equal(icons[2], 'https://example.org/favicon.ico');
  });
});
