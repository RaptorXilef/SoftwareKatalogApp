const CMD_METACHAR_RE = /[&|<>^()]/;

/**
 * Prueft, ob ein Kommando auf eine Windows-Batchdatei (`.cmd` oder `.bat`) zeigt.
 * @param {unknown} command
 * @returns {boolean}
 */
export function isWindowsBatchCommand(command) {
  const clean = String(command || '').trim();
  return Boolean(clean && /\.(cmd|bat)$/i.test(clean));
}

/**
 * Quotet ein einzelnes Argument sicher fuer `cmd.exe /d /s /c "..."` + `CommandLineToArgvW`.
 * Entfernt Steuerzeichen (`\r`, `\n`, `\0`) und verdoppelt Backslashes nach Windows-Regeln.
 * @param {unknown} arg
 * @returns {string}
 */
export function escapeCmdExeArg(arg) {
  const raw = String(arg ?? '').replace(/[\r\n\0]/g, '');
  if (raw.length === 0) {
    return '""';
  }
  if (/^[A-Za-z0-9._:/@=+,-]+$/.test(raw)) {
    return raw;
  }

  let out = '"';
  let backslashes = 0;
  let inQuotes = true;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\\') {
      backslashes++;
    } else if (ch === '"') {
      if (backslashes > 0) {
        out += '\\'.repeat(backslashes * 2);
        backslashes = 0;
      }
      out += '\\"';
      inQuotes = !inQuotes;
    } else {
      if (backslashes > 0) {
        out += '\\'.repeat(backslashes);
        backslashes = 0;
      }
      if (!inQuotes && CMD_METACHAR_RE.test(ch)) {
        out += `^${ch}`;
      } else {
        out += ch;
      }
    }
  }

  if (backslashes > 0) {
    out += '\\'.repeat(backslashes * 2);
  }
  out += '"';
  return out;
}

/**
 * Erzeugt die vollstaendige gequotete Einzel-Kommandozeile fuer `cmd.exe /d /s /c`.
 * @param {string} command
 * @param {unknown[]} [args]
 * @returns {string}
 */
export function buildCmdExeCommandLine(command, args = []) {
  const cleanCommand = String(command || '')
    .replace(/[\r\n\0"]/g, '')
    .trim();
  if (!cleanCommand) {
    throw new Error('Kommando darf nicht leer sein.');
  }

  const quotedCmd = /[\s&|<>^()%]/.test(cleanCommand) ? `"${cleanCommand}"` : cleanCommand;
  const escapedArgs = Array.isArray(args) ? args.map((a) => escapeCmdExeArg(a)) : [];
  const inner = escapedArgs.length > 0 ? `${quotedCmd} ${escapedArgs.join(' ')}` : quotedCmd;
  return `"${inner}"`;
}

/**
 * Erstellt sichere `spawn()`-Parameter ohne `shell: true` (verhindert Node.js `DEP0190`).
 * Windows-`.cmd`/`.bat`-Shims werden ueber `cmd.exe /d /s /c` + `windowsVerbatimArguments: true` gekapselt.
 * @param {string} command
 * @param {unknown[]} [args]
 * @param {{ platform?: string, shell?: boolean, comspec?: string }} [options]
 * @returns {{
 *   command: string,
 *   args: string[],
 *   useCmdWrapper: boolean,
 *   spawnOptions: { shell: false, windowsVerbatimArguments?: boolean },
 * }}
 */
export function buildSafeSpawnSpec(
  command,
  args = [],
  { platform = process.platform, shell = false, comspec = process.env.ComSpec || 'cmd.exe' } = {}
) {
  const cleanCommand = String(command || '').trim();
  const cleanArgs = Array.isArray(args) ? args.map((a) => String(a ?? '')) : [];
  const needsCmdWrapper = platform === 'win32' && (isWindowsBatchCommand(cleanCommand) || Boolean(shell));

  if (needsCmdWrapper) {
    return {
      command: String(comspec || 'cmd.exe').trim() || 'cmd.exe',
      args: ['/d', '/s', '/c', buildCmdExeCommandLine(cleanCommand, cleanArgs)],
      useCmdWrapper: true,
      spawnOptions: {
        shell: false,
        windowsVerbatimArguments: true,
      },
    };
  }

  return {
    command: cleanCommand,
    args: cleanArgs,
    useCmdWrapper: false,
    spawnOptions: {
      shell: false,
    },
  };
}

/**
 * Waehlt aus einer `where.exe`-Trefferliste unter Windows das bevorzugte ausfuehrbare Format
 * (`.exe` > `.com` > `.cmd` > `.bat` > sonstige, z. B. endungslose POSIX-Shims).
 * @param {string[]} candidates
 * @returns {string | null}
 */
export function pickBestWindowsExecutable(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const rankOf = (filePath) => {
    const lower = String(filePath || '')
      .trim()
      .toLowerCase();
    if (lower.endsWith('.exe')) return 0;
    if (lower.endsWith('.com')) return 1;
    if (lower.endsWith('.cmd')) return 2;
    if (lower.endsWith('.bat')) return 3;
    return 4;
  };

  let best = null;
  let bestRank = Infinity;
  for (const candidate of candidates) {
    const clean = String(candidate || '').trim();
    if (!clean) continue;
    const rank = rankOf(clean);
    if (rank < bestRank) {
      best = clean;
      bestRank = rank;
      if (bestRank === 0) break;
    }
  }
  return best;
}
