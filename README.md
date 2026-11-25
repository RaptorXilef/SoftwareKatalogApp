# Software Catalog

[German/Deutsch](./README.de.md)

A portable, fast software catalog, Windows package manager, and developer workspace built on Electron.

The application combines a local or network-based **software archive** (e.g., on a NAS or external drive) with **18 integrated package providers** (including Winget, MS Store, Scoop, Chocolatey, MSI, npm, pnpm, Bun, NVM, Composer, pip, uv, Cargo, vcpkg, .NET Tools, and PowerShell Gallery) as well as a dedicated **DEV workspace** for local coding projects.

---

## Highlights at a Glance

- **Centralized Update Management:** Detects updates from your own archive, Windows package managers, GitHub Releases, and websites, processing them via a strictly sequential **update queue** (with drag-and-drop prioritization and cancellation support).
- **Multi-Root Archive & Offline Resilience:** Connect multiple archive locations (e.g., NAS + local drive) with a defined priority order. Unreachable network drives are cleanly skipped while cached data remains intact.
- **18 Package Providers Under One Roof:** Install, update, search, and uninstall applications and CLI tools from a unified interface—including a 7-day offline cache and manager bootstrap.
- **Package Bundles & 1-Click PC Snapshot:** Assemble software collections for new PCs, export/import them as JSON, or create a snapshot of installed programs with a single click.
- **DEV Tab for Developer Projects:** Analyzes local projects across 10 ecosystems (`npm`, `pnpm`, `bun`, `yarn`, `composer`, `uv`, `pip`, `cargo`, `dotnet`, `vcpkg`), visualizes dependency trees/graphs, checks for security vulnerabilities (`audit`), and supports reusable dev bundles.
- **Security & Enterprise Features:** Strict opt-in silent mode with **adware/click protection**, one-time UAC **admin session**, password-protected admin login (`scrypt` + integrity check), whitelist/blacklist access policies (optionally locked via Windows HKLM registry), and a system tray with background auto-updates.
- **Multilingual (i18n):** Built-in support for English and German (with automatic system language detection) and extensible via custom language files without rebuilding.

---

## The 6 Main Sections of the Application

| Tab | Function |
| --- | --- |
| **Updates** | Displays all pending archive, web, and package manager updates. Supports multi-selection, bulk downloads into the archive, the sequential update queue, and an exportable ignore list. |
| **Installed** | Combines detected Windows programs (Registry, AppX/MS Store, package managers) with entries from the local archive, automatically extracts missing icons into the cache, and allows direct uninstallation or archiving. |
| **Archive** | Your personal software library with categories, tags, favorites, hidden categories, a screenshot/video lightbox, drag-and-drop folder ingestion, and an in-app metadata editor. |
| **Bundles** | Reusable installation profiles made up of archive and package manager programs with live status matching (`Up to date`, `Outdated`, `Missing`) and two-phase execution (silent first, then interactive). |
| **Install New** | Cross-provider search for new software including version selection, direct installation, optional archive storage, and a wizard for local `.msi` files. |
| **Dev** | Dedicated project workspace for local code repositories (manifest/lockfile analysis, SemVer tiered updates, scope switching, dependency graph, security audits, and dev bundles). Can optionally be hidden in Settings. |

---

## Installation & Distribution (Windows x64)

