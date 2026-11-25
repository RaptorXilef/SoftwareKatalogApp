# DEV-Arbeitsbereich (Lokale Entwicklungsprojekte)

Der Tab **Dev** (optional in **Einstellungen -> Allgemein** ausblendbar) ist ein eigenständiger Paket- und Abhängigkeitsmanager für lokale Code-Repositories. Er trennt projekt-lokale Abhängigkeiten sauber von systemweit installierter Software.

---

## 1. Unterstützte Ökosysteme & Erkennung

Projektordner lassen sich per Dialog oder direkt per **Drag & Drop** auf den Dev-Tab verknüpfen (gespeichert in `data/dev-projects.json`). Mehrere Ökosysteme im selben Projekt (z. B. ein PHP-Backend mit JS-Frontend) werden parallel erkannt:

| Ökosystem                | Paketmanager                 | Manifest-Dateien                     | Lockfiles                                                                    |
| ------------------------ | ---------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| **JavaScript / Node.js** | `npm`, `pnpm`, `bun`, `yarn` | `package.json`                       | `package-lock.json`, `pnpm-lock.yaml`, `bun.lock` / `bun.lockb`, `yarn.lock` |
| **PHP**                  | `composer`                   | `composer.json`                      | `composer.lock`                                                              |
| **Python**               | `uv`, `pip`                  | `pyproject.toml`, `requirements.txt` | `uv.lock` (erkennt zudem lokale `.venv`/`venv`)                              |
| **Rust**                 | `cargo`                      | `Cargo.toml`                         | `Cargo.lock`                                                                 |
| **.NET / C#**            | `dotnet` (NuGet)             | `*.csproj`                           | `packages.lock.json`                                                         |
| **C / C++**              | `vcpkg`                      | `vcpkg.json`                         | `vcpkg-configuration.json`                                                   |

Ist ein verknüpfter Projektordner vorübergehend nicht erreichbar (z. B. abgestecktes Laufwerk), markiert die App das Projekt sauber als **Offline**, ohne Daten zu verlieren.

---

## 2. Funktionen im Projekt-Workspace

Nach dem Klick auf eine Projektkarte stehen fünf Unterbereiche bereit:

### Updates (SemVer-Stufen & Major-Schutz)

- Vergleicht installierte Paketversionen mit den offiziellen Registries (`npm`, `Packagist`, `PyPI`, `crates.io`, `NuGet`) sowie den jeweiligen `outdated`-CLIs.
- Zeigt den Versionsfluss transparent als **Installiert -> Kompatibel (`wanted`) -> Neueste (`latest`)**.
- **SemVer-Stufen-Auswahl:** Wähle pro Paket gezielt zwischen **Patch**, **Minor** und **Major** aus.
- **Sichere Massenaktualisierung:** "Alle kompatiblen aktualisieren" schließt Major-Sprünge bewusst aus; Major-Upgrades erfordern eine bewusste Auswahl.

### Installierte Pakete (Direkt)

- Listet alle direkt deklarierten Pakete getrennt nach Scope (`prod`, `dev`, `optional`) samt deklarierter Version-Range und tatsächlich installierter Version.
- Unterstützt **Scope-Wechsel** (`prod` <-> `dev`, bei allen unterstützten Managern) sowie gezieltes Entfernen einzelner Pakete und Lockfile-Sync (`Sync`).

### Abhängigkeiten (Liste, Baum & Graph)

- Parst die Lockfiles direkt für eine vollständige Übersicht aller direkten und transitiven Pakete inklusive Lizenzinformationen, `requires` und `requiredBy`.
- **Drei Ansichten:**
  1. **Liste:** Durchsuchbar nach Paketname, Lizenz und Eltern-/Kind-Paketen.
  2. **Baumansicht:** Aufklappbarer Abhängigkeitsbaum mit automatischem **Zyklusschutz**.
  3. **Interaktiver Graph:** Visualisiert Abhängigkeiten mit Zoom, Pan und Fokus-Modus auf einzelne Knoten (mit Schutzlimit bei sehr großen Projekten).

### Neu installieren (Projekt-Registry-Suche)

- Durchsucht die zum Projekt passende Registry (erkannte Projekt-Manager werden automatisch priorisiert).
- Ermöglicht direkte Installation als `prod`- oder `dev`-Abhängigkeit inkl. optionaler Versionsangabe und automatischem Projekt-Rescan.

### Security Audit (`npm`, `pnpm`, `composer`)

- Führt ein Sicherheits-Audit im Projekt aus und gruppiert gefundene Schwachstellen nach Schweregrad (`Critical`, `High`, `Moderate`, `Low`) inklusive CVE-Links und Hinweisen auf verwaiste (`abandoned`) Composer-Pakete.
- Bietet für unterstützte Manager eine direkte **Auto-Fix**-Aktion mit anschließendem erneutem Check.

---

## 3. Dev-Bündel (Projekt-Stacks)

Ähnlich wie globale Software-Bündel kannst du projekt-lokale **Dev-Bündel** in `data/dev-bundles.json` anlegen (unterstützt `npm`, `pnpm`, `bun`, `composer`, `pip`, `uv`, `cargo`, `dotnet`):

- **Typische Einsatzfälle:** Standard-Quality-Stacks (z. B. Biome + Knip + TypeScript für JS-Projekte oder PHPStan + Pint für PHP-Projekte).
- **1-Klick-Snapshot:** Übernimmt bestehende `prod`- und/oder `dev`-Pakete aus einem vorhandenen Projekt als neues Dev-Bündel (optional mit gepinnten Versionen).
- **Projekt-Abgleich:** Zeigt vor der Installation genau an, welche Pakete im geöffneten Projekt bereits aktuell, veraltet oder fehlend sind, und installiert ausgewählte Pakete gebündelt.
- **Teilen im Team:** Einzelne Dev-Bündel lassen sich als JSON exportieren und in anderen Instanzen importieren.
