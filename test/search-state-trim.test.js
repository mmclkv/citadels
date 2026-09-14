'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const HeuristicAI = require('../src/ai.js');
const mcts = require('../training/mcts.js');
const train = require('../training/train.js');
const { cloneTrimmed, trimInPlace, DROPPED_KEYS } = require('../training/search-state.js');
const { PolicyValueNetwork, mulberry32 } = require('../training/neural-policy.js');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

// 旧行为参考实现：与训练代码里 enumerateLegalActions 完全同构，只是用全量深拷贝
function enumerateFull(state, playerId) {
  const available = Engine.getAvailableActions(state, playerId);
  const player = state.players.find(p => p.id === playerId);
  let candidates = [];
  for (const action of available.actions || []) {
    if (action.disabled) continue;
    if (action.type === 'lab') {
      for (const card of player.hand) candidates.push({ ...action, discardUid: card.uid });
    } else if (action.type === 'museum') {
      for (const card of player.hand) candidates.push({ ...action, cardUid: card.uid });
    } else if (action.type === 'choose_cards') candidates.push(...train.redrawCandidates(action, player.hand));
    else candidates.push(clone(action));
  }
  const seen = new Set();
  const uniq = candidates.filter(a => {
    const key = JSON.stringify(a);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const legal = uniq.filter(a => Engine.applyAction(clone(state), playerId, a).ok);
  if (!legal.length) {
    try {
      const fb = HeuristicAI.decide(state, playerId);
      if (fb && Engine.applyAction(clone(state), playerId, fb).ok) legal.push(fb);
    } catch (_) { /* ignore */ }
  }
  return legal;
}

function makeState(seatCount = 4, seed = 20260913) {
  const seats = Array.from({ length: seatCount }, (_, i) => ({
    id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural'
  }));
  const state = Engine.createGame({ endDistricts: 8, charSetMode: 'base', seed, seats });
  Engine.startGame(state);
  return state;
}

// 推进若干步并让 log 堆积起来 —— 老 tailored 的场景正是我们优化的目标
function advance(state, steps, rng) {
  for (let i = 0; i < steps && state.phase !== 'gameover'; i++) {
    const actor = train.currentActor(state);
    if (!actor) break;
    const legal = train.enumerateLegalActions(state, actor.id);
    if (!legal.length) break;
    Engine.applyAction(state, actor.id, legal[Math.floor(rng() * legal.length)]);
  }
}

test('cloneTrimmed 不修改源状态', () => {
  const state = makeState();
  advance(state, 80, mulberry32(1));
  const before = JSON.stringify(state);
  const logRef = state.log;
  const noticesRef = state.notices;
  const copy = cloneTrimmed(state);
  assert.equal(JSON.stringify(state), before, '源状态逐字节不变');
  assert.equal(state.log, logRef, 'log 仍是同一个数组引用，没被换掉');
  assert.equal(state.notices, noticesRef, 'notices 仍是同一个数组引用');
  assert.notEqual(copy, state);
  for (const key of DROPPED_KEYS) {
    assert.deepEqual(copy[key], [], '快照的 ' + key + ' 为空');
  }
});

test('cloneTrimmed 只丢掉 UI 字段，其余内容一致', () => {
  const state = makeState();
  advance(state, 60, mulberry32(2));
  const copy = cloneTrimmed(state);
  for (const key of Object.keys(state)) {
    if (DROPPED_KEYS.includes(key)) continue;
    assert.deepEqual(copy[key], state[key], '字段 ' + key + ' 应该原样保留');
  }
  assert.deepEqual(Object.keys(copy).sort(), Object.keys(state).sort());
});

test('cloneTrimmed 在源状态缺字段时不凭空插键', () => {
  const state = { players: [], log: [1, 2, 3] };
  const copy = cloneTrimmed(state);
  assert.deepEqual(copy.log, []);
  assert.equal('notices' in state, false, '源状态不该多出 notices 键');
  assert.deepEqual(state.log, [1, 2, 3], 'log 已还原');
});

test('trimInPlace 就地清空', () => {
  const state = { log: [1, 2], notices: [3] };
  assert.equal(trimInPlace(state), state);
  assert.deepEqual(state.log, []);
  assert.deepEqual(state.notices, []);
});

test('掐掉 log/notices 不改变合法动作集合', () => {
  const state = makeState(5, 777);
  const rng = mulberry32(9);
  let checked = 0;
  for (let step = 0; step < 260 && state.phase !== 'gameover'; step++) {
    const actor = train.currentActor(state);
    if (!actor) break;
    const trimmed = train.enumerateLegalActions(state, actor.id);
    const full = enumerateFull(state, actor.id);
    assert.equal(trimmed.length, full.length,
      '步 ' + step + ' 合法动作数量应一致（' + trimmed.length + ' vs ' + full.length + '）');
    assert.deepEqual(JSON.parse(JSON.stringify(trimmed)), JSON.parse(JSON.stringify(full)),
      '步 ' + step + ' 合法动作内容应一致');
    checked++;
    if (!trimmed.length) break;
    Engine.applyAction(state, actor.id, trimmed[Math.floor(rng() * trimmed.length)]);
  }
  assert.ok(checked > 20, '至少覆盖 ' + checked + ' 个决策点');
});

test('引擎在掐掉 UI 字段的快照上行为一致', () => {
  const state = makeState(5, 4242);
  const rng = mulberry32(11);
  let checked = 0;
  for (let step = 0; step < 160 && state.phase !== 'gameover'; step++) {
    const actor = train.currentActor(state);
    if (!actor) break;
    const legal = train.enumerateLegalActions(state, actor.id);
    if (!legal.length) break;
    for (const action of legal) {
      const full = clone(state);
      const trimmed = cloneTrimmed(state);
      const rf = Engine.applyAction(full, actor.id, JSON.parse(JSON.stringify(action)));
      const rt = Engine.applyAction(trimmed, actor.id, JSON.parse(JSON.stringify(action)));
      assert.equal(rt.ok, rf.ok, '同一动作的 ok 结果应一致');
      if (!rf.ok) continue;
      // 除 log / notices 外，两条分支产生的后继状态必须完全相同
      for (const key of Object.keys(full)) {
        if (DROPPED_KEYS.includes(key)) continue;
        assert.deepEqual(trimmed[key], full[key],
          '动作 ' + action.type + ' 在字段 ' + key + ' 上产生了不同结果');
      }
      checked++;
    }
    Engine.applyAction(state, actor.id, legal[Math.floor(rng() * legal.length)]);
  }
  assert.ok(checked > 50, '至少验证 ' + checked + ' 次 applyAction');
});

test('MCTS 结果：掐 UI 字段 vs 全量深拷贝完全一致', async () => {
  const state = makeState(4, 31337);
  advance(state, 40, mulberry32(5));
  // 证实此刻 log 确实已经堆起来了，否则这条测试没有意义
  assert.ok(JSON.stringify(state.log || []).length > 500, 'log 应当已经积累到可观体积');

  const modelA = new PolicyValueNetwork({ profile: 'fast', stateSize: 192, actionSize: 64, seed: 99 });
  const modelB = new PolicyValueNetwork({ profile: 'fast', stateSize: 192, actionSize: 64, seed: 99 });
  const baseOpts = {
    rootPlayerId: train.currentActor(state).id, Engine, sanitize: Engine.sanitize,
    encodeState: train.encodeState, encodeAction: train.encodeAction,
    rewardFn: null, simulate: 40, cPuct: 1.0, dirichletAlpha: 0.3, dirichletEpsilon: 0.03, maxDepth: 200
  };

  // 旧路径：全量深拷贝 + 全量深拷贝版的合法动作枚举
  const legacy = await mcts.search(Object.assign({}, baseOpts, {
    rootState: clone(state), model: modelA, legalFn: enumerateFull,
    cloneState: clone, rng: mulberry32(12345)
  }));
  // 新路径：掐掉 UI 字段
  const trimmed = await mcts.search(Object.assign({}, baseOpts, {
    rootState: clone(state), model: modelB, legalFn: train.enumerateLegalActions,
    rng: mulberry32(12345)
  }));

  assert.equal(trimmed.expansions, legacy.expansions, '扩展节点数应一致');
  assert.equal(trimmed.visits, legacy.visits, '访问总数应一致');
  assert.equal(trimmed.pi.length, legacy.pi.length);
  for (let i = 0; i < legacy.pi.length; i++) {
    assert.ok(Math.abs(trimmed.pi[i] - legacy.pi[i]) < 1e-6,
      'π[' + i + '] 应完全相同：' + trimmed.pi[i] + ' vs ' + legacy.pi[i]);
  }
  assert.ok(Math.abs(trimmed.rootQ - legacy.rootQ) < 1e-6, '根节点 Q 应相同');
});

test('掐掉 UI 字段后真的变小了', () => {
  const state = makeState(5, 2024);
  advance(state, 300, mulberry32(3));
  const fullSize = JSON.stringify(state).length;
  const trimmedSize = JSON.stringify(cloneTrimmed(state)).length;
  assert.ok(fullSize > 8000, '跑这么多步后状态应该已经不小了，实际 ' + fullSize);
  assert.ok(trimmedSize < fullSize * 0.7,
    '掐掉 UI 字段后应至少小 30%，实际 ' + fullSize + ' → ' + trimmedSize);
  console.log('  state JSON ' + (fullSize / 1024).toFixed(1) + 'KB → ' +
    (trimmedSize / 1024).toFixed(1) + 'KB（省 ' +
    ((1 - trimmedSize / fullSize) * 100).toFixed(0) + '%）');
});
