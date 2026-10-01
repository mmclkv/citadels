'use strict';

// MCTS 设置的通路：房主面板 → createRoom/config 消息 → 服务器截断入库 →
// 房间驱动 → 策略神经网络电脑。默认 0 = 关闭，老房间行为不变。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, connect, until } = require('./agent-harness.js');

test('服务器截断并保存 MCTS 设置，大厅视图原样回显', async t => {
  const f = await fixture(false); t.after(f.close);
  const c = await connect(f.base, '房主'); t.after(c.close);
  c.send({ t: 'createRoom', name: '房主', config: { playerCount: 3, bots: 1,
    mctsSimulations: 999999, mctsMaxDepth: -7, mctsParticles: 999 } });
  await until(() => c.state && c.state.phase === 'lobby', 'lobby view');
  assert.equal(c.state.config.mctsSimulations, 2000, '越界的模拟数被截断');
  assert.equal(c.state.config.mctsMaxDepth, 0, '负数深度按 0（自动）保存');
  assert.equal(c.state.config.mctsParticles, 8, '粒子数被截断到上限');
  c.send({ t: 'config', config: { mctsSimulations: 120, mctsMaxDepth: 40, mctsParticles: 6 } });
  await until(() => c.state.config.mctsSimulations === 120, 'config update applied');
  assert.equal(c.state.config.mctsMaxDepth, 40);
  assert.equal(c.state.config.mctsParticles, 6);
  c.send({ t: 'config', config: { mctsSimulations: 0 } });
  await until(() => c.state.config.mctsSimulations === 0, '关闭搜索');
});

test('新房间的神经网络 MCTS 默认值与严格评测对齐', async t => {
  const f = await fixture(false); t.after(f.close);
  const c = await connect(f.base, '房主'); t.after(c.close);
  c.send({ t: 'createRoom', name: '房主', config: {
    playerCount: 3, bots: 1, botType: 'neural', charSetMode: 'base'
  } });
  await until(() => c.state && c.state.phase === 'lobby', 'lobby view');
  assert.equal(c.state.config.mctsSimulations, 500);
  assert.equal(c.state.config.mctsMaxDepth, 700);
  assert.equal(c.state.config.mctsParticles, 4);
});
