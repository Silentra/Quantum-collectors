/**
 * Toast Notification System
 * Position: bottom-left (avoids Edit Game / Create Game controls)
 * Duration: 5 seconds before fade-out
 */

const container = () => document.getElementById('toast-container');

export function success(message) { show(message, 'success'); }
export function error(message) { show(message, 'error'); }
export function info(message) { show(message, 'info'); }

function show(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  const c = container();
  if (c) {
    c.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-100%)';
      el.style.transition = 'all 0.3s ease';
      setTimeout(() => el.remove(), 300);
    }, 5000);
  }
}
