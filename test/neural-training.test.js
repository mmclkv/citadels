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
  assert.strictEqual(Train.sanitizeConfig({}).maxRounds, 100, '未配置时单局回合上限默认 100');
  const capped = Train.sanitizeConfig({ targetGames: 1, minPlayers: 2, maxPlayers: 2,
    charSet: 'base', profile: 'fast', batchGames: 1, seed: 42, endDistricts: 7, maxRounds: 1 });
  const cappedResult = await Train.runSelfPlayGame(model, capped, 1, () => 0.42, () => false);
  assert.ok(cappedResult && cappedResult.truncated, '超过回合上限的局按当前排名提前结算');
  assert.ok(!cappedResult.dropped && cappedResult.transitions.length > 0,
    '超长局保留已收集的训练轨迹，不再整局丢弃');
  assert.ok(cappedResult.rounds > 1 && cappedResult.rounds <= 2, '到上限立即中断，不等这一局跑完');
  // 课程首段只有一人用策略网络：网络指标必须是那名玩家自己的名次分/得分，
  // 不能是同桌均值（那种数按构造≈0，衡量不出进步）。
  const solo = Train.sanitizeConfig({ targetGames: 1, minPlayers: 4, maxPlayers: 4,
    charSet: 'base', profile: 'fast', batchGames: 1, seed: 42, endDistricts: 7,
    selfPlayMode: 'curriculum', curriculumStartPlayers: 1, curriculumStepGames: 100000 });
  const soloResult = await Train.runSelfPlayGame(model, solo, 1, () => 0.42, () => false);
  assert.strictEqual(soloResult.networkPlayerCount, 1, '课程首段每局只有一名网络玩家');
  assert.ok(soloResult.rewards.includes(soloResult.networkReward),
    'networkReward 等于那名网络玩家的名次奖励');
  assert.ok(soloResult.scores.includes(soloResult.networkScore),
    'networkScore 等于那名网络玩家的得分');
  assert.strictEqual(soloResult.networkWin, soloResult.networkReward >= 1 ? 1 : 0,
    'networkWin 与名次分一致（第一名奖励为 +1）');
  const before = model.policyOut.w[0];
  const loss = model.trainPPO(result.transitions.slice(0, 24), { epochs: 1, learningRate: 0.0003 });
  assert.ok(Object.values(loss).every(Number.isFinite), 'PPO 损失指标均为有限数值');
  assert.notStrictEqual(model.policyOut.w[0], before, 'PPO 反向传播更新网络参数');
  const ceModel = new PolicyValueNetwork({ profile: 'fast', seed: 43 });
  const ceTransitions = result.transitions.slice(0, 24).map(tr => ({ ...tr,
    pi: tr.actions.map((_, index) => index === tr.chosen ? 1 : 0)
  }));
  const ceLoss = ceModel.trainPPO(ceTransitions, { epochs: 1, learningRate: 0.0003, policyLossMode: 'auto' });
  assert.ok(Object.values(ceLoss).every(Number.isFinite), 'MCTS 访问分布交叉熵指标均为有限数值');
  assert.strictEqual(ceLoss.clipFraction, 0, 'MCTS 交叉熵模式不使用 PPO 裁剪');
  const { pi: _missingPi, ...missingPolicyTarget } = ceTransitions[0];
  const invalidCeLoss = ceModel.trainPPO([missingPolicyTarget], {
    epochs: 1, learningRate: 0.0003, policyLossMode: 'auto', mctsCeRequired: true
  });
  assert.strictEqual(invalidCeLoss.policySamples, 0,
    'MCTS 搜索失败样本不得伪造一热策略目标');
  assert.strictEqual(invalidCeLoss.policyLoss, 0,
    '没有有效 MCTS 目标时策略损失应为 0，而不是对退化目标计算交叉熵');

  const history = Array.from({ length: 1000 }, (_, i) => ({ game: (i + 1) * 4 }));
  const sampled = Train.sampleHistory(history, 100);
  assert.strictEqual(sampled.length, 100, '长训练历史会压缩到图表容量');
  assert.strictEqual(sampled[0].game, 4, '历史压缩保留横轴起点');
  assert.strictEqual(sampled[sampled.length - 1].game, 4000, '历史压缩保留横轴终点');

  console.log('本地神经网络训练：参数档位、隐私、整局自对弈、PPO 与 MCTS 交叉熵更新全部通过');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
