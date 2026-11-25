# Software Katalog

[English](./README.md)

Ein portabler, schneller Software-Katalog, Windows-Paketmanager und Entwickler-Arbeitsbereich auf Basis von Electron.

Die Anwendung vereint ein lokales oder netzwerkbasiertes **Software-Archiv** (z. B. auf einem NAS oder externen Laufwerk) mit **18 integrierten Paket-Providern** (u. a. Winget, MS Store, Scoop, Chocolatey, MSI, npm, pnpm, Bun, NVM, Composer, pip, uv, Cargo, vcpkg, .NET Tools und PowerShell Gallery) sowie einem eigenen **DEV-Arbeitsbereich** für lokale Programmierprojekte.

---

## Highlights auf einen Blick

* **Zentrale Update-Steuerung:** Erkennt Updates aus dem eigenen Archiv, Windows-Paketmanagern, GitHub Releases und Webseiten und verarbeitet sie über eine streng sequentielle **Update-Warteschlange** (mit Drag-&-Drop-Priorisierung und Abbruch-Funktion).
* **Multi-Root-Archiv & Offline-Resilienz:** Binde mehrere Archiv-Orte (z. B. NAS + lokales Laufwerk) mit Prioritätsreihenfolge ein. Nicht erreichbare Netzlaufwerke werden sauber übersprungen, gecachte Daten bleiben erhalten.
* **18 Paket-Provider unter einer Oberfläche:** Installiere, aktualisiere, durchsuche und deinstalliere Programme und CLI-Tools aus einer einheitlichen Oberfläche - inklusive 7-Tage-Offline-Cache und Manager-Bootstrap.
* **Paketbündel & 1-Klick-PC-Snapshot:** Stelle Software-Paketsammlungen für neue PCs zusammen, exportiere/importiere sie als JSON oder erstelle per Klick einen Snapshot der installierten Programme.
* **DEV-Tab für Entwicklerprojekte:** Analysiert lokale Projekte aus 10 Ökosystemen (`npm`, `pnpm`, `bun`, `yarn`, `composer`, `uv`, `pip`, `cargo`, `dotnet`, `vcpkg`), visualisiert Abhängigkeitsbäume/-graphen, prüft Sicherheitslücken (`audit`) und unterstützt wiederverwendbare Dev-Bündel.
* **Sicherheit & Unternehmensfunktionen:** Strikter Opt-in-Silent-Modus mit **Adware-/Klick-Schutz**, Einmal-UAC-**Admin-Sitzung**, passwortgeschützter Admin-Login (`scrypt` + Integritätsprüfung), Whitelist-/Blacklist-Zugriffsrichtlinien (optional per Windows-HKLM-Registry gesperrt) sowie System-Tray mit Hintergrund-Auto-Updates.
* **Mehrsprachig (i18n):** Integriert in Englisch und Deutsch (mit automatischer Systemspracherkennung) und ohne Neubau über eigene Sprachdateien erweiterbar.

---

## Die 6 Hauptbereiche der Anwendung

| Tab | Funktion |
| --- | --- |
| **Updates** | Zeigt alle offenen Archiv-, Web- und Paketmanager-Updates. Unterstützt Mehrfachauswahl, Massen-Downloads ins Archiv, die sequentielle Update-Warteschlange und eine exportierbare Ignorierliste. |
| **Installiert** | Vereint erkannte Windows-Programme (Registry, AppX/MS Store, Paketmanager) mit Einträgen aus dem lokalen Archiv, extrahiert fehlende Icons automatisch in den Cache und erlaubt direkte Deinstallation oder Archiv-Aufnahme. |
| **Archiv** | Deine eigene Software-Bibliothek mit Kategorien, Tags, Favoriten, versteckten Kategorien, Screenshot-/Video-Lightbox, Drag-&-Drop-Ordneraufnahme und In-App-Metadaten-Editor. |
| **Bündel** | Wiederverwendbare Installations-Profile aus Archiv- und Paketmanager-Programmen mit Live-Statusabgleich (`Aktuell`, `Veraltet`, `Fehlt`) und zweiphasiger Ausführung (erst still, dann interaktiv). |
| **Neu installieren** | Provider-übergreifende Suche nach neuer Software inkl. Versionsauswahl, direkter Installation, optionaler Archiv-Ablage und Assistent für lokale `.msi`-Dateien. |
| **Dev** | Dedizierter Projekt-Arbeitsbereich für lokale Code-Repositories (Manifest-/Lockfile-Analyse, SemVer-Stufen-Updates, Scope-Wechsel, Abhängigkeitsgraph, Security-Audits und Dev-Bündel). Optional in den Einstellungen ausblendbar. |

---

## Installation & Auslieferung (Windows x64)

