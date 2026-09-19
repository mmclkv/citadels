/**
 * 信念层（training/belief.js）的契约测试。
 *
 * 搜索结构由 test/ismcts-particles.test.js 管，这里管的是「粒子不再均匀」这件事：
 *   1. 引擎把「谁有钱、还能建，却没建」记成公开观测（且只记公开量）；
 *   2. 信念层把这条事实翻译成权重，与事实矛盾的世界少被抽到；
 *   3. 权重一路传到 JS 搜索 / native 协议 / C++ worker，长度对不上就退回均匀；
 *   4. 端到端：真世界比均匀重洗出来的世界更符合公开事实（信念不是噪声）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../src/engine.js');
const HeuristicAI = require('../src/ai.js');
const { determinize } = require('../training/determinize.js');
const { beliefWeights, beliefDiagnostics, countViolations, collectConstraints,
  DEFAULT_DECAY, MIN_WEIGHT } = require('../training/belief.js');
const { encodeSearchRequest, decodeSearchRequest } = require('../native/protocol.js');
const Train = require('../training/train.js');

/**
 * 造一个最小的粒子：players[i].hand 直接给牌。
 * 观测数组按 playerIdx 存 —— 视角玩家是 p0，所以被约束的对手要放在下标 1。
 */
function makeParticle(handCosts, observations) {
  const players = handCosts.map((costs, i) => ({
    id: 'p' + i,
    gold: 0,
    hand: costs.map((cost, k) => ({ uid: 'u' + i + '-' + k, cost, color: 'blue', name: 'X' + cost }))
  }));
  return { players, observations };
}

/** 造一条「1 号玩家有钱、还能建、却没建」的观测。 */
function obs(gold, handSize, freeColors = []) {
  return [null, { round: 1, gold, handSize, freeColors }];
}

test('没有观测（开局第一回合）时老老实实均匀采样', () => {
  const pool = [makeParticle([[1, 2], [3, 4]], []), makeParticle([[1, 1], [5, 6]], [])];
  assert.deepEqual(beliefWeights(pool, 'p0'), [1, 1]);
  assert.equal(beliefDiagnostics(pool, 'p0').constraints, 0);
});

test('他有钱却没建 ⇒ 手里有便宜牌的世界被压下去', () => {
  const observations = obs(4, 2);
  const clean = makeParticle([[], [5, 6]], observations);   // 全是贵牌，符合事实
  const dirty = makeParticle([[], [1, 6]], observations);   // 有一张 1 费，矛盾
  const weights = beliefWeights([clean, dirty], 'p0');
  assert.equal(weights[0], 1, '符合事实的世界权重保持 1');
  assert.ok(weights[1] < weights[0], '矛盾的世界必须被压低，实得 ' + weights[1]);
  assert.equal(weights[1], DEFAULT_DECAY, '违反 1 张 = 乘一次 decay');
});

test('违反得越多权重越低，但永远不为 0（软约束而非硬过滤）', () => {
  const pool = [
    makeParticle([[], [5, 6, 7]], obs(4, 3)),   // 0 张违反
    makeParticle([[], [1, 6, 7]], obs(4, 3)),   // 1 张
    makeParticle([[], [1, 2, 7]], obs(4, 3)),   // 2 张
    makeParticle([[], [1, 2, 3]], obs(4, 3))    // 3 张
  ];
  const weights = beliefWeights(pool, 'p0');
  for (let i = 1; i < weights.length; i++) {
    assert.ok(weights[i] < weights[i - 1], '违反越多权重越低：' + weights.join(' > '));
  }
  assert.ok(weights.every(w => w >= MIN_WEIGHT), '权重有地板，不会把世界判死：' + weights.join('/'));
});

test('decay=1 就是关掉信念（退回均匀采样）', () => {
  const pool = [makeParticle([[], [5, 6]], obs(6, 2)), makeParticle([[], [1, 1]], obs(6, 2))];
  assert.deepEqual(beliefWeights(pool, 'p0', { decay: 1 }), [1, 1]);
  assert.ok(beliefWeights(pool, 'p0')[1] < 1, '默认 decay 下同样的池必须有权重差');
});

test('观测之后新摸的牌不受约束（否则会把真世界判死）', () => {
  // 观测时他手里 1 张、有 5 金币没建；现在手里 3 张 ⇒ 多出的 2 张是后摸的，随便什么价
  const drawn = makeParticle([[], [1, 2, 6]], obs(5, 1));
  assert.equal(countViolations(drawn, collectConstraints(drawn.observations, 0)), 0,
    '多出来的 2 张应被豁免');
  // 手牌张数没变 ⇒ 这 3 张当时就在手里，便宜的两张都算违反
  const same = makeParticle([[], [1, 2, 6]], obs(5, 3));
  assert.equal(countViolations(same, collectConstraints(same.observations, 0)), 2,
    '手牌张数没变时同样的牌就该算违反');
});

