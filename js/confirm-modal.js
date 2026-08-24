/**
 * Shared #confirm-modal helper — full visual + listener isolation on every open.
 *
 * Kept outside ui.js so leaderboard-admin / shop / achievements / cosmetics can
 * import without circular dependency (ui.js imports those modules).
 */

/** @type {Readonly<{ safe: string, destructive: string }>} */
export const CONFIRM_OK_CLASS = Object.freeze({
  safe: 'flex-1 bg-primary-600 hover:bg-primary-500 py-3 rounded-lg font-semibold transition text-sm',
  destructive: 'flex-1 bg-red-600 hover:bg-red-500 py-3 rounded-lg font-semibold transition text-sm',
});

/**
 * Normalize legacy (message, title) or options-object form.
 * @param {string|{ title?: string, message?: string, confirmText?: string, destructive?: boolean, icon?: string, okButtonClass?: string }} messageOrOptions
 * @param {string} [titleMaybe]
 */
export function normalizeConfirmActionArgs(messageOrOptions, titleMaybe) {
  if (messageOrOptions && typeof messageOrOptions === 'object' && !Array.isArray(messageOrOptions)) {
    const o = messageOrOptions;
    return {
      title: o.title != null && o.title !== '' ? String(o.title) : 'Are you sure?',
      message: o.message != null ? String(o.message) : '',
      confirmText: o.confirmText != null && o.confirmText !== '' ? String(o.confirmText) : 'Confirm',
      destructive: o.destructive === true,
      icon: o.icon != null ? String(o.icon) : '⚠️',
      okButtonClass: typeof o.okButtonClass === 'string' && o.okButtonClass
        ? o.okButtonClass
        : null,
    };
  }
  return {
    title: titleMaybe != null && titleMaybe !== '' ? String(titleMaybe) : 'Are you sure?',
    message: messageOrOptions != null ? String(messageOrOptions) : '',
    confirmText: 'Confirm',
    destructive: false,
    icon: '⚠️',
    okButtonClass: null,
  };
}

/**
 * Resolve OK button className for an options bag (after normalize).
 * @param {{ destructive: boolean, okButtonClass: string|null }} opts
 */
export function resolveConfirmOkClassName(opts) {
  if (opts.okButtonClass) return opts.okButtonClass;
  return opts.destructive ? CONFIRM_OK_CLASS.destructive : CONFIRM_OK_CLASS.safe;
}

/**
 * Show the shared confirmation modal.
 * Returns a Promise that resolves once to true (confirm) or false (cancel).
 *
 * @param {string|{ title?: string, message?: string, confirmText?: string, destructive?: boolean, icon?: string, okButtonClass?: string }} messageOrOptions
 * @param {string} [titleMaybe] legacy second arg when first is message string
 * @returns {Promise<boolean>}
 */
export function confirmAction(messageOrOptions, titleMaybe) {
  const opts = normalizeConfirmActionArgs(messageOrOptions, titleMaybe);

  return new Promise((resolve) => {
    const modal = document.getElementById('confirm-modal');
    if (!modal) {
      resolve(false);
      return;
    }

    const titleEl = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    const iconEl = document.getElementById('confirm-icon');
    let okBtn = document.getElementById('btn-confirm-ok');
    let cancelBtn = document.getElementById('btn-confirm-cancel');

    if (!titleEl || !messageEl || !okBtn || !cancelBtn || !okBtn.parentNode || !cancelBtn.parentNode) {
      resolve(false);
      return;
    }

    // Clone/replace so ALL prior listeners (including foreign callers) are dropped
    const freshOk = okBtn.cloneNode(true);
    const freshCancel = cancelBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(freshOk, okBtn);
    cancelBtn.parentNode.replaceChild(freshCancel, cancelBtn);
    okBtn = freshOk;
    cancelBtn = freshCancel;

    titleEl.textContent = opts.title;
    messageEl.textContent = opts.message;
    if (iconEl) {
      iconEl.textContent = opts.icon;
      iconEl.classList.remove('hidden');
    }

    okBtn.textContent = opts.confirmText;
    okBtn.className = resolveConfirmOkClassName(opts);
    okBtn.disabled = false;
    cancelBtn.disabled = false;

    modal.classList.remove('hidden');

    let settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      resolve(result);
    }
    function onOk() { finish(true); }
    function onCancel() { finish(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}
