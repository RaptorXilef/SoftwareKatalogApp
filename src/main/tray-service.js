import fs from 'node:fs';
import path from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';
import { buildTrayMenuDescriptors, formatTrayTooltip } from '../shared/background-update-logic.js';
import { t } from '../shared/i18n.js';
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
  let iconImage = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  if (iconImage.isEmpty() && iconPath) {
    iconImage = nativeImage.createFromPath(path.resolve(iconPath));
  }

  tray = new Tray(iconImage);
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
