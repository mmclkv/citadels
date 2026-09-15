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

test('JS 终局奖励只随排名变化，不随分差变化', () => {
  const state = fixture(4);
  state.scores = Engine.computeScores(state);
  const original = Array.from(train.gameRewards(state).values());
  const sorted = state.scores.slice().sort((a, b) => b.total - a.total);
  const ranks = new Map(sorted.map((row, rank) => [row.playerIdx, rank]));
  state.scores = state.scores.map(row => ({ ...row, total: 100 - ranks.get(row.playerIdx) * 10 }));
  assert.deepEqual(Array.from(train.gameRewards(state).values()), original);
  assert.deepEqual(original, state.scores.map(row => 1 - 2 * ranks.get(row.playerIdx) / 3));
});

test('并列名次共享奖励，且不按座位顺序拆分并列', t => {
  const state = fixture(4);
  state.firstToFinish = -1;
  state.players = state.players.map((player, i) => ({
    ...player, city: [card('tie-' + i, 'yellow', 1)]
  }));
  state.scores = Engine.computeScores(state);
  const rewards = train.gameRewards(state);
  assert.deepEqual(Array.from(rewards.values()), [1, 1, 1, 1]);
  const executable = process.env.CITADELS_NATIVE_TERMINAL_REWARD_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_TERMINAL_REWARD_PROBE，跳过 C++ 并列名次检查'); return; }
  const actual = execFileSync(executable, { input: JSON.stringify(state) + '\n', encoding: 'utf8' })
    .trim().split(',').map(Number);
  assert.deepEqual(actual, [1, 1, 1, 1]);
});

test('4/5/6 人无组队终局奖励与 C++ terminal_value 一致', t => {
  const executable = process.env.CITADELS_NATIVE_TERMINAL_REWARD_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_TERMINAL_REWARD_PROBE，跳过跨语言终局奖励检查'); return; }
  for (const playerCount of [4, 5, 6]) {
    const state = fixture(playerCount);
    state.scores = Engine.computeScores(state);
    const expected = train.gameRewards(state);
    const sorted = state.scores.slice().sort((a, b) => b.total - a.total);
    const actual = execFileSync(executable, { input: JSON.stringify(state) + '\n', encoding: 'utf8' })
      .trim().split(',').map(Number);
    assert.equal(actual.length, playerCount);
    for (let i = 0; i < playerCount; i++) {
      const rank = sorted.findIndex(row => row.playerIdx === i);
      const rankOnly = 1 - 2 * rank / (playerCount - 1);
      assert.equal(expected.get('p' + i), rankOnly);
      assert.ok(Math.abs(actual[i] - expected.get('p' + i)) < 1e-5,
        `player ${playerCount}/${i}: native=${actual[i]} js=${expected.get('p' + i)}`);
    }
  }
});

test('4/5/6 人 C++/JS 终局 valueVector 按相对座位一致', t => {
  const executable = process.env.CITADELS_NATIVE_TERMINAL_REWARD_VECTOR_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_TERMINAL_REWARD_VECTOR_PROBE，跳过跨语言向量检查'); return; }
  for (const playerCount of [4, 5, 6]) {
    const state = fixture(playerCount);
    state.scores = Engine.computeScores(state);
    const rewards = train.gameRewards(state);
    const actual = execFileSync(executable, { input: JSON.stringify(state) + '\n', encoding: 'utf8' })
      .trim().split(';').map(row => row.split(',').map(Number));
    assert.equal(actual.length, playerCount);
    for (let perspective = 0; perspective < playerCount; perspective++) {
      const expected = train.relativeRewardVector(state, 'p' + perspective, rewards);
      assert.equal(actual[perspective].length, 8);
      for (let slot = 0; slot < 8; slot++) {
        assert.ok(Math.abs(actual[perspective][slot] - expected.values[slot]) < 1e-5,
          `player ${playerCount}/${perspective}/${slot}: native=${actual[perspective][slot]} js=${expected.values[slot]}`);
      }
    }
  }
});
