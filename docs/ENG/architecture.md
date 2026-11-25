# Technical Architecture & Development

This guide is intended for developers who want to understand the codebase, extend it, or submit pull requests.

---

## 1. Tech Stack & Design Principles

- **Runtime & Build:** Electron 45 (`^45.2.3`) + `electron-vite` (`^6.0.0`) + Vite (`^8.3.8`).
- **Language:** Native ES module JavaScript without a frontend framework (no React, Vue, or TypeScript build step). Static type checking runs in the background via `jsconfig.json` (`checkJs: true`, JSDoc types, `npm run typecheck`).
- **Styling:** Native CSS using `@layer base, layout, components, modals;`, CSS nesting, and `color-mix()` without `!important` and without descending selector specificity.
- **Security:**
  - Renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (Preload is therefore built as CommonJS).
  - Strict Content Security Policy (no inline event handlers such as `onclick=`).
  - Rich text and Markdown are sanitized before insertion using `DOMPurify` (`src/renderer/utils/sanitize.js`).
  - Local media is served exclusively via the privileged `catalog-media://` protocol (restricted to configured archive roots and the icon cache).
  - All CLI invocations use `execFile`/`spawn` with an explicit argument array (`shell: false`, `windowsHide: true`, Windows `.cmd`/`.bat` wrappers without Node `DEP0190`) and UTF-8 output.

---

## 2. Directory Structure

```text
SoftwareKatalogApp/
├── build/                    # App icon (icon.ico) and build assets
├── docs/                     # User and developer documentation
├── src/
│   ├── locales/              # Built-in language files (en.json, de.json)
│   ├── main/                 # Electron main process (Node.js backend)
│   │   ├── index.js          # App lifecycle, window management, IPC registration
│   │   ├── config.js         # Configuration, multi-root resolution, data paths
│   │   ├── jobs.js           # Parallel, cancelable job manager
│   │   ├── update-queue.js   # Strictly sequential update queue
│   │   ├── auth-service.js   # Admin login, policy integrity & HKLM lock
│   │   ├── elevated-helper.js & elevated-worker.mjs  # Named-pipe admin session
│   │   ├── background-updater*.js & autostart*.js    # Tray, scheduler & autostart
│   │   ├── providers/        # 18 package providers + CLI runner + bootstrap
│   │   └── dev-projects/     # DEV scanner, CLI runner, actions & dev bundles
│   ├── preload/
│   │   └── index.js          # contextBridge (`window.electronAPI`) + `webUtils.getPathForFile`
│   ├── renderer/             # UI (HTML, CSS, JS modules)
│   │   ├── index.html & main.js & state.js
│   │   ├── components/       # Toolbar, Cards, Discover, Bundles, Dev-Workspace, Queue, Jobs
│   │   ├── modals/           # Detail, Edit, Settings, Cleanup, Matcher, Audit, Login, Sources
│   │   ├── styles/           # Modular CSS layers
│   │   └── utils/            # DOM helpers, sanitizer, Markdown, i18n
│   ├── scanner/
│   │   └── scanner.mjs       # Standalone archive scanner (bundled into out/scanner/)
│   └── shared/               # Platform-independent, purely testable logic & parsers
└── tests/                    # Unit & integration tests (`node:test`, without host side effects)
```

---

## 3. Data Storage (`data/` vs. `userData`)

To cleanly separate portable operation (e.g., on a NAS shared across multiple PCs) from machine-specific state, data is strictly split:

- **Shared / Portable Runtime Data (`data/`):**
  - `config.json` - General settings, archive paths, active providers, background options
  - `catalog.json` - Scanned archive directory with relative paths
  - `bundles.json` - Global software bundles
  - `ignored-updates.json` - Ignored update rules
  - `dev-projects.json` & `dev-bundles.json` - Local dev projects and dev bundles
  - `admin-policy.json` - Optional admin protection & access policies
  - `locales/` - Custom community language files (override built-in locales)
  - `scan.lock` - Temporary lock file during active archive scans
    _(Note: In system-wide installations under read-only `Program Files`, `data/` automatically falls back to `%ProgramData%\SoftwareKatalog\data` or `%APPDATA%\SoftwareKatalog\data`.)_
- **Local PC State (`userData`, defaults to `%TEMP%\SoftwareKatalog_Data` for SMB compatibility):**
  - `state.json` - Favorites, locally detected versions, last notified update versions, last app update check
  - `provider-cache.json` - 7-day offline cache for package details
  - `icon-cache/` - Extracted & downloaded icons along with `icon-index.json`

---

## 4. Quality Assurance & Build Pipeline

All changes must pass the following checks without errors before submitting a pull request:

```bash
npm run fix:biome
npm run chk:biome
npm run typecheck
npm test
npm run chk:unused
npm run build:vite
```

### Build Specifics

- `electron.vite.config.mjs` includes a custom Vite plugin (`bundleStandaloneScannerPlugin`) that compiles `src/scanner/scanner.mjs` along with its `src/shared/` dependencies into a standalone ESM bundle at `out/scanner/scanner.mjs`. `electron-builder` subsequently packages `scanner.mjs`, `elevated-worker.mjs`, `icon.ico`, and `src/locales/*.json` as `extraResources` so that the scanner and elevated admin worker can run directly via `ELECTRON_RUN_AS_NODE=1` in the packaged build.
- Unit tests in `tests/` use `node:test` and dependency injection or mocks—they never install real packages on the host system and never trigger UAC prompts.
