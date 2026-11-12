# 🗂️ Software Katalog

Ein portabler, blitzschneller Katalog für Netzlaufwerke (NAS) zur Verwaltung und Strukturierung von Software-Installationsdateien. Basierend auf Electron.

Dank Lazy-Loading, relativem Caching und optimierten Hintergrundprozessen startet die App selbst bei hunderten Programmen über langsame SMB-Netzlaufwerke in 1-2 Sekunden.

---

## 🚀 Installation & Einrichtung auf dem NAS

Um die maximale Startgeschwindigkeit über das Netzwerk zu garantieren, wird die App **nicht** als eine einzelne, komprimierte `.exe`-Datei ausgeliefert, sondern als entpackter Ordner.

### 1. Dateien auf das NAS kopieren
1. Lade das aktuelle Release (`SoftwareKatalog-NAS-Version.zip`) herunter.
2. Erstelle auf deinem Netzlaufwerk (z. B. `Z:\`) einen neuen Ordner, z. B. `Z:\SoftwareKatalogApp`.
3. Entpacke den **kompletten Inhalt** des ZIP-Archivs in diesen Ordner.
4. Lege das Skript `scanner.mjs` in das Hauptverzeichnis (neben die `Software Katalog.exe`).

Jeder im Heimnetzwerk kann nun einfach die `Software Katalog.exe` per Doppelklick starten. Es ist **keine Installation von Node.js mehr nötig**, da die App völlig autark arbeitet!

### 2. Ersteinrichtung (UI)
Beim allerersten Start erstellt die App automatisch eine `config.json`. Klicke in der App oben rechts auf das **Zahnrad (Einstellungen)**:
- Wähle über "Wählen" den Pfad zu deinem Software-Hauptordner auf dem NAS aus.
- Klicke auf "Speichern & Anwenden".

---

## 📂 Strukturierung der Software (Dateisystem)

Der Scanner durchsucht deine NAS-Ordner automatisch. Halte deine Ordnerstruktur flach (z.B. `Z:\software\VLC_Mediaplayer`).

Damit ein Programm im Katalog erscheint, muss im entsprechenden Ordner lediglich ein Unterordner namens **`_metadata`** existieren.

### Der `_metadata` Ordner
Wenn der Ordner existiert (selbst wenn er leer ist), erkennt die App das Programm. Du kannst Software-Informationen auf zwei Wegen hinzufügen:

**Option 1: Der bequeme Weg (In-App Editor)**
Klicke in der App auf "➕ Software hinzufügen". Wähle einen Ordner aus. Die App erstellt das `_metadata`-Verzeichnis und eine leere `meta.json` automatisch. Klicke danach in der App auf "✏️ Bearbeiten", um Beschreibungen, Tags, versteckte Kategorien und Links bequem in der Benutzeroberfläche einzutippen!

**Option 2: Der manuelle Weg (`meta.json`)**
Du kannst die `meta.json` auch manuell im `_metadata`-Ordner anlegen.
Beispiel:
```json
{
  "name": "Offizieller Name der Software",
  "category": "Video",
  "hiddenCategory": "Privat",
  "tags": ["Player", "Streaming"],
  "formats": [".mkv", ".mp4"],
  "os": ["Windows 10", "Windows 11", "macOS"],
  "description": [
    "Kurzer Einleitungssatz.",
    "<b>Hauptmerkmale:</b>",
    "• Merkmal 1",
    "• Merkmal 2"
  ],
  "links": {
    "Offizielle Website": "https://..."
  }
}
```

**Bilder hinzufügen:**
Öffne das Programm in der App und klicke auf "Bilderordner öffnen". Ziehe deine Bilder einfach in den Windows Explorer:
- **Das Icon:** Eine Bilddatei, die exakt mit `icon.` beginnt (z. B. `icon.png`, `icon.ico`, `icon.jpg`, `icon.svg` oder `icon.webp`), wird als App-Logo verwendet.
- **Screenshots:** Alle weiteren Bilder in diesem Ordner werden automatisch als klickbare Screenshot-Galerie (Lightbox) eingebunden. (jpg, png, gif, webp, svg)

### Der `_last` Ordner (Für Downloads)
Lege neben dem `_metadata`-Ordner einen Ordner namens **`_last`** an.
- Packe dort deine Setups (`setup.exe`, `lizenz.pdf`, `.zip`) hinein.
- In der App erscheint dadurch ein "Download"-Button. Klickt der Nutzer darauf, kann er einen lokalen Ordner auf seinem PC wählen, und alle Dateien aus `_last` werden automatisch dorthin kopiert.

---

## 🔄 Die Scan-Optionen (Katalog aktualisieren)

In der Toolbar findest du drei Scan-Möglichkeiten:

1. **Neu scannen:** (Für komplett neue Software). Überspringt bekannte Ordner und liest nur neue Ordner ein.
2. **Metadaten aktualisieren:** (Für Änderungen an Bildern oder Texten). Ignoriert das Dateisystem und aktualisiert blitzschnell nur die bereits bekannten Programme aus der `meta.json`.
3. **Vollständiger Rescan:** Verwirft den bisherigen Cache und liest das komplette Laufwerk von null auf neu ein.

*(Die Katalog-Datenbank (`catalog.json`) nutzt ausschließlich relative Pfade. Du kannst das NAS-Laufwerk jederzeit klonen oder den Laufwerksbuchstaben ändern, ohne dass der Katalog kaputtgeht!)*

---

## ⚙️ Features & Einstellungen

Klicke auf das Zahnrad-Symbol (Einstellungen), um das Verhalten der App anzupassen:
* **Tiefen-Scanner (Nested Scanning):** Erlaube dem Scanner, auch Unterordner zu durchsuchen, nachdem bereits ein `_metadata`-Ordner gefunden wurde.
* **Versteckte Kategorien:** Blende Software ein oder aus, die du in der `meta.json` einer `hiddenCategory` (z. B. "Hacking" oder "Privat") zugewiesen hast.
* **Auto-Updater:** Die App prüft über die GitHub-API automatisch im Hintergrund (z. B. täglich oder wöchentlich), ob neue Versionen verfügbar sind, und zeigt einen Update-Link im Header an.

---

## 📄 Lizenzen & Mitwirkung

- **Lizenz:** Dieses Projekt ("Software Katalog") steht unter der **Creative Commons Namensnennung - Weitergabe unter gleichen Bedingungen 4.0 International (CC BY-SA 4.0)** (siehe [LICENSE.md](./LICENSE.md)). Es darf frei genutzt, bearbeitet und geteilt werden, solange Namensnennung (Felix Maywald / RaptorXilef) erfolgt und abgeleitete Werke unter denselben Bedingungen geteilt werden.
- **Mitwirken:** Wenn du Code beisteuern möchtest, lies dir bitte unsere [CONTRIBUTING.md](./CONTRIBUTING.md) sowie die [CLA.md](./CLA.md) durch.
- **Changelog:** Alle Änderungen werden im [CHANGELOG.md](./CHANGELOG.md) dokumentiert.
