'use strict';

/**
 * ISMCTS（信息集蒙特卡洛树搜索）骨架的行为契约。
 *
 * 这些用例锁住的是「搜索结构与隐藏信息的关系」，不是数值：
 *  1. 只给 rootState 时（单粒子）行为与改造前一致，旧调用方不受影响；
 *  2. 粒子池里的每条模拟都进**同一棵树**（visits 累加到同一个根）；
 *  3. 每次模拟确实重新抽粒子，而不是整棵树钉死在一个世界上；
 *  4. 粒子权重生效（为后续把「观测似然」接进来做准备）；
 *  5. 粒子与路径不合时放弃该条模拟，既不卡死也不污染统计量；
 *  6. 聚合合法性的前提：同一信息集下，不同粒子送进网络的特征向量完全相同。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Engine = require('../src/engine.js');
const mcts = require('../training/mcts.js');
const { determinize } = require('../training/determinize.js');
const { enumerateLegalActions, encodeState, encodeAction } = require('../training/train.js');
const { PolicyValueNetwork, mulberry32 } = require('../training/neural-policy.js');

const SIMULATE = 60;

function buildModel(seed = 1) {
  return new PolicyValueNetwork({ profile: 'fast', stateSize: 192, actionSize: 64, seed });
}

function newGame(playerCount = 4) {
  const seats = [];
  for (let i = 0; i < playerCount; i++) {
    seats.push({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' });
  }
  const state = Engine.createGame({ roomId: 'ismcts-' + playerCount, endDistricts: 8,
    charSetMode: 'mixed', seed: 4242, seats });
  Engine.startGame(state);
  return state;
}

function baseOptions(state, model, extra = {}) {
  return Object.assign({
    rootPlayerId: state.players[0].id,
    model,
    Engine,
    sanitize: Engine.sanitize,
    legalFn: enumerateLegalActions,
    encodeState,
    encodeAction,
    simulate: SIMULATE,
    cPuct: 1.0,
    dirichletAlpha: 0,
    rng: mulberry32(20260919)
  }, extra);
}

/** 生成粒子池：每份都与公开信息一致，只换隐藏部分。 */
function particlePool(state, count, seed = 7) {
  const rng = mulberry32(seed);
  const me = state.players[0].id;
  const legal = enumerateLegalActions(state, me);
  const baseline = JSON.stringify(legal);
  const pool = [];
  for (let attempt = 0; attempt < count * 5 && pool.length < count; attempt++) {
    const guess = determinize(state, me, rng);
    if (JSON.stringify(enumerateLegalActions(guess, me)) !== baseline) continue;
    pool.push(guess);
  }
  return pool;
}

test('单粒子（只给 rootState）时行为与改造前一致：π 归一化且 visits 等于模拟数', async () => {
  const state = newGame();
  const result = await mcts.search(baseOptions(state, buildModel(11), { rootState: state }));
  assert.equal(result.particles, 1, '只给 rootState 时退化成单粒子');
  assert.equal(result.visits, SIMULATE, 'visits 与模拟数一致');
  assert.equal(result.pi.length, enumerateLegalActions(state, state.players[0].id).length);
  let sum = 0;
  for (let i = 0; i < result.pi.length; i++) {
    assert.ok(result.pi[i] >= 0 && Number.isFinite(result.pi[i]), 'π 元素非负有限');
    sum += result.pi[i];
  }
  assert.ok(Math.abs(sum - 1) < 1e-5, 'π 归一化，sum=' + sum);
});

test('多粒子时所有模拟都进同一棵树，且每条模拟重新抽粒子', async () => {
  const state = newGame();
  const pool = particlePool(state, 3);
  assert.equal(pool.length, 3, '粒子池生成成功');
  const result = await mcts.search(baseOptions(state, buildModel(23), { rootStates: pool }));

  assert.equal(result.particles, 3, '粒子池大小回传');
  // 关键：visits 是「这一棵树」的根访问总数。若是三棵独立树，这里只会是每棵的 1/3。
  assert.equal(result.visits, SIMULATE, '三条粒子的模拟累加到同一棵树');
  // 每条模拟重新采样：三个粒子都该被抽到过
  assert.equal(result.particleDraws.length, 3);
  assert.equal(result.particleDraws.reduce((a, b) => a + b, 0), SIMULATE, '抽取次数合计 = 模拟数');
  for (let i = 0; i < 3; i++) {
    assert.ok(result.particleDraws[i] > 0, '粒子 ' + i + ' 至少被抽到一次');
  }
});

