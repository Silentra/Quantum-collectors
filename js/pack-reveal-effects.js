/**
 * pack-reveal-effects.js — Pack/breakthrough reveal celebration FX
 *
 * Extracted from ui.js (Phase 4) to avoid ui.js ↔ project-ui.js circular imports
 * when pack rendering uses card-render.js.
 */

/**
 * Spawn celebratory firework particles around a card element.
 * Epic = ~10 particles, Legendary = ~20 particles + lightning flash.
 * @param {HTMLElement} wrapperEl
 * @param {string} rarity
 */
export function spawnRevealParticles(wrapperEl, rarity) {
  const isLegendary = rarity === 'legendary';
  const count = isLegendary ? 20 : 10;
  const colors = isLegendary
    ? ['#f59e0b', '#fbbf24', '#fcd34d', '#f97316', '#fff7ed']
    : ['#a855f7', '#c084fc', '#d8b4fe', '#7c3aed', '#e9d5ff'];

  const container = document.createElement('div');
  container.className = 'pack-particles-container';
  wrapperEl.style.position = 'relative';
  wrapperEl.appendChild(container);

  if (isLegendary) {
    const flash = document.createElement('div');
    flash.className = 'legendary-reveal-flash';
    container.appendChild(flash);
  }

  const rect = wrapperEl.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;

  for (let i = 0; i < count; i++) {
    const particle = document.createElement('div');
    particle.className = 'pack-particle' + (isLegendary ? ' pack-particle--legendary' : '');
    particle.style.background = colors[i % colors.length];
    particle.style.left = cx + 'px';
    particle.style.top = cy + 'px';

    const size = isLegendary ? (4 + Math.random() * 6) : (4 + Math.random() * 4);
    particle.style.width = size + 'px';
    particle.style.height = size + 'px';

    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.9;
    const dist = isLegendary ? (50 + Math.random() * 70) : (40 + Math.random() * 55);
    particle.style.setProperty('--px', `${Math.cos(angle) * dist}px`);
    particle.style.setProperty('--py', `${Math.sin(angle) * dist}px`);

    particle.style.animationDelay = (Math.random() * 0.08) + 's';

    container.appendChild(particle);
  }

  setTimeout(() => container.remove(), isLegendary ? 1200 : 1000);
}
