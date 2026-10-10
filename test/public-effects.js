'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const boxes = { '#desktop-public-effects': {}, '#mobile-public-effects': {} };
const context = vm.createContext({ App: {}, $: id => boxes[id],
  escapeHtml: text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') });
vm.runInContext(source.slice(source.indexOf('  function publicEffectItems('),
  source.indexOf('  function renderMobilePlayers(')), context);
const state = { roomId: 'one', round: 1, charDeck: [
  { num: 1, name: '刺客' }, { num: 2, name: '盗贼' }, { num: 3, name: '<巫师>' },
  { num: 9, id: 'tax_collector', name: '税务官' }
], effects: { assassinated: 1, thief: 2, bewitched: 3,
  magistrate: { nums: [9, 2], real: 9 }, blackmailer: { nums: [3, 1], real: 3 }, taxCollectorGold: 5 } };
context.renderPublicEffects(state);
const html = boxes['#desktop-public-effects'].innerHTML;
for (const text of ['1 号·刺客 被刺杀', '2 号·盗贼 被盗贼盯上', '3 号·&lt;巫师&gt; 被施咒',
  '逮捕令 2 号·盗贼、9 号·税务官', '威胁标记 1 号·刺客、3 号·&lt;巫师&gt;', '累计建筑税：5 枚金币']) {
  assert.ok(html.includes(text), text);
}
assert.equal(html.replaceAll('desktop-public-effect', 'mobile-public-effect'), boxes['#mobile-public-effects'].innerHTML);
state.effects = { taxCollectorGold: 0 };
context.renderPublicEffects(state);
assert.ok(boxes['#desktop-public-effects'].innerHTML.includes('被盗贼盯上（已生效）'), 'resolved declarations remain this round');
assert.ok(boxes['#desktop-public-effects'].innerHTML.includes('累计建筑税：0 枚金币'), 'tax collection updates immediately');
state.round++;
context.renderPublicEffects(state);
assert.ok(!boxes['#desktop-public-effects'].innerHTML.includes('被盗贼盯上'), 'next round clears declarations');
state.effects = { thief: 2 };
context.renderPublicEffects(state);
state.roomId = 'two';
state.effects = {};
state.charDeck = [];
context.renderPublicEffects(state);
assert.ok(boxes['#desktop-public-effects'].innerHTML.includes('本轮暂无公开宣告'), 'room changes clear declarations');
assert.equal(boxes['#mobile-public-effects'].hidden, true);
console.log('PASS: public declarations, tax balance, round/room reset, and desktop/mobile parity');