test('视角玩家自己的手牌不参与约束（那是已知量）', () => {
  // 观测放在 p0（= 视角玩家自己）时，即使他手里全是便宜牌也不算违反
  const selfObs = [{ round: 1, gold: 4, handSize: 2, freeColors: [] }];
  const me = makeParticle([[1, 1], []], selfObs);
  assert.equal(beliefWeights([me], 'p0')[0], 1, '自己的手牌是已知量，不构成违反');
  // 同一个池换到 p1 视角，p0 就成了被约束的对手
  const other = makeParticle([[1, 1], []], selfObs);
  assert.ok(beliefWeights([other], 'p1')[0] < 1, '换视角后同样的手牌就该被约束');
});

test('生意人的绿色建筑不受建造限额约束，绿牌不算违反', () => {
  const observations = [null, { round: 1, gold: 4, handSize: 2, freeColors: ['green'] }];
  const green = { players: [{ id: 'p0', gold: 0, hand: [] },
    { id: 'p1', gold: 0, hand: [{ uid: 'g1', cost: 1, color: 'green' },
      { uid: 'b1', cost: 6, color: 'blue' }] }], observations };
  assert.equal(countViolations(green, collectConstraints(observations, 0)), 0,
    '绿牌被豁免，不该算违反');
});

/* ------------------------------ 引擎侧观测账本 ------------------------------ */

function bareState(playerCount = 4) {
  const seats = [];
  for (let i = 0; i < playerCount; i++) seats.push({ id: 'p' + i, name: 'P' + i, isBot: true });
  const state = Engine.createGame({ roomId: 'belief', endDistricts: 8, charSetMode: 'base', seed: 7, seats });
  Engine.repairState(state);
  return state;
}

test('回合结束时记下观测：有钱 + 建造次数没用完 + 没建', () => {
  const state = bareState();
  const turn = { playerIdx: 1, charId: 'merchant', phase: 'main', builds: 0 };
  state.players[1].gold = 5;
  state.players[1].hand = [{ uid: 'a', cost: 3 }, { uid: 'b', cost: 4 }];
  Engine.recordBeliefObservation(state, turn, state.players[1], Engine.charOf('merchant'), 1);
  const observation = state.observations[1];
  assert.ok(observation, '应当记下一条观测');
  assert.equal(observation.gold, 5);
  assert.equal(observation.handSize, 2);
  assert.deepEqual(observation.freeColors, []);
});

test('下列情况不能记观测：航海家 / 主教 / 已建满 / 没钱 / 女巫接管', () => {
  const cases = [
    ['航海家不能建造', { charId: 'navigator', builds: 0, gold: 5, phase: 'main' }],
    ['主教忽略金币建造', { charId: 'bishop', builds: 0, gold: 5, phase: 'main' }],
    ['已经建满', { charId: 'merchant', builds: 1, gold: 5, phase: 'main' }],
    ['没钱', { charId: 'merchant', builds: 0, gold: 0, phase: 'main' }],
    ['女巫接管', { charId: 'merchant', builds: 0, gold: 5, phase: 'witch_resume' }]
  ];
  for (const [label, setup] of cases) {
    const state = bareState();
    state.players[1].gold = setup.gold;
    const turn = { playerIdx: 1, charId: setup.charId, phase: setup.phase, builds: setup.builds };
    Engine.recordBeliefObservation(state, turn, state.players[1], Engine.charOf(setup.charId), 1);
    assert.equal(state.observations[1], undefined,
      label + '：不该记观测（记了就是把「没建」误当成「买不起」）');
  }
});

test('观测账本只写公开量，不含任何牌面', () => {
  const state = bareState();
  state.players[2].gold = 6;
  state.players[2].hand = [{ uid: 'secret-uid', cost: 1, name: '神庙' }];
  Engine.recordBeliefObservation(state, { playerIdx: 2, charId: 'king', phase: 'main', builds: 0 },
    state.players[2], Engine.charOf('king'), 1);
  const serialized = JSON.stringify(state.observations);
  assert.ok(!serialized.includes('secret-uid'), '观测里不能出现牌的 uid');
  assert.ok(!serialized.includes('神庙'), '观测里不能出现牌名');
  assert.deepEqual(Object.keys(state.observations[2]).sort(),
    ['freeColors', 'gold', 'handSize', 'round'], '观测字段固定为这四个公开量');
});

/* ------------------------------ 传播链路 ------------------------------ */

