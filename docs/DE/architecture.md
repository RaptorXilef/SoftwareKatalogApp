# Technische Architektur & Entwicklung

Dieser Leitfaden richtet sich an Entwicklerinnen und Entwickler, die den Code verstehen, erweitern oder eigene Pull Requests einreichen möchten.

---

## 1. Tech-Stack & Designprinzipien

- **Runtime & Build:** Electron 45 (`^45.2.3`) + `electron-vite` (`^6.0.0`) + Vite (`^8.3.8`).
- **Sprache:** Natives ES-Modul-JavaScript ohne Frontend-Framework (kein React, Vue oder TypeScript-Build-Schritt). Statische Typprüfung erfolgt im Hintergrund über `jsconfig.json` (`checkJs: true`, JSDoc-Typen, `npm run typecheck`).
- **Styling:** Natives CSS mit `@layer base, layout, components, modals;`, CSS-Nesting und `color-mix()` - ohne `!important` und ohne absteigende Selektor-Spezifität.
- **Sicherheit:**
  - Renderer läuft mit `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (Preload wird daher als CommonJS gebaut).
  - Strikte Content Security Policy (keine Inline-Event-Handler wie `onclick=`).
  - Rich-Text und Markdown werden vor dem Einfügen mit `DOMPurify` (`src/renderer/utils/sanitize.js`) bereinigt.
  - Lokale Medien werden ausschließlich über das privilegierte `catalog-media://`-Protokoll ausgeliefert (beschränkt auf konfigurierte Archiv-Wurzeln und den Icon-Cache).
  - Alle CLI-Aufrufe nutzen `execFile`/`spawn` mit explizitem Argument-Array (`shell: false`, `windowsHide: true`, Windows-`.cmd`/`.bat`-Wrappers ohne Node `DEP0190`) und UTF-8-Output.

---

## 2. Verzeichnisstruktur

```text
SoftwareKatalogApp/
├── build/                    # App-Icon (icon.ico) und Build-Assets
├── docs/                     # Anwender- und Entwickler-Dokumentation
├── src/
│   ├── locales/              # Eingebaute Sprachdateien (en.json, de.json)
│   ├── main/                 # Electron Main-Prozess (Node.js-Backend)
│   │   ├── index.js          # App-Lifecycle, Fenster, IPC-Registrierung
│   │   ├── config.js         # Konfiguration, Multi-Root-Auflösung, Datenpfade
│   │   ├── jobs.js           # Paralleler, abbrechbarer Job-Manager
│   │   ├── update-queue.js   # Streng sequentielle Update-Warteschlange
│   │   ├── auth-service.js   # Admin-Login, Policy-Integrität & HKLM-Sperre
│   │   ├── elevated-helper.js & elevated-worker.mjs  # Named-Pipe Admin-Sitzung
│   │   ├── background-updater*.js & autostart*.js    # Tray, Scheduler & Autostart
│   │   ├── providers/        # 18 Paket-Provider + CLI-Runner + Bootstrap
│   │   └── dev-projects/     # DEV-Scanner, CLI-Runner, Aktionen & Dev-Bündel
│   ├── preload/
│   │   └── index.js          # contextBridge (`window.electronAPI`) + `webUtils.getPathForFile`
│   ├── renderer/             # UI (HTML, CSS, JS-Module)
│   │   ├── index.html & main.js & state.js
│   │   ├── components/       # Toolbar, Cards, Discover, Bundles, Dev-Workspace, Queue, Jobs
│   │   ├── modals/           # Detail, Edit, Settings, Cleanup, Matcher, Audit, Login, Sources
│   │   ├── styles/           # Modulare CSS-Layer
│   │   └── utils/            # DOM-Helfer, Sanitizer, Markdown, i18n
│   ├── scanner/
│   │   └── scanner.mjs       # Eigenständiger Archiv-Scanner (gebündelt in out/scanner/)
│   └── shared/               # Plattformunabhängige, rein testbare Logik & Parser
└── tests/                    # Unit- & Integrationstests (`node:test`, ohne Host-Seiteneffekte)
```

---

## 3. Datenhaltung (`data/` vs. `userData`)

Um portablen Betrieb (z. B. auf einem NAS für mehrere PCs) sauber von maschinenspezifischem Zustand zu trennen, werden Daten strikt aufgeteilt:

- **Geteilte / portable Laufzeitdaten (`data/`):**
  - `config.json` - Allgemeine Einstellungen, Archiv-Pfade, aktive Provider, Hintergrund-Optionen
  - `catalog.json` - Gescanntes Archiv-Verzeichnis mit relativen Pfaden
  - `bundles.json` - Globale Software-Bündel
  - `ignored-updates.json` - Ignorierte Update-Regeln
  - `dev-projects.json` & `dev-bundles.json` - Lokale Dev-Projekte und Dev-Bündel
  - `admin-policy.json` - Optionaler Admin-Schutz & Zugriffsrichtlinien
  - `locales/` - Benutzerdefinierte Community-Sprachdateien (überschreiben eingebaute Locales)
  - `scan.lock` - Temporäre Sperrdatei während aktiver Archiv-Scans
    _(Hinweis: Bei systemweiter Installation unter schreibgeschütztem `Program Files` weicht `data/` automatisch auf `%ProgramData%\SoftwareKatalog\data` bzw. `%APPDATA%\SoftwareKatalog\data` aus.)_
- **Lokaler PC-State (`userData`, standardmäßig `%TEMP%\SoftwareKatalog_Data` für SMB-Kompatibilität):**
  - `state.json` - Favoriten, lokal erkannte Versionen, zuletzt gemeldete Update-Versionen, letzter App-Update-Check
  - `provider-cache.json` - 7-Tage-Offline-Cache für Paketdetails
  - `icon-cache/` - Extrahierte & heruntergeladene Icons samt `icon-index.json`

---

## 4. Qualitätssicherung & Build-Pipeline

Alle Änderungen müssen vor einem Pull Request die folgenden Prüfungen fehlerfrei bestehen:

```bash
npm run fix:biome
npm run chk:biome
npm run typecheck
npm test
npm run chk:unused
npm run build:vite
```

### Besonderheiten beim Build

- `electron.vite.config.mjs` enthält ein eigenes Vite-Plugin (`bundleStandaloneScannerPlugin`), das `src/scanner/scanner.mjs` inklusive seiner `src/shared/`-Abhängigkeiten als eigenständiges ESM-Bundle nach `out/scanner/scanner.mjs` kompiliert.
- `electron-builder` packt anschließend `scanner.mjs`, `elevated-worker.mjs`, `icon.ico` und `src/locales/*.json` als `extraResources`, sodass der Scanner und der erhöhte Admin-Worker im gepackten Zustand direkt über `ELECTRON_RUN_AS_NODE=1` ausgeführt werden können.
- Unit-Tests in `tests/` nutzen `node:test` und Dependency Injection bzw. Mocks - sie installieren niemals echte Pakete auf dem Host-System und lösen keine UAC-Dialoge aus.
