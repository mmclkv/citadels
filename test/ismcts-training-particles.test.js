'use strict';

/**
 * 训练侧与 native 侧的 ISMCTS 接线契约。
 *
 * 搜索骨架本身的行为由 test/ismcts-particles.test.js 覆盖，这里盯的是「两侧都真的
 * 接上了粒子池」：
 *  1. mctsParticles 配置项：夹逼区间、默认值、被夹时要显式告知（不能静默改写）；
 *  2. 面板三处同步（formConfig / CONFIG_FIELDS / training.html），漏一处就是
 *     「能提交但读不回来」，已有 test/training-checkpoint-config.test.js 会红；
 *  3. alignedParticlePool：每份粒子都与真局面同一个信息集，凑不齐就少给而不是将就；
 *  4. native 协议：粒子池走 state + particles，哈希覆盖整池，单个局面仍不带 particles。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Engine = require('../src/engine.js');
const Train = require('../training/train.js');
const { mulberry32 } = require('../training/neural-policy.js');
const { encodeSearchRequest, decodeSearchRequest, stableFingerprint } =
  require('../native/protocol.js');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function newGame(playerCount = 4, seed = 4242) {
  const seats = [];
  for (let i = 0; i < playerCount; i++) {
    seats.push({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' });
  }
  const state = Engine.createGame({ roomId: 'pool-' + playerCount, endDistricts: 8,
    charSetMode: 'mixed', seed, seats });
  Engine.startGame(state);
  return state;
}

test('mctsParticles：默认值 >1，越界被夹到 [1, MAX_MCTS_PARTICLES]', () => {
  const { sanitizeConfig, MAX_MCTS_PARTICLES, adjustedConfigFields } = Train;
  assert.equal(sanitizeConfig({}).mctsParticles, 4,
    '默认就是多粒子 —— 1 份等于退回「猜一次钉死整棵树」');
  assert.equal(sanitizeConfig({ mctsParticles: 0 }).mctsParticles, 1);
  assert.equal(sanitizeConfig({ mctsParticles: -3 }).mctsParticles, 1);
  assert.equal(sanitizeConfig({ mctsParticles: 1 }).mctsParticles, 1, '1 是合法值（退回单世界搜索）');
  assert.equal(sanitizeConfig({ mctsParticles: MAX_MCTS_PARTICLES + 100 }).mctsParticles,
    MAX_MCTS_PARTICLES);
  assert.equal(sanitizeConfig({ mctsParticles: 'abc' }).mctsParticles, 4, '非数值取默认');
});

test('mctsParticles 被夹逼时要在启动日志里说出来（不能静默改写）', () => {
  const { sanitizeConfig, MAX_MCTS_PARTICLES, adjustedConfigFields } = Train;
  const raw = { mctsParticles: MAX_MCTS_PARTICLES + 50 };
  const adjusted = adjustedConfigFields(raw, sanitizeConfig(raw));
  const hit = adjusted.find(item => item.key === 'mctsParticles');
  assert.ok(hit, 'ADJUSTED_CONFIG_FIELDS 里要有粒子数，被夹时才会打印「配置调整」');
  assert.equal(hit.label, 'MCTS 粒子数');
  assert.equal(hit.from, MAX_MCTS_PARTICLES + 50);
  assert.equal(hit.to, MAX_MCTS_PARTICLES);
  // 合法值不该被当成「改写」刷屏
  assert.equal(adjustedConfigFields({ mctsParticles: 2 }, sanitizeConfig({ mctsParticles: 2 }))
    .filter(item => item.key === 'mctsParticles').length, 0);
});

test('面板三处同步：formConfig 提交、CONFIG_FIELDS 回填、training.html 控件与上限', () => {
  const js = read('public/training.js');
  const html = read('public/training.html');

  const form = js.match(/function formConfig\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(form, '必须能读到 formConfig()');
  assert.match(form[0], /mctsParticles:/, 'formConfig 要提交 mctsParticles');

  const table = js.match(/const CONFIG_FIELDS = \[[\s\S]*?\n\];/);
  assert.match(table[0], /\['mctsParticles',\s*'mcts-particles',\s*'number'\]/,
    'CONFIG_FIELDS 要能把它回填到面板');

  // 上限必须和后端 MAX_MCTS_PARTICLES 同一个数，两端各写一个必然漂移
  const input = html.match(/<input id="mcts-particles"[^>]*>/);
  assert.ok(input, 'training.html 里要有 mcts-particles 控件');
  const max = Number((input[0].match(/max="(\d+)"/) || [])[1]);
  assert.equal(max, Train.MAX_MCTS_PARTICLES, '输入框 max 应等于后端 MAX_MCTS_PARTICLES');
});

test('alignedParticlePool：每份粒子都在同一个信息集里，凑不齐就少给', () => {
  const state = newGame();
  const me = state.players[0].id;
  const legal = Train.enumerateLegalActions(state, me);
  const before = JSON.stringify(state);

  const pool = Train.alignedParticlePool(state, me, legal, mulberry32(11), 4);
  assert.equal(pool.length, 4, '四份都该对得上');
  pool.forEach((entry, i) => {
    assert.notEqual(entry.state, state, '粒子 ' + i + ' 是真局面的克隆，不是真局面本身');
    assert.deepEqual(entry.legal, legal, '粒子 ' + i + ' 的动作列表与真局面逐字一致');
    assert.equal(JSON.stringify(Engine.sanitize(entry.state, me)),
      JSON.stringify(Engine.sanitize(state, me)),
      '粒子 ' + i + ' 的公开视角与真局面一字不差');
  });
  const hidden = pool.map(entry =>
    JSON.stringify((entry.state.players || []).map(p => (p.hand || []).map(c => c.uid))));
  assert.ok(new Set(hidden).size > 1, '各粒子的隐藏牌堆应当不同（否则等于没猜）');
  assert.equal(JSON.stringify(state), before, '不得改写权威局面');

  // 一个都对不上时返回空数组，绝不退回真局面
  assert.deepEqual(Train.alignedParticlePool(state, 'nobody', legal, mulberry32(3), 2), []);
  assert.deepEqual(Train.alignedParticlePool(state, me, [{ type: 'not_a_real_action' }],
    mulberry32(3), 2), []);
});

test('native 协议：粒子池走 state + particles，哈希覆盖整池', () => {
  const state = newGame();
  const me = state.players[0].id;
  const legal = Train.enumerateLegalActions(state, me);
  const pool = Train.alignedParticlePool(state, me, legal, mulberry32(13), 3);
  assert.equal(pool.length, 3);

  const request = JSON.parse(encodeSearchRequest(pool.map(entry => entry.state), me, legal, 'p-1'));
  assert.equal(request.particles.length, 2, '第一份留在 state、其余进 particles');
  assert.equal(request.stateHash, stableFingerprint([request.state, ...request.particles]),
    '哈希要覆盖整池：粒子被截断/串位同样是灾难');
  assert.doesNotThrow(() => decodeSearchRequest(JSON.stringify(request)));

  // 改任一份粒子都要被哈希拦下
  const tampered = JSON.parse(JSON.stringify(request));
  tampered.particles[0].players[0].gold += 1;
  assert.throws(() => decodeSearchRequest(tampered), /stateHash 不匹配/);

  // 单个局面仍然不带 particles —— 旧 worker 只认 state，天然退化成单粒子
  const single = JSON.parse(encodeSearchRequest(state, me, legal, 'p-2'));
  assert.equal(single.particles, undefined);
  assert.doesNotThrow(() => decodeSearchRequest(JSON.stringify(single)));
});

console.log('训练侧与 native 侧的粒子池接线：配置项、面板同步、对齐校验、协议全部通过');
