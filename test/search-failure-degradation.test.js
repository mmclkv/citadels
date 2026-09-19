'use strict';

// 搜索失败（最常见的是 CUDA 显存不足）必须降级，不能掀翻整轮训练：
// 2026-09-19 的一次 OOM 顺着 IPC 传回主进程，整轮训练直接中断，6000+ 局、
// 1h46m 的样本因为异常路径上没有存档而全部作废。
//   1. 偶发失败 → 本步改用均匀策略继续走；
//   2. 连续失败到上限 → 丢弃这一局（返回 null），把「通道坏了」交给上层判死；
//   3. 无论哪种，都不许把异常抛出自对弈循环。

const assert = require('node:assert/strict');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const Train = require('../training/train.js');

const OOM = new Error('CUDA driver error: out of memory · 行长=52911 · id=282729 · 后端=libtorch');

function collectWarnings() {
  const warnings = [];
  const real = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  return { warnings, restore: () => { console.warn = real; } };
}

function baseConfig(extra) {
  return Train.sanitizeConfig(Object.assign({
    targetGames: 1, minPlayers: 3, maxPlayers: 3, charSet: 'base', profile: 'fast',
    batchGames: 1, ppoEpochs: 1, seed: 42, endDistricts: 7, selfPlayMode: 'all-network',
    mctsSimulations: 8, mctsEngine: 'cpp', backend: 'native',
    neuralNetworkFramework: 'libtorch', mctsMaxDepth: 30, mctsParticles: 2
  }, extra));
}

(async () => {
  // ---- 1. 每一步都失败：不抛异常，到达上限后丢弃这一局 ----
  {
    const sink = collectWarnings();
    let calls = 0;
    const alwaysFails = {
      search: async () => { calls++; throw OOM; }
    };
    let result;
    try {
      result = await Train.runSelfPlayGame(new PolicyValueNetwork({ profile: 'fast', seed: 11 }),
        baseConfig(), 1, Math.random, () => false, null, alwaysFails);
    } finally {
      sink.restore();
    }
    assert.equal(result, null, '连续搜索失败应丢弃这一局（返回 null），而不是抛异常或返回残局');
    assert.equal(calls, 8, '连续失败上限是 8 步（实得 ' + calls + '）');
    assert.ok(sink.warnings.some(line => /搜索失败/.test(line)), '应打印搜索失败警告');
    assert.ok(sink.warnings.some(line => /连续 8 步搜索失败/.test(line)), '应打印丢弃整局的原因');
    console.log('ok 1 - 搜索连续失败时丢弃该局并降级提示，不掀翻训练');
  }

  // ---- 2. 前几步失败后恢复：游戏继续跑，失败次数计入 fallbackCount ----
  {
    const sink = collectWarnings();
    let calls = 0;
    const flaky = {
      search: async (state, playerId, legal) => {
        calls++;
        if (calls <= 2) throw OOM;
        const size = legal.length || 1;
        return { policy: new Array(size).fill(1 / size), value: 0, valueVector: null,
          visits: size, expansions: 1 };
      }
    };
    let searches = 0;
    let result;
    try {
      result = await Train.runSelfPlayGame(new PolicyValueNetwork({ profile: 'fast', seed: 12 }),
        baseConfig(), 2, Math.random, () => ++searches >= 8, null, flaky);
    } finally {
      sink.restore();
    }
    assert.ok(result && result.stopped === true,
      '偶发失败后游戏应继续跑（被 shouldStop 收尾），而不是被丢弃');
    assert.ok(calls >= 6, '搜索恢复后应继续被调用（实得 ' + calls + ' 次）');
    assert.equal(sink.warnings.filter(line => /搜索失败/.test(line)).length, 2,
      '只应有 2 条搜索失败警告');
    console.log('ok 2 - 偶发搜索失败降级为均匀策略，整局继续');
  }

  console.log('搜索失败降级：2 组断言通过');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
