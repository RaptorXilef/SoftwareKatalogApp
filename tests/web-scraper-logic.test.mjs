import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractBetweenAll, extractLinkFromHtml, extractVersionFromHtml } from '../src/shared/web-scraper-logic.js';

describe('web-scraper-logic: extractVersionFromHtml & extractLinkFromHtml', () => {
  it('prüft alle Präfix/Suffix-Vorkommen und überspringt irrelevante erste Treffer ohne Versionsnummer', () => {
    const html = `
      <html>
        <head><title>App</title></head>
        <body>
          <nav><span class="badge">Neu</span><span class="badge">Kostenlos</span></nav>
          <main><p>Aktuelle Version: <span class="badge">4.2.15</span> verfügbar</p></main>
        </body>
      </html>
    `;
    const candidates = extractBetweenAll(html, '<span class="badge">', '</span>');
    assert.deepEqual(candidates, ['Neu', 'Kostenlos', '4.2.15']);
    assert.equal(extractVersionFromHtml(html, '<span class="badge">', '</span>'), '4.2.15');
  });

  it('erkennt 1-, 2-, 3- und 4-stellige Versionen trotz Quotes-, Whitespace- und Attribut-Abweichungen', () => {
    const serverHtml = `
      <body>
        <div id='dl' class='ver-box'>Current&nbsp;Release:&nbsp;<strong>1.3.4.21</strong> (x64)</div>
      </body>
    `;
    const domPrefix = '<div class="ver-box" id="dl">Current Release: <strong>';
    const domSuffix = '</strong> (x64)</div>';
    assert.equal(extractVersionFromHtml(serverHtml, domPrefix, domSuffix), '1.3.4.21');

    const singleDigitHtml = '<body><p>Major Version: <b>5</b></p></body>';
    assert.equal(extractVersionFromHtml(singleDigitHtml, 'Major Version: <b>', '</b>'), '5');

    const twoPartHtml = '<body><a href="/release/2.10/download">Release 2.10</a></body>';
    assert.equal(extractVersionFromHtml(twoPartHtml, 'href="/release/2.9/download">Release ', '</a>'), '2.10');
  });

  it('extrahiert Download-Links sauber ohne Anker oder javascript:-Links', () => {
    const html = `
      <body>
        <a class="dl" href="#top">Top</a>
        <a class="dl" href="/files/setup-4.2.1.exe">Download</a>
      </body>
    `;
    assert.equal(extractLinkFromHtml(html, '<a class="dl" href="', '">'), '/files/setup-4.2.1.exe');
  });
});
