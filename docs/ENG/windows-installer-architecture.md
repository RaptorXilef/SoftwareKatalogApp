# Windows Installer, Architecture (x64 vs. ia32) & Data Paths

## Why Only 64-Bit (x64) Is Built for Windows

This project uses `electron@45.2.3`. Starting with **Electron 44**, Electron no longer officially ships 32-bit Windows binaries (`win32-ia32`). The official release assets for `electron` `v45.2.3` on Windows exclusively include:

- `electron-v45.2.3-win32-x64.zip` (64-bit)
- `electron-v45.2.3-win32-arm64.zip` (ARM64)

Configuring `ia32` under `build.win.target` in `package.json` would inevitably cause `electron-builder` to fail with a download/build error because `electron-v45.2.3-win32-ia32.zip` does not exist. Therefore, `package.json` cleanly builds the three Windows `x64` targets without errors:

- `SoftwareKatalog-Setup-x64.exe` (NSIS Installer)
- `SoftwareKatalog-Portable.exe` (Portable Single EXE)
- `Software Katalog-<version>-win.zip` (Extractable ZIP Archive)

## Self-Updater Compatibility for `ia32`

The pure asset selection logic in `src/shared/app-update-logic.js` as well as `src/main/app-updater.js` continues to support both `x64` and `ia32`:

- `installed` + `x64` -> selects `*-Setup-x64.exe` (fallback: architecture-neutral `*-Setup.exe`)
- `installed` + `ia32` -> selects `*-Setup-ia32.exe` (never accidentally installs an `x64` setup on `ia32`)
- `portable-exe` -> selects `*-Portable.exe`
- `portable-dir` -> selects the Windows `*.zip` asset

## NSIS Installer & Write Protection under `Program Files`

The NSIS installer (`build.nsis` in `package.json`) is configured to be user-friendly (`oneClick: false`, `perMachine: false`, `allowElevation: true`, `allowToChangeInstallationDirectory: true`, Desktop & Start Menu shortcuts, `deleteAppDataOnUninstall: false`).

At startup, `src/main/config.js` (`getInstallInfo()`) detects:

1. `portable-exe`: `process.env.PORTABLE_EXECUTABLE_DIR` is set.
2. `installed`: The app is located in `Program Files`, `Program Files (x86)`, `AppData\Local\Programs`, or contains an NSIS uninstaller (`Uninstall Software Katalog.exe`) in the app folder.
3. `portable-dir`: Extracted ZIP folder (or development mode).

For a system-wide installation (`Program Files` is write-protected), `getDataFolder()` automatically falls back to a writable user/system path:

- All-users installation (`Program Files`): `%ProgramData%\SoftwareKatalog\data` (if writable, otherwise `%APPDATA%\SoftwareKatalog\data`)
- Per-user installation (`AppData\Local\Programs` or custom folder): `<AppFolder>\data` if writable, otherwise `%APPDATA%\SoftwareKatalog\data`
- Portable (`portable-exe` / `portable-dir`): `<AppFolder>\data`