Aktuelle Releases stehen im Bereich [GitHub Releases](https://github.com/RaptorXilef/SoftwareKatalogApp/releases) in drei Varianten bereit (alle 64-Bit / `x64`, da Electron ab Version 44 kein 32-Bit-Windows mehr ausliefert):

1. **Installer (`SoftwareKatalog-Setup-x64.exe`):** Klassischer NSIS-Assistent (Benutzer- oder Systeminstallation, freie Zielordnerwahl, Startmenü- & Desktop-Verknüpfung).
2. **Portable Einzel-EXE (`SoftwareKatalog-Portable.exe`):** Eine einzelne ausführbare Datei für USB-Sticks oder schnelle Nutzung ohne Installation.
3. **Entpackbares ZIP-Archiv (`Software Katalog-<version>-win.zip`):** Empfohlen für Netzlaufwerke (NAS/SMB), da beim Start keine Entpack-Verzögerung entsteht.

### Schnellstart auf dem PC oder NAS

1. Installiere die App oder entpacke das ZIP-Archiv in einen Ordner (z. B. `Z:\SoftwareKatalogApp` oder `D:\Tools\SoftwareKatalog`).
2. Starte `Software Katalog.exe` - es wird **kein** vorinstalliertes Node.js benötigt, und der eingebaute Scanner (`resources/scanner.mjs`) ist bereits fertig integriert.
3. Öffne oben rechts die **Einstellungen** und hinterlege unter **Archiv & Downloads** einen oder mehrere Archiv-Ordner (z. B. `../software` oder `\\NAS\Software`).
4. Klicke in der Toolbar auf **Archiv prüfen**, **Online-Updates** oder **PC prüfen** (alle drei können parallel laufen und jederzeit abgebrochen werden).

Die Anwendung prüft automatisch über GitHub Releases auf neue App-Versionen und wählt über den integrierten Self-Updater das exakt passende Release-Asset (Setup, Portable-EXE oder ZIP). Details zu Installationsmodi und beschreibbaren Datenpfaden unter `Program Files` stehen in [docs/windows-installer-architecture.md](./docs/windows-installer-architecture.md).

---

## Dokumentation im Detail

Für alle tiefergehenden Themen gibt es eigene Leitfäden im Ordner `docs/`:

* **[Archiv, Ordnerstruktur & Metadaten](./docs/archive-and-metadata.md)** - Multi-Root-Archive, `_metadata/meta.json`-Referenz, Icons & Screenshots, `_last`-Pinning, Online-Scraper & manueller Archiv-Aufräumer.
* **[Paketmanager & Provider](./docs/package-managers.md)** - Übersicht aller 18 integrierten Quellen, Bootstrap-Funktionen, Custom-Registries/Buckets, lokaler MSI-Assistent und Winget-Zuordnungs-Assistent.
* **[DEV-Arbeitsbereich](./docs/dev-workspace.md)** - Projekt-Scan für 10 Entwickler-Ökosysteme, Abhängigkeitsbaum & Graph, SemVer-Updates, Security-Audits und Dev-Bündel.
* **[Sicherheit, Richtlinien & Hintergrundbetrieb](./docs/security-and-policies.md)** - Adware-Schutz, Admin-Sitzung (Einmal-UAC), Admin-Login, Whitelist/Blacklist, HKLM-Registry-Sperre, System-Tray, Autostart und Auto-Updates.
* **[Windows-Installer & Datenpfade](./docs/windows-installer-architecture.md)** - Architektur (`x64`), NSIS-Verhalten unter `Program Files` und Self-Updater-Logik.
* **[Architektur & Entwicklung](./docs/architecture.md)** - Tech-Stack, Prozessmodell, IPC-Sicherheit, Projektstruktur und Build-/Test-Workflows.
* **[Übersetzungen (i18n)](./docs/TRANSLATING.md)** - Neue Sprachen hinzufügen, lokal in `data/locales/` testen und validieren.

---

## Lokale Entwicklung

Voraussetzung: **Node.js (v20 LTS oder neuer)** unter Windows.

```bash
git clone [https://github.com/RaptorXilef/SoftwareKatalogApp.git](https://github.com/RaptorXilef/SoftwareKatalogApp.git)
cd SoftwareKatalogApp
npm install
npm run dev
```

### Wichtige npm-Skripte

| Befehl | Beschreibung |
| --- | --- |
| `npm run dev` | Startet die App im Entwicklungsmodus mit Hot-Reload (`electron-vite`). |
| `npm run fix:biome` / `npm run chk:biome` | Formatiert und prüft Code, CSS und JSON mit Biome. |
| `npm run typecheck` | Führt die statische Typprüfung (`tsc -p jsconfig.json` mit `checkJs`) aus. |
| `npm test` | Führt die komplette Unit-Test-Suite (`node:test`) ohne Host-Seiteneffekte aus. |
| `npm run chk:unused` | Prüft mit Knip auf ungenutzte Dateien, Exporte und Abhängigkeiten. |
| `npm run build:vite` | Baut Main-, Preload-, Renderer- und Standalone-Scanner-Bundles in `out/`. |
| `npm run build:dist` | Erstellt alle Windows-Release-Artefakte (NSIS, Portable, ZIP) in `dist/`. |

---

## Lizenz & Mitwirkung

* **Dual-Lizenzierung:** Dieses Projekt unterliegt einem **Dual-Licensing-Modell** (siehe [LICENSE.md](./LICENSE.md)):
  * **Privatpersonen & nicht-kommerzielle Nutzung:** Kostenlose Nutzung, Anpassung und Weitergabe im nicht-kommerziellen Rahmen gemäß der **PolyForm Noncommercial License 1.0.0**.
  * **Kommerzielle Nutzung (z. B. Unternehmen, Behörden, IT-Dienstleister):** Erfordert vorab den Erwerb einer kostenpflichtigen **kommerziellen Nutzungslizenz** beim Urheber (Felix Maywald / RaptorXilef).
* **Mitwirken:** Pull Requests und Übersetzungen sind herzlich willkommen! Bitte lies vorab die [CONTRIBUTING.md](./CONTRIBUTING.md) sowie das [Contributor License Agreement (CLA.md)](./CLA.md).
* **Änderungshistorie:** Alle Releases sind im [CHANGELOG.md](./CHANGELOG.md) dokumentiert.
