# Security, Policies & Background Operation

Software Catalog is designed from the ground up so that home users stay safe from unwanted bundled software while administrators can manage workstations in a controlled manner.

---

## 1. Installation Modes & Adware/Click Protection

Silent installations are **strictly opt-in** throughout the entire application. The default mode always remains interactive.

Three modes are available for every archive program:

| Mode                                           | Behavior                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **`interactive` (Default)**                    | Launches the regular setup wizard with visible dialogs.                                                                                  |
| **`silent`**                                   | Runs the setup silently in the background with configured arguments (`silentArgs`) and an optional Inno `.inf` answer file (`/LOADINF`). |
| **`interactive-required` (Adware Protection)** | **Hard Lock:** Always enforces interactive execution. All silent arguments, `.inf` files, and bulk/auto-update silent flags are ignored. |

### Automatic Installer Analysis & Adware Heuristics

In the editor under **PC Detection**, the installer detector analyzes local `.exe` and `.msi` files **without executing them** (purely safe reading of file headers and overlay strings):

- Detects **MSI**, **Inno Setup**, **NSIS**, **WiX Burn**, and **InstallShield**, and suggests matching silent parameters.
- For **Inno Setup**, installation checkboxes can be recorded once via `/SAVEINF` into an answer file (`_metadata/silent.inf`).
- Detects known adware/bundle candidates (via name, package ID, publisher, and PE markers such as `OpenCandy`, `InstallCore`, `InstallIQ`) and automatically recommends the `interactive-required` protection mode.

---

## 2. Admin Session (One-Time UAC)

During larger update queues or bundles, individual Windows installers would otherwise trigger repeated UAC prompts. Via the **Admin Mode** button in the header (or optionally automatically starting at 2 or more packages), an admin session limited to the app's runtime can be activated:

- Launches the isolated background worker `elevated-worker.mjs` (`ELECTRON_RUN_AS_NODE=1`) once via UAC.
- Communication occurs over a randomly named **Windows Named Pipe** (`\\.\pipe\SoftwareKatalog_Elev_<random>`) with a **256-bit session token** (verified via `crypto.timingSafeEqual`).
- A parent watchdog automatically terminates the helper as soon as the main app is closed.
- If the app is already running elevated as Administrator, commands execute directly without an additional helper.

---

## 3. Admin Login & Access Policies (Enterprise / Multi-User)

Under **Settings -> Security & Policies**, administrative write protection can be enabled. All sensitive IPC channels (settings, catalog editing, provider management, archive cleaner, bundle editing, dev actions) are blocked server-side in the main process unless a valid admin session is active.

### Cryptography & Tamper Protection

- **Password Storage:** Salted `scrypt` hashing (`N=16384, r=8, p=1, keylen=64`) with a 16-byte random salt and constant-time verification (`timingSafeEqual`).
- **Integrity Check (`admin-policy.json`):** Every policy file carries a canonical **SHA-256 checksum**. In case of tampering or file corruption, a **fail-closed** mechanism takes effect: administrative actions and package installations remain locked.
- **Session Timeout:** Optional automatic logout after configurable inactivity.
- **Read-Only Protection:** If the policy file resides on a read-only network share, the app automatically detects this and prevents local overwrite attempts.

### Centralized Policy Distribution & HKLM Registry Lock

The policy file is resolved according to the following priority:

1. **Windows Registry (HKLM, highest priority):** `HKLM\SOFTWARE\Policies\SoftwareKatalog`, string value `PolicyFilePath`. If this value is set (e.g., via Group Policy/GPO or directly through Settings with UAC), end users can no longer redirect the path in `config.json`.
2. **Configured Path (`authFilePath` in `config.json`).**
3. **Default Path (`data/admin-policy.json`).**

### Package Access Policies (Whitelist / Blacklist)

- **Scope:** Either shared (`shared`) or separate (`separate`) for **Updates** and **Install New**.
- **Rule Types:** Matching by `packageId`, `archiveId`, `name` (including `*` wildcards), or an entire `provider`. More specific rules override broader ones (`packageId > archiveId > name > provider`).
- **Execution Mode:** `allow-interactive` or `silent-only` (configurable globally and overridable per entry).
- **Adware Conflict Protection:** If a policy enforces `silent-only` for a package that is simultaneously protected by `interactive-required`, execution is safely **blocked** rather than silently installing adware.
- **Portability:** Policies can be exported as JSON and imported onto other systems.

---

## 4. System Tray, Autostart & Background Updates

Under **Settings -> Background & Updates**, the app can be configured as a persistent update assistant:

- **System Tray:** Optional minimizing to the notification area upon closing (`minimizeToTrayOnClose`). The app also supports the `--tray` and `--minimized` startup flags.
- **Windows Autostart:**
  - **Normal:** Standard user autostart via Windows LoginItem (`--tray`).
  - **Admin Mode:** Configures a Windows Scheduled Task (`SoftwareKatalog_AdminAutostart`) with highest privileges so background updates can run without UAC interruptions.
- **Periodic Update Checks:** Checks for updates in the background at configurable intervals (1, 3, 6, 12, or 24 hours).
- **Anti-Spam Notifications:** Remembers previously notified target versions (`notifiedUpdateVersions`) and only notifies on genuinely new updates.
- **Silent Auto-Update (Opt-in):**
  - Only executes when the app is running with elevated privileges and is not paused.
  - Supports its own auto-update rule set (`All`, `Whitelist`, `Blacklist`).
  - Strictly respects the ignore list, active access policies, and skips all packages marked with `interactive-required` or adware signals.
