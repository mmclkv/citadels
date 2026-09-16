'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../src/engine.js');

function navigatorState() {
  const state = Engine.createGame({ charSetMode: 'dark', seed: 128, seats: [
    { id: 'nav', name: '航海家玩家' }, { id: 'p1', name: '玩家2' },
    { id: 'p2', name: '玩家3' }, { id: 'p3', name: '玩家4' }
  ] });
  Engine.startGame(state);
  state.phase = 'action';
  state.players.forEach(player => { player.chars = []; player.played = []; });
  state.players[0].chars = ['navigator'];
  state.turn = { charId: 'navigator', num: 9, playerIdx: 0, playerId: 'nav', phase: 'main',
    takenResources: true, incomeTaken: true, abilityUsed: false, builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
  assert.equal(Engine.applyAction(state, 'nav', { type: 'ability' }).ok, true);
  return state;
}

test('航海家额外金币与手牌奖励发出对应动画通知', () => {
  const goldState = navigatorState();
  assert.equal(Engine.applyAction(goldState, 'nav', { type: 'navigator_bonus', mode: 'gold' }).ok, true);
  const goldNotice = goldState.notices.findLast(n => n.kind === 'navigator_bonus');
  assert.deepEqual({ mode: goldNotice.mode, amount: goldNotice.amount, playerIdx: goldNotice.playerIdx },
    { mode: 'gold', amount: 4, playerIdx: 0 });

  const cardState = navigatorState();
  const handBefore = cardState.players[0].hand.length;
  assert.equal(Engine.applyAction(cardState, 'nav', { type: 'navigator_bonus', mode: 'cards' }).ok, true);
  const cardNotice = cardState.notices.findLast(n => n.kind === 'navigator_bonus');
  assert.equal(cardNotice.mode, 'cards');
  assert.equal(cardNotice.amount, cardState.players[0].hand.length - handBefore);
  assert.ok(cardNotice.amount > 0);
});

test('前端根据航海家奖励类型播放金币或手牌入场动画', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = app.indexOf("case 'navigator_bonus':");
  assert.ok(start >= 0, '前端应处理航海家奖励通知');
  const end = app.indexOf('\n      case ', start + 10);
  const handler = app.slice(start, end);
  assert.match(handler, /n\.mode === 'gold'[\s\S]*?flyGoldIn\(n\.playerIdx, n\.amount\)/,
    '金币奖励应飞入航海家玩家框');
  assert.match(handler, /n\.mode === 'cards'[\s\S]*?flyCardsToHand\(n\.playerIdx, n\.amount\)/,
    '手牌奖励应飞入航海家玩家框');
});
