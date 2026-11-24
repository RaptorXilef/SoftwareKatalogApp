import { t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';

const container = () => document.getElementById('toastContainer');

/**
 * Zeigt eine nicht-blockierende Toast-Meldung unten rechts an.
 * type: 'info' | 'success' | 'warn' | 'error'
 */
export function showToast(message, { type = 'info', duration = 4000, action = null } = {}) {
  const root = container();
  if (!root) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    info: 'ℹ️',
    success: '✅',
    warn: '⚠️',
    error: '❌',
  };

  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-msg">${escapeHTML(message)}</span>
    ${action ? `<button type="button" class="toast-action">${escapeHTML(action.label)}</button>` : ''}
    <button type="button" class="toast-close" aria-label="${escapeHTML(t('common.close'))}">✕</button>
  `;

  const remove = () => {
    toast.classList.add('toast-leaving');
    setTimeout(() => toast.remove(), 220);
  };

  toast.querySelector('.toast-close')?.addEventListener('click', remove);
  if (action) {
    toast.querySelector('.toast-action')?.addEventListener('click', () => {
      action.onClick?.();
      remove();
    });
  }

  root.appendChild(toast);

  if (duration > 0) {
    setTimeout(remove, duration);
  }
}
