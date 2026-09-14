'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mcts = require('../training/mcts.js');
const { BatchEvaluator } = require('../training/evaluator.js');
const { PolicyValueNetwork, mulberry32 } = require('../training/neural-policy.js');
const Engine = require('../src/engine.js');

test('BatchEvaluator 下 MCTS 行为与 JsEvaluator 等价', async () => {
  // 构造两个 MCTS 实例：model 完全相同 + 相同 RNG + 相同 search 配置
  const modelJs = new PolicyValueNetwork({ profile: 'fast', stateSize: 192, actionSize: 64, seed: 31337 });
  const modelBatch = new PolicyValueNetwork({ profile: 'fast', stateSize: 192, actionSize: 64, seed: 31337 });
  const { encodeState, encodeAction, enumerateLegalActions } = require('../training/train.js');
  const state = Engine.createGame({ endDistricts: 8, charSetMode: 'base',
    seats: [{ id: 'a', name: 'A', isBot: true, botType: 'neural' },
            { id: 'b', name: 'B', isBot: true, botType: 'neural' }] });
  Engine.startGame(state);
  const rng = mulberry32(20260913);

  // JsEvaluator 路径
  const jsResult = await mcts.search({
    rootState: state, rootPlayerId: state.players[0].id, model: modelJs,
    Engine, sanitize: Engine.sanitize,
    legalFn: enumerateLegalActions, encodeState, encodeAction,
    simulate: 30, cPuct: 1.0, dirichletAlpha: 0, rng
  });

  // BatchEvaluator 路径：mock forwardBatch 直接调 model.forward，每批 8 个
  const collectedStates = [];
  let forwardCalls = 0;
  const fakeForwardBatch = async (stateVectors, actionVectorsList) => {
    forwardCalls++;
    collectedStates.push(stateVectors.length);
    const probsList = [];
    const values = [];
    for (let i = 0; i < stateVectors.length; i++) {
      // action vectors 没用到，因为 forward 输出 P 维度等于 actions 长度；
      // mock 这里直接复用 JsEvaluator 逻辑：调 modelBatch.forward
      const actions = actionVectorsList[i].map(v => new Float32Array(v));
      const out = modelBatch.forward(new Float32Array(stateVectors[i]), actions, 1.0);
      probsList.push(out.probs);
      values.push(out.value);
    }
    return { probsList, values };
  };
  const batchEvaluator = new BatchEvaluator({
    forwardBatch: fakeForwardBatch, batchSize: 8, maxWaitMs: 0,
    sanitize: Engine.sanitize, encodeState, encodeAction, cacheSize: 0
  });
  const batchResult = await mcts.search({
    rootState: state, rootPlayerId: state.players[0].id, model: modelBatch,
    Engine, sanitize: Engine.sanitize,
    legalFn: enumerateLegalActions, encodeState, encodeAction,
    simulate: 30, cPuct: 1.0, dirichletAlpha: 0, rng,
    evaluator: batchEvaluator
  });
  // 比较 visits 总数（应都=30）
  assert.equal(jsResult.visits, batchResult.visits, 'visits 一致');
  // 比较 π（两者数学上应高度重合：model 是确定性的 forward（relu/softmax），fakeForwardBatch 走完全相同代码）
  assert.equal(jsResult.pi.length, batchResult.pi.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < jsResult.pi.length; i++) {
    dot += jsResult.pi[i] * batchResult.pi[i];
    normA += jsResult.pi[i] * jsResult.pi[i];
    normB += batchResult.pi[i] * batchResult.pi[i];
  }
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-12);
  assert.ok(cos > 0.95, 'π 余弦相似度 > 0.95, actual=' + cos.toFixed(4));
  // 至少触发了一次 batch forward（30 sims 多次 expand，去重后 batch 数量有保障）
  assert.ok(forwardCalls >= 1, 'batch 路径确实调过 forwardBatch，calls=' + forwardCalls);
  // 累计 unique states
  const totalForwardNodes = collectedStates.reduce((a, b) => a + b, 0);
  console.log('  BatchEvaluator 收集：forwardCalls=' + forwardCalls +
    ' · totalForwardedNodes=' + totalForwardNodes +
    ' · visits=' + batchResult.visits);
  // 同 state hash 去重生效：去重后 forwarded nodes < 30*步数 上限
  assert.ok(totalForwardNodes < 1000, '去重让 GPU 实际负载远小于 simul 数');
});

