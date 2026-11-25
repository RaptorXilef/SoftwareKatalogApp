# Translating Software Catalog

Thank you for helping translate **Software Catalog** into more languages!

All built-in translation files live in [`src/locales/`](../src/locales/) as UTF-8 JSON dictionaries, with English (`en.json`) acting as the canonical reference.

## 1. Create a New Language File

1. Copy [`src/locales/en.json`](../src/locales/en.json) to `src/locales/<code>.json` (use a standard lowercase BCP-47 / ISO 639-1 language code, such as `fr.json`, `es.json`, or `pt-br.json`).
2. Update the `_meta` header at the top of the file:

```json
{
  "_meta": {
    "code": "fr",
    "name": "French",
    "nativeName": "Francais",
    "author": "Your Name (@github-handle)"
  }
}
```

- `code` must match the filename stem in lowercase (for `fr.json`, `"code": "fr"`).
- `name` is the English display name.
- `nativeName` is the language name in its own script.
- `author` credits the translator(s).

## 2. Translation Guidelines

- Keep every `{placeholder}` token verbatim and spelled identically (for example `{version}`, `{count}`, `{name}`, `{error}`).
- Keep any technical identifiers unchanged (`_metadata`, `_last`, `_archive`, `meta.json`, `winget`, `VCPKG_ROOT`, `/VERYSILENT`, `/qn /norestart`).
- Never leave any string empty and do not add or remove nested keys relative to `en.json`.
- Use standard ASCII hyphens (`-`) and straight quotes (`"` / `'`) instead of typographic dashes or smart quotes.
- Do not embed raw HTML tags in translation strings.

## 3. Test Locally Without Rebuilding

You can test a new or modified translation live at any time by placing your `<code>.json` file into the app's runtime `data/locales/` directory (you can open it directly via the button in **Settings -> General -> Language**).

Custom files in `data/locales/` are loaded automatically on startup and override built-in locales with the same `code`, so you can switch to your translation immediately in **Settings -> General** without rebuilding the app.

## 4. Validate Completeness

Before opening a pull request, run the automated completeness and formatting checks:

```bash
npm test
npm run chk:biome
```

The test suite in [`tests/i18n.test.mjs`](../tests/i18n.test.mjs) verifies:

- 100% key parity against `src/locales/en.json`
- Valid `_meta` fields matching the filename
- Non-empty values for all keys
- Identical `{placeholder}` sets and balanced braces
- All `t(...)` keys and `data-i18n*` attributes referenced in the codebase exist in `en.json`

## 5. Open a Pull Request

1. Commit your changes using [Conventional Commits](https://www.conventionalcommits.org/) (for example `feat(i18n): add French translation`).
2. Open a Pull Request on GitHub targeting `main`.
3. Include `"I accept the CLA"` in your pull request description as described in [`CONTRIBUTING.md`](../CONTRIBUTING.md).
