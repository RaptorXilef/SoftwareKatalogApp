import fs from 'node:fs';
import path from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';
import { buildTrayMenuDescriptors, formatTrayTooltip } from '../shared/background-update-logic.js';
import { t } from '../shared/i18n.js';
import { extractPngFromIcoBuffer } from '../shared/ico-logic.js';
import { getAppFolder } from './config.js';

/** @type {Tray | null} */
let tray = null;

/** @type {{ onOpenWindow?: () => void, onCheckUpdatesNow?: () => void, onToggleAutoUpdatePaused?: () => void, onOpenSettings?: () => void, onQuitApp?: () => void }} */
let trayHandlers = {};

let trayState = {
  appVersion: '',
  updateCount: 0,
  isChecking: false,
  autoUpdateEnabled: false,
  autoUpdatePaused: false,
  isElevated: false,
  settingsLocked: false,
};

/**
 * Loest den Pfad zum App-Icon fuer Fenster, Taskleiste, Tray und Benachrichtigungen auf.
 * @returns {string}
 */
export function resolveAppIconPath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'icon.ico') : '',
    path.join(getAppFolder(), 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
    path.resolve(__dirname, '../../build/icon.ico'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Ignorieren
    }
  }
  return '';
}

function resolveFallbackPngPath() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'icon.png') : '',
    path.join(getAppFolder(), 'build', 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(getAppFolder(), 'build', 'icon-original.png'),
    path.join(app.getAppPath(), 'build', 'icon-original.png'),
    path.resolve(__dirname, '../../build/icon.png'),
    path.resolve(__dirname, '../../build/icon-original.png'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Ignorieren
    }
  }
  return '';
}

/**
 * Laedt ein garantiertes RGBA-NativeImage fuer BrowserWindow & Taskleiste.
 * Extrahiert unter Windows bevorzugt den eingebetteten 256x256-PNG-Frame aus icon.ico,
 * da nativeImage.createFromPath() bei .ico-Dateien oft leer oder unvollstaendig bleibt.
 * @param {string} [icoPath]
 * @returns {Electron.NativeImage | null}
 */
export function loadAppWindowIcon(icoPath = resolveAppIconPath()) {
  if (icoPath) {
    try {
      const raw = fs.readFileSync(icoPath);
      const pngBuf = extractPngFromIcoBuffer(raw);
      if (pngBuf) {
        const fromEmbeddedPng = nativeImage.createFromBuffer(pngBuf);
        if (!fromEmbeddedPng.isEmpty()) {
          return fromEmbeddedPng;
        }
      }
    } catch {
      // Weiter mit PNG-/Path-Fallback
    }
  }

  const pngPath = resolveFallbackPngPath();
  if (pngPath) {
    try {
      let img = nativeImage.createFromPath(pngPath);
      if (!img.isEmpty()) {
        const size = img.getSize();
        if (size.width > 256 || size.height > 256) {
          img = img.resize({ width: 256, height: 256, quality: 'best' });
        }
        return img;
      }
    } catch {
      // Weiter mit direktem .ico-Fallback
    }
  }

  if (icoPath) {
    try {
      const direct = nativeImage.createFromPath(icoPath);
      if (!direct.isEmpty()) {
        return direct;
      }
    } catch {
      // Ignorieren
    }
  }

  return null;
}

function buildTrayMenu() {
  const descriptors = buildTrayMenuDescriptors({ ...trayState, t });
  /** @type {Record<string, () => void>} */
  const actionMap = {
    'open-window': () => trayHandlers.onOpenWindow?.(),
    'check-updates': () => trayHandlers.onCheckUpdatesNow?.(),
    'toggle-auto-update': () => trayHandlers.onToggleAutoUpdatePaused?.(),
    'open-settings': () => trayHandlers.onOpenSettings?.(),
    quit: () => trayHandlers.onQuitApp?.(),
  };

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = descriptors.map((entry) => {
    if (entry.type === 'separator') {
      return { type: 'separator' };
    }
    const handler = actionMap[entry.actionId];
    return {
      label: entry.label,
      enabled: entry.enabled,
      ...(handler && entry.enabled ? { click: handler } : {}),
    };
  });

  return Menu.buildFromTemplate(template);
}

function refreshTrayUi() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(formatTrayTooltip({ ...trayState, t }));
  tray.setContextMenu(buildTrayMenu());
}

/**
 * Initialisiert das native System-Tray-Icon samt Kontextmenue.
 * @param {{
 *   onOpenWindow?: () => void,
 *   onCheckUpdatesNow?: () => void,
 *   onToggleAutoUpdatePaused?: () => void,
 *   onOpenSettings?: () => void,
 *   onQuitApp?: () => void,
 * }} [handlers]
 * @param {Partial<typeof trayState>} [initialState]
 */
export function initTrayService(handlers = {}, initialState = {}) {
  trayHandlers = handlers || {};
  trayState = { ...trayState, ...initialState };

  if (tray && !tray.isDestroyed()) {
    refreshTrayUi();
    return tray;
  }

  const iconPath = resolveAppIconPath();
  const trayIcon =
    process.platform === 'win32' && iconPath ? iconPath : loadAppWindowIcon(iconPath) || nativeImage.createEmpty();

  tray = new Tray(trayIcon);
  tray.on('click', () => trayHandlers.onOpenWindow?.());
  tray.on('double-click', () => trayHandlers.onOpenWindow?.());
  refreshTrayUi();
  return tray;
}

/**
 * Aktualisiert Tooltip und Kontextmenue des System-Trays.
 * @param {Partial<typeof trayState>} [partialState]
 */
export function updateTrayState(partialState = {}) {
  trayState = { ...trayState, ...partialState };
  refreshTrayUi();
}

/**
 * Gibt true zurueck, solange ein aktives Tray-Icon existiert.
 * @returns {boolean}
 */
export function isTrayActive() {
  return Boolean(tray && !tray.isDestroyed());
}

/**
 * Entfernt das Tray-Icon sauber beim Beenden der App.
 */
export function destroyTrayService() {
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
  }
  tray = null;
}
