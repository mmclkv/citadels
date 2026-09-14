'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TorchBridge } = require('../training/torch-bridge.js');

// 用可控的假 child 模拟 PyTorch 子进程：write() 收到请求后由测试驱动响应，
// 从而能观测 train / batchForward 是否真的被串行化（GPU 锁）。
function makeBridgeWithFakeChild({ delayFirst = 0 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-lock-'));
  const bridge = new TorchBridge({ root: tmp, model: {}, config: { profile: 'balanced' } });
  bridge.dataDir = tmp;        // 让 rollout 临时文件直接落在已存在的 tmp 里
  bridge.readModel = () => {}; // 避开「读回权重」对真实模型文件的依赖
  const writes = [];
  let firstHandled = false;
  bridge.child = {
    stdin: { write: (s) => {
      const msg = JSON.parse(s);
      writes.push(msg);
      const delay = (!firstHandled && delayFirst) ? delayFirst : 0;
      firstHandled = true;
      setTimeout(() => {
        const entry = bridge.pending.shift();
        if (!entry) return;
        if (msg.cmd === 'train') {
          entry.resolve({ ok: true, metrics: { policyLoss: 0.1, valueLoss: 0.1, totalLoss: 0.2,
            entropy: 0.5, clipFraction: 0, approxKl: 0, gradientNorm: 1, samples: 1 } });
        } else {
          entry.resolve({ ok: true, probsList: [[0.5, 0.5]], values: [0] });
        }
      }, delay);
    } },
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    kill() {}
  };
  return { bridge, writes };
}

// 包裹 request，统计「同时在途」的 GPU 请求数；>1 即说明没被串行化。
function spyConcurrency(bridge) {
  let active = 0, maxActive = 0;
  const orig = bridge.request.bind(bridge);
  bridge.request = (msg) => {
    active++; maxActive = Math.max(maxActive, active);
    return orig(msg).finally(() => { active--; });
  };
  return () => maxActive;
}

test('GPU 锁：并发 batchForward 不会让 request 并发发出', async () => {
  const { bridge } = makeBridgeWithFakeChild();
  const maxActive = spyConcurrency(bridge);
  const p1 = bridge.batchForward({ stateVectors: [[1]], actionVectorsList: [[[1]]] });
  const p2 = bridge.batchForward({ stateVectors: [[2]], actionVectorsList: [[[2]]] });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(maxActive(), 1, '同一时刻只有一个 GPU 请求在途（互斥）');
  assert.ok(r1 && r2, '两次批量前向都拿到结果');
});

test('GPU 锁：首个 forward 占用 GPU 时，第二个会等它结束才发（顺序 = FIFO）', async () => {
  const { bridge, writes } = makeBridgeWithFakeChild({ delayFirst: 40 });
  const maxActive = spyConcurrency(bridge);
  const p1 = bridge.batchForward({ stateVectors: [[1]], actionVectorsList: [[[1]]] });
  const p2 = bridge.batchForward({ stateVectors: [[2]], actionVectorsList: [[[2]]] });
  await Promise.all([p1, p2]);
  assert.equal(maxActive(), 1, '长耗时 forward 期间不应插入第二个 GPU 请求');
  assert.equal(writes.length, 2, '两次请求最终都发出');
  assert.equal(writes[0].cmd, 'batch_eval');
  assert.equal(writes[1].cmd, 'batch_eval');
});

test('GPU 锁：train 与 batchForward 互斥，不会在权重更新中插入前向', async () => {
  const { bridge, writes } = makeBridgeWithFakeChild({ delayFirst: 40 });
  const maxActive = spyConcurrency(bridge);
  const trainP = bridge.train([
    { state: [1], actions: [[1]], chosen: 0, oldProb: 0.5, oldValue: 0, reward: 0.1, temperature: 1 }
  ]);
  const fwdP = bridge.batchForward({ stateVectors: [[2]], actionVectorsList: [[[2]]] });
  const [metrics] = await Promise.all([trainP, fwdP]);
  assert.equal(maxActive(), 1, 'train 与 batchForward 不应并发');
  assert.ok(metrics, 'train 返回指标');
  // 锁保证顺序：先 train 权重更新，再 batch_eval 前向
  assert.equal(writes[0].cmd, 'train');
  assert.equal(writes[1].cmd, 'batch_eval');
});
