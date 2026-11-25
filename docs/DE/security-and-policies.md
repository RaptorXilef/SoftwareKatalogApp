# Sicherheit, Richtlinien & Hintergrundbetrieb

Software Katalog ist von Grund auf so konzipiert, dass sowohl Privatanwender sicher vor ungewollter Beigabe-Software bleiben als auch Administratoren Arbeitsplätze kontrolliert verwalten können.

---

## 1. Installationsmodi & Adware-/Klick-Schutz

Stille Installationen sind im gesamten Programm **strikt opt-in**. Der Standardmodus bleibt immer interaktiv.

Für jedes Archiv-Programm stehen drei Modi zur Verfügung:

| Modus                                      | Verhalten                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`interactive` (Standard)**               | Startet den regulären Setup-Assistenten mit sichtbaren Dialogen.                                                                                                 |
| **`silent`**                               | Führt das Setup still im Hintergrund mit konfigurierten Parametern (`silentArgs`) und optionaler Inno-`.inf`-Antwortdatei (`/LOADINF`) aus.                      |
| **`interactive-required` (Adware-Schutz)** | **Harte Sperre:** Erzwingt immer die interaktive Ausführung. Sämtliche Silent-Parameter, `.inf`-Dateien sowie Massen-/Auto-Update-Silent-Flags werden ignoriert. |

### Automatische Installer-Analyse & Adware-Heuristik

Im Editor unter **PC-Erkennung** analysiert der Installer-Detektor lokale `.exe`- und `.msi`-Dateien **ohne sie auszuführen** (nur sicheres Auslesen von Datei-Header und Overlay-Strings):

- Erkennt **MSI**, **Inno Setup**, **NSIS**, **WiX Burn** und **InstallShield** und schlägt passende Silent-Parameter vor.
- Für **Inno Setup** lassen sich Installations-Häkchen einmalig per `/SAVEINF` in eine Antwortdatei (`_metadata/silent.inf`) aufzeichnen.
- Erkennt bekannte Adware-/Bundle-Kandidaten (über Name, Paket-ID, Herausgeber und PE-Marker wie `OpenCandy`, `InstallCore`, `InstallIQ`) und empfiehlt automatisch den Schutzmodus `interactive-required`.

---

## 2. Admin-Sitzung (Einmal-UAC)

Bei größeren Update-Warteschlangen oder Bündeln lösen einzelne Windows-Installer sonst wiederholte UAC-Abfragen aus. Über die Schaltfläche **Admin-Modus** im Header (oder optional automatisch ab 2 Paketen) lässt sich eine zeitlich auf die App-Laufzeit begrenzte Admin-Sitzung aktivieren:

- Startet einmalig per UAC den isolierten Hintergrund-Worker `elevated-worker.mjs` (`ELECTRON_RUN_AS_NODE=1`).
- Die Kommunikation erfolgt über eine zufällig benannte **Windows Named Pipe** (`\\.\pipe\SoftwareKatalog_Elev_<random>`) mit einem **256-Bit-Sitzungstoken** (geprüft via `crypto.timingSafeEqual`).
- Ein Parent-Watchdog beendet den Helper automatisch, sobald die Haupt-App geschlossen wird.
- Läuft die App bereits erhöht als Administrator, werden Befehle direkt ohne zusätzlichen Helper ausgeführt.

---

## 3. Admin-Login & Zugriffsrichtlinien (Enterprise / Mehrbenutzer)

Unter **Einstellungen -> Sicherheit & Richtlinien** lässt sich ein administrativer Schreibschutz aktivieren. Alle sensiblen IPC-Kanäle (Einstellungen, Katalog-Bearbeitung, Provider-Verwaltung, Archiv-Aufräumer, Bündel-Bearbeitung, Dev-Aktionen) werden im Main-Prozess serverseitig blockiert, solange keine gültige Admin-Sitzung besteht.

### Kryptografie & Manipulationsschutz

