'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const CitCards = require('../src/cards.js');

function seats(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural'
  }));
}

function createGame(seed, count, mode) {
  const state = Engine.createGame({
    roomId: 'seed-' + seed, endDistricts: 8, charSetMode: mode, seed, seats: seats(count)
  });
  Engine.startGame(state);
  return state;
}

// createdAt 是 Date.now() 打的墙钟时间戳，跟玩法无关，比对时要剔掉
function fingerprint(state) {
  const copy = JSON.parse(JSON.stringify(state));
  delete copy.createdAt;
  return JSON.stringify(copy);
}

// 恒定选合法动作列表里的第 0 项：策略本身确定，才能把随机源隔离出来
function playOut(state, maxSteps) {
  let steps = 0;
  while (state.phase !== 'gameover' && steps < maxSteps) {
    const actor = pickActor(state);
    if (!actor) break;
    const legal = Engine.getAvailableActions(state, actor);
    const usable = (legal.actions || []).filter(a => !a.disabled);
    if (!usable.length) break;
    const r = Engine.applyAction(state, actor, usable[0]);
    if (!r.ok) break;
    steps++;
  }
  return steps;
}

function pickActor(state) {
  if (state.phase === 'draft' && state.draft) {
    const step = state.draft.steps[state.draft.stepIdx];
    return step ? state.players[step.player].id : null;
  }
  if (state.reaction) return state.players[state.reaction.playerIdx].id;
  if (state.roundConfirm) {
    const i = (state.roundConfirm.confirmed || []).findIndex(v => !v);
    return i >= 0 ? state.players[i].id : null;
  }
  return state.turn ? state.players[state.turn.playerIdx].id : null;
}

test('同一 seed + mixed 模式：整套初始局面逐字节相同', () => {
  for (const count of [4, 5, 6]) {
    const a = createGame(20260913, count, 'mixed');
    const b = createGame(20260913, count, 'mixed');
    assert.deepEqual(a.charDeck, b.charDeck, count + ' 人局角色组应一致');
    assert.equal(fingerprint(a), fingerprint(b), count + ' 人局初始状态应逐字节相同');
  }
});

test('不同 seed 应该产生不同局面（防止退化成常量）', () => {
  const a = createGame(1, 5, 'mixed');
  const b = createGame(2, 5, 'mixed');
  const c = createGame(999, 5, 'mixed');
  const seen = new Set([a.charDeck.join(','), b.charDeck.join(','), c.charDeck.join(',')]);
  assert.ok(seen.size > 1, '不同 seed 至少应产生过不同的角色组：' + [...seen].join(' | '));
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test('跑完整局：同 seed 两次的结果完全一致（mixed）', () => {
  const runs = [1, 2].map(() => {
    const state = createGame(424242, 5, 'mixed');
    const steps = playOut(state, 4000);
    return { steps, fp: fingerprint(state), phase: state.phase };
  });
  assert.ok(runs[0].steps > 30, '这局得真跑起来才有说服力，实际 ' + runs[0].steps + ' 步');
  assert.equal(runs[0].steps, runs[1].steps, '步数应一致');
  assert.equal(runs[0].phase, runs[1].phase, '终局阶段应一致');
  assert.equal(runs[0].fp, runs[1].fp, '打完一整局后的状态应逐字节相同');
});

test('base / dark 模式同样可复现', () => {
  for (const mode of ['base', 'dark']) {
    const a = createGame(777, 5, mode);
    const b = createGame(777, 5, mode);
    assert.equal(fingerprint(a), fingerprint(b), mode + ' 模式应可复现');
  }
});

test('pickCharacterSet：注入 rnd 时可复现，不注入时仍能工作', () => {
  let s1 = 12345;
  let s2 = 12345;
  const seeded = () => { s1 = (s1 * 1103515245 + 12345) & 0x7fffffff; return s1 / 0x7fffffff; };
  const same = () => { s2 = (s2 * 1103515245 + 12345) & 0x7fffffff; return s2 / 0x7fffffff; };

  const a = CitCards.pickCharacterSet(5, 'mixed', seeded).map(c => c.id);
  const b = CitCards.pickCharacterSet(5, 'mixed', same).map(c => c.id);
  assert.deepEqual(a, b, '同一 rnd 序列应得到同一套角色');

  const c = CitCards.pickCharacterSet(5, 'mixed').map(c => c.id);
  assert.ok(c.length >= 8, '不传 rnd 时应退回 Math.random 且仍产出合理角色组，实际 ' + c.length + ' 张');

  const d = CitCards.pickCharacterSet(5, 'base').map(c => c.id);
  assert.ok(d.length >= 8, 'base 模式不受影响');
});
