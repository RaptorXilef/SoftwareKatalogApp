# DEV Workspace (Local Development Projects)

The **Dev** tab (optionally hidden in **Settings -> General**) is a standalone package and dependency manager for local code repositories. It cleanly separates project-local dependencies from system-wide installed software.

---

## 1. Supported Ecosystems & Detection

Project folders can be linked via dialog or directly via **drag & drop** onto the Dev tab (stored in `data/dev-projects.json`). Multiple ecosystems within the same project (e.g., a PHP backend with a JS frontend) are detected in parallel:

| Ecosystem                | Package Manager              | Manifest Files                       | Lockfiles                                                                    |
| ------------------------ | ---------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| **JavaScript / Node.js** | `npm`, `pnpm`, `bun`, `yarn` | `package.json`                       | `package-lock.json`, `pnpm-lock.yaml`, `bun.lock` / `bun.lockb`, `yarn.lock` |
| **PHP**                  | `composer`                   | `composer.json`                      | `composer.lock`                                                              |
| **Python**               | `uv`, `pip`                  | `pyproject.toml`, `requirements.txt` | `uv.lock` (also detects local `.venv`/`venv`)                                |
| **Rust**                 | `cargo`                      | `Cargo.toml`                         | `Cargo.lock`                                                                 |
| **.NET / C#**            | `dotnet` (NuGet)             | `*.csproj`                           | `packages.lock.json`                                                         |
| **C / C++**              | `vcpkg`                      | `vcpkg.json`                         | `vcpkg-configuration.json`                                                   |

If a linked project folder is temporarily unreachable (e.g., an unplugged drive), the app cleanly marks the project as **Offline** without losing any data.

---

## 2. Project Workspace Features

Clicking on a project card opens five subsections:

### Updates (SemVer Tiers & Major Protection)

- Compares installed package versions against official registries (`npm`, `Packagist`, `PyPI`, `crates.io`, `NuGet`) as well as the respective `outdated` CLIs.
- Transparently displays the version flow as **Installed -> Compatible (`wanted`) -> Latest (`latest`)**.
- **SemVer Tier Selection:** Choose specifically between **Patch**, **Minor**, and **Major** per package.
- **Safe Bulk Updates:** "Update all compatible" intentionally excludes major jumps; major upgrades require deliberate selection.

### Installed Packages (Direct)

- Lists all directly declared packages separated by scope (`prod`, `dev`, `optional`) along with the declared version range and actual installed version.
- Supports **scope switching** (`prod` <-> `dev`, across all supported managers) as well as targeted removal of individual packages and lockfile synchronization (`Sync`).

### Dependencies (List, Tree & Graph)

- Parses lockfiles directly for a complete overview of all direct and transitive packages including license information, `requires`, and `requiredBy`.
- **Three Views:**
  1. **List:** Searchable by package name, license, and parent/child packages.
  2. **Tree View:** Expandable dependency tree with automatic **cycle protection**.
  3. **Interactive Graph:** Visualizes dependencies with zoom, pan, and focus mode on individual nodes (with a safety limit for very large projects).

### Install New (Project Registry Search)

- Searches the registry matching the project (detected project managers are automatically prioritized).
- Allows direct installation as a `prod` or `dev` dependency including optional version specification and automatic project rescan.

### Security Audit (`npm`, `pnpm`, `composer`)

- Runs a security audit in the project and groups discovered vulnerabilities by severity (`Critical`, `High`, `Moderate`, `Low`) including CVE links and notices for `abandoned` Composer packages.
- Offers a direct **Auto-Fix** action for supported managers followed by an automatic re-check.

---

## 3. Dev Bundles (Project Stacks)

Similar to global software bundles, you can create project-local **Dev Bundles** in `data/dev-bundles.json` (supports `npm`, `pnpm`, `bun`, `composer`, `pip`, `uv`, `cargo`, `dotnet`):

- **Typical Use Cases:** Standard quality stacks (e.g., Biome + Knip + TypeScript for JS projects, or PHPStan + Pint for PHP projects).
- **1-Click Snapshot:** Captures existing `prod` and/or `dev` packages from an existing project as a new Dev Bundle (optionally with pinned versions).
- **Project Matching:** Shows before installation which packages in the opened project are already up to date, outdated, or missing, and installs selected packages in bulk.
- **Team Sharing:** Individual Dev Bundles can be exported as JSON and imported into other instances.
