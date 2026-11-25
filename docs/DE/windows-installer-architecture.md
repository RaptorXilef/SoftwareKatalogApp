# Windows-Installer, Architektur (x64 vs. ia32) & Datenpfade

## Warum nur 64-Bit (x64) fuer Windows gebaut wird

Das Projekt verwendet `electron@45.2.3`. Ab **Electron 44** liefert Electron offiziell keine 32-Bit-Windows-Binaries (`win32-ia32`) mehr aus. Die offiziellen Release-Assets fuer `electron` `v45.2.3` enthalten fuer Windows ausschliesslich:

- `electron-v45.2.3-win32-x64.zip` (64-Bit)
- `electron-v45.2.3-win32-arm64.zip` (ARM64)

Eine Konfiguration von `ia32` unter `build.win.target` in `package.json` wuerde bei `electron-builder` unweigerlich zu einem Download-/Build-Fehler fuehren, weil kein `electron-v45.2.3-win32-ia32.zip` existiert. Daher baut `package.json` sauber und fehlerfrei die drei Windows-`x64`-Ziele:

- `SoftwareKatalog-Setup-x64.exe` (NSIS-Installer)
- `SoftwareKatalog-Portable.exe` (Portable Einzel-EXE)
- `Software Katalog-<version>-win.zip` (Entpackbares ZIP-Archiv)

## Self-Updater-Kompatibilitaet fuer `ia32`

Die reine Asset-Auswahllogik in `src/shared/app-update-logic.js` sowie `src/main/app-updater.js` unterstuetzt weiterhin sowohl `x64` als auch `ia32`:

- `installed` + `x64` -> waehlt `*-Setup-x64.exe` (Fallback: architekturneutrales `*-Setup.exe`)
- `installed` + `ia32` -> waehlt `*-Setup-ia32.exe` (installiert niemals versehentlich ein `x64`-Setup auf `ia32`)
- `portable-exe` -> waehlt `*-Portable.exe`
- `portable-dir` -> waehlt das Windows-`*.zip`-Asset

## NSIS-Installer & Schreibschutz unter `Program Files`

Der NSIS-Installer (`build.nsis` in `package.json`) ist benutzerfreundlich konfiguriert (`oneClick: false`, `perMachine: false`, `allowElevation: true`, `allowToChangeInstallationDirectory: true`, Desktop- & Startmenue-Verknuepfung, `deleteAppDataOnUninstall: false`).

Beim Start erkennt `src/main/config.js` (`getInstallInfo()`):

1. `portable-exe`: `process.env.PORTABLE_EXECUTABLE_DIR` ist gesetzt.
2. `installed`: Die App liegt in `Program Files`, `Program Files (x86)`, `AppData\Local\Programs` oder enthaelt einen NSIS-Uninstaller (`Uninstall Software Katalog.exe`) im App-Ordner.
3. `portable-dir`: Entpackter ZIP-Ordner (oder Entwicklungsmodus).

Bei einer systemweiten Installation (`Program Files` ist schreibgeschuetzt) weicht `getDataFolder()` automatisch auf einen beschreibbaren Benutzer-/Systempfad aus:

- All-Users-Installation (`Program Files`): `%ProgramData%\SoftwareKatalog\data` (falls beschreibbar, sonst `%APPDATA%\SoftwareKatalog\data`)
- Per-User-Installation (`AppData\Local\Programs` oder eigener Ordner): `<AppFolder>\data` falls beschreibbar, sonst `%APPDATA%\SoftwareKatalog\data`
- Portabel (`portable-exe` / `portable-dir`): `<AppFolder>\data`
