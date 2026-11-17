# Changelog

## [1.17.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.16.0...v1.17.0) (2026-11-17)

### 🚀 Features

* **launcher:** Prioritize Registry DisplayVersion over executable metadata during local version scans ([a2f5856](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/a2f58560a45d25eb8ae0edda3209d05d78f53b52))
* **settings/debug:** Add comprehensive Debug & Backup utilities ([689c3cf](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/689c3cf286c2282751b63fa47a5903d7e28a9e2d))
* **ui:** Organize toolbar with collapsible advanced actions menu ([7823cdb](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/7823cdb0f8c2a1ab7070d8dff98e22badd167f51))

### 🐛 Bug Fixes

* **launcher:** Prevent PWA false positives by enforcing dynamic length thresholds on reverse name matches ([2af3f6f](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/2af3f6fad4093c8aebd5075b7fd91e228afeb91c))

## [1.16.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.15.0...v1.16.0) (2026-11-17)

### 🚀 Features

* **launcher/ui:** Split manual and auto-detected install paths with configurable origin badges ([dacc0fe](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/dacc0fe66c17368c6a41e7615917e8c337265090))
* **launcher:** Global Auto-Detect, native EXE icon extraction, and missing path badges ([f254d4b](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/f254d4be9824dd8e802e0ae94dab619f51e43d06))

### 🐛 Bug Fixes

* **launcher/ui:** Improve Auto-Detect accuracy via Start Menu shortcuts and fix Linter warning ([52e231d](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/52e231de96c24d0b9d2cba90d586431b9036b743))
* **launcher:** Enhance Start Menu shortcut detection to resolve parallel folder structures ([e810626](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/e8106265d5f3a14d04613e18e4d691b3a4f4b03f))
* **launcher:** Implement smart Start Menu shortcut ranking to resolve ambiguous targets ([cfd3263](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/cfd32638d16b409a3eddec6b872162d0c038b2f8))
* **launcher:** Improve Auto-Detect path precision with smart Start Menu shortcut ranking and direct EXE search ([f1d7bb6](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/f1d7bb6d0892d03399e521fa9765316db80c9d77))
* **launcher:** Resolve 8GadgetPack detection and add dedicated icon extraction button ([4bb3a68](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/4bb3a68a56e64d6bb471c64d337d868c40cda2ce))

## [1.15.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.14.0...v1.15.0) (2026-11-17)

### 🚀 Features

* **launcher:** Add alternative search names for registry auto-detection ([1ff89c2](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/1ff89c24b665756de6b7d47515ea0236ea4c8d52))
* **launcher:** Add Auto-Detect for local installation paths via Registry parsing ([faf216c](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/faf216c20a146f5ca211220f4e66fe9f947617c8))

### 🐛 Bug Fixes

* **launcher:** Bulletproof Auto-Detect utilizing two-way regex matching, uninstaller fallback, and EncodedCommand ([893e9ee](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/893e9eee86842e1b81ca8f18b4b203a9fa3ab081))
* **ui:** Restore missing Auto-Detect button in the edit modal ([2621ca7](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/2621ca721f8d8cf92da4d1edfe1ee08a02496f30))

## [1.14.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.13.3...v1.14.0) (2026-11-16)

### 🚀 Features

* **launcher:** Read local executable file versions via PowerShell ([96a2535](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/96a25351422b987ba475eadd23ff3bdc2d840765))
* **ui:** Add status card coloring, install/update sorting, and version display ([9da7c0e](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/9da7c0ebd1d25bac26ec216f9a4afd3bbf77d375))

### 🐛 Bug Fixes

* **core/ui:** Resolve unused variable linter warning and add version comparison depth setting ([2fcadae](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/2fcadaef12d7ab0a8c2ba9e2cc8063db7f21fb85))
* **ui:** Restore version display on cards, fix lightbox triggers, and resolve linter errors ([b2e0e86](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/b2e0e86baad932621e9c1b70443b69f26750f7d2))

## [1.13.3](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.13.2...v1.13.3) (2026-11-15)

### 🐛 Bug Fixes

* **core/ui:** Fix explorer path parsing and ensure reliable detached PowerShell execution ([fcd7fce](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/fcd7fce104caa89baa7b7a3b53dd0acc4d73f4b1))

### ⚡ Performance

* **build:** Optimize Electron compression to reduce GitHub Actions build time ([d91f2e5](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/d91f2e56e01114e94fd2cc2833a4a8a8b10c9843))

