# Paketmanager & Provider-System

Software Katalog abstrahiert alle Paketquellen über eine einheitliche Provider-Registry (`src/main/providers/registry.js`). Standardmäßig sind nur **Archiv** und **Winget** aktiviert. Alle weiteren Paketmanager lassen sich unter **Einstellungen -> Paketmanager** individuell aktivieren, auf Verfügbarkeit prüfen und teilweise per Klick installieren oder deinstallieren.

---

## 1. Übersicht aller 18 integrierten Provider

### Archiv

| Provider           | ID        | Suche | Installiert | Updates | Versionen | Install / Uninstall |     Quellen-Verwaltung      |
| ------------------ | --------- | :---: | :---------: | :-----: | :-------: | :-----------------: | :-------------------------: |
| **Lokales Archiv** | `archive` |  Ja   |     Ja      |   Ja    |   Lokal   |       Install       | Multi-Root in Einstellungen |

### System-Paketmanager (Windows)

| Provider           | ID           | Beschreibung                                                   | Suche | Updates | Versionen |      Manager-Bootstrap       |  Quellen-Verwaltung  |
| ------------------ | ------------ | -------------------------------------------------------------- | :---: | :-----: | :-------: | :--------------------------: | :------------------: |
| **Winget**         | `winget`     | Offizieller Windows-Paketmanager (inkl. Archiv-Setup-Download) |  Ja   |   Ja    |    Ja     |        System / Store        | Ja (`winget source`) |
| **MS Store**       | `msstore`    | Microsoft Store-Apps über Winget + AppX-Manifest-Auflösung     |  Ja   |   Ja    |   Nein    |          via Winget          |      via Winget      |
| **Scoop**          | `scoop`      | Portable Windows-Tools ohne Adminrechte                        |  Ja   |   Ja    |   Nein    |     Install & Uninstall      | Ja (`scoop bucket`)  |
| **Chocolatey**     | `chocolatey` | Windows-Paketmanager (erfordert UAC/Admin)                     |  Ja   |   Ja    |    Ja     |  Install & Uninstall (UAC)   | Ja (`choco source`)  |
| **MSI**            | `msi`        | Lokale `.msi`-Pakete via `msiexec.exe` & Registry              | Nein  |  Nein   |   Nein    |       Systemkomponente       |         Nein         |
| **PowerShell 7**   | `pwsh7`      | PowerShell-7-Module (`PSResourceGet` / `PowerShellGet`)        |  Ja   |   Ja    |   Nein    | Install & Uninstall (Winget) |  Ja (Repositories)   |
| **PowerShell 5.1** | `pwsh5`      | Windows-PowerShell-5.1-Module (`PowerShellGet`)                |  Ja   |   Ja    |   Nein    |       Systemkomponente       |  Ja (Repositories)   |

### Sprachen & Entwickler-Provider (Global)

| Provider       | ID         | Beschreibung                                          | Suche | Updates | Versionen |     Manager-Bootstrap      |  Quellen-Verwaltung  |
| -------------- | ---------- | ----------------------------------------------------- | :---: | :-----: | :-------: | :------------------------: | :------------------: |
| **npm**        | `npm`      | Globale Node.js-Pakete (`npm install -g`)             |  Ja   |   Ja    |    Ja     |   Node.js LTS via Winget   | Ja (Custom Registry) |
| **Bun**        | `bun`      | Schnelle JS-Runtime & globale Pakete (`bun add -g`)   |  Ja   |   Ja    |    Ja     | Winget / PowerShell-Skript | Ja (Custom Registry) |
| **NVM**        | `nvm`      | Node.js-Versionsmanager für Windows (inkl. `nvm use`) |  Ja   |   Ja    |   Nein    |  Winget (`NVMforWindows`)  |         Nein         |
| **pnpm**       | `pnpm`     | Globale JavaScript-Pakete (`pnpm add -g`)             |  Ja   |   Ja    |    Ja     |    Winget (`pnpm.pnpm`)    | Ja (Custom Registry) |
| **Composer**   | `composer` | Globale PHP-CLI-Tools (Packagist)                     |  Ja   |   Ja    |   Nein    |    Winget (`Composer`)     |         Nein         |
| **pip**        | `pip`      | Python-Pakete aus PyPI (`python -m pip`)              |  Ja   |   Ja    |    Ja     |   Winget (`Python 3.13`)   |  Ja (Custom Index)   |
| **uv tool**    | `uv`       | Isolierte Python-CLI-Tools von Astral (`uv tool`)     |  Ja   |   Ja    |    Ja     |  Winget (`astral-sh.uv`)   |  Ja (Custom Index)   |
| **Cargo**      | `cargo`    | Installierte Rust-CLI-Crates (`crates.io`)            |  Ja   |   Ja    |    Ja     |     Winget (`Rustup`)      |         Nein         |
| **vcpkg**      | `vcpkg`    | C/C++-Paketmanager (`VCPKG_ROOT` oder `PATH`)         |  Ja   |   Ja    |   Nein    |   Git-Clone + Bootstrap    |         Nein         |
| **.NET Tools** | `dotnet`   | Globale .NET-CLI-Tools (`dotnet tool -g` / NuGet)     |  Ja   |   Ja    |   Nein    |  Winget (`.NET SDK 10/9`)  |         Nein         |

