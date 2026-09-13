'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Engine = require('../src/engine.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const { currentActor } = require('../training/train.js');
const { createLocalNeuralBot, MAX_INFERENCE_MS, TTA_VARIANTS } = require('../lib/local-neural-bot.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-neural-bot-'));
let bot;
(async () => {
  try {
    bot = createLocalNeuralBot({ root });
    assert.equal(bot.status().configured, false, '没有 checkpoint 时神经网络电脑不可用');
    assert.throws(() => bot.decide({}, 'missing'), /checkpoint/, '没有 checkpoint 时给出明确错误');

    const repositoryDir = path.join(root, 'models');
    fs.mkdirSync(repositoryDir, { recursive: true });
    const repositoryModel = new PolicyValueNetwork({ profile: 'fast', seed: 66 });
    fs.writeFileSync(path.join(repositoryDir, 'policy-default.json.gz'), zlib.gzipSync(JSON.stringify({
      game: 10000, config: { profile: 'fast' }, model: repositoryModel.export(), history: []
    })));
    fs.writeFileSync(path.join(repositoryDir, 'policy-default.meta.json'), JSON.stringify({
      game: 10000, profile: 'fast'
    }));
    const repositoryStatus = bot.status();
    assert.equal(repositoryStatus.configured, true, '干净 checkout 可直接发现仓库默认模型');
    assert.equal(repositoryStatus.source, 'repository');
    assert.equal(repositoryStatus.checkpoint, 'policy-default.json.gz');
    assert.equal(repositoryStatus.game, 10000, '状态接口从轻量元数据读取训练局数');
    assert.equal(repositoryStatus.tta.variants, TTA_VARIANTS, '默认启用 ' + TTA_VARIANTS + ' 个 TTA 视图');
    assert.equal(repositoryStatus.tta.maxInferenceMs, MAX_INFERENCE_MS, '单步推理上限为二十秒');

    const dataDir = path.join(root, 'training-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const model = new PolicyValueNetwork({ profile: 'fast', seed: 77 });
    const payload = { game: 321, config: { profile: 'fast' }, model: model.export(), history: [] };
    fs.writeFileSync(path.join(dataDir, 'checkpoint-000321.json.gz'),
      zlib.gzipSync(JSON.stringify(payload)));

    const repositoryPreferred = bot.status();
    assert.equal(repositoryPreferred.source, 'repository', '房间始终优先使用版本化仓库模型');
    fs.rmSync(path.join(repositoryDir, 'policy-default.json.gz'));
    const status = bot.status();
    assert.equal(status.configured, true);
    assert.equal(status.checkpoint, 'checkpoint-000321.json.gz');
    assert.equal(status.game, 321);
    assert.equal(status.source, 'training', '仓库模型缺失时可回退到本地训练 checkpoint');

    const seats = Array.from({ length: 4 }, (_, i) => ({
      id: 'neural-' + i, name: '神经网络 ' + (i + 1), isBot: true, botType: 'neural'
    }));
    const state = Engine.createGame({ roomId: 'neural-smoke', endDistricts: 7,
      charSetMode: 'base', seed: 42, seats });
    Engine.startGame(state);
    const actor = currentActor(state);
    const timeoutBot = createLocalNeuralBot({ root, maxInferenceMs: 1 });
    try {
      await assert.rejects(timeoutBot.decide(state, actor.id), error => error.code === 'timeout',
        '硬超时会终止卡住的推理工作线程');
    } finally {
      timeoutBot.close();
    }
    const beforeDecision = JSON.stringify(state);
    const action = await bot.decide(state, actor.id);
    assert.equal(JSON.stringify(state), beforeDecision, 'TTA 推理不会改写权威游戏状态');
    assert(action && action.type, '神经网络在真实引擎状态中给出行动');
    assert.equal(Engine.applyAction(state, actor.id, action).ok, true, '神经网络行动通过规则引擎校验');
    const inference = bot.status().tta.lastInference;
    assert.equal(inference.variants, TTA_VARIANTS, 'TTA 聚合全部语义等价视图');
    assert.equal(inference.timedOut, false, '正常局面在预算内完成 TTA 推理');
    assert(inference.durationMs <= MAX_INFERENCE_MS, '推理没有超过二十秒预算');

    console.log('本地神经网络电脑：checkpoint、TTA 聚合、硬超时与合法行动全部通过');
  } finally {
    if (bot) bot.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