## [1.13.2](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.13.1...v1.13.2) (2026-11-15)

### 🐛 Bug Fixes

* **updater/ui:** Fix explorer button, persistent update progress, and robust zip extraction ([c7a39d0](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/c7a39d0e43375e563e489ce4c13dea4a40320f8f))

## [1.13.1](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.13.0...v1.13.1) (2026-11-15)

### 🐛 Bug Fixes

* **updater:** Implement in-app download with progress bar and clean ZIP extraction ([16e1c54](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/16e1c546d7936f41e1f760e4657956a410abc722))
* **updater:** Switch update script to safe copy-overwrite to protect NAS data ([e568694](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/e568694dd80827ace83e6c20265e0f5d57556df9))

## [1.13.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.12.0...v1.13.0) (2026-11-15)

### 🚀 Features

* **core:** Implement 'Installed' status, version tracking, and update badges ([4114aaa](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/4114aaaa1d6e7aef11555f7496ea7d913984e0ac))

### 🐛 Bug Fixes

* **core/ui:** Resolve remaining Biome linter warnings ([f29ff4a](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/f29ff4afa07958b850bd478859a1c462bcd480d1))
* **core:** Refine version extraction regex and enable natural numeric sorting ([0608009](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/0608009684bcbe9a974d94754fdcd25168db6cda))

## [1.12.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.11.0...v1.12.0) (2026-11-15)

### 🚀 Features

* /fix(backend): Enforce security boundaries, SMB concurrency limits, and atomic catalog writes ([1f53172](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/1f53172c7ba334e936beafad4b9424924be41144))
* /fix(ui): Polish search UX, handle empty states, and fix global event propagation ([c58eae9](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/c58eae9328bd1f16174e52f87a76fd6640c0d9e5))
* /fix(ui): Resolve Biome linter issues, remove artifacts, and implement drag & drop ([c33e7d4](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/c33e7d4939f76191408edd38bf6be68b07a384ee))
* /refactor(media): Move favorites to state.json, add file explorer shortcut, and implement media drag-and-drop ([0709e74](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/0709e743ca7e11936bfe7cbdbfa9b17f4e8f2017))
* **frontend:** Implement auto-update engine, favorites system, and XSS protection ([3f81c59](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/3f81c59e04a451895fb87740d28eb016dff9da9a))
* **ui/media:** Add dedicated dropzone for automatic icon extraction and renaming ([29b56f7](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/29b56f75dc129208305c4348ef4179d3443bad76))
* **ui/scanner:** Add sorting, 'NEW' badges, smart settings reload, version select, and shortcuts ([7bd47f3](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/7bd47f38d8b28264bca2514fc1662ecceb0dd64e))
* **ui/settings:** Make 'NEW' badge duration configurable ([9a9da3e](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/9a9da3e76e602b476cb4f6925a7ab3b2ce4fed31))

### 🐛 Bug Fixes

* /feat(ui): Fix save logic crash and add native offline rich text editor ([b918b4d](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/b918b4d6f3024a439ab2031e7650b1a044e1cf44))
* **core:** Resolve Biome linter warnings for template literals and async promise executor ([5a376dd](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/5a376dd0f09da2d6e619514bce2075c8658fa640))
* **core:** Resolve CSP errors, optimize save, fix modal buttons, and safely execute installers via temp folder ([c305d03](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/c305d039aee869d1957c074f57e911acfba6d63e))
* **ui/scanner:** Resolve Biome optional chain warning and fix version sorting ([1304758](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/130475809699a73fbdb64272d3de10f03879ffcd))

### ⚙️ Refactoring

* **ui:** Split index.html into dedicated HTML, CSS, and JS files ([bd2afb2](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/bd2afb28ad14de90f452c76e953798b4d8962b1b))

## [1.11.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.10.0...v1.11.0) (2026-11-14)

### 🚀 Features

* **core:** add native AVIF image format support to metadata scanner ([4494b19](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/4494b194409847ab915c9a813c046ff8b3479a38))
* **media:** add native playback for videos in metadata scanner and lightbox UI ([7435889](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/7435889422a18080db1b1fe970165ea7af7bd0ce))

## [1.10.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.9.0...v1.10.0) (2026-11-14)

### 🚀 Features

