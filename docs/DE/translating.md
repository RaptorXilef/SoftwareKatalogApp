# Software Katalog übersetzen

Vielen Dank, dass du dabei hilfst, **Software Katalog** in weitere Sprachen zu übersetzen!

Alle eingebauten Sprachdateien liegen als UTF-8-JSON-Wörterbücher unter [`src/locales/`](../src/locales/), wobei Englisch (`en.json`) als kanonische Referenz dient.

## 1. Eine neue Sprachdatei erstellen

1. Kopiere [`src/locales/en.json`](../src/locales/en.json) nach `src/locales/<code>.json` (verwende einen standardisierten kleingeschriebenen BCP-47- / ISO-639-1-Sprachcode, wie z. B. `fr.json`, `es.json` oder `pt-br.json`).
2. Aktualisiere den `_meta`-Header ganz oben in der Datei:

```json
{
  "_meta": {
    "code": "fr",
    "name": "French",
    "nativeName": "Francais",
    "author": "Dein Name (@github-handle)"
  }
}
```

- `code` muss exakt dem Dateinamen ohne Endung in Kleinbuchstaben entsprechen (für `fr.json` also `"code": "fr"`).
- `name` ist der englische Anzeigename.
- `nativeName` ist der Sprachname in der eigenen Sprache und Schrift.
- `author` nennt die Übersetzerin bzw. den Übersetzer.

## 2. Übersetzungsrichtlinien

- Behalte jedes `{placeholder}`-Token unverändert und in identischer Schreibweise bei (zum Beispiel `{version}`, `{count}`, `{name}`, `{error}`).
- Lasse alle technischen Bezeichner unverändert (`_metadata`, `_last`, `_archive`, `meta.json`, `winget`, `VCPKG_ROOT`, `/VERYSILENT`, `/qn /norestart`).
- Lasse niemals einen String leer und füge im Vergleich zu `en.json` keine verschachtelten Schlüssel hinzu oder entferne welche.
- Verwende standardmäßige ASCII-Bindestriche (`-`) und gerade Anführungszeichen (`"` / `'`) anstelle von typografischen Gedankenstrichen oder geschwungenen Anführungszeichen.
- Bette keine rohen HTML-Tags in Übersetzungsstrings ein.

## 3. Lokal ohne Neubau testen

Du kannst eine neue oder geänderte Übersetzung jederzeit live testen, indem du deine `<code>.json`-Datei im Laufzeitverzeichnis `data/locales/` der App ablegst (du kannst den Ordner direkt über die Schaltfläche unter **Einstellungen -> Allgemein -> Sprache** öffnen).

Eigene Dateien in `data/locales/` werden beim Start automatisch geladen und überschreiben eingebaute Sprachen mit demselben `code`, sodass du unter **Einstellungen -> Allgemein** sofort zu deiner Übersetzung wechseln kannst, ohne die App neu bauen zu müssen.

## 4. Vollständigkeit validieren

Führe vor dem Öffnen eines Pull Requests die automatisierten Vollständigkeits- und Formatierungsprüfungen aus:

```bash
npm test
npm run chk:biome
```

Die Test-Suite in [`tests/i18n.test.mjs`](../tests/i18n.test.mjs) überprüft:

- 100 % Schlüssel-Parität gegenüber `src/locales/en.json`
- Gültige `_meta`-Felder passend zum Dateinamen
- Nicht-leere Werte für alle Schlüssel
- Identische `{placeholder}`-Sets und ausgeglichene geschweifte Klammern
- Dass alle im Code referenzierten `t(...)`-Schlüssel und `data-i18n*`-Attribute in `en.json` existieren

## 5. Einen Pull Request öffnen

1. Committe deine Änderungen gemäß [Conventional Commits](https://www.conventionalcommits.org/) (zum Beispiel `feat(i18n): add French translation`).
2. Öffne einen Pull Request auf GitHub mit dem Ziel-Branch `main`.
3. Füge `"I accept the CLA"` in deine Pull-Request-Beschreibung ein, wie in [`CONTRIBUTING.md`](../CONTRIBUTING.md) beschrieben.