Current releases are available in the [GitHub Releases](https://github.com/RaptorXilef/SoftwareKatalogApp/releases) section in three variants (all 64-bit / `x64`, as Electron no longer supports 32-bit Windows starting with version 44):

1. **Installer (`SoftwareKatalog-Setup-x64.exe`):** Classic NSIS wizard (user or system-wide installation, custom target folder selection, Start Menu & desktop shortcuts).
2. **Portable Single EXE (`SoftwareKatalog-Portable.exe`):** A single executable file for USB drives or quick use without installation.
3. **Extractable ZIP Archive (`Software Katalog-<version>-win.zip`):** Recommended for network drives (NAS/SMB), as there is no extraction delay upon startup.

### Quick Start on PC or NAS

1. Install the app or extract the ZIP archive into a folder (e.g., `Z:\SoftwareKatalogApp` or `D:\Tools\SoftwareKatalog`).
2. Launch `Software Katalog.exe`—**no** pre-installed Node.js is required, and the built-in scanner (`resources/scanner.mjs`) is already integrated and ready to use.
3. Open **Settings** in the top-right corner and configure one or more archive folders under **Archive & Downloads** (e.g., `../software` or `\\NAS\Software`).
4. Click **Check Archive**, **Online Updates**, or **Scan PC** in the toolbar (all three can run in parallel and be canceled at any time).

The application automatically checks GitHub Releases for new app versions and selects the exact matching release asset (Setup, Portable EXE, or ZIP) via its integrated self-updater. Details on installation modes and writable data paths under `Program Files` can be found in [docs/windows-installer-architecture.md](./docs/windows-installer-architecture.md).

---

## Detailed Documentation

Dedicated guides for all advanced topics are available in the `docs/` folder:

- **[Archive, Folder Structure & Metadata](./docs/archive-and-metadata.md)** - Multi-root archives, `_metadata/meta.json` reference, icons & screenshots, `_last` pinning, online scrapers & manual archive cleaner.
- **[Package Managers & Providers](./docs/package-managers.md)** - Overview of all 18 integrated sources, bootstrap functions, custom registries/buckets, local MSI wizard, and Winget mapping wizard.
- **[DEV Workspace](./docs/dev-workspace.md)** - Project scanning for 10 developer ecosystems, dependency tree & graph, SemVer updates, security audits, and dev bundles.
- **[Security, Policies & Background Operation](./docs/security-and-policies.md)** - Adware protection, admin session (one-time UAC), admin login, whitelist/blacklist, HKLM registry lock, system tray, autostart, and auto-updates.
- **[Windows Installer & Data Paths](./docs/windows-installer-architecture.md)** - Architecture (`x64`), NSIS behavior under `Program Files`, and self-updater logic.
- **[Architecture & Development](./docs/architecture.md)** - Tech stack, process model, IPC security, project structure, and build/test workflows.
- **[Translations (i18n)](./docs/TRANSLATING.md)** - Adding new languages, testing locally in `data/locales/`, and validating translations.

---

## Local Development

Prerequisite: **Node.js (v20 LTS or newer)** on Windows.

```bash
git clone [https://github.com/RaptorXilef/SoftwareKatalogApp.git](https://github.com/RaptorXilef/SoftwareKatalogApp.git)
cd SoftwareKatalogApp
npm install
npm run dev
```

### Key npm Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Starts the app in development mode with hot reload (`electron-vite`). |
| `npm run fix:biome` / `npm run chk:biome` | Formats and lints code, CSS, and JSON using Biome. |
| `npm run typecheck` | Runs static type checking (`tsc -p jsconfig.json` with `checkJs`). |
| `npm test` | Executes the complete unit test suite (`node:test`) without host side effects. |
| `npm run chk:unused` | Checks for unused files, exports, and dependencies using Knip. |
| `npm run build:vite` | Builds main, preload, renderer, and standalone scanner bundles into `out/`. |
| `npm run build:dist` | Creates all Windows release artifacts (NSIS, Portable, ZIP) in `dist/`. |

---

## License & Contributing

- **Dual Licensing:** This project is subject to a **dual-licensing model** (see [LICENSE.md](./LICENSE.md)):
  - **Individuals & Non-Commercial Use:** Free to use, modify, and distribute for non-commercial purposes under the **PolyForm Noncommercial License 1.0.0**.
  - **Commercial Use (e.g., businesses, government agencies, IT service providers):** Requires prior purchase of a paid **commercial usage license** from the author (Felix Maywald / RaptorXilef).
- **Contributing:** Pull requests and translations are warmly welcomed! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) and the [Contributor License Agreement (CLA.md)](./CLA.md) beforehand.
- **Changelog:** All releases are documented in [CHANGELOG.md](./CHANGELOG.md).
