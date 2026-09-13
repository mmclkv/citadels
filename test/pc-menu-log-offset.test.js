#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

assert.ok(/gameScreen\.classList\.toggle\('log-panel-open', willShow\)/.test(app),
  '展开和收起战报时同步游戏页定位状态');
assert.ok(/getBoundingClientRect\(\)\.width/.test(app) && /--desktop-log-width/.test(app),
  '展开后读取战报栏实际宽度，不依赖固定宽度猜测');
assert.ok(/@media \(min-width:821px\)\{[\s\S]*?#screen-game\.log-panel-open \.mobile-menu-toggle\{right:calc\(18px \+ var\(--desktop-log-width,288px\)\)\}/.test(css),
  'PC 战报展开后菜单按钮按实际栏宽左移，贴住战斗区域右边界');
assert.ok(/#screen-game\.log-panel-open\.mobile-menu-open \.topbar\{right:calc\(18px \+ var\(--desktop-log-width,288px\)\)\}/.test(css),
  '菜单浮窗与按钮使用相同的战斗区域锚点');
assert.ok(/\.mobile-menu-toggle\{[^}]*transition:right \.2s ease/.test(css),
  '战报开合时按钮平滑移动，不发生位置跳变');
assert.ok(/style\.css\?v=52/.test(html) && /app\.js\?v=69/.test(html),
  '静态资源版本已更新');

console.log('PC 战报展开时菜单锚点回归：6 项断言全部通过');
