'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');

function card(uid, color, cost, extra = {}) {
  return { uid, name: uid, en: uid, color, cost,
    scoreValue: extra.scoreValue || cost, beautified: extra.beautified || 0,
    builtRound: extra.builtRound || 1, museum: extra.museum || [],
    museumCount: (extra.museum || []).length,
    ...(extra.purple ? { purple: extra.purple } : {}) };
}

function fixture(playerCount) {
  const cities = [
    [card('y0', 'yellow', 3), card('b0', 'blue', 2), card('g0', 'green', 5, { scoreValue: 6 }),
      card('r0', 'red', 3), card('ghost0', 'purple', 2, { purple: { effect: 'anyColorScore' }, builtRound: 1 }),
      card('museum0', 'purple', 4, { purple: { effect: 'museum' }, beautified: 1, museum: [{ uid: 'm0' }, { uid: 'm1' }] })],
    [card('y1', 'yellow', 5), card('b1', 'blue', 3), card('g1', 'green', 2)],
    [card('r2', 'red', 5), card('p2', 'purple', 6, { scoreValue: 8 })],
    [card('y3', 'yellow', 3), card('g3', 'green', 4)],
    [card('b4', 'blue', 5), card('r4', 'red', 3)],
    [card('g5', 'green', 5), card('p5', 'purple', 4)]
  ];
  return {
    phase: 'gameover', round: 2, firstToFinish: 0,
    config: { endDistricts: 5, playerCount },
    players: cities.slice(0, playerCount).map((city, i) => ({ id: 'p' + i, name: 'P' + i, city }))
  };
}

test('4/5/6 人无组队终局奖励与 C++ terminal_value 一致', t => {
  const executable = process.env.CITADELS_NATIVE_TERMINAL_REWARD_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_TERMINAL_REWARD_PROBE，跳过跨语言终局奖励检查'); return; }
  for (const playerCount of [4, 5, 6]) {
    const state = fixture(playerCount);
    state.scores = Engine.computeScores(state);
    const expected = train.gameRewards(state);
    const actual = execFileSync(executable, { input: JSON.stringify(state) + '\n', encoding: 'utf8' })
      .trim().split(',').map(Number);
    assert.equal(actual.length, playerCount);
    for (let i = 0; i < playerCount; i++)
      assert.ok(Math.abs(actual[i] - expected.get('p' + i)) < 1e-5,
        `player ${playerCount}/${i}: native=${actual[i]} js=${expected.get('p' + i)}`);
  }
});
