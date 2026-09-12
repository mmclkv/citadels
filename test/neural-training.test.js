'use strict';

const assert = require('assert');
const Engine = require('../src/engine.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const Train = require('../training/train.js');

(async () => {
  const counts = {};
  for (const profile of ['fast', 'balanced', 'large']) counts[profile] = new PolicyValueNetwork({ profile }).parameterCount;
  assert.ok(counts.fast >= 100000 && counts.fast < counts.balanced, '快速档至少十万参数且小于均衡档');
  assert.ok(counts.balanced >= 300000 && counts.balanced < counts.large, '均衡档约三十万参数且小于增强档');
  assert.ok(counts.large >= 500000, '增强档超过五十万参数');

  const seats = [0, 1].map(i => ({ id: 'privacy-' + i, name: '玩家' + i, isBot: true }));
  const stateA = Engine.createGame({ roomId: 'privacy', endDistricts: 7, charSetMode: 'base', seed: 17, seats });
  Engine.startGame(stateA);
  const stateB = JSON.parse(JSON.stringify(stateA));
  stateB.deck.reverse();
  stateB.players[1].hand.reverse();
  const viewA = Engine.sanitize(stateA, seats[0].id);
  const viewB = Engine.sanitize(stateB, seats[0].id);
  assert.deepStrictEqual(Array.from(Train.encodeState(viewA, seats[0].id).vector),
    Array.from(Train.encodeState(viewB, seats[0].id).vector),
    '牌库顺序和对手手牌顺序不会进入策略网络输入');

  const model = new PolicyValueNetwork({ profile: 'fast', seed: 42 });
  const config = Train.sanitizeConfig({ targetGames: 1, minPlayers: 2, maxPlayers: 2,
    charSet: 'base', profile: 'fast', batchGames: 1, ppoEpochs: 1, seed: 42, endDistricts: 7 });
  const result = await Train.runSelfPlayGame(model, config, 1, () => 0.42, () => false);
  assert.ok(result.steps > 0 && result.steps < config.maxSteps, '神经网络自对弈完成整局');
  assert.strictEqual(result.fallbackCount, 0, '整局没有非法行动兜底');
  assert.ok(result.transitions.length > 10, '收集到可训练的多选行动轨迹');
  assert.ok(result.avgInferenceMs < 30, '单步神经网络推理低于 30ms');
  const before = model.policyOut.w[0];
  const loss = model.trainPPO(result.transitions.slice(0, 24), { epochs: 1, learningRate: 0.0003 });
  assert.ok(Object.values(loss).every(Number.isFinite), 'PPO 损失指标均为有限数值');
  assert.notStrictEqual(model.policyOut.w[0], before, 'PPO 反向传播更新网络参数');

  console.log('本地神经网络训练：参数档位、隐私、整局自对弈、推理与 PPO 更新全部通过');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
