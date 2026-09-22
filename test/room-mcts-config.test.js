'use strict';

// MCTS 设置的通路：房主面板 → createRoom/config 消息 → 服务器截断入库 →
// 房间驱动 → 策略神经网络电脑。默认 0 = 关闭，老房间行为不变。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const { createBotDriver } = require('../lib/bot-driver.js');
const { normalizeMcts } = require('../lib/local-neural-bot.js');
const { fixture, connect, until } = require('./agent-harness.js');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function state(botType) {
  const st = Engine.createGame({ seed: 91, endDistricts: 7, charSetMode: 'base',
    seats: Array.from({ length: 4 }, (_, i) => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType })) });
  Engine.startGame(st);
  return st;
}
const actor = st => st.phase === 'draft' ? st.players[st.draft.steps[st.draft.stepIdx].player] :
  st.reaction ? st.players[st.reaction.playerIdx] : st.turn && st.players[st.turn.playerIdx];

function driverWith(roomConfig, captured) {
  const st = state('neural');
  const neural = {
    status: () => ({ configured: true }),
    decide: async (_state, playerId, options) => {
      captured.options = options;
      return Engine.getAvailableActions(_state, playerId).actions.find(item => !item.disabled);
    }
  };
  const room = { state: st, config: Object.assign({ botPace: 1 }, roomConfig) };
  const driver = createBotDriver({ Engine, AI: { decide: () => null }, neural, currentActor: actor,
    send() {}, delay: () => 10000 });
  driver.tick(room);
  return { driver, room };
}

test('驱动把房主的 MCTS 设置原样交给神经网络电脑', async () => {
  const captured = {};
  const { driver, room } = driverWith({ mctsSimulations: 240, mctsMaxDepth: 30 }, captured);
  await wait(30);
  room.closed = true; driver.cancel(room);
  assert.deepEqual(captured.options.mcts, { simulations: 240, maxDepth: 30, particles: undefined });
  assert.deepEqual(normalizeMcts(captured.options.mcts), { simulations: 240, maxDepth: 30, particles: 4 });
});

test('老房间没有 MCTS 字段时搜索保持关闭', async () => {
  const captured = {};
  const { driver, room } = driverWith({}, captured);
  await wait(30);
  room.closed = true; driver.cancel(room);
  assert.equal(captured.options.mcts.simulations, undefined, '未配置的房间不擅自开搜索');
  assert.equal(normalizeMcts(captured.options.mcts), null, '缺省即等于 0 = 关闭');
});

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