test('native 协议带上信念权重，长度对不上就退回不带', () => {
  const state = bareState();
  const single = decodeSearchRequest(encodeSearchRequest(state, 'p0', [], '1', [1]));
  assert.equal(single.particleWeights[0], 1, '单粒子也允许带权重');

  const pool = [state, state, state];
  const encoded = decodeSearchRequest(encodeSearchRequest(pool, 'p0', [], '2', [1, 0.5, 0.25]));
  assert.deepEqual(encoded.particleWeights, [1, 0.5, 0.25], '权重随粒子池一起发过去');
  assert.equal(encoded.particles.length, 2);

  const mismatched = decodeSearchRequest(encodeSearchRequest(pool, 'p0', [], '3', [1, 0.5]));
  assert.equal(mismatched.particleWeights, undefined,
    '长度对不上就不发 —— 权重错位比没有信念更糟');

  const bad = JSON.parse(encodeSearchRequest(pool, 'p0', [], '4', [1, 0.5, 0.25]));
  bad.particleWeights = [1, -1, 0.25];
  assert.throws(() => decodeSearchRequest(bad), /particleWeights/, '负权重要被挡下');
});

test('训练侧：单粒子不发权重，关掉信念也不发', () => {
  const state = bareState();
  const single = Train.alignedParticlePool(state, 'p0', [], () => 0.5, 1, 2);
  assert.equal(Train.particleBeliefWeights(single, 'p0', 0.15), null,
    '池里只有一份时权重没有意义（必被抽中）');
  assert.equal(Train.sanitizeConfig({ mctsBelief: false }).mctsBelief, false, '面板关掉信念要能传下来');
  assert.equal(Train.sanitizeConfig({}).mctsBelief, true, '默认开启');
});

/* ------------------------------ 端到端：信念不是噪声 ------------------------------ */

test('真世界比均匀重洗的世界更符合公开事实', () => {
  // 这条是信念层存在的理由：如果真世界的违反数与随机猜测同分布，那信念就是噪声，
  // 加权只是在糟蹋搜索预算。用若干局自对弈的小规模统计守住它。
  let samples = 0, truthSum = 0, guessSum = 0, truthWins = 0;
  for (let game = 0; game < 8; game++) {
    const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true }));
    const state = Engine.createGame({ roomId: 'belief-e2e', endDistricts: 8, charSetMode: 'mixed',
      seed: 4200 + game * 31, seats });
    Engine.startGame(state);
    let steps = 0;
    const rng = Math.random;
    while (state.phase !== 'gameover' && steps < 4000) {
      if (state.roundConfirm) {
        state.players.forEach(p => {
          if (state.roundConfirm && state.phase !== 'gameover') {
            Engine.applyAction(state, p.id, { type: 'confirm_round' });
          }
        });
        continue;
      }
      const actor = Train.currentActor(state);
      if (!actor) break;
      const legal = (Engine.getAvailableActions(state, actor.id).actions) || [];
      if (!legal.length) break;
      Engine.applyAction(state, actor.id, HeuristicAI.decide(state, actor.id, rng) || legal[0]);
      steps++;
      if (steps % 3 !== 0 || state.phase !== 'action') continue;
      const me = state.players[0].id;
      const actions = Train.enumerateLegalActions(state, me);
      if (!actions.length) continue;
      const baseline = JSON.stringify(actions);
      // 0 号放真世界，其余是均匀重洗的猜测
      const pool = [JSON.parse(JSON.stringify(state))];
      for (let i = 0; i < 16 && pool.length < 5; i++) {
        const guess = determinize(state, me, rng);
        if (JSON.stringify(Train.enumerateLegalActions(guess, me)) !== baseline) continue;
        pool.push(guess);
      }
      if (pool.length < 3) continue;
      const diag = beliefDiagnostics(pool, me);
      if (!diag.constraints || diag.totalViolations === 0) continue;
      samples++;
      const guesses = diag.violations.slice(1);
      const guessAvg = guesses.reduce((a, b) => a + b, 0) / guesses.length;
      truthSum += diag.violations[0];
      guessSum += guessAvg;
      if (diag.violations[0] < guessAvg) truthWins++;
    }
  }
  assert.ok(samples > 150, '样本量要够，实得 ' + samples);
  const truthAvg = truthSum / samples, guessAvg = guessSum / samples;
  assert.ok(truthAvg < guessAvg * 0.85,
    '真世界应显著更干净（真 ' + truthAvg.toFixed(3) + ' vs 猜 ' + guessAvg.toFixed(3) + '）');
  assert.ok(truthWins / samples > 0.6,
    '真世界更干净的次数应过半，实得 ' + (truthWins / samples * 100).toFixed(1) + '%');
});
