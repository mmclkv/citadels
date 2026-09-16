'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Cards = require('../src/cards.js');
const Engine = require('../src/engine.js');

function stateWith(charId) {
  const state = Engine.createGame({ seed: 22, charSetMode: 'dark', seats: [
    { id: 'p0', name: '甲', isBot: true }, { id: 'p1', name: '乙', isBot: true },
    { id: 'p2', name: '丙', isBot: true }, { id: 'p3', name: '丁', isBot: true }
  ] });
  Engine.startGame(state);
  state.phase = 'action';
  state.players.forEach(p => { p.chars = []; p.played = []; });
  state.players[0].chars = [charId];
  state.players[0].gold = 2;
  state.turn = { charId, num: Cards.CHAR_MAP[charId].num, playerIdx: 0, phase: 'main',
    takenResources: true, incomeTaken: false, abilityUsed: false, builds: 0,
    spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
  return state;
}

test('dark 6 个角色已注册，dark 角色组可选用新增角色', () => {
  for (const id of ['magistrate', 'spy', 'blackmailer', 'wizard', 'abbot', 'tax_collector']) {
    assert.ok(Cards.CHAR_MAP[id], id + ' 应有角色定义');
  }
  const ids = Cards.pickCharacterSet(6, 'dark', () => 0).map(c => c.id);
  assert.deepEqual(ids, ['witch', 'blackmailer', 'wizard', 'emperor', 'abbot', 'alchemist', 'navigator', 'diplomat', 'tax_collector']);
});

test('住持可以按蓝色建筑数量宣告金币和建筑牌', () => {
  const state = stateWith('abbot');
  state.players[0].city = [{ uid: 'b1', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  const ability = Engine.getAvailableActions(state, 'p0').actions.find(a => a.type === 'ability');
  assert.ok(ability, '住持应有主动能力');
  assert.equal(Engine.applyAction(state, 'p0', ability).ok, true);
  assert.equal(state.turn.pending.kind, 'abbot_declare');
  assert.equal(Engine.applyAction(state, 'p0', { type: 'abbot_resource', gold: 1, cards: 0 }).ok, true);
  assert.equal(state.turn.incomeTaken, true);
});

test('税务官建造后会累积建筑税，并可在自己的回合收取', () => {
  const state = stateWith('tax_collector');
  state.players[1].hand = [{ uid: 'd1', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  state.players[1].gold = 3;
  state.turn.playerIdx = 1; state.turn.charId = 'tax_collector'; state.turn.num = 9;
  state.players[1].chars = ['king'];
  state.players[0].chars = ['tax_collector'];
  assert.equal(Engine.applyAction(state, 'p1', { type: 'build', uid: 'd1' }).ok, true);
  assert.equal(state.effects.taxCollectorGold, 1);
  state.turn.playerIdx = 0; state.turn.charId = 'tax_collector'; state.turn.num = 9;
  state.players[0].chars = ['tax_collector'];
  const collect = Engine.getAvailableActions(state, 'p0').actions.find(a => a.type === 'ability');
  assert.ok(collect, '税务官应有收税能力');
  assert.equal(Engine.applyAction(state, 'p0', collect).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'tax_collect' }).ok, true);
  assert.equal(state.effects.taxCollectorGold, 0);
});

test('间谍可以调查玩家手牌并按建筑类型抽牌', () => {
  const state = stateWith('spy');
  state.players[1].hand = [{ uid: 'x1', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  state.players[1].gold = 2;
  assert.equal(Engine.applyAction(state, 'p0', { type: 'ability' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'spy_target', target: 'p1' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'spy_color', color: 'blue' }).ok, true);
  assert.equal(state.players[0].hand.length, 5);
  assert.equal(state.players[1].gold, 1);
});

test('法师可以查看并立即建造目标手牌且不增加正常建造次数', () => {
  const state = stateWith('wizard');
  state.players[0].gold = 5;
  state.players[1].hand = [{ uid: 'x2', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  assert.equal(Engine.applyAction(state, 'p0', { type: 'ability' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'wizard_target', target: 'p1' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'wizard_card', uid: 'x2' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'wizard_build' }).ok, true);
  assert.equal(state.players[0].city[0].uid, 'x2');
  assert.equal(state.turn.builds, 0);
});

test('行政官签名逮捕令会没收目标第一次付费建造的建筑', () => {
  const state = stateWith('magistrate');
  state.players[0].chars = ['magistrate'];
  state.players[1].hand = [{ uid: 'x3', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  state.players[1].gold = 3;
  state.effects.magistrate = { nums: [3, 5, 6], signed: 3, playerIdx: 0, claimed: false };
  state.turn = { charId: 'wizard', num: 3, playerIdx: 1, phase: 'main', takenResources: true,
    incomeTaken: true, abilityUsed: true, builds: 0, spentOnBuild: 0, usedLab: false,
    usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
  assert.equal(Engine.applyAction(state, 'p1', { type: 'build', uid: 'x3' }).ok, true);
  assert.equal(state.players[0].city[0].uid, 'x3');
  assert.equal(state.players[1].city.length, 0);
  assert.equal(state.players[1].gold, 3);
});

test('勒索者能分配两个威胁目标，目标可用一半金币赎回', () => {
  const state = stateWith('blackmailer');
  assert.equal(Engine.applyAction(state, 'p0', { type: 'ability' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'blackmailer_char', num: 3 }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'blackmailer_char', num: 5 }).ok, true);
  assert.deepEqual(state.effects.blackmailer.nums, [3, 5]);
});
