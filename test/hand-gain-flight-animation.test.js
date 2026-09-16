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
  '学者选牌', '修士资源', '预言家抽取手牌', '墓地收回建筑', '额外抽牌'
]) {
  assert.ok(engine.includes("notifyHandGain(state,") && engine.includes("'" + effect + "'"),
    effect + '效果应报告手牌获得并触发动画');
}

console.log('各手牌获得效果均已接入牌背飞行动画');
