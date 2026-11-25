# Archiv, Ordnerstruktur & Metadaten

Das **Archiv** ist deine eigene, unabhängige Software-Bibliothek auf einem lokalen Laufwerk, einer externen Festplatte oder einem Netzlaufwerk (NAS/SMB). Alle Pfade in `data/catalog.json` werden relativ gespeichert, sodass das Archiv jederzeit verschoben oder unter einem anderen Laufwerksbuchstaben eingebunden werden kann.

---

## 1. Multi-Root-Archive & Offline-Resilienz

In **Einstellungen -> Archiv & Downloads** kannst du einen oder mehrere Archiv-Wurzelordner definieren (z. B. `\\NAS\Software` als Primärarchiv #1 und `D:\LocalSoftware` als Sekundärarchiv #2):

* **Prioritätsreihenfolge:** Die Reihenfolge lässt sich per Drag & Drop oder Pfeil-Buttons festlegen. Das oberste erreichbare Archiv gilt als Primärarchiv für neue Downloads.
* **Automatisches Zusammenführen:** Existiert dieselbe Software (erkannt über `packageId`/`wingetId` oder normalisierten Namen) in mehreren Archiven, werden Setup-Dateien, Screenshots, Links und fehlende Metadaten zusammengeführt. Im Detail-Dialog wird jede Setup-Datei mit ihrer Quelle gekennzeichnet (z. B. `[#1 NAS/Software]`).
* **Offline-Resilienz:** Ist ein Netzlaufwerk beim Scannen offline, wird es übersprungen. Bereits bekannte Einträge aus `data/catalog.json` bleiben im Katalog sichtbar und werden als offline markiert, während erreichbare Zweitarchive normal weiter funktionieren.

---

## 2. Ordnerstruktur eines Programms

Halte deine Struktur innerhalb eines Archiv-Wurzelordners möglichst flach (optional kann in den Einstellungen **Tiefen-Scanner / Nested Scanning** mit einstellbarer Tiefe aktiviert werden). Ein Ordner wird als Programm erkannt, sobald darin der Unterordner **`_metadata`** existiert:

```text
SoftwareArchiv/
└── VLC_Media_Player/
    ├── _metadata/
    │   ├── meta.json        # Programm-Metadaten (Beschreibung, IDs, Online-Quelle, Silent-Config)
    │   ├── icon.png         # App-Icon (beliebige Datei mit Präfix "icon.")
    │   ├── silent.inf       # Optional: aufgezeichnete Inno-Setup-Antwortdatei
    │   ├── screen1.png      # Screenshots (werden in der Lightbox angezeigt)
    │   └── demo.mp4         # Videos (werden ebenfalls in der Lightbox abgespielt)
    ├── _last/               # Optional: Pinnt bestimmte Setup-Dateien dauerhaft als primäre Downloads
    ├── _archive/            # Optional: Zielordner des manuellen Archiv-Aufräumers für ältere Versionen
    ├── vlc-3.0.21-win64.exe # Setup-Dateien direkt im Programmordner (Standardfall)
    └── vlc-3.0.20-win64.exe
```

### Setup-Dateien & der `_last`-Ordner

* **Standardfall:** Setup-Dateien (`.exe`, `.msi`, `.zip` - konfigurierbar über `autoExtensions`) liegen direkt im Programmordner. Der Scanner sortiert sie automatisch absteigend nach der höchsten erkannten Versionsnummer.
* **Pinning via `_last/`:** Existiert ein nicht-leerer Unterordner `_last`, werden gezielt dessen Dateien als primäre Setups verwendet. Zudem schützt ein vorhandener `_last`-Ordner das Programm zwingend vor dem Archiv-Aufräumer.

### Medien & Icons

* **Icon-Priorität:** `_metadata/icon.*` (`.png`, `.ico`, `.svg`, `.webp`, `.jpg`, `.jpeg`, `.gif`, `.avif`) hat immer höchste Priorität. Fehlt ein eigenes Icon, greift die App automatisch auf das extrahierte lokale PC-Icon oder den persistenten Icon-Cache zurück.
* **Galerie:** Alle weiteren Bilder und Videos (`.mp4`, `.webm`, `.ogg`, `.mov`, `.avi`) im `_metadata`-Ordner erscheinen als klickbare Galerie mit Vollbild-Lightbox.
* **Komfort-Funktionen:** Medien und Icons lassen sich im In-App-Editor direkt per Drag & Drop hinzufügen oder aus einer lokalen `.exe`-Datei extrahieren. Neue Software-Ordner können einfach auf das App-Fenster gezogen werden.

---

## 3. Referenz: `_metadata/meta.json`

Du kannst Programme vollständig über den In-App-Editor pflegen (inkl. **Autofill** aus Paketquellen/Web) oder die `meta.json` direkt bearbeiten:

```json
{
  "name": "VLC Media Player",
  "softwareType": "default",
  "category": "Multimedia",
  "hiddenCategory": "",
  "tags": ["Video", "Audio", "Player", "Open Source"],
  "formats": [".mkv", ".mp4", ".mp3"],
  "os": ["Windows 10", "Windows 11"],
  "description": "Freier, plattformübergreifender Multimedia-Player.",
  "searchNames": ["VLC media player"],
  "installPaths": [],
  "autoPaths": ["C:\\Program Files\\VideoLAN\\VLC\\vlc.exe"],
  "packageManager": "winget",
  "packageId": "VideoLAN.VLC",
  "wingetId": "VideoLAN.VLC",
  "keepAllVersions": false,
  "installMode": "interactive",
  "silentArgs": "/S",
  "innoInfFile": "",
  "webSourceType": "winget",
  "githubAssetPattern": "",
  "webVersionUrl": "",
  "webVersionPrefix": "",
  "webVersionSuffix": "",
  "downloadUrl": "",
  "dlPrefix": "",
  "dlSuffix": "",
  "webVersion": "3.0.21",
  "links": {
    "Offizielle Website": "[https://www.videolan.org/vlc/](https://www.videolan.org/vlc/)"
  }
}
```

### Wichtige Felder im Überblick

| Feld | Beschreibung |
| --- | --- |
| `softwareType` | `default` (Standardprogramm), `portable` (keine PC-Pfad-Warnung) oder `driver` (Treiberpaket). |
| `hiddenCategory` | Blendet den Eintrag standardmäßig aus, bis diese Kategorie in den Einstellungen sichtbar geschaltet wird. |
| `packageManager` / `packageId` | Verknüpft den Archiv-Ordner mit einem Paketmanager (z. B. `winget` + `VideoLAN.VLC` oder `scoop` + `extras/neovim`). `wingetId` wird abwärtskompatibel synchron gehalten. |
| `installMode` | `interactive` (Standard), `silent` (Opt-in) oder `interactive-required` (harter Adware-Schutz). |
| `silentArgs` / `innoInfFile` | Benutzerdefinierte Silent-Parameter sowie optionaler Dateiname einer Inno-`.inf`-Antwortdatei in `_metadata/`. |
| `keepAllVersions` | Bei `true` wird das Programm vom manuellen Archiv-Aufräumer dauerhaft geschützt. |
| `webSourceType` | Quelle für Online-Versionsprüfungen: `none`, `winget`, `provider`, `github` oder `web`. |

---

## 4. Online-Update-Quellen & Visuelle Assistenten

Im Editor-Tab **Online-Updates** lassen sich vier Quellarten konfigurieren:

1. **Paketmanager (Winget / Provider):** Nutzt die Metadaten und Download-URLs des verknüpften Paketmanagers (bei Winget inkl. direktem Setup-Download ins Archiv).
2. **GitHub Releases:** Liest automatisch das neueste Release über die GitHub-API aus. Über `githubAssetPattern` (z. B. `win64.exe`) lässt sich das gewünschte Asset exakt auswählen.
3. **Webseite (Visueller Scraper & Link-Picker):**
   * **Version auf Seite markieren:** Öffnet die Webseite in einer isolierten Browser-Session; nach Markieren der Versionsnummer berechnet die App automatisch Präfix und Suffix im HTML.
   * **Download-Link auswählen:** Erkennt direkte Links, `{version}`-URL-Templates oder fängt dynamische JS-Downloads automatisch ab (ohne die Datei doppelt herunterzuladen).
4. **Auto-Benennung:** Heruntergeladene Setups werden automatisch nach dem konfigurierten Muster benannt (Standard: `{Name}_v{Version}{Arch}{Ext}`), sofern der Originalname nicht bereits eine Version enthält.

---

## 5. Scan-Modi & Manueller Archiv-Aufräumer

### Die drei Scan-Modi

* **Archiv prüfen (Smart-Scan, Standard):** Prüft anhand der Ordner-Zeitstempel (`scanMtime`), ob neue Programme, geänderte `meta.json`-Dateien oder neue Setups hinzugekommen sind, und parst nur geänderte Ordner neu.
* **Alle Metadaten neu einlesen (`--update`):** Liest gezielt alle bekannten Einträge neu ein, ohne das komplette Dateisystem neu zu durchwandern.
* **Vollständiger Archiv-Rescan (`--full`):** Verwirft den Scan-Cache und indiziert alle Archiv-Wurzeln komplett neu.

*(Einzelne Änderungen im Editor lösen immer nur einen blitzschnellen `--single`-Scan für genau diesen Ordner aus.)*

### Manueller Archiv-Aufräumer

Über das `...`-Menü in der Toolbar (**Archiv aufräumen**) lässt sich alter Ballast sicher reduzieren:

* Läuft **niemals** automatisch, sondern immer mit vorheriger Live-Vorschau (Anzahl Dateien & freigewordener Speicherplatz) und expliziter Bestätigung.
* Behält pro Programm die `N` neuesten Versions-Slots (Standard: `2`; verschiedene Architekturen derselben Version wie `x64` und `x86` teilen sich einen Slot).
* Zwei Aktionsmodi: **In `_archive/` verschieben** (Standard, verlustfrei) oder **In den Papierkorb verschieben**.
* **Garantierter Schutz:** Programme mit einem `_last`-Ordner oder dem Flag `keepAllVersions: true` werden niemals angetastet.
