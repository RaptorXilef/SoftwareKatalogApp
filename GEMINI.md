# Projektregeln: Software Katalog & Paketmanager

## Tech-Stack & Architektur

- Electron 45 + electron-vite + natives JavaScript (ES-Module, KEIN React/Vue/TypeScript/SCSS).
- Natives CSS mit `@layer base, layout, components, modals;`, CSS-Nesting und `color-mix()`.
- KEIN `!important` in CSS und keine absteigende Selektor-Spezifität (`noDescendingSpecificity`).
- Laufzeitdaten liegen ausschließlich in `data/` (`config.json`, `catalog.json`, `bundles.json`, `scan.lock`), niemals im Projektstamm.
- Lokaler PC-State und Provider-Cache liegen in `app.getPath('userData')`.
- Medien im Renderer werden ausschließlich über das `catalog-media://`-Protokoll geladen.
- Drag & Drop nutzt `window.electronAPI.getFilePath(file)` (via `webUtils.getPathForFile`).
- Statische Hintergrundprüfung erfolgt über `jsconfig.json` (`checkJs: true`, reines JS, keine `.ts`-Dateien außer `src/renderer/global.d.ts`).

## Sicherheit & UX

- Strikte CSP: niemals Inline-Event-Handler (`onclick=`, `oninput=`) in HTML-Templates verwenden.
- HTML aus Rich-Text oder Markdown immer mit `DOMPurify` (`src/renderer/utils/sanitize.js`) bereinigen.
- Keine blockierenden `alert()`, `confirm()` oder `prompt()` verwenden - nutze `showToast()` oder In-App-Modals.
- Begrifflichkeit im gesamten UI: Konsequent **"Archiv"** statt "NAS" verwenden.
- Alle langlaufenden Vorgänge über `src/main/jobs.js` (parallele, abbrechbare Jobs) abwickeln.
- Silent-Install ist IMMER opt-in. Standard bleibt interaktiv (Adware-Schutz).
- Der Archiv-Aufräumer läuft niemals automatisch und fasst weder `_last`-Ordner noch Programme mit `keepAllVersions: true` an.

## Paketmanager, CLI & Windows-Spezifika

- **Sichere Prozess-Ausführung:** Verwende für CLI-Aufrufe immer `execFile` oder `spawn` mit explizitem Argument-Array (`shell: false`, `windowsHide: true`) - niemals `exec()` mit zusammengesetzten Strings (Schutz vor Command-Injection und Leerzeichen-Fehlern in Windows-Pfaden).
- **UTF-8-Encoding erzwingen:** Stelle bei PowerShell- und CLI-Aufrufen unter Windows sicher, dass die Ausgabe sauber als UTF-8 gelesen wird (`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8`).
- **Tests ohne System-Seiteneffekte:** Unit-Tests in `tests/` dürfen niemals echte Paketmanager auf dem Host-System installieren, deinstallieren oder UAC-Dialoge auslösen - CLI-Aufrufe und Dateisystem-Checks müssen über Dependency Injection oder Mocks getestet werden.
- **IPC-Grenze einhalten:** Neue Backend-Funktionen immer sauber über `ipcMain.handle` und `contextBridge` in `src/preload/index.js` exponieren (`contextIsolation: true`, `nodeIntegration: false`).

## Qualitätssicherung nach jeder Aufgabe

- Nach jeder Codeänderung zwingend **einzeln nacheinander** `npm run fix:biome`, `npm run chk:biome`, `npm run typecheck`, `npm test` und `npm run build:vite` ausführen und alle Fehler/Warnungen beheben.
- Neue Logik in `src/shared/` und neue Provider-/Lifecycle-Logik immer mit Unit-Tests in `tests/` (`node:test`) absichern.
- Am Ende jeder Aufgabe eine Git-Commit-Message im Format `feat/fix/refactor(scope): ...` mit `[EN]`- und `[DE]`-Erklärung vorschlagen.
- Verwende in Code, Kommentaren, UI-Texten und Commit-Messages ausschließlich ASCII-Bindestriche (`-`) statt typografischer Gedankenstriche (En-Dash/Em-Dash).
- Verwende in Code, Kommentaren, UI-Texten und Commit-Messages ausschließlich gerade Anführungszeichen (`"` oder `'`) statt typografischer Anführungszeichen.

## Console und Terminal

- **Integrierte Tools bevorzugen:** Nutze für das Auflisten von Verzeichnissen, Lesen von Dateien und Durchsuchen von Code ausschließlich deine integrierten File-Search-, Read- und Grep-Tools - niemals PowerShell- oder Shell-Befehle (`Get-ChildItem`, `Select-String`, `Get-Content`, `cat`, `ls`).
- **Keine Befehlsverkettung:** Führe im Terminal immer nur **einen einzelnen Befehl pro Aufruf** aus. Verkette Befehle niemals mit `;`, `&&`, `||` oder Pipes (`|`), damit die Sicherheits-Allowlist zuverlässig greift.
