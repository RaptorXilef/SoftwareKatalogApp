# 🗂️ Software Katalog

Ein portabler, blitzschneller Katalog für Netzlaufwerke (NAS) zur Verwaltung und Strukturierung von Software-Installationsdateien. Basierend auf Electron und Node.js.

---

## 🚀 Installation & Einrichtung auf dem NAS

Um die Anwendung auf deinem NAS/Laufwerk bereitzustellen, benötigst du genau drei Dateien aus dem aktuellen Release:

1. `SoftwareKatalog.exe`
2. `scanner.mjs`
3. `config.json`

### 1. Ordnerstruktur anlegen

Erstelle im Hauptverzeichnis deines Netzlaufwerks (z. B. `Z:\`) einen neuen Ordner namens **`SoftwareKatalogApp`**.
Lege die drei heruntergeladenen Dateien genau dort hinein.

### 2. Die `config.json` konfigurieren

Öffne die `config.json` mit einem Texteditor. Hier legst du fest, welcher Ordner gescannt werden soll.

```json
{
  "targetPath": "../software",
  "jsonPath": "catalog.json",
  "scriptPath": "scanner.mjs"
}
```

* **`targetPath`:** Der Pfad zu deinen Software-Ordnern. `../software` bedeutet, das Skript geht von `Z:\SoftwareKatalogApp` einen Ordner nach oben und sucht dann im Ordner `software`. Du kannst hier auch absolute Pfade wie `Z:\\software` angeben.

---

## 🛠️ Systemvoraussetzungen (Node.js)

* **Zum reinen Betrachten und Öffnen:** Keine Installation notwendig. Jeder im Heimnetzwerk kann die `.exe` einfach per Doppelklick starten.
* **Um den Katalog zu scannen (aktualisieren):** Auf dem PC der Person, die auf "Scannen" klickt, muss **Node.js** installiert sein, da die `.exe` im Hintergrund das Skript `scanner.mjs` aufruft.
  * *Empfehlung:* Nutze **NVM (Node Version Manager) für Windows** und installiere die aktuelle **LTS-Version (z.B. v20)**.

---

## 📂 Strukturierung der Software

Der Scanner durchsucht deine Ordnerstruktur automatisch. Damit ein Ordner als "Software" erkannt wird, muss darin lediglich ein Ordner namens `_metadata` existieren.

### Der `_metadata` Ordner

**Mindestanforderung:** Der Ordner `_metadata` muss existieren. Wenn er leer ist, wird die Software trotzdem erkannt (die App nutzt dann einfach den Namen des übergeordneten Ordners).

**Optional: Die `meta.json`**Du kannst im `_metadata`-Ordner eine einzige Datei namens `meta.json` anlegen, um die Darstellung in der App aufzuwerten. Alle Felder sind freiwillig.

Beispiel einer `meta.json`:

``` json
{
  "name": "Offizieller Name der Software",
  "category": "Video",
  "tags": ["Player", "Streaming", "Open Source"],
  "formats": [".mkv", ".mp4", ".flv"],
  "os": ["Windows 10", "Windows 11", "macOS"],
  "description": [
    "Kurzer, prägnanter Einleitungssatz.",
    "",
    "<b>Hauptmerkmale:</b>",
    "• Merkmal 1",
    "• Merkmal 2"
  ],
  "links": {
    "Offizielle Website": "https://...",
    "Dokumentation": "https://..."
  }
}
```

**Bilder im `_metadata`-Ordner:**

* **Das Icon:** Eine Bilddatei (`.png`, `.jpg`, `.ico`, `.svg`), die exakt mit `icon.` beginnt (z. B. `icon.png`), wird als App-Logo verwendet.
* **Screenshots:** Alle weiteren Bilddateien in diesem Ordner (die *nicht* mit `icon.` beginnen) werden automatisch als klickbare Screenshot-Galerie eingebunden.

| Dateiname | Inhalt / Funktion | Beispiel |
| :--- | :--- | :--- |
| `icon.png` / `.ico` / `.jpg` / `.svg` | Das Logo der Software. **Muss** mit `icon.` beginnen! | *(Bilddatei)* |
| `(beliebiger Name).jpg` / `.png` / `.webp` | Alle Bilder im Ordner, die **nicht** `icon.` heißen, werden als Screenshots angezeigt. | `interface.png`, `bild1.jpg` |

### Der `_last` Ordner (Für Downloads)

Neben dem `_metadata`-Ordner kannst du einen Ordner namens **`_last`** anlegen.

* **Funktion:** In der App erscheint dadurch ein "Download"-Button. Klickt man darauf, wählt man einen Zielordner auf dem eigenen PC, und alle Dateien aus `_last` werden dorthin kopiert.
* **Dateinamen:** Die Namen und Dateiendungen in `_last` sind **völlig egal**. Das können eine oder auch zehn Dateien sein.
* **Beispiel:** Du kannst dort `setup.exe`, `plugin_v2.zip` und `liesmich.pdf` hineinlegen. Die App kopiert einfach alles, was sich in diesem Ordner befindet.

---

## 🔄 Die Scan-Optionen

In der Programmoberfläche (UI) hast du zwei Möglichkeiten, den Katalog zu aktualisieren:

1. **Neu scannen (Inkrementell):**
   * *Nutzen:* Wenn du komplett neue Software-Ordner hinzugefügt hast.
   * *Verhalten:* Überspringt blitzschnell alle Ordner, die bereits im Katalog stehen.
   * *Vorteil:* Sehr schnell und netzwerkschonend.
2. **Vollständiger Rescan:**
   * *Nutzen:* Wenn du Metadaten (z. B. Beschreibung, Links) oder Dateien im `_last`-Ordner bei einer **bereits bekannten** Software geändert hast.
   * *Verhalten:* Ignoriert den bisherigen Katalog und liest jede Datei auf dem NAS komplett neu ein.

---

## 📄 Lizenzen & Mitwirkung

* **Lizenz:** Dieses Projekt steht unter einer ShareAlike-Lizenz (siehe [LICENSE.md](./LICENSE.md)). Es darf frei genutzt, bearbeitet und geteilt werden, solange Namensnennung erfolgt und abgeleitete Werke unter denselben Bedingungen geteilt werden.
* **Mitwirken:** Wenn du Code beisteuern möchtest, lies dir bitte unsere [CONTRIBUTING.md](./CONTRIBUTING.md) sowie die [CLA.md](./CLA.md) durch.
* **Changelog:** Alle Änderungen werden im [CHANGELOG.md](./CHANGELOG.md) dokumentiert.
