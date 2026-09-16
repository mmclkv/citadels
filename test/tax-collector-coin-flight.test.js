'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const engine = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

assert.match(engine, /notify\(state, 'tax_collected',[\s\S]*?playerIdx:\s*idx[\s\S]*?amount:\s*amount/,
  '税务官收取正数金币时应广播收税事件');
assert.match(app, /case 'tax_collected':[\s\S]*?flyTaxCoinsToCollector\(n\.playerIdx, n\.amount\)/,
  '客户端应响应税务官收税通知');
assert.match(app, /function flyTaxCoinsToCollector\(seat, amount\)[\s\S]*?\$\('#tax-pot \.tax-pot-mark'\)[\s\S]*?playerGoldAnchor\(seat\)[\s\S]*?coinFlight\(rectOf\(pot\)/,
  '金币应从钱袋图标飞向税务官金币标识');

console.log('税务官收税金币飞行动画检查通过');