* **core:** implement automatic fallback file discovery and direct execution UI ([4aa028d](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/4aa028d179f5d8d2071114bd12997c29fb4f1ce4))
* **ui:** add real-time catalog item counter to the main toolbar ([ed5a0ac](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/ed5a0ac682c0781d226a98c9b4cd17582d077112))

### 💎 Styling

* apply ES6 template literals to string concatenations to satisfy Biome linter ([7c8aadc](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/7c8aadccbbcc22b898ef9b6d889749ef8088870b))
* **ui:** reformat catalog item counter to a two-line layout matching button heights ([e266979](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/e266979c05afdad7adeea02f2eb43dc696b6b66e))

## [1.9.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.8.1...v1.9.0) (2026-11-14)

### 🚀 Features

* **ui:** implement non-blocking scan execution, sticky toolbar, and scroll retention ([25cf0db](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/25cf0db84b688894ee4d9a268ecdccd87db63eb3))
* **ui:** implement smart historical progress bar and resolve CSS specificity linter warnings ([0e52e21](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/0e52e212134506fd2d1d456fe77d9cde9bf0d26a))

### 🐛 Bug Fixes

* entfernt weißes Aufblitzen ([5204bb0](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/5204bb0ae8ea7e529c41771549e5f1e1627ea115))
* **ui:** separate progress bar expectations by scan mode and resolve CSS linting order ([423a79f](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/423a79ffda05eb858cf9ac6b41c9c0910673b0c5))

## [1.8.1](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.8.0...v1.8.1) (2026-11-12)

### 🐛 Bug Fixes

* **core:** disable hardware acceleration and sandbox for SMB execution stability ([ed08604](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/ed0860497424833a417ec4f4670e28184df35070))
* **core:** resolve native image load warnings and GPU overlay probing errors ([2c4786b](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/2c4786bbc3485e4eeb7d49a28c9667d9cd1cb613))

## [1.8.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.7.0...v1.8.0) (2026-11-12)

### 🚀 Features

* **ui:** add native UI to add and edit software metadata ([4152a2a](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/4152a2a64a28b43043c5a044a01523df90f125dc))

### 🐛 Bug Fixes

* **core,ui:** resolve Dawn GPU cache collisions and apply Biome string template fixes ([9b2ef88](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/9b2ef8842be5b8badf126b6185fbd53880fc610f))

### 🏗️ Build System

* include scanner script in release archive via extraFiles ([19834a9](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/19834a933ca8a4110599d51a791735dd8c894c7d))

### 👷 CI/CD Configuration

* update github actions release workflow for dual-target deployment ([549901e](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/549901e410d55a7eff5791b946b3357b29394be7))

### 📚 Dokumentation

* rewrite README to reflect current architecture and update package license ([720c1f0](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/720c1f0a1ac3f13eb20707196624d98da151e025))

### 🧹 Chore / Maintenance

* **build:** configure multiple deployment targets and project metadata ([aaca83c](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/aaca83cd1591304f461ac56b77855e19564ca400))

## [1.7.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.6.1...v1.7.0) (2026-11-12)

### 🚀 Features

* **core,ui:** add advanced scanner configurations, hidden categories, and UI improvements ([62c6050](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/62c6050d1aeda378c1738668473467b5d39038ee))
* **core,ui:** add configurable auto-update checker ([be3d1b1](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/be3d1b1dc3e0a5d05b48cf9212b88c1ea7240a83))
* **ui:** add 'About' section with dynamic GitHub update checker ([d27784b](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/d27784b567e49224cae69f22ec1dea8cbcac5ee3))

### 🐛 Bug Fixes

* **core,ui:** improve error handling, resolve Biome warnings, and fix Electron cache error ([d95558e](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/d95558e10ed86ad66b62e198976cf821a394166d))
* **core,ui:** resolve NAS performance bottlenecks and Electron runtime errors ([5d04de2](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/5d04de273c3387a5e6b269cc249c6b4c860f0b51))

## [1.6.1](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.6.0...v1.6.1) (2026-11-08)

### ⚙️ Refactoring

* **core:** store relative paths in catalog for true portability ([348a158](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/348a158ae16e4fe41c29442f66b98140d4fe270f))

## [1.6.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.5.0...v1.6.0) (2026-11-08)

### 🚀 Features

* **core,ui:** add automatic config generation, settings UI, and app branding ([98bc4ce](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/98bc4ceec35d07cf32927eb9c8f6adf4df8abee1))