---

## 2. Besondere Provider-Funktionen

### Quellen-, Bucket- & Registry-Verwaltung

Über den Button **Quellen** bei unterstützten Providern in den Einstellungen lassen sich direkt in der App eigene Bezugsquellen verwalten:

- **CLI-basiert:** Winget-Quellen, Scoop-Buckets (mit Schnellvorlagen wie `extras`, `versions`, `nerd-fonts`), Chocolatey-Sources und PowerShell-Repositories.
- **Config-basiert:** Eigene Registries/Mirrors für `npm`, `bun`, `pnpm`, `pip` und `uv` (z. B. Firmen-Proxys wie Verdaccio, Nexus oder Artifactory).

### Lokale `.msi`-Installation

Im Tab **Neu installieren** steht (bei aktiviertem `msi`-Provider) ein Assistent für lokale `.msi`-Dateien zur Verfügung:

- Liest vor der Installation automatisch `ProductName`, `ProductVersion`, `Manufacturer` und `ProductCode` (`{GUID}`) direkt aus der MSI-Datenbank aus.
- Unterstützt interaktive Installation (Standard) oder stilles Setup (`/qn /norestart`) unter Beachtung aktiver Zugriffsrichtlinien.
- Kann die `.msi`-Datei nach erfolgreicher Installation direkt ins Archiv übernehmen.

### NVM-Versionsumschaltung & Update-Erkennung

- Installierte Node.js-Versionen zeigen an, welche Version aktuell aktiv ist (`Aktiv`-Chip).
- Im Detail-Dialog kann per Klick (`nvm use`) direkt auf eine installierte Version umgeschaltet werden (mit automatischem UAC-Fallback für Windows-Symlinks).
- Die Update-Prüfung gleicht installierte Versionen gegen `nvm list available` und den offiziellen Node.js-Release-Index (`nodejs.org/dist/index.json`) ab.

### MS Store & AppX-Auflösung

Kryptische Store-Produkt-IDs (wie `9N9PHDT62W94`) werden automatisch über lokale `AppxManifest.xml`-Dateien und den Provider-Cache auf echte App-Namen, Herausgeber und hochauflösende App-Logos aufgelöst.

---

## 3. Verknüpfung zwischen Paketmanagern & Archiv

### Speichermodus bei Neuinstallationen (`archiveSaveMode`)

In den Einstellungen legst du fest, was passiert, wenn du Software über einen Paketmanager installierst oder aktualisierst:

- **`ask` (Standard):** Fragt nach dem Zielordner im Archiv und bietet bei vorhandenen `_metadata`-Ordnern eine sichere Kollisionsauflösung (Verknüpfen, Überschreiben, anderen Ordner wählen, Abbrechen).
- **`auto-id`:** Legt automatisch einen Ordner `<Archiv>/<packageId>` an, speichert aber den echten Anzeigenamen in `meta.json`.
- **`none`:** Keine automatische Ablage im Archiv.

### Zweistufiger Winget-Zuordnungs-Assistent

Über `...` -> **Winget-IDs zuordnen** kannst du bestehende Archiv-Ordner ohne `packageId` komfortabel mit Winget verknüpfen:

1. **Stufe 1 (Hohe Sicherheit):** Automatischer Abgleich mit lokal installierten Programmen (`winget export`, Installationspfade und Registry-Namen) - diese Treffer sind vorausgewählt.
2. **Stufe 2 (Vorschläge):** Gedrosselte `winget search`-Abfrage für verbleibende Ordner - niemals ungefragt angehakt, sondern frei per Dropdown auswählbar.

---

## 4. Offline-First-Caching

Um auch bei langsamen Verbindungen oder komplett offline schnell zu bleiben, nutzt die App zwei lokale Caches in `userData`:

- **Provider-Metadaten-Cache (`provider-cache.json`):** Speichert Detailabfragen (`show`) für 7 Tage. Schlägt nach Ablauf ein Online-Abruf fehl, bleiben die gecachten Daten dauerhaft nutzbar und werden als veraltet markiert.
- **Persistenter Icon-Cache (`icon-cache/`):** Speichert extrahierte EXE-/DLL-/AppX-Icons und Online-Favicons mit 30-Tage-TTL (offline unbegrenzt gültig) und 24-Stunden-Negativ-Cache. Beide Caches lassen sich in den Einstellungen einsehen und leeren.
