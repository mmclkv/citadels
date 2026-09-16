'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const start = app.indexOf("case 'spy_result':");
assert.ok(start >= 0, '前端应处理间谍调查结算通知');
const end = app.indexOf('\n      case ', start + 10);
const noticeHandler = app.slice(start, end);
assert.match(noticeHandler, /flyCoins\(n\.targetIdx,\s*n\.byIdx,\s*n\.gold\)/,
  '金币动画应从被调查者飞向间谍');
assert.match(noticeHandler, /handTransferAnim\(n\.targetIdx,\s*n\.byIdx,\s*Array\.isArray\(n\.cards\)\s*\?\s*n\.cards\.length\s*:\s*0/,
  '手牌动画数量应对应间谍实际获得的卡牌数');

const transferStart = app.indexOf('function handTransferAnim(');
const transferEnd = app.indexOf('\n  }', transferStart) + 4;
const transferFunction = app.slice(transferStart, transferEnd);
assert.match(transferFunction, /i < count/, '手牌转移动画应按张数创建牌背');
assert.match(transferFunction, /hand-swap-flight hand-transfer-flight/,
  '转移的卡牌应使用统一主题牌背样式');

console.log('间谍金币与手牌飞行动画检查通过');
