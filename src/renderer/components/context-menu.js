import { t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';

/** @type {HTMLDivElement | null} */
let menuEl = null;
/** @type {Array<{ type?: string, id?: string, label?: string, hint?: string, disabled?: boolean, title?: string, danger?: boolean, onSelect?: () => void }>} */
let currentItems = [];
/** @type {HTMLElement | null} */
let lastFocusedEl = null;
/** @type {(() => void) | null} */
let cleanupListeners = null;

function ensureMenuElement() {
  if (menuEl && document.body.contains(menuEl)) {
    return menuEl;
  }
  const el = document.createElement('div');
  el.id = 'appContextMenu';
  el.className = 'context-menu';
  el.setAttribute('role', 'menu');
  el.hidden = true;
  document.body.appendChild(el);
  menuEl = el;
  return el;
}

function getEnabledMenuButtons(root) {
  return /** @type {HTMLButtonElement[]} */ ([...root.querySelectorAll('[role="menuitem"]:not(:disabled)')]);
}

function isContextMenuOpen() {
  return Boolean(menuEl && !menuEl.hidden);
}

export function closeContextMenu({ restoreFocus = false } = {}) {
  if (cleanupListeners) {
    cleanupListeners();
    cleanupListeners = null;
  }

  if (menuEl) {
    menuEl.hidden = true;
    menuEl.innerHTML = '';
    menuEl.onclick = null;
  }

  currentItems = [];

  if (restoreFocus && lastFocusedEl && typeof lastFocusedEl.focus === 'function' && document.contains(lastFocusedEl)) {
    lastFocusedEl.focus();
  }
  lastFocusedEl = null;
}

/**
 * Oeffnet ein tastaturbedienbares In-App-Kontextmenue an (x, y) innerhalb des Viewports.
 * @param {{ x: number, y: number, items: Array<Record<string, any>>, ariaLabel?: string }} options
 */
export function openContextMenu({ x, y, items = [], ariaLabel = t('contextMenu.defaultAria') }) {
  closeContextMenu({ restoreFocus: false });
  if (!Array.isArray(items) || items.length === 0) return;

  const root = ensureMenuElement();
  lastFocusedEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  currentItems = items;

  root.setAttribute('aria-label', ariaLabel);
  root.innerHTML = items
    .map((item, idx) => {
      if (item?.type === 'separator') {
        return '<hr class="context-menu-divider" role="separator">';
      }
      const cls = ['context-menu-item'];
      if (item?.danger) cls.push('is-danger');
      const disabledAttr = item?.disabled ? 'disabled aria-disabled="true"' : '';
      const titleAttr = item?.title ? `title="${escapeHTML(item.title)}"` : '';
      const hintHtml = item?.hint ? `<span class="context-menu-hint">${escapeHTML(item.hint)}</span>` : '';

      return `
        <button type="button" class="${cls.join(' ')}" role="menuitem" data-menu-idx="${idx}" ${disabledAttr} ${titleAttr}>
          <span class="context-menu-label">${escapeHTML(item?.label || '')}</span>
          ${hintHtml}
        </button>
      `;
    })
    .join('');

  root.style.left = '0px';
  root.style.top = '0px';
  root.hidden = false;

  const padding = 8;
  const rect = root.getBoundingClientRect();
  let left = Number.isFinite(x) ? x : padding;
  let top = Number.isFinite(y) ? y : padding;

  if (left + rect.width > window.innerWidth - padding) {
    left = Math.max(padding, left - rect.width);
  }
  if (left + rect.width > window.innerWidth - padding) {
    left = Math.max(padding, window.innerWidth - rect.width - padding);
  }
  if (left < padding) left = padding;

  if (top + rect.height > window.innerHeight - padding) {
    top = Math.max(padding, top - rect.height);
  }
  if (top + rect.height > window.innerHeight - padding) {
    top = Math.max(padding, window.innerHeight - rect.height - padding);
  }
  if (top < padding) top = padding;

  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;

  const enabledButtons = getEnabledMenuButtons(root);
  if (enabledButtons.length > 0) {
    enabledButtons[0].focus();
  }

  root.onclick = (e) => {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest('[data-menu-idx]');
    if (!(btn instanceof HTMLButtonElement) || btn.disabled) return;
    const idx = Number(btn.dataset.menuIdx);
    const chosen = currentItems[idx];
    closeContextMenu({ restoreFocus: false });
    if (chosen && typeof chosen.onSelect === 'function') {
      void chosen.onSelect();
    }
  };

  const onMouseDown = (e) => {
    if (!(e.target instanceof Node) || !root.contains(e.target)) {
      closeContextMenu({ restoreFocus: false });
    }
  };

  const onKeyDown = (e) => {
    if (!isContextMenuOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu({ restoreFocus: true });
      return;
    }
    if (e.key === 'Tab') {
      closeContextMenu({ restoreFocus: false });
      return;
    }

    const buttons = getEnabledMenuButtons(root);
    if (buttons.length === 0) return;

    const currentIdx = buttons.indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = currentIdx === -1 ? 0 : (currentIdx + 1) % buttons.length;
      buttons[next].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = currentIdx <= 0 ? buttons.length - 1 : currentIdx - 1;
      buttons[prev].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1].focus();
    }
  };

  const onViewportChange = () => {
    closeContextMenu({ restoreFocus: false });
  };

  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('blur', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);

  cleanupListeners = () => {
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('blur', onViewportChange);
    window.removeEventListener('scroll', onViewportChange, true);
  };
}
