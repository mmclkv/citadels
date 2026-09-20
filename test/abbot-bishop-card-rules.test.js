'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Cards = require('../src/cards.js');
const Engine = require('../src/engine.js');

function stateWith(role) {
  const state = Engine.createGame({ seed: 19, charSetMode: 'dark', seats: [
    { id: 'p0', name: '甲', isBot: true }, { id: 'p1', name: '乙', isBot: true },
    { id: 'p2', name: '丙', isBot: true }, { id: 'p3', name: '丁', isBot: true }
  ] });
  Engine.startGame(state);
  state.phase = 'action';
  state.players.forEach(p => { p.chars = []; p.played = []; });
  state.players[0].chars = [role];
  state.turn = { charId: role, num: Cards.CHAR_MAP[role].num, playerIdx: 0, phase: 'main',
    takenResources: true, incomeTaken: false, abilityUsed: false, builds: 0,
    spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
  return state;
}

test('住持按卡图领取宗教建筑金币，不再发动旧资源组合能力', () => {
  const state = stateWith('abbot');
  state.players[0].city = [
    { uid: 'blue-1', name: '教堂', color: 'blue', cost: 2 },
    { uid: 'blue-2', name: '修道院', color: 'blue', cost: 3 }
  ];
  const actions = Engine.getAvailableActions(state, 'p0').actions;
  assert.ok(actions.some(action => action.type === 'income'));
  assert.ok(!actions.some(action => action.type === 'ability'));
  assert.equal(Engine.applyAction(state, 'p0', { type: 'income' }).ok, true);
  assert.equal(state.players[0].gold, 4);
  assert.equal(state.turn.incomeTaken, true);
});

test('住持未被刺杀或施咒时免疫全部8号角色建筑能力，失去角色效果后不免疫', () => {
  const state = stateWith('warlord');
  // 保护看的是「本轮已打出住持」（played 对所有观看者公开），不是「手里握住」——
  // 后者会把谁拿住了持直接从 8 号角色的候选目标列表里读出来，见 test/abbot-privacy.test.js。
  state.players[1].played = ['abbot'];
  state.players[1].city = [{ uid: 'abbot-city', name: '教堂', color: 'blue', cost: 2 }];
  state.players[0].gold = 10;
  state.turn.pending = { kind: 'warlord_destroy' };
  let actions = Engine.getAvailableActions(state, 'p0').actions;
  assert.ok(!actions.some(action => action.target === 'p1'));
  state.effects.assassinated = 5;
  actions = Engine.getAvailableActions(state, 'p0').actions;
  assert.ok(actions.some(action => action.target === 'p1'));
});

test('主教每栋宗教建筑抽一张牌', () => {
  const state = stateWith('bishop');
  state.players[0].city = [
    { uid: 'blue-1', name: '教堂', color: 'blue', cost: 2 },
    { uid: 'blue-2', name: '修道院', color: 'blue', cost: 3 }
  ];
  state.deck = [
    { uid: 'draw-1', name: '市集', color: 'green', cost: 2 },
    { uid: 'draw-2', name: '堡垒', color: 'red', cost: 3 }
  ];
  assert.equal(Engine.applyAction(state, 'p0', { type: 'income' }).ok, true);
  assert.deepEqual(state.players[0].hand.slice(-2).map(card => card.uid), ['draw-1', 'draw-2']);
});

test('主教可让一名玩家支付建造差额，并按每金币一张手牌偿还', () => {
  const state = stateWith('bishop');
  state.players[0].gold = 2;
  state.players[0].hand = [
    { uid: 'build-me', name: '大教堂', color: 'blue', cost: 4, scoreValue: 4 },
    { uid: 'repay-1', name: '市集', color: 'green', cost: 2, scoreValue: 2 },
    { uid: 'repay-2', name: '要塞', color: 'red', cost: 3, scoreValue: 3 }
  ];
  state.players[1].gold = 5;
  const build = Engine.getAvailableActions(state, 'p0').actions.find(action => action.type === 'build' && action.uid === 'build-me');
  assert.ok(build && !build.target, '第一步应只选择要建造的建筑');
  assert.equal(Engine.applyAction(state, 'p0', build).ok, true);
  assert.equal(state.turn.pending.kind, 'bishop_payer');
  const payer = Engine.getAvailableActions(state, 'p0').actions.find(action => action.type === 'choose_player' && action.target === 'p1');
  assert.ok(payer, '第二步应选择代偿玩家');
  assert.equal(Engine.applyAction(state, 'p0', payer).ok, true);
  assert.equal(state.turn.pending.kind, 'bishop_repay');
  const result = Engine.applyAction(state, 'p0', { type: 'choose_cards', uids: ['repay-1', 'repay-2'] });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(state.players[0].city.map(card => card.uid), ['build-me']);
  assert.equal(state.players[0].gold, 0);
  assert.equal(state.players[1].gold, 3);
  assert.deepEqual(state.players[1].hand.slice(-2).map(card => card.uid), ['repay-1', 'repay-2']);
});

test('主教偿还手牌数量必须与代付金币差额一致', () => {
  const state = stateWith('bishop');
  state.players[0].gold = 1;
  state.players[0].hand = [
    { uid: 'build-me', name: '大教堂', color: 'blue', cost: 3 },
    { uid: 'repay', name: '市集', color: 'green', cost: 2 },
    { uid: 'repay-2', name: '要塞', color: 'red', cost: 3 }
  ];
  state.players[1].gold = 2;
  const build = Engine.getAvailableActions(state, 'p0').actions.find(action => action.type === 'build' && action.uid === 'build-me');
  assert.ok(build);
  assert.equal(state.players[0].gold, 1);
  assert.equal(state.players[0].hand.find(card => card.uid === 'build-me').cost, 3);
  assert.equal(Engine.applyAction(state, 'p0', build).ok, true);
  assert.equal(state.turn.pending.kind, 'bishop_payer');
  assert.equal(Engine.applyAction(state, 'p0', { type: 'choose_player', target: 'p1' }).ok, true);
  assert.equal(state.turn.pending.amount, 2);
  const result = Engine.applyAction(state, 'p0', { type: 'choose_cards', uids: [] });
  assert.equal(result.ok, false);
  assert.match(result.error, /恰好 2 张/);
});
