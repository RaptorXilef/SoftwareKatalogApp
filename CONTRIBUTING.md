# Contributing to Software Katalog 🚀

Vielen Dank, dass du helfen möchtest, den Software Katalog noch besser zu machen!
Um die hohe Code-Qualität und Stabilität der App zu erhalten, befolge bitte diesen Workflow:

## 🛠️ Development Setup

1. Clone das Repository lokal.
2. Stelle sicher, dass du Node.js (v20 LTS) installiert hast.
3. Führe `npm install` aus. Dadurch werden alle Tools (Electron, Biome, Husky, Commitlint) installiert.

## 📏 Coding Standards (Biome)

Wir nutzen **Biome** für extrem schnelle und strikte Formatierung/Linting von JavaScript, HTML und JSON.
Dein Code wird bei einem Pull Request geprüft und muss fehlerfrei sein.

- **Prüfen:** Führe `npm run chk:biome` aus, um Linter-Fehler zu sehen.
- **Automatisch fixen:** Führe `npm run fix:biome` aus. Das Tool formatiert deinen Code automatisch nach unseren Standards und behebt simple Warnungen.

## 📝 Commits (Husky & Conventional Commits)

Wir nutzen zwingend **Conventional Commits**. Husky blockiert automatisch Commits, die nicht diesem Format entsprechen.

**Erlaubte Typen:**
`feat` (Features), `fix` (Fehlerbehebung), `chore` (Wartung), `style` (Code-Formatierung), `refactor`, `docs`, `test`, `build`, `ci`, `perf`, `security`, `revert`.

*Gültiges Beispiel:* `feat: download funktion für _last ordner hinzugefügt`
*Ungültiges Beispiel:* `download button eingebaut`

## ⚖️ Mitwirkenden-Lizenzvereinbarung (CLA)

Um sicherzustellen, dass das Projekt rechtlich sauber bleibt, bitten wir **alle** Mitwirkenden, unser Contributor License Agreement (CLA) zu akzeptieren.

Bitte lies dir die [CLA.md](./CLA.md) durch.

**Pflicht:** Um deinen Code einzureichen, musst du zwingend den Satz **"I accept the CLA"** in die Beschreibung deines Pull Requests schreiben.
