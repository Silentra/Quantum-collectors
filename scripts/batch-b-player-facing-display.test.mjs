/**
 * Batch B player-facing display helpers (achievements / titles / consumables).
 * Run: node scripts/batch-b-player-facing-display.test.mjs
 */

import {
  formatTitleAchievementSourceLine,
  getAchievementSourcesForCosmetic,
  resolveAchievementRowIconEmoji,
  shouldDisplayConsumable,
} from '../js/player-facing-display.js';

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS:', msg);
  }
}

// --- Trophy / earned distinction ---
{
  assert(
    resolveAchievementRowIconEmoji(false, { icon: { emoji: '🏆' } }) === '',
    'locked → no trophy',
  );
  assert(
    resolveAchievementRowIconEmoji(true, { icon: { emoji: '' } }) === '🏆',
    'unlocked/unclaimed → default trophy',
  );
  assert(
    resolveAchievementRowIconEmoji(true, { icon: { emoji: '📚' } }) === '📚',
    'unlocked → custom emoji kept',
  );
  assert(
    resolveAchievementRowIconEmoji(true, { icon: { emoji: '🏆' } }) === '🏆',
    'claimed (unlocked) → trophy remains',
  );
}

// --- Title reverse-map ---
{
  const defs = [
    {
      id: 'ach_archivist',
      name: 'Archivist',
      rewards: [{ type: 'cosmetic', itemId: 'title_archivist' }],
    },
    {
      id: 'ach_scholar',
      name: 'Scholar',
      rewards: [{ type: 'cosmetic', itemId: 'title_archivist' }],
    },
    {
      id: 'ach_rp',
      name: 'RP Boost',
      rewards: [{ type: 'rp', amount: 50 }],
    },
  ];

  const one = getAchievementSourcesForCosmetic('title_archivist', [
    defs[0],
    defs[2],
  ]);
  assert(one.length === 1 && one[0].name === 'Archivist', 'single achievement source maps');

  const multi = getAchievementSourcesForCosmetic('title_archivist', defs);
  assert(
    multi.length === 2 && multi.map(s => s.name).join(', ') === 'Archivist, Scholar',
    'multiple achievement sources joined',
  );

  const none = getAchievementSourcesForCosmetic('title_shop_only', defs);
  assert(none.length === 0, 'non-achievement title returns no source');

  assert(
    formatTitleAchievementSourceLine(one) === 'Earned from: Archivist',
    'format single source line',
  );
  assert(
    formatTitleAchievementSourceLine(multi) === 'Earned from: Archivist, Scholar',
    'format multi source line',
  );
  assert(formatTitleAchievementSourceLine([]) === '', 'no fake source line when empty');
  assert(formatTitleAchievementSourceLine(none) === '', 'shop/unknown title omits line');
}

// --- Consumable visibility filter ---
{
  assert(
    shouldDisplayConsumable({ id: 'a', enabled: false }, 0) === false,
    'disabled×0 hidden',
  );
  assert(
    shouldDisplayConsumable({ id: 'a', enabled: false }, 2) === true,
    'disabled×>0 visible',
  );
  assert(
    shouldDisplayConsumable({ id: 'a', enabled: true }, 0) === true,
    'enabled×0 unchanged (still displayable)',
  );
  assert(
    shouldDisplayConsumable({ id: 'a', enabled: true }, 3) === true,
    'enabled×>0 visible',
  );
  assert(
    shouldDisplayConsumable(null, 0) === false,
    'missing definition not displayable',
  );
}

// --- Research button class path (static string check via source file) ---
{
  const fs = await import('node:fs');
  const path = new URL('../js/project-ui.js', import.meta.url);
  const source = fs.readFileSync(path, 'utf8');
  assert(
    source.includes('class="shop-btn rp-assign-back-btn" id="rp-btn-back"')
      && source.includes('class="shop-btn rp-assign-back-btn" id="rp-report-btn-back"'),
    'Research back buttons reuse shop-btn + rp-assign-back-btn',
  );
}

if (!process.exitCode) {
  console.log('\nbatch-b-player-facing-display tests: ALL PASSED');
}
