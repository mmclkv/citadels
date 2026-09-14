'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mcts = require('../training/mcts.js');
const { runSelfPlayGame, sanitizeConfig } = require('../training/train.js');
const { PolicyValueNetwork, mulberry32 } = require('../training/neural-policy.js');

function buildTinyModel(seed = 1) {
  // 'fast' 档 ≈ 12 万参数，跑得最快
  return new PolicyValueNetwork({ profile: 'fast', stateSize: 192, actionSize: 64, seed });
}

test('sampleDirichlet 返回长度一致、归一化的概率分布', () => {
  for (const size of [1, 2, 5, 12]) {
    const rng = mulberry32(2026);
    const out = mcts.sampleDirichlet(size, 0.03, rng);
    assert.equal(out.length, size, '长度匹配 size');
    let sum = 0;
    for (let i = 0; i < size; i++) {
      assert.ok(Number.isFinite(out[i]) && out[i] >= 0, `元素 ${i} 非负有限`);
      sum += out[i];
    }
    assert.ok(Math.abs(sum - 1) < 1e-5, '分布求和 ≈ 1，size=' + size);
  }
});

test('MCTS 在零模拟时直接返回网络先验作为 π', async () => {
  const Engine = require('../src/engine.js');
  const state = Engine.createGame({ endDistricts: 8, charSetMode: 'base',
    seats: [{id:'a',name:'A',isBot:true,botType:'neural'},{id:'b',name:'B',isBot:true,botType:'neural'}] });
  Engine.startGame(state);
  const model = buildTinyModel(11);
  const result = await mcts.search({
    rootState: state, rootPlayerId: state.players[0].id, model,
    Engine, sanitize: Engine.sanitize,
    legalFn: require('../training/train.js').enumerateLegalActions,
    encodeState: require('../training/train.js').encodeState,
    encodeAction: require('../training/train.js').encodeAction,
    simulate: 0, cPuct: 1.0, dirichletAlpha: 0, rng: mulberry32(1)
  });
  assert.ok(result.pi, '应当返回 π');
  let sum = 0;
  for (let i = 0; i < result.pi.length; i++) { assert.ok(result.pi[i] >= 0); sum += result.pi[i]; }
  assert.ok(Math.abs(sum - 1) < 1e-5, 'π 归一化');
  assert.equal(result.visits, 0, '零模拟时 visits = 0');
});

test('MCTS 经过若干次模拟后访问分布归一化且 visits 总和等于模拟数', async () => {
  const Engine = require('../src/engine.js');
  const state = Engine.createGame({ endDistricts: 8, charSetMode: 'base',
    seats: [{id:'a',name:'A',isBot:true,botType:'neural'},{id:'b',name:'B',isBot:true,botType:'neural'}] });
  Engine.startGame(state);
  const model = buildTinyModel(17);
  // 用确定性 RNG（mulberry32）以便重现
  const rng = mulberry32(20260101);
  const result = await mcts.search({
    rootState: state, rootPlayerId: state.players[0].id, model,
    Engine, sanitize: Engine.sanitize,
    legalFn: require('../training/train.js').enumerateLegalActions,
    encodeState: require('../training/train.js').encodeState,
    encodeAction: require('../training/train.js').encodeAction,
    simulate: 50, cPuct: 1.0, dirichletAlpha: 0, rng
  });
  assert.ok(result.pi);
  let sum = 0;
  for (let i = 0; i < result.pi.length; i++) { assert.ok(result.pi[i] >= 0); sum += result.pi[i]; }
  assert.ok(Math.abs(sum - 1) < 1e-5, 'π 求和 ≈ 1（误差 ' + sum + '）');
  assert.equal(result.visits, 50, 'visits 与 simul 一致');
});

test('MCTS 根节点加入 Dirichlet 噪声后访问分布非纯贪心', async () => {
  const Engine = require('../src/engine.js');
  const state = Engine.createGame({ endDistricts: 8, charSetMode: 'base',
    seats: [{id:'a',name:'A',isBot:true,botType:'neural'},{id:'b',name:'B',isBot:true,botType:'neural'},
            {id:'c',name:'C',isBot:true,botType:'neural'},{id:'d',name:'D',isBot:true,botType:'neural'}] });
  Engine.startGame(state);
  const model = buildTinyModel(33);
  const rng = mulberry32(424242);
  const result = await mcts.search({
    rootState: state, rootPlayerId: state.players[0].id, model,
    Engine, sanitize: Engine.sanitize,
    legalFn: require('../training/train.js').enumerateLegalActions,
    encodeState: require('../training/train.js').encodeState,
    encodeAction: require('../training/train.js').encodeAction,
    simulate: 100, cPuct: 1.0, dirichletAlpha: 0.6, rng
  });
  assert.ok(result.pi);
  // 有 Dirichlet 噪声时第二甚至第三动作通常都会拿到访问
  let touched = 0;
  for (let i = 0; i < result.pi.length; i++) if (result.pi[i] > 0) touched++;
  assert.ok(touched >= 2, '至少两个动作被访问到，touched=' + touched);
});

test('自对弈接 MCTS 时 transition 上有 pi 且求和为 1', async () => {
  const config = sanitizeConfig({ targetGames: 1, mctsSimulations: 20, charSet: 'base',
    minPlayers: 4, maxPlayers: 4, profile: 'fast', backend: 'js' });
  const model = buildTinyModel(7);
  const result = await runSelfPlayGame(model, config, 1, mulberry32(11), () => false);
  assert.ok(result.steps > 0, '走出了一些步');
  const transitions = result.transitions;
  assert.ok(transitions.length > 0, '产生了一些 transitions');
  for (const tr of transitions.slice(0, 5)) {
    assert.ok(Array.isArray(tr.pi), '每条 transition 都有 pi 数组');
    let sum = 0;
    for (let i = 0; i < tr.pi.length; i++) {
      assert.ok(tr.pi[i] >= 0, 'pi 元素非负');
      sum += tr.pi[i];
    }
    assert.ok(Math.abs(sum - 1) < 1e-4, 'pi 求和 ≈ 1，sum=' + sum);
    assert.ok(tr.mctsValue != null, 'mctsValue 有值');
    assert.ok(tr.oldProb > 0 && tr.oldProb <= 1, 'oldProb 在 (0,1]');
  }
});

test('关闭 MCTS 时 transition 没有 pi 字段（保持向后兼容）', async () => {
  const config = sanitizeConfig({ targetGames: 1, mctsSimulations: 0, charSet: 'base',
    minPlayers: 4, maxPlayers: 4, profile: 'fast', backend: 'js' });
  const model = buildTinyModel(7);
  const result = await runSelfPlayGame(model, config, 1, mulberry32(11), () => false);
  for (const tr of result.transitions.slice(0, 5)) {
    assert.equal(tr.pi, undefined, '非 MCTS 模式无 pi 字段');
  }
});
