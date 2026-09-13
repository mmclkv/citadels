'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Engine = require('../src/engine.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const { currentActor } = require('../training/train.js');
const { createLocalNeuralBot } = require('../lib/local-neural-bot.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'citadels-neural-bot-'));
try {
  const bot = createLocalNeuralBot({ root });
  assert.equal(bot.status().configured, false, '没有 checkpoint 时神经网络电脑不可用');
  assert.throws(() => bot.decide({}, 'missing'), /checkpoint/, '没有 checkpoint 时给出明确错误');

  const dataDir = path.join(root, 'training-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const model = new PolicyValueNetwork({ profile: 'fast', seed: 77 });
  const payload = { game: 321, config: { profile: 'fast' }, model: model.export(), history: [] };
  fs.writeFileSync(path.join(dataDir, 'checkpoint-000321.json.gz'),
    zlib.gzipSync(JSON.stringify(payload)));

  const status = bot.status();
  assert.equal(status.configured, true);
  assert.equal(status.checkpoint, 'checkpoint-000321.json.gz');
  assert.equal(status.game, 321);

  const seats = Array.from({ length: 4 }, (_, i) => ({
    id: 'neural-' + i, name: '神经网络 ' + (i + 1), isBot: true, botType: 'neural'
  }));
  const state = Engine.createGame({ roomId: 'neural-smoke', endDistricts: 7,
    charSetMode: 'base', seed: 42, seats });
  Engine.startGame(state);
  const actor = currentActor(state);
  const action = bot.decide(state, actor.id);
  assert(action && action.type, '神经网络在真实引擎状态中给出行动');
  assert.equal(Engine.applyAction(state, actor.id, action).ok, true, '神经网络行动通过规则引擎校验');

  console.log('本地神经网络电脑：checkpoint 发现、模型加载、真实状态推理与合法行动全部通过');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