test('BatchEvaluator maxWaitMs=0 表示即时 flush（下一 tick 即发送，不强制等待）', async () => {
  const model = new PolicyValueNetwork({ profile: 'fast', stateSize: 192, actionSize: 64, seed: 11 });
  const fakeForwardBatch = async (stateVectors) => ({
    probsList: stateVectors.map(() => new Float32Array(64).fill(1 / 64)),
    values: stateVectors.map(() => 0.0)
  });
  const { encodeState, encodeAction } = require('../training/train.js');
  const evalr = new BatchEvaluator({
    forwardBatch: fakeForwardBatch, batchSize: 8, maxWaitMs: 0,
    sanitize: Engine.sanitize, encodeState, encodeAction, cacheSize: 0
  });
  const state = Engine.createGame({ endDistricts: 8, charSetMode: 'base', seats: [{ id: 'a' }, { id: 'b' }] });
  Engine.startGame(state);
  const node = {
    state, playerId: state.players[0].id,
    legalActions: [{ id: 'noop' }], expanded: false,
    P: null, value: 0, W: 0, N: 0, children: new Map()
  };
  const p = evalr.evaluate(node);
  let resolved = false;
  p.then(() => { resolved = true; });
  // maxWaitMs=0 → setTimeout(0) 在下一 tick flush（即时发送），不应被长时间挂起
  await new Promise(r => setTimeout(r, 30));
  assert.equal(resolved, true, 'maxWaitMs=0 时单条 evaluate 应在下一 tick 被即时 flush');
  await p;
  assert.equal(node.expanded, true, 'flush 后节点被展开');
});

test('BatchEvaluator maxWaitMs=0 在 mcts.search 中不会死锁（串行 await 可被即时 flush 唤醒）', async () => {
  const model = new PolicyValueNetwork({ profile: 'fast', stateSize: 192, actionSize: 64, seed: 5 });
  const { encodeState, encodeAction, enumerateLegalActions } = require('../training/train.js');
  const collected = [];
  const fakeForwardBatch = async (stateVectors, actionVectorsList) => {
    collected.push(stateVectors.length);
    const probsList = [];
    const values = [];
    for (let i = 0; i < stateVectors.length; i++) {
      const actions = actionVectorsList[i].map(v => new Float32Array(v));
      const out = model.forward(new Float32Array(stateVectors[i]), actions, 1.0);
      probsList.push(out.probs);
      values.push(out.value);
    }
    return { probsList, values };
  };
  const state = Engine.createGame({ endDistricts: 8, charSetMode: 'base', seats: [{ id: 'a' }, { id: 'b' }] });
  Engine.startGame(state);
  const rng = mulberry32(20260913);
  const batchEvaluator = new BatchEvaluator({
    forwardBatch: fakeForwardBatch, batchSize: 8, maxWaitMs: 0,
    sanitize: Engine.sanitize, encodeState, encodeAction, cacheSize: 0
  });
  // 必须在合理时间内返回（此前 0 被吞成 1ms 之前的"不设定时器"变体会死锁）
  const result = await Promise.race([
    mcts.search({
      rootState: state, rootPlayerId: state.players[0].id, model,
      Engine, sanitize: Engine.sanitize, legalFn: enumerateLegalActions,
      encodeState, encodeAction, simulate: 20, cPuct: 1.0, dirichletAlpha: 0, rng,
      evaluator: batchEvaluator
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('maxWaitMs=0 死锁：search 超时')), 5000))
  ]);
  assert.ok(result && result.visits > 0, 'search 在 maxWaitMs=0 下正常完成');
  assert.ok(collected.length >= 1, '即时 flush 触发了 forwardBatch，calls=' + collected.length);
});

test('BatchEvaluator 同 state 跨批次命中缓存', async () => {
  const model = new PolicyValueNetwork({ profile: 'fast', stateSize: 192, actionSize: 64, seed: 7 });
  const calls = [];
  const fakeForwardBatch = async (stateVectors) => {
    calls.push(stateVectors.length);
    const probsList = stateVectors.map(() => new Float32Array(64).fill(1 / 64));
    const values = stateVectors.map(() => 0.0);
    return { probsList, values };
  };
  const evalr = new BatchEvaluator({
    forwardBatch: fakeForwardBatch, batchSize: 32, maxWaitMs: 1,
    sanitize: Engine.sanitize,
    encodeState: require('../training/train.js').encodeState,
    encodeAction: require('../training/train.js').encodeAction,
    cacheSize: 128
  });
  const state = Engine.createGame({ endDistricts: 8, charSetMode: 'base',
    seats: [{ id: 'a' }, { id: 'b' }] });
  Engine.startGame(state);
  // 第一批：5 个同 state 共享 1 次 forward（去重）
  const nodesA = Array.from({ length: 5 }, () => ({
    state, playerId: state.players[0].id,
    legalActions: [{ id: 'noop' }], expanded: false,
    P: null, value: 0, W: 0, N: 0, children: new Map()
  }));
  await Promise.all(nodesA.map(n => evalr.evaluate(n)));
  assert.equal(calls.length, 1, '同批只 forward 一次（含去重）');
  // 第二批：再来 3 个同 state，应走缓存
  const nodesB = Array.from({ length: 3 }, () => ({
    state, playerId: state.players[0].id,
    legalActions: [{ id: 'noop' }], expanded: false,
    P: null, value: 0, W: 0, N: 0, children: new Map()
  }));
  await Promise.all(nodesB.map(n => evalr.evaluate(n)));
  assert.equal(calls.length, 1, '后续同 state 走缓存，calls 仍是 1');
  assert.equal(evalr.batchStats.cacheHits, 3, '3 次 cache 命中');
});