### 🐛 Bug Fixes

* **ui:** add explicit type attribute to settings button ([53f6921](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/53f69215f802556fca9c88e593531d7282d597ef))

## [1.5.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.4.0...v1.5.0) (2026-11-08)

### 🚀 Features

* **core:** add 'formats' support to meta.json and update documentation ([0875742](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/0875742883e99953e1920d2e27839a24274e7e6f))

## [1.4.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.3.0...v1.4.0) (2026-11-08)

### 🚀 Features

* **ui:** enhance modal layout, add image zoom and fuzzy multi-word search ([3dd8983](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/3dd898362992c91ba023a337843220e71bc57595))

### 🐛 Bug Fixes

* **a11y:** remove redundant tabindex attribute from lightbox overlay ([04d84bc](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/04d84bca2e6874d4913fcd5a21babf6aba3301d6))
* style biome ([fa70e81](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/fa70e818e808b4ae7cd29fdca03426b7810d9fe4))
* **ui:** resolve image zoom glitch by implementing a dedicated lightbox overlay ([d1ade68](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/d1ade689f64bb5b55707169b4638817b52485630))

### 🧹 Chore / Maintenance

* add meta.txt zu .gitignore ([3211d90](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/3211d903ea28dc3b3d56fde45400c9b6db61ac91))

## [1.3.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.2.4...v1.3.0) (2026-11-08)

### 🚀 Features

* **scanner:** add support for GIF, JPEG, SVG, and ICO image formats ([c2d6d92](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/c2d6d92239a86ffcd3e33baaec19490993a1ffd6))
* **scanner:** support multiline descriptions and array format in meta.json ([2e8697f](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/2e8697f150db116d170ee7a69d38a66c16cae60e))

### ⚙️ Refactoring

* **scanner:** consolidate metadata text files into a single meta.json ([68ef835](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/68ef8359c18ab8c200acbcdd24d76e8fd3b712ec))

## [1.2.4](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.2.3...v1.2.4) (2026-11-08)

### 🐛 Bug Fixes

* **core,ui:** fix portable executable path resolution and missing tags mapping ([0fb7570](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/0fb7570ffe7e4afb4a2e2762b1158fa778113e45))
* **core:** utilize Electron's built-in Node engine via spawn for reliable scanning ([215b209](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/215b209bcc7908d06c9073d80116be78f69bfed2))

## [1.2.3](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.2.2...v1.2.3) (2026-11-08)

### 🐛 Bug Fixes

* main.mjs debug ([9cb74d6](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/9cb74d644dcd9d60667c7e010c812531b010fba6))

## [1.2.2](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.2.1...v1.2.2) (2026-11-08)

### 🐛 Bug Fixes

* **scanner,ui:** fix scan hanging state, improve real-time path streaming and optimize CI cache ([0ff7fa8](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/0ff7fa8a0df84cf22d9c764227045746d29406fa))

## [1.2.1](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.2.0...v1.2.1) (2026-11-08)

### 🐛 Bug Fixes

* **assets:** Resize application icon to meet 256x256 electron-builder requirement ([1b63d29](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/1b63d2989a39373d1f55d471b060c3c4da061e08))

## [1.2.0](https://github.com/RaptorXilef/SoftwareKatalogApp/compare/v1.1.0...v1.2.0) (2026-11-08)

### 🚀 Features

* **ui:** füge Live-Scan-Feedback, Spinner-Animation und App-Icon hinzu ([fa11345](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/fa1134556fd1206596b1d9973a41298ce1b0b920))

### 💎 Styling

* **assets:** Update application icon in build directory ([3babaf1](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/3babaf1e024d52f515b9aafc59d3fb3bb60a46cd))

### 📚 Dokumentation

* **core:** füge Projekt-Dokumentation, Lizenzen und Guidelines hinzu ([dd4e2b6](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/dd4e2b6f06a56124cd9d3f3e27ed27e225ed5e4f))

## 1.1.0 (2026-11-07)

### 🚀 Features

* Release-ready: Ordnerstruktur und Skripte finalisiert ([c16ad27](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/c16ad27c63fc87d29760713b4d53742864f0bc79))

### 💎 Styling

* behebe verbleibende Biome-Linter-Fehler und Warnungen ([7d4671f](https://github.com/RaptorXilef/SoftwareKatalogApp/commit/7d4671f4fe22d96d88d4ae67f8374a5a9233f9a0))
