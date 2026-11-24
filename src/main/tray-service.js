import fs from 'node:fs';
import path from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';
import { formatTrayTooltip } from '../shared/background-update-logic.js';
import { getAppFolder } from './config.js';

/** @type {Tray | null} */
let tray = null;

/** @type {{ onOpenWindow?: () => void, onCheckUpdatesNow?: () => void, onToggleAutoUpdatePaused?: () => void, onQuitApp?: () => void }} */
let trayHandlers = {};

let trayState = {
  updateCount: 0,
  isChecking: false,
  autoUpdateEnabled: false,
  autoUpdatePaused: false,
  isElevated: false,
};

/**
 * Loest den Pfad zum App-Icon fuer Tray und Benachrichtigungen auf.
 * @returns {string}
 */
export function resolveTrayIconPath() {
  const candidates = [
    app.isPackaged && process.resourcesPath ? path.join(process.resourcesPath, 'icon.ico') : '',
    path.join(getAppFolder(), 'build', 'icon.ico'),
    path.join(app.getAppPath(), 'build', 'icon.ico'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignorieren
    }
  }
  return '';
}

function buildTrayMenu() {
  const checkLabel = trayState.isChecking ? '⏳ Prüfe auf Updates...' : '🔄 Jetzt auf Updates prüfen';
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    {
      label: '📂 Software Katalog öffnen',
      click: () => trayHandlers.onOpenWindow?.(),
    },
    {
      label: checkLabel,
      enabled: !trayState.isChecking,
      click: () => trayHandlers.onCheckUpdatesNow?.(),
    },
  ];

  if (trayState.autoUpdateEnabled) {
    template.push({
      label: trayState.autoUpdatePaused ? '⚡ Auto-Update fortsetzen' : '⚡ Auto-Update pausieren',
      click: () => trayHandlers.onToggleAutoUpdatePaused?.(),
    });
  }

  template.push(
    { type: 'separator' },
    {
      label: '🚪 Vollständig beenden',
      click: () => trayHandlers.onQuitApp?.(),
    }
  );

  return Menu.buildFromTemplate(template);
}

function refreshTrayUi() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(formatTrayTooltip(trayState));
  tray.setContextMenu(buildTrayMenu());
}

/**
 * Initialisiert das native System-Tray-Icon samt Kontextmenue.
 * @param {{
 *   onOpenWindow?: () => void,
 *   onCheckUpdatesNow?: () => void,
 *   onToggleAutoUpdatePaused?: () => void,
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

  const iconPath = resolveTrayIconPath();
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
