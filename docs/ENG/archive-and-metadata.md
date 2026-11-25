# Archive, Folder Structure & Metadata

The **Archive** is your own independent software library on a local drive, an external hard drive, or a network drive (NAS/SMB). All paths in `data/catalog.json` are stored relatively so that the archive can be moved or mounted under a different drive letter at any time.

---

## 1. Multi-Root Archives & Offline Resilience

In **Settings -> Archive & Downloads**, you can define one or more archive root folders (e.g., `\\NAS\Software` as primary archive #1 and `D:\LocalSoftware` as secondary archive #2):

- **Priority Order:** The order can be set via drag & drop or arrow buttons. The highest reachable archive serves as the primary archive for new downloads.
- **Automatic Merging:** If the same software (detected via `packageId`/`wingetId` or normalized name) exists in multiple archives, setup files, screenshots, links, and missing metadata are merged. In the detail dialog, each setup file is labeled with its source (e.g., `[#1 NAS/Software]`).
- **Offline Resilience:** If a network drive is offline during scanning, it is skipped. Previously known entries from `data/catalog.json` remain visible in the catalog and are marked as offline, while reachable secondary archives continue to work normally.

---

## 2. Folder Structure of a Program

Keep your structure within an archive root folder as flat as possible (optionally, **Nested Scanning** with configurable depth can be enabled in Settings). A folder is recognized as a program as soon as the **`_metadata`** subfolder exists inside it:

```text
SoftwareArchiv/
└── VLC_Media_Player/
    ├── _metadata/
    │   ├── meta.json        # Program metadata (description, IDs, online source, silent config)
    │   ├── icon.png         # App icon (any file with the prefix "icon.")
    │   ├── silent.inf       # Optional: recorded Inno Setup answer file
    │   ├── screen1.png      # Screenshots (displayed in the lightbox)
    │   └── demo.mp4         # Videos (also played in the lightbox)
    ├── _last/               # Optional: permanently pins specific setup files as primary downloads
    ├── _archive/            # Optional: target folder of the manual archive cleaner for older versions
    ├── vlc-3.0.21-win64.exe # Setup files directly in the program folder (standard case)
    └── vlc-3.0.20-win64.exe
```

### Setup Files & the `_last` Folder

- **Standard Case:** Setup files (`.exe`, `.msi`, `.zip` — configurable via `autoExtensions`) are placed directly in the program folder. The scanner automatically sorts them in descending order by the highest detected version number.
- **Pinning via `_last/`:** If a non-empty `_last` subfolder exists, its files are specifically used as primary setups. Additionally, an existing `_last` folder strictly protects the program from the archive cleaner.

### Media & Icons

- **Icon Priority:** `_metadata/icon.*` (`.png`, `.ico`, `.svg`, `.webp`, `.jpg`, `.jpeg`, `.gif`, `.avif`) always has the highest priority. If no custom icon is present, the app automatically falls back to the extracted local PC icon or the persistent icon cache.
- **Gallery:** All other images and videos (`.mp4`, `.webm`, `.ogg`, `.mov`, `.avi`) in the `_metadata` folder appear as a clickable gallery with a fullscreen lightbox.
- **Convenience Features:** Media and icons can be added directly via drag & drop in the in-app editor or extracted from a local `.exe` file. New software folders can simply be dragged onto the app window.

---

## 3. Reference: `_metadata/meta.json`

You can maintain programs entirely via the in-app editor (including **Autofill** from package sources/web) or edit `meta.json` directly:

```json
{
  "name": "VLC Media Player",
  "softwareType": "default",
  "category": "Multimedia",
  "hiddenCategory": "",
  "tags": ["Video", "Audio", "Player", "Open Source"],
  "formats": [".mkv", ".mp4", ".mp3"],
  "os": ["Windows 10", "Windows 11"],
  "description": "Free, cross-platform multimedia player.",
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
    "Official Website": "[https://www.videolan.org/vlc/](https://www.videolan.org/vlc/)"
  }
}
```

### Key Fields at a Glance

| Field                          | Description                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `softwareType`                 | `default` (standard program), `portable` (no PC path warning), or `driver` (driver package).                                                                              |
| `hiddenCategory`               | Hides the entry by default until this category is toggled visible in Settings.                                                                                            |
| `packageManager` / `packageId` | Links the archive folder to a package manager (e.g., `winget` + `VideoLAN.VLC` or `scoop` + `extras/neovim`). `wingetId` is kept synchronized for backward compatibility. |
| `installMode`                  | `interactive` (default), `silent` (opt-in), or `interactive-required` (strict adware protection).                                                                         |
| `silentArgs` / `innoInfFile`   | Custom silent arguments as well as an optional filename for an Inno `.inf` answer file in `_metadata/`.                                                                   |
| `keepAllVersions`              | When `true`, permanently protects the program from the manual archive cleaner.                                                                                            |
| `webSourceType`                | Source for online version checks: `none`, `winget`, `provider`, `github`, or `web`.                                                                                       |

---

## 4. Online Update Sources & Visual Wizards

In the **Online Updates** editor tab, four source types can be configured:

1. **Package Manager (Winget / Provider):** Uses the metadata and download URLs of the linked package manager (for Winget, including direct setup download into the archive).
2. **GitHub Releases:** Automatically reads the latest release via the GitHub API. Using `githubAssetPattern` (e.g., `win64.exe`), the desired asset can be matched precisely.
3. **Website (Visual Scraper & Link Picker):**
   - **Highlight Version on Page:** Opens the webpage in an isolated browser session; once you highlight the version number, the app automatically calculates the prefix and suffix in the HTML.
   - **Select Download Link:** Detects direct links, `{version}` URL templates, or automatically intercepts dynamic JS downloads (without downloading the file twice).
4. **Auto-Naming:** Downloaded setups are automatically named according to the configured pattern (default: `{Name}_v{Version}{Arch}{Ext}`), provided the original filename does not already contain a version.

---

## 5. Scan Modes & Manual Archive Cleaner

### The Three Scan Modes

- **Check Archive (Smart Scan, Default):** Checks folder timestamps (`scanMtime`) to see if new programs, modified `meta.json` files, or new setups have been added, and only re-parses modified folders.
- **Reload All Metadata (`--update`):** Specifically re-reads all known entries without traversing the entire filesystem again.
- **Full Archive Rescan (`--full`):** Discards the scan cache and completely re-indexes all archive roots.

_(Individual changes in the editor always trigger only a lightning-fast `--single` scan for that specific folder.)_

### Manual Archive Cleaner

Via the `...` menu in the toolbar (**Clean Up Archive**), old clutter can be safely reduced:

- **Never** runs automatically—always shows a live preview first (number of files & freed disk space) and requires explicit confirmation.
- Keeps the `N` newest version slots per program (default: `2`; different architectures of the same version such as `x64` and `x86` share a single slot).
- Two action modes: **Move to `_archive/`** (default, lossless) or **Move to Recycle Bin**.

**Guaranteed Protection:** Programs with a `_last` folder or the `keepAllVersions: true` flag are never touched.
