# Changelog

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
