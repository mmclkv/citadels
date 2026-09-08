/* 回归测试：抽两张留一张时，pending.cards 必须保留 en 字段，
 * 否则霓虹主题无法通过 Theme.districtKey 找到卡图资源。 */
const Engine = require('../src/engine.js');
// 直接读取霓虹主题清单，避免 Node 环境下 theme-manager 与 manifest 全局对象不一致的问题
const manifest = require('../public/themes/neon/manifest.js');
const districts = (manifest.CitadelThemeManifests && manifest.CitadelThemeManifests.neon)
  ? manifest.CitadelThemeManifests.neon.cards.districts
  : (typeof CitadelThemeManifests !== 'undefined' && CitadelThemeManifests.neon)
    ? CitadelThemeManifests.neon.cards.districts
    : {};

function buildState() {
  const state = Engine.createGame({
    roomId: 'test',
    endDistricts: 8,
    charSetMode: 'base',
    seats: [
      { id: 'me', name: '我', isBot: false },
      { id: 'b1', name: '电脑1', isBot: true, botLevel: 'normal' }
    ]
  });
  Engine.startGame(state);
  state.phase = 'action';
  state.turn = {
    charId: 'merchant', num: 6, playerIdx: 0, phase: 'main',
    takenResources: false, incomeTaken: false, abilityUsed: false,
    builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false,
    usedMuseum: false, pending: null, bonusDone: false
  };
  return state;
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.error('  ✗ ' + msg); }
}

const state = buildState();
const res = Engine.applyAction(state, 'me', { type: 'take_cards' });
assert(res.ok, 'take_cards action succeeds');

const pub = Engine.sanitize(state, 'me');
const pending = pub.turn && pub.turn.pending;
assert(pending && pending.kind === 'draw_keep', 'pending kind is draw_keep');
assert(pending.cards && pending.cards.length === 2, 'pending has 2 cards');
assert(pending.cards.every(c => c.en), 'every pending card has en field');

function districtKey(c) {
  const raw = c.en || c.name;
  const safe = String(raw).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return 'district_' + safe;
}

pending.cards.forEach(c => {
  const key = districtKey(c);
  const entry = districts[key];
  assert(entry && entry.thumb && entry.thumb.endsWith('.webp'),
    'neon manifest contains thumb for "' + c.name + '" (en=' + c.en + ', key=' + key + ')');
});

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
