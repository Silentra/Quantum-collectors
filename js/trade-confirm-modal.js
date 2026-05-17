/**
 * Trade Confirmation Modal — Sandbox-safe replacement for native confirm()
 *
 * Returns a Promise<boolean> that resolves true on confirm, false on cancel/close.
 * Created to fix: "Ignored call to 'confirm()'. The document is sandboxed,
 * and the 'allow-modals' keyword is not set."
 *
 * Usage:
 *   const confirmed = await showTradeConfirmModal({
 *     title: 'Confirm Trade',
 *     message: 'You give: Atom [rare]\nYou get: Neutron [rare]',
 *     warning: 'This is your LAST COPY',
 *     confirmText: 'Confirm',
 *     cancelText: 'Cancel',
 *   });
 */

let _activeModal = null; // prevents stacking

/**
 * @param {Object} options
 * @param {string} [options.title='Confirm']
 * @param {string} [options.message='']
 * @param {string} [options.confirmText='Confirm']
 * @param {string} [options.cancelText='Cancel']
 * @param {string} [options.warning='']
 * @returns {Promise<boolean>}
 */
export function showTradeConfirmModal(options = {}) {
  // If a modal is already open, reject the old one and replace
  if (_activeModal) {
    _activeModal.resolve(false);
    _activeModal.overlay.remove();
    _activeModal = null;
  }

  const {
    title = 'Confirm',
    message = '',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    warning = '',
  } = options;

  return new Promise((resolve) => {
    // Build overlay
    const overlay = document.createElement('div');
    overlay.className = 'trade-confirm-overlay';

    // Build modal
    const modal = document.createElement('div');
    modal.className = 'trade-confirm-modal';

    // Title
    const titleEl = document.createElement('div');
    titleEl.className = 'trade-confirm-title';
    titleEl.textContent = title;
    modal.appendChild(titleEl);

    // Message — preserve newlines
    if (message) {
      const msgEl = document.createElement('div');
      msgEl.className = 'trade-confirm-message';
      msgEl.innerHTML = message.replace(/\n/g, '<br>');
      modal.appendChild(msgEl);
    }

    // Warning
    if (warning) {
      const warnEl = document.createElement('div');
      warnEl.className = 'trade-confirm-warning';
      warnEl.textContent = warning;
      modal.appendChild(warnEl);
    }

    // Actions
    const actions = document.createElement('div');
    actions.className = 'trade-confirm-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'trade-confirm-btn trade-confirm-btn-cancel';
    cancelBtn.textContent = cancelText;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'trade-confirm-btn trade-confirm-btn-confirm';
    confirmBtn.textContent = confirmText;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);
    overlay.appendChild(modal);

    // Cleanup helper
    const close = (result) => {
      // Remove listeners
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      _activeModal = null;
      resolve(result);
    };

    // Backdrop click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(false);
    });

    // Button clicks
    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));

    // Esc key
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(false);
      }
    };
    document.addEventListener('keydown', onKey);

    // Track active modal
    _activeModal = { overlay, resolve };

    // Mount
    document.body.appendChild(overlay);

    // Focus confirm button for keyboard accessibility
    confirmBtn.focus();
  });
}
