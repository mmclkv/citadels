'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engine = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

assert.match(engine, /function notifyHandGain\(state, toIdx, amount, fromIdx, why\)/,
  '规则层应提供统一的手牌获得通知');
assert.match(app, /case 'hand_gain':[\s\S]*?handTransferAnim\(n\.fromIdx, n\.playerIdx, n\.amount[\s\S]*?flyCardsToHand\(n\.playerIdx, n\.amount\)/,
  '客户端应根据手牌来源播放转移或牌堆抽取动画');

for (const effect of [
  '图书馆', '抽牌保留', '铁匠铺', '法师获得手牌', '住持资源', '魔术师重抽',
  '学者选牌', '修士资源', '预言家抽取手牌', '预言家归还手牌', '墓地收回建筑', '额外抽牌'
]) {
  assert.ok(engine.includes("notifyHandGain(state,") && engine.includes("'" + effect + "'"),
    effect + '效果应报告手牌获得并触发动画');
}

// 运行期：预言家「抽取」与「归还」两段各发出一次 hand_gain 通知，客户端据此播动画。
{
  const Engine = require('../src/engine.js');
  const seats = [{ id: 'pro', name: '预言家玩家' }, { id: 'p1', name: '玩家2' },
    { id: 'p2', name: '玩家3' }, { id: 'p3', name: '玩家4' }];
  const state = Engine.createGame({ charSetMode: 'base', seed: 256, seats });
  Engine.startGame(state);
  state.phase = 'action';
  state.players.forEach(player => { player.chars = []; player.played = []; });
  state.players[0].chars = ['prophet'];
  state.turn = { charId: 'prophet', num: 3, playerIdx: 0, playerId: 'pro', phase: 'main',
    takenResources: true, incomeTaken: true, abilityUsed: false, builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
  const take = Engine.applyAction(state, 'pro', { type: 'ability' });
  assert.equal(take.ok, true, '预言家能力可以发动');
  const draws = state.notices.filter(n => n.kind === 'hand_gain' && n.why === '预言家抽取手牌');
  assert.equal(draws.length, 3, '每位对手各产生一条抽取通知');

  const targetIdx = state.turn.pending.targetIdx;
  const before = state.players[targetIdx].hand.length;
  const card = state.players[0].hand[0];
  assert.equal(Engine.applyAction(state, 'pro', { type: 'prophet_give', uid: card.uid }).ok, true);
  assert.equal(state.players[targetIdx].hand.length, before + 1, '归还后目标手牌 +1');

  const back = state.notices.filter(n => n.kind === 'hand_gain' && n.why === '预言家归还手牌');
  assert.equal(back.length, 1, '归还这一步要发出手牌获得通知，客户端才会播飞行动画');
  assert.deepEqual({ playerIdx: back[0].playerIdx, fromIdx: back[0].fromIdx, amount: back[0].amount },
    { playerIdx: targetIdx, fromIdx: 0, amount: 1 },
    '归还通知的方向是「预言家 → 目标玩家」，数量 1');
}

console.log('各手牌获得效果均已接入牌背飞行动画');
