# Package Managers & Provider System

Software Catalog abstracts all package sources via a unified provider registry (`src/main/providers/registry.js`). By default, only **Archive** and **Winget** are enabled. All other package managers can be individually enabled under **Settings -> Package Managers**, checked for availability, and in many cases installed or uninstalled with a single click.

---

## 1. Overview of All 18 Integrated Providers

### Archive

| Provider          | ID        | Search | Installed | Updates | Versions | Install / Uninstall |   Source Management    |
| ----------------- | --------- | :----: | :-------: | :-----: | :------: | :-----------------: | :--------------------: |
| **Local Archive** | `archive` |  Yes   |    Yes    |   Yes   |  Local   |       Install       | Multi-root in Settings |

### System Package Managers (Windows)

| Provider           | ID           | Description                                                     | Search | Updates | Versions |      Manager Bootstrap       |   Source Management   |
| ------------------ | ------------ | --------------------------------------------------------------- | :----: | :-----: | :------: | :--------------------------: | :-------------------: |
| **Winget**         | `winget`     | Official Windows Package Manager (incl. archive setup download) |  Yes   |   Yes   |   Yes    |        System / Store        | Yes (`winget source`) |
| **MS Store**       | `msstore`    | Microsoft Store apps via Winget + AppX manifest resolution      |  Yes   |   Yes   |    No    |          via Winget          |      via Winget       |
| **Scoop**          | `scoop`      | Portable Windows tools without admin rights                     |  Yes   |   Yes   |    No    |     Install & Uninstall      | Yes (`scoop bucket`)  |
| **Chocolatey**     | `chocolatey` | Windows package manager (requires UAC/admin)                    |  Yes   |   Yes   |   Yes    |  Install & Uninstall (UAC)   | Yes (`choco source`)  |
| **MSI**            | `msi`        | Local `.msi` packages via `msiexec.exe` & Registry              |   No   |   No    |    No    |       System component       |          No           |
| **PowerShell 7**   | `pwsh7`      | PowerShell 7 modules (`PSResourceGet` / `PowerShellGet`)        |  Yes   |   Yes   |    No    | Install & Uninstall (Winget) |  Yes (Repositories)   |
| **PowerShell 5.1** | `pwsh5`      | Windows PowerShell 5.1 modules (`PowerShellGet`)                |  Yes   |   Yes   |    No    |       System component       |  Yes (Repositories)   |

### Languages & Developer Providers (Global)

| Provider       | ID         | Description                                           | Search | Updates | Versions |     Manager Bootstrap      |   Source Management   |
| -------------- | ---------- | ----------------------------------------------------- | :----: | :-----: | :------: | :------------------------: | :-------------------: |
| **npm**        | `npm`      | Global Node.js packages (`npm install -g`)            |  Yes   |   Yes   |   Yes    |   Node.js LTS via Winget   | Yes (Custom Registry) |
| **Bun**        | `bun`      | Fast JS runtime & global packages (`bun add -g`)      |  Yes   |   Yes   |   Yes    | Winget / PowerShell script | Yes (Custom Registry) |
| **NVM**        | `nvm`      | Node.js version manager for Windows (incl. `nvm use`) |  Yes   |   Yes   |    No    |  Winget (`NVMforWindows`)  |          No           |
| **pnpm**       | `pnpm`     | Global JavaScript packages (`pnpm add -g`)            |  Yes   |   Yes   |   Yes    |    Winget (`pnpm.pnpm`)    | Yes (Custom Registry) |
| **Composer**   | `composer` | Global PHP CLI tools (Packagist)                      |  Yes   |   Yes   |    No    |    Winget (`Composer`)     |          No           |
| **pip**        | `pip`      | Python packages from PyPI (`python -m pip`)           |  Yes   |   Yes   |   Yes    |   Winget (`Python 3.13`)   |  Yes (Custom Index)   |
| **uv tool**    | `uv`       | Isolated Python CLI tools by Astral (`uv tool`)       |  Yes   |   Yes   |   Yes    |  Winget (`astral-sh.uv`)   |  Yes (Custom Index)   |
| **Cargo**      | `cargo`    | Installed Rust CLI crates (`crates.io`)               |  Yes   |   Yes   |   Yes    |     Winget (`Rustup`)      |          No           |
| **vcpkg**      | `vcpkg`    | C/C++ package manager (`VCPKG_ROOT` or `PATH`)        |  Yes   |   Yes   |    No    |   Git clone + bootstrap    |          No           |
| **.NET Tools** | `dotnet`   | Global .NET CLI tools (`dotnet tool -g` / NuGet)      |  Yes   |   Yes   |    No    |  Winget (`.NET SDK 10/9`)  |          No           |

