'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Engine = require('../src/engine.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const { currentActor, enumerateLegalActions } = require('../training/train.js');
const { createLocalNeuralBot, normalizeMcts, MAX_INFERENCE_MS, TTA_VARIANTS,
  MCTS_MAX_SIMULATIONS, MCTS_MAX_DEPTH_CAP } = require('../lib/local-neural-bot.js');

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
    assert.equal(inference.method, 'tta', '默认（模拟数 0）不搜索，行为与旧版一致');

    // 确定化 MCTS：房主填了模拟数才启用
    const mctsStatus = bot.status().mcts;
    assert.equal(mctsStatus.determinizations >= 1, true, '状态接口报告确定化份数');
    assert.equal(mctsStatus.maxSimulations, MCTS_MAX_SIMULATIONS);
    assert.equal(mctsStatus.maxDepthCap, MCTS_MAX_DEPTH_CAP);
    assert.equal(normalizeMcts(undefined), null, '不传设置 = 关闭搜索');
    assert.equal(normalizeMcts({ simulations: 0 }), null, '模拟数 0 = 关闭搜索');
    assert.equal(normalizeMcts({ simulations: -5 }), null, '负数按关闭处理');
    assert.deepEqual(normalizeMcts({ simulations: 10 }), { simulations: 10, maxDepth: 60, particles: 4 },
      '最大深度 0 表示用默认值');
    assert.equal(normalizeMcts({ simulations: 9e9 }).simulations, MCTS_MAX_SIMULATIONS, '模拟数有上限');
    assert.equal(normalizeMcts({ simulations: 10, maxDepth: 9e9 }).maxDepth, MCTS_MAX_DEPTH_CAP, '深度有上限');

    const searchState = JSON.stringify(state);
    const nextActor = currentActor(state);
    const nextLegal = enumerateLegalActions(state, nextActor.id);
    assert(nextLegal.length, '推进一手后仍有可决策的玩家');
    const searched = await bot.decide(state, nextActor.id, { mcts: { simulations: 48, maxDepth: 12 } });
    assert(searched && searched.type, '确定化搜索同样给出行动');
    assert.equal(JSON.stringify(state), searchState, '搜索只在猜测出的副本上进行，不改权威状态');
    const searchInference = bot.status().tta.lastInference;
    assert.equal(searchInference.method, 'mcts', '开启后走确定化 MCTS');
    assert(searchInference.determinizations >= 1, '至少完成一份确定化的搜索');
    assert(searchInference.visits >= 1, '搜索确实访问了节点');
    assert(nextLegal.some(item => JSON.stringify(item) === JSON.stringify(searched)), true,
      '搜索结果仍是当前合法动作');

    console.log('本地神经网络电脑：checkpoint、TTA 聚合、确定化 MCTS、硬超时与合法行动全部通过');
  } finally {
    if (bot) bot.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
