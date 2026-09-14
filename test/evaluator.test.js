'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JsEvaluator, BatchEvaluator, hashStateVector } = require('../training/evaluator.js');

// 一个 stub model：固定 forward 返回值
class StubModel {
  constructor(probs, value) {
    this.probs = probs;
    this.value = value;
    this.calls = 0;
  }
  forward(state, actions, temperature) {
    this.calls++;
    return { probs: this.probs, value: this.value };
  }
}

function makeNode() {
  return {
    state: { foo: 1 },
    playerId: 'p0',
    legalActions: [{ type: 'pick' }, { type: 'draw' }],
    expanded: false,
    P: null, value: 0, W: 0, N: 0, children: new Map()
  };
}

const fixedSanitize = () => ({ foo: 1 });
const fixedEncodeState = () => ({ vector: new Float32Array([0.1, 0.2, 0.3]), context: { x: 1 } });
const fixedEncodeAction = action => new Float32Array([action.type === 'pick' ? 1 : 0, 0, 0]);

test('JsEvaluator 调用 model.forward 并把 (P, V) 填进 node', async () => {
  const model = new StubModel(new Float32Array([0.7, 0.3]), 0.42);
  const evaluator = new JsEvaluator({
    model, sanitize: fixedSanitize,
    encodeState: fixedEncodeState, encodeAction: fixedEncodeAction
  });
  const node = makeNode();
  const out = await evaluator.evaluate(node);
  assert.equal(model.calls, 1, '调一次 forward');
  assert.ok(Math.abs(out.P[0] - 0.7) < 1e-6 && Math.abs(out.P[1] - 0.3) < 1e-6, 'P ≈ [0.7, 0.3]');
  assert.equal(out.V, 0.42);
  assert.ok(Math.abs(node.P[0] - 0.7) < 1e-6);
  assert.equal(node.value, 0.42);
  assert.equal(node.expanded, true);
});

test('JsEvaluator.evaluate(已 expanded 节点) 是空操作', async () => {
  const model = new StubModel(new Float32Array([0.5, 0.5]), 0.1);
  const evaluator = new JsEvaluator({ model, sanitize: fixedSanitize,
    encodeState: fixedEncodeState, encodeAction: fixedEncodeAction });
  const node = makeNode();
  node.expanded = true; node.P = new Float32Array([1, 0]); node.value = 0.99;
  const out = await evaluator.evaluate(node);
  assert.equal(out.P[0], 1);
  assert.equal(out.V, 0.99);
  assert.equal(model.calls, 0, '不再 forward');
});

test('BatchEvaluator 攒齐 batchSize 时一次性 forwardBatch（含 dedup）', async () => {
  let calls = 0;
  const forwardBatch = async (stateVectors, actionVectorsList) => {
    calls++;
    // 期望传入的是去重后的 unique keys（这里 4 个 node 同 state → 1 个 entry）
    return {
      probsList: actionVectorsList.map(() => new Float32Array([0.5, 0.5])),
      values: actionVectorsList.map((_, i) => 0.5 + i * 0.1)
    };
  };
  const evaluator = new BatchEvaluator({
    forwardBatch, batchSize: 4, maxWaitMs: 100,
    sanitize: fixedSanitize, encodeState: fixedEncodeState,
    encodeAction: fixedEncodeAction, cacheSize: 0
  });
  const nodes = [makeNode(), makeNode(), makeNode(), makeNode()];
  const results = await Promise.all(nodes.map(n => evaluator.evaluate(n)));
  assert.equal(calls, 1, '同 state 4 个 node 一次 forwardBatch，dedup 后只 1 个 entry');
  assert.equal(results.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(nodes[i].P[0] - 0.5) < 1e-6);
    assert.equal(nodes[i].value, 0.5, 'dedup 后 4 个 node 共享同一 forwardBatch 结果，V 都是 0.5');
  }
  assert.equal(evaluator.batchStats.forwardBatches, 1);
  assert.equal(evaluator.batchStats.forwardNodes, 1, 'stats 只记去重后 forwarded 节点数');
});

test('BatchEvaluator 同状态 hash 命中缓存，不重复 forward', async () => {
  let calls = 0;
  const forwardBatch = async () => {
    calls++;
    return {
      probsList: [new Float32Array([0.6, 0.4])],
      values: [0.2]
    };
  };
  const evaluator = new BatchEvaluator({
    forwardBatch, batchSize: 4, maxWaitMs: 30,
    sanitize: fixedSanitize, encodeState: fixedEncodeState,
    encodeAction: fixedEncodeAction, cacheSize: 10
  });
  const a = makeNode(), b = makeNode();
  await Promise.all([evaluator.evaluate(a), evaluator.evaluate(b)]);
  assert.equal(calls, 1, '相同 state 在同一 batch 内被 dedup，只 forward 一次');
  assert.equal(evaluator.batchStats.cacheHits, 0, '同 batch dedup 不计 cache');
  // 后续同 state 应走缓存
  const c = makeNode();
  await evaluator.evaluate(c);
  assert.equal(calls, 1, '缓存命中，不再 forward');
  assert.equal(evaluator.batchStats.cacheHits, 1);
});

test('BatchEvaluator 单条 evaluate 等待 maxWaitMs 后也 flush', async () => {
  let calls = 0;
  const forwardBatch = async () => {
    calls++;
    return {
      probsList: [new Float32Array([0.5, 0.5])],
      values: [0.0]
    };
  };
  const evaluator = new BatchEvaluator({
    forwardBatch, batchSize: 100, maxWaitMs: 30,
    sanitize: fixedSanitize, encodeState: fixedEncodeState,
    encodeAction: fixedEncodeAction, cacheSize: 0
  });
  const node = makeNode();
  await evaluator.evaluate(node);
  assert.equal(calls, 1, '虽未到 batchSize 但 maxWaitMs 触发');
});

test('hashStateVector 对相同向量稳定，对不同向量不同', () => {
  const a = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const b = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const c = new Float32Array([0.1, 0.2, 0.3, 0.41]);
  assert.equal(hashStateVector(a), hashStateVector(b));
  assert.notEqual(hashStateVector(a), hashStateVector(c));
});