---

## 2. Special Provider Features

### Source, Bucket & Registry Management

Using the **Sources** button next to supported providers in Settings, custom package sources can be managed directly within the app:

- **CLI-based:** Winget sources, Scoop buckets (with quick presets such as `extras`, `versions`, `nerd-fonts`), Chocolatey sources, and PowerShell repositories.
- **Config-based:** Custom registries/mirrors for `npm`, `bun`, `pnpm`, `pip`, and `uv` (e.g., corporate proxies like Verdaccio, Nexus, or Artifactory).

### Local `.msi` Installation

In the **Install New** tab (when the `msi` provider is enabled), a dedicated wizard is available for local `.msi` files:

- Automatically reads `ProductName`, `ProductVersion`, `Manufacturer`, and `ProductCode` (`{GUID}`) directly from the MSI database prior to installation.
- Supports interactive installation (default) or silent setup (`/qn /norestart`) in compliance with active access policies.
- Can directly add the `.msi` file to the archive upon successful installation.

### NVM Version Switching & Update Detection

- Installed Node.js versions display which version is currently active (`Active` chip).
- In the detail dialog, you can switch directly to an installed version with a single click (`nvm use`) (with automatic UAC fallback for Windows symlinks).
- Update checking compares installed versions against `nvm list available` and the official Node.js release index (`nodejs.org/dist/index.json`).

### MS Store & AppX Resolution

Cryptic Store product IDs (such as `9N9PHDT62W94`) are automatically resolved to real app names, publishers, and high-resolution app logos via local `AppxManifest.xml` files and the provider cache.

---

## 3. Linking Package Managers & Archive

### Save Mode for New Installations (`archiveSaveMode`)

In Settings, you define what happens when you install or update software via a package manager:

- **`ask` (Default):** Prompts for the target folder in the archive and offers safe collision resolution when `_metadata` folders already exist (Link, Overwrite, Choose another folder, Cancel).
- **`auto-id`:** Automatically creates an `<Archive>/<packageId>` folder while storing the real display name in `meta.json`.
- **`none`:** No automatic saving to the archive.

### Two-Stage Winget Mapping Wizard

Via `...` -> **Map Winget IDs**, you can conveniently link existing archive folders without a `packageId` to Winget:

1. **Stage 1 (High Confidence):** Automatic matching against locally installed programs (`winget export`, installation paths, and registry names)—these matches are pre-selected.
2. **Stage 2 (Suggestions):** Throttled `winget search` queries for remaining folders—never checked without asking, and freely selectable via dropdown.

---

## 4. Offline-First Caching

To remain fast even on slow connections or when completely offline, the app uses two local caches in `userData`:

- **Provider Metadata Cache (`provider-cache.json`):** Stores detail queries (`show`) for 7 days. If an online fetch fails after expiration, the cached data remains permanently usable and is marked as stale.
- **Persistent Icon Cache (`icon-cache/`):** Stores extracted EXE/DLL/AppX icons and online favicons with a 30-day TTL (valid indefinitely offline) and a 24-hour negative cache. Both caches can be inspected and cleared in Settings.