- **Passwort-Speicherung:** Gesalzenes `scrypt`-Hashing (`N=16384, r=8, p=1, keylen=64`) mit 16-Byte-Zufallssalt und konstant-zeitlicher Verifikation (`timingSafeEqual`).
- **Integritätsprüfung (`admin-policy.json`):** Jede Policy-Datei trägt eine kanonische **SHA-256-Prüfsumme**. Bei Manipulation oder beschädigter Datei greift ein **Fail-Closed**-Mechanismus: Administrative Aktionen und Paket-Installationen bleiben gesperrt.
- **Session-Timeout:** Optional automatische Abmeldung nach konfigurierbarer Inaktivität.
- **Read-Only-Schutz:** Liegt die Policy-Datei auf einer schreibgeschützten Netzwerkfreigabe, erkennt die App dies automatisch und verhindert lokale Überschreibversuche.

### Zentrale Policy-Verteilung & HKLM-Registry-Sperre

Die Policy-Datei wird nach folgender Priorität aufgelöst:

1. **Windows-Registry (HKLM, höchste Priorität):** `HKLM\SOFTWARE\Policies\SoftwareKatalog`, Zeichenfolge `PolicyFilePath`. Ist dieser Wert gesetzt (z. B. per Gruppenrichtlinie/GPO oder direkt über die Einstellungen mit UAC), können Endnutzer den Pfad in `config.json` nicht mehr umbiegen.
2. **Konfigurierter Pfad (`authFilePath` in `config.json`).**
3. **Standardpfad (`data/admin-policy.json`).**

### Paket-Zugriffsrichtlinien (Whitelist / Blacklist)

- **Geltungsbereich:** Entweder gemeinsam (`shared`) oder getrennt (`separate`) für **Updates** und **Neuinstallationen**.
- **Regeltypen:** Abgleich nach `packageId`, `archiveId`, `name` (inkl. `*`-Wildcards) oder ganzem `provider`. Spezifischere Regeln überschreiben allgemeinere (`packageId > archiveId > name > provider`).
- **Ausführungsmodus:** `allow-interactive` oder `silent-only` (global und pro Eintrag überschreibbar).
- **Adware-Konfliktschutz:** Erzwingt eine Richtlinie `silent-only` für ein Paket, das gleichzeitig durch `interactive-required` geschützt ist, wird die Ausführung sicher **blockiert**, statt still Adware zu installieren.
- **Portabilität:** Richtlinien können als JSON exportiert und auf anderen Systemen importiert werden.

---

## 4. System-Tray, Autostart & Hintergrund-Updates

Unter **Einstellungen -> Hintergrund & Updates** lässt sich die App als laufender Update-Assistent einrichten:

- **System-Tray:** Optionales Minimieren in den Infobereich beim Schließen (`minimizeToTrayOnClose`). Die App unterstützt zudem die Startparameter `--tray` und `--minimized`.
- **Windows-Autostart:**
  - **Normal:** Regulärer Benutzer-Autostart via Windows-LoginItem (`--tray`).
  - **Admin-Modus:** Richtet eine Windows-Aufgabenplanung (`SoftwareKatalog_AdminAutostart`) mit höchsten Privilegien ein, damit Hintergrund-Updates ohne UAC-Unterbrechung laufen können.
- **Periodische Update-Checks:** Prüft in einstellbaren Intervallen (1, 3, 6, 12 oder 24 Stunden) im Hintergrund auf Updates.
- **Anti-Spam-Benachrichtigungen:** Merkt sich bereits gemeldete Zielversionen (`notifiedUpdateVersions`) und benachrichtigt nur bei wirklich neuen Updates.
- **Stilles Auto-Update (Opt-in):**
  - Wird nur ausgeführt, wenn die App mit erhöhten Rechten läuft und nicht pausiert ist.
  - Unterstützt eine eigene Auto-Update-Regelung (`Alle`, `Whitelist`, `Blacklist`).
  - Respektiert zwingend die Ignorierliste, aktive Zugriffsrichtlinien und überspringt strikt alle Pakete mit `interactive-required` oder Adware-Signalen.
