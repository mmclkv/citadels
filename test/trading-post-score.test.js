#!/usr/bin/env node
'use strict';

const assert = require('assert');
const Cards = require('../src/cards.js');
const Engine = require('../src/engine.js');

const tradingPostDef = Cards.DISTRICTS.find(card => card.en === 'Trading Post');
assert.ok(tradingPostDef, '建筑定义中存在商栈');
assert.strictEqual(tradingPostDef.cost, 3, '商栈规则数据与卡图一致，费用及基础分均为3');

const deckTradingPosts = Cards.buildDistrictDeck(() => 0.5)
  .filter(card => card.en === 'Trading Post');
assert.strictEqual(deckTradingPosts.length, 3, '牌堆生成3张商栈');
deckTradingPosts.forEach(card => {
  assert.strictEqual(card.cost, 3, '生成的商栈费用为3');
  assert.strictEqual(card.scoreValue, 3, '生成的商栈计分值为3');
});

const state = Engine.createGame({
  seats: [
    { id: 'p0', name: '玩家' },
    { id: 'p1', name: '电脑', isBot: true }
  ],
  endDistricts: 8,
  charSetMode: 'base',
  seed: 42
});
state.phase = 'action';
state.round = 1;
state.firstToFinish = -1;
state.players[0].city = [
  { uid: 'tavern', name: '酒馆', en: 'Tavern', color: 'green', cost: 1, scoreValue: 1 },
  { uid: 'keep', name: '堡垒', en: 'Keep', color: 'purple', cost: 3, scoreValue: 3,
    purple: { effect: 'immune' } },
  Object.assign({ uid: 'trading-post' }, deckTradingPosts[0]),
  { uid: 'battlefield', name: '战场', en: 'Battlefield', color: 'red', cost: 3, scoreValue: 3 }
];

const score = Engine.computeScores(state)[0];
assert.strictEqual(score.base, 10, '图示四张建筑按 1+3+3+3 计算为10分');
assert.strictEqual(score.total, 10, '没有其它奖励时实时总分显示10');
assert.deepStrictEqual(score.detail[0], { label: '建筑总分', value: 10 },
  '计分明细同步显示建筑总分10');

console.log('商栈费用与图示实时计分回归：全部断言通过');