test('粒子权重生效：高权粒子被显著更频繁地抽中', async () => {
  const state = newGame();
  const pool = particlePool(state, 3);
  const result = await mcts.search(baseOptions(state, buildModel(31), {
    rootStates: pool, particleWeights: [100, 1, 1]
  }));
  assert.ok(result.particleDraws[0] > result.particleDraws[1] + result.particleDraws[2],
    '高权粒子占多数，draws=' + JSON.stringify(result.particleDraws));
});

test('粒子与路径不合时放弃该条模拟：不卡死、π 仍然合法', async () => {
  const state = newGame();
  const pool = particlePool(state, 2);
  // 掺一个「来自另一局」的异质粒子：它的公开局面与根节点不同，重放必然对不上。
  const alien = newGame();
  const mixed = pool.concat([alien]);

  const result = await mcts.search(baseOptions(state, buildModel(41), { rootStates: mixed }));
  assert.ok(result.pi, '搜索仍然返回结果');
  assert.equal(result.visits, SIMULATE, '每条模拟都完成了回传');
  let sum = 0;
  for (let i = 0; i < result.pi.length; i++) { assert.ok(result.pi[i] >= 0); sum += result.pi[i]; }
  assert.ok(Math.abs(sum - 1) < 1e-5, 'π 仍然归一化');
  assert.equal(result.simReplayFail + result.simInfoSetMismatch + result.simOther +
    result.simLeaf + result.simTerminal + result.simDepthCapped, SIMULATE,
    '每条模拟都归属于某条统计路径');
});

test('注入 infosetKeyFn 后不同信息集会拆成独立子节点，而不是污染共享统计', async () => {
  const state = newGame();
  const pool = particlePool(state, 3);
  let counter = 0;
  // 每次调用都返回新 key：每次后继都应进入自己的信息集子节点，而不是沿用旧节点。
  const result = await mcts.search(baseOptions(state, buildModel(53), {
    rootStates: pool,
    infosetKeyFn: () => 'infoset-' + (++counter)
  }));
  assert.equal(result.simInfoSetMismatch, 0, '不同信息集应拆分节点，不应再误记为重放冲突');
  assert.equal(result.visits, SIMULATE, '拆分后的各信息集子节点仍应完整累计访问次数');
});

test('聚合合法性的前提：同一信息集下不同粒子送进网络的特征向量完全相同', () => {
  const state = newGame();
  const pool = particlePool(state, 3);
  const me = state.players[0].id;
  const reference = encodeState(Engine.sanitize(pool[0], me), me).vector;
  for (let i = 1; i < pool.length; i++) {
    const vector = encodeState(Engine.sanitize(pool[i], me), me).vector;
    assert.deepEqual(Array.from(vector), Array.from(reference),
      '粒子 ' + i + ' 与粒子 0 的网络输入一致 —— 隐藏信息不进网络，聚合才成立');
  }
});

test('deadlineAt 到点后搜索提前停下，返回的 π 依然可用', async () => {
  const state = newGame();
  const pool = particlePool(state, 3);
  const result = await mcts.search(baseOptions(state, buildModel(67), {
    rootStates: pool, deadlineAt: Date.now() + 1
  }));
  assert.ok(result.pi, '超时也返回 π');
  assert.ok(result.simulations <= SIMULATE, '完成的模拟数不超过预算，simulations=' + result.simulations);
  let sum = 0;
  for (let i = 0; i < result.pi.length; i++) { assert.ok(result.pi[i] >= 0); sum += result.pi[i]; }
  assert.ok(Math.abs(sum - 1) < 1e-5, 'π 仍然归一化');
});
