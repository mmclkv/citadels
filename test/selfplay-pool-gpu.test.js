'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const { sanitizeConfig } = require('../training/train.js');
const { SelfPlayPool } = require('../training/selfplay-pool.js');

// 集成测试：worker 真的在跑（mctsSimulations > 0 + mctsEvaluator='gpu'），
// 会把 forwardBatch 消息发回主进程；这里验证主进程的 batchForward 委托被调到，
// 并且 worker 把结果回写到 forwardBatchResult 后整局能跑完。
test('SelfPlayPool 把 worker 的 forwardBatch 转发到主进程 batchForward', async () => {
  const root = path.join(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-pool-gpu-'));
  const modelPath = path.join(temp, 'model.bin');
  const model = new PolicyValueNetwork({ profile: 'fast', seed: 7 });
  fs.writeFileSync(modelPath, Buffer.from(model.exportFlat().buffer));
  const config = sanitizeConfig({
    targetGames: 1, minPlayers: 2, maxPlayers: 2,
    batchGames: 1, workers: 1,
    profile: 'fast', charSet: 'base', seed: 7, endDistricts: 7,
    // 关键：触发 GPU 评估路径，worker 才会发 forwardBatch 消息
    mctsSimulations: 2, mctsEvaluator: 'gpu',
    mctsBatchSize: 4, mctsMaxWaitMs: 0
  });
  let batchCalls = 0;
  const seenStates = [];
  const pool = new SelfPlayPool({
    root, config, size: 1,
    onLog: text => { /* swallow worker log */ },
    batchForward: async (stateVectors, actionVectorsList) => {
      batchCalls++;
      seenStates.push(stateVectors.length);
      // mock 一个均匀分布的 P / 0 值，让游戏能玩但不会优化
      return {
        probsList: actionVectorsList.map(actions => {
          const p = new Float32Array(actions.length);
          p.fill(1 / Math.max(1, actions.length));
          return p;
        }),
        values: stateVectors.map(() => 0)
      };
    }
  });
  try {
    const results = await pool.run([1], modelPath, 0);
    assert.equal(results.length, 1, '完成 1 局');
    assert.ok(results[0].steps > 0, '走出了一些步');
    assert.ok(batchCalls >= 1, '主进程 batchForward 至少被调一次，实际 ' + batchCalls);
    // 同 state hash 应有去重，单次 forwardBatch 收到的 state 数 < batchSize 上限
    const totalForwarded = seenStates.reduce((a, b) => a + b, 0);
    console.log('  pool 转发：batchCalls=' + batchCalls +
      ' · 各批 forwardedStates=' + JSON.stringify(seenStates) +
      ' · totalForwarded=' + totalForwarded);
  } finally {
    await pool.close();
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { /* ignored */ }
  }
});