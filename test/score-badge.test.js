#!/usr/bin/env node
/* 分数徽章回归测试：
   1) PC/移动端分数 UI 改为「蓝色圆圈 + 数值」徽章，悬停出计分组成提示；
   2) 旧「分数」圆按钮（.score-btn）全部移除；
   3) 手牌数外面的圆圈（.hand-count-number 的圆形边框）移除。 */
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function read(p) { return fs.readFileSync(path.join(root, p), 'utf8'); }

const html = read('public/index.html');
const css = read('public/style.css');
const js = read('public/app.js');
const neon = read('public/themes/neon/theme.css');

console.log('== 分数徽章 ==');
ok(html.includes('class="score-badge" id="btn-my-score"'), '我的区域使用 score-badge 按钮');
ok(html.includes('score-icon') && html.includes('id="my-score-val"'), '徽章含蓝色圆圈图标与数值节点');
ok(!html.includes('score-btn'), 'index.html 无 score-btn 残留');
ok(!css.includes('.score-btn') && !js.includes("'score-btn'") && !neon.includes('.score-btn'), '旧 .score-btn 样式/代码全部移除');
ok(/\.score-icon\{[^}]*border-radius:50%/.test(css), 'score-icon 是圆形');
ok(/\.score-icon\{[^}]*#2f6fc4/.test(css.replace(/\n/g, '')) || css.includes('#2f6fc4'), 'score-icon 使用蓝色渐变');
ok(js.includes('scoreBadgeHTML(i, p.name)') && js.includes('bindScoreBadge(head.querySelector(\'.score-badge\'), i)'), '对手面板渲染分数徽章并绑定交互');
ok(js.includes("myScoreVal.textContent = srow ? srow.total : 0"), '我的区域徽章数值随状态刷新');
ok(js.includes('function showScoreTip') && js.includes('function hideScoreTip'), '悬停计分组成提示函数存在');
ok(js.includes("btn.addEventListener('mouseenter', () => showScoreTip(btn, idx))"), '徽章悬停显示组成提示');
ok(js.includes("st-row total"), '提示里包含合计行');
ok((js.match(/hideScoreTip\(\); \/\/ 徽章随渲染重建/g) || []).length === 2, '两处渲染入口都会收掉残留提示');
ok(neon.includes('.score-badge') && neon.includes('.score-icon') && neon.includes('.score-tip'), '霓虹主题适配徽章与提示浮层');

console.log('== 手牌数圆圈移除 ==');
const hcn = css.slice(css.lastIndexOf('.hand-count-number'));
ok(!/border-radius:\s*50%/.test(css.slice(css.indexOf('.hand-count-number{'), css.indexOf('.hand-count-number{') + 220)), 'hand-count-number 不再是圆形');
ok(!/border:1px solid var\(--line2\)/.test(css.slice(css.indexOf('.hand-count-number{'), css.indexOf('.hand-count-number{') + 220)), 'hand-count-number 无圆形边框');
ok(!/width:24px;height:24px/.test(css.slice(css.indexOf('.hand-count-number{'), css.indexOf('.hand-count-number{') + 220)), 'hand-count-number 无固定圆尺寸');
ok(!/hand-count-number\{width:28px/.test(css), '移动端环形布局也不再给数字套圆圈');
ok(js.includes('hand-count-number'), '手牌数节点仍正常渲染（牌背 × 数字）');

console.log('分数徽章回归测试：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
