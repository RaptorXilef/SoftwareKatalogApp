import { renderAuthHeaderControls } from '../components/toolbar.js';
import { applyAuthStatus, refreshAuthStatus, state } from '../state.js';
import { t } from '../utils/i18n.js';
import { escapeHTML } from '../utils/sanitize.js';

/**
 * Oeffnet das In-App-Login-Modal im verschachtelten Dialog-Overlay.
 * @param {{ reason?: string }} [options]
 * @returns {Promise<{ authenticated: boolean, canceled?: boolean, status?: Record<string, any> }>}
 */
export function openLoginModal({ reason = '' } = {}) {
  const overlay = document.getElementById('dialogOverlay');
  const dialog = document.getElementById('dialogContent');
  if (!overlay || !dialog) {
    return Promise.resolve({ authenticated: false, canceled: true });
  }

  const auth = /** @type {Record<string, any>} */ (state.authStatus || {});
  const defaultUsername = String(auth.username || '').trim();
  const integrityWarningHtml =
    auth.integrityValid === false && auth.integrityWarning
      ? `<div class="login-warning-box" role="alert">⚠️ ${escapeHTML(auth.integrityWarning)}</div>`
      : '';

  dialog.innerHTML = `
    <div class="modal-header">
      <h2>🔒 ${escapeHTML(t('login.title'))}</h2>
      <button type="button" class="icon-btn" data-login-action="cancel" title="${escapeHTML(t('common.cancel'))}" aria-label="${escapeHTML(t('common.cancel'))}">✕</button>
    </div>

    <form id="authLoginForm" class="modal-body login-modal-body" autocomplete="off">
      ${reason ? `<p class="panel-hint">${escapeHTML(reason)}</p>` : `<p class="panel-hint">${escapeHTML(t('login.defaultHint'))}</p>`}
      ${integrityWarningHtml}

      <label class="form-field">
        <span>${escapeHTML(t('login.usernameLabel'))}</span>
        <input type="text" id="authLoginUsername" value="${escapeHTML(defaultUsername)}" placeholder="${escapeHTML(t('login.usernamePlaceholder'))}" required autocomplete="username">
      </label>

      <label class="form-field">
        <span>${escapeHTML(t('login.passwordLabel'))}</span>
        <div class="login-password-row">
          <input type="password" id="authLoginPassword" placeholder="${escapeHTML(t('login.passwordPlaceholder'))}" required autocomplete="current-password">
          <button type="button" class="btn btn-ghost btn-xs" id="btnToggleLoginPw" data-login-action="toggle-pw" title="${escapeHTML(t('login.togglePasswordTitle'))}">👁️</button>
        </div>
      </label>

      <div id="authLoginError" class="login-error-box" role="alert" hidden></div>

      <div class="login-actions-row">
        <button type="button" class="btn btn-ghost" data-login-action="cancel">${escapeHTML(t('common.cancel'))}</button>
        <button type="submit" class="btn btn-primary" id="btnAuthLoginSubmit">🔓 ${escapeHTML(t('login.submitBtn'))}</button>
      </div>
    </form>
  `;

  overlay.hidden = false;

  const form = dialog.querySelector('#authLoginForm');
  const userInput = dialog.querySelector('#authLoginUsername');
  const passInput = dialog.querySelector('#authLoginPassword');
  const errorBox = dialog.querySelector('#authLoginError');
  const submitBtn = dialog.querySelector('#btnAuthLoginSubmit');

  return new Promise((resolve) => {
    let settled = false;
    let busy = false;

    const cleanup = () => {
      overlay.hidden = true;
      dialog.innerHTML = '';
      dialog.onclick = null;
      overlay.onclick = null;
      if (form instanceof HTMLFormElement) {
        form.onsubmit = null;
      }
      document.removeEventListener('keydown', onKeyDown, true);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) finish({ authenticated: false, canceled: true });
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    overlay.onclick = (e) => {
      if (e.target === overlay && !busy) {
        finish({ authenticated: false, canceled: true });
      }
    };

    dialog.onclick = (e) => {
      if (!(e.target instanceof Element)) return;
      const btn = e.target.closest('[data-login-action]');
      if (!(btn instanceof HTMLElement)) return;
      const action = btn.dataset.loginAction;
      if (action === 'cancel' && !busy) {
        finish({ authenticated: false, canceled: true });
      } else if (action === 'toggle-pw' && passInput instanceof HTMLInputElement) {
        const show = passInput.type === 'password';
        passInput.type = show ? 'text' : 'password';
        btn.textContent = show ? '🙈' : '👁️';
        passInput.focus();
      }
    };

    if (form instanceof HTMLFormElement) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (busy) return;

        const username = userInput instanceof HTMLInputElement ? userInput.value.trim() : '';
        const password = passInput instanceof HTMLInputElement ? passInput.value : '';

        if (!username || !password) {
          if (errorBox instanceof HTMLElement) {
            errorBox.textContent = t('login.missingCredentials');
            errorBox.hidden = false;
          }
          return;
        }

        busy = true;
        if (submitBtn instanceof HTMLButtonElement) {
          submitBtn.disabled = true;
          submitBtn.textContent = `⏳ ${t('login.submittingBtn')}`;
        }
        if (errorBox instanceof HTMLElement) {
          errorBox.hidden = true;
          errorBox.textContent = '';
        }

        try {
          const res = await window.electronAPI.loginAuth(username, password);
          if (res?.status) {
            applyAuthStatus(res.status);
            renderAuthHeaderControls();
          }

          if (res?.success) {
            finish({ authenticated: true, status: res.status });
            return;
          }

          if (errorBox instanceof HTMLElement) {
            errorBox.textContent = res?.error || t('login.failed');
            errorBox.hidden = false;
          }
          if (passInput instanceof HTMLInputElement) {
            passInput.value = '';
            passInput.focus();
          }
        } catch (err) {
          if (errorBox instanceof HTMLElement) {
            errorBox.textContent = err?.message || t('login.connectionError');
            errorBox.hidden = false;
          }
        } finally {
          busy = false;
          if (!settled && submitBtn instanceof HTMLButtonElement) {
            submitBtn.disabled = false;
            submitBtn.textContent = `🔓 ${t('login.submitBtn')}`;
          }
        }
      };
    }

    setTimeout(() => {
      if (defaultUsername && passInput instanceof HTMLInputElement) {
        passInput.focus();
      } else if (userInput instanceof HTMLInputElement) {
        userInput.focus();
      }
    }, 0);
  });
}

/**
 * Stellt sicher, dass bei aktivem Admin-Schutz eine gueltige Session besteht;
 * oeffnet andernfalls automatisch das In-App-Login-Modal.
 * @param {{ reason?: string }} [options]
 * @returns {Promise<boolean>}
 */
export async function ensureAdminAuthenticated({ reason = '' } = {}) {
  const status = await refreshAuthStatus();
  renderAuthHeaderControls();
  if (!status.enabled || status.isAuthenticated) {
    return true;
  }
  const result = await openLoginModal({ reason });
  return Boolean(result?.authenticated);
}
