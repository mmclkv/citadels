'use strict';
// 回归：训练控制台需要把 approxKl（MCTS 策略与网络策略的近似散度）单独画成一张图。
//
// 两个易错点：
//   1) KL 量级很小（典型 0.0x），drawLines 的 Y 轴刻度写死 toFixed(2) 会把它压成同一个数，
//      必须支持自定义小数位。
//   2) KL 恒为正，若沿用「min~max 自适应」会让基线悬空，看不出绝对值大小，应把下界锚到 0。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('训练页有独立的 KL 散度图表面板', () => {
  const html = read('public/training.html');
  assert.match(html, /<h2>KL 散度<\/h2>/, '需要 KL 散度面板标题');
  assert.match(html, /<canvas id="approx-kl-chart"><\/canvas>/, '需要 KL 专属 canvas');
  assert.match(html, /id="approx-kl-now"/, '需要展示最新 KL 值的标题位');
  // 面板必须落在 chart-grid 内，才会跟其它图一起排布
  const grid = html.slice(html.indexOf('chart-grid'), html.indexOf('</section>', html.indexOf('chart-grid')));
  assert.match(grid, /approx-kl-chart/, 'KL 图必须在 chart-grid 内');
});

test('KL 图绑定 approxKl 字段，并用高精度刻度 + 零基线', () => {
  const js = read('public/training.js');
  const call = js.match(/drawLines\(\$\('approx-kl-chart'\)[\s\S]*?\);/);
  assert.ok(call, '必须调用 drawLines 绘制 approx-kl-chart');
  assert.match(call[0], /key:\s*'approxKl'/, '数据字段必须是 approxKl');
  assert.match(call[0], /digits:\s*4/, 'KL 值太小，刻度需要至少 4 位小数才看得出变化');
  assert.match(call[0], /zeroBased:\s*true/, 'KL 恒为正，下界应锚到 0');
});

test('drawLines 支持自定义刻度精度与零基线，且不再写死 toFixed(2)', () => {
  const js = read('public/training.js');
  assert.match(js, /function drawLines\(canvas, history, series, options\)/);
  assert.match(js, /const digits = Number\.isFinite\(opts\.digits\) \? opts\.digits : 2;/);
  assert.match(js, /max\.toFixed\(digits\)/);
  assert.match(js, /min\.toFixed\(digits\)/);
  assert.doesNotMatch(js, /toFixed\(2\), 3, pad\.t \+ 3\)/, 'Y 轴刻度不应再写死两位小数');
  assert.match(js, /if \(opts\.zeroBased && min > 0\) min = 0;/);
});

test('顶部数值：KL 归独立面板，不再挤在策略损失标题里重复显示', () => {
  const js = read('public/training.js');
  assert.match(js, /\$\('approx-kl-now'\)\.textContent = 'KL ' \+ num\(point\.approxKl, 5\)/);
  // 注意：仓库在 Windows 上检出为 CRLF，行尾不能写死 \n，用 \s* 兼容两种换行
  const policyLine = js.match(/\$\('policy-now'\)\.textContent = [\s\S]*?;\s*\n/);
  assert.ok(policyLine, '应保留策略损失标题的赋值');
  assert.doesNotMatch(policyLine[0], /approxKl|' · KL '/, '策略损失标题不应再重复显示 KL');
});

test('数据链路：history 的每个点都要带 approxKl，否则新图无源', () => {
  const train = read('training/train.js');
  assert.match(train, /approxKl:\s*losses\.approxKl \|\| 0/, 'train.js 的 point 必须写入 approxKl');
  const py = read('training/gpu_trainer.py');
  assert.match(py, /"approxKl":\s*total\["kl"\] \/ denominator/, 'python 侧必须回传 approxKl');
});

test('训练页静态资源版本号已推进（浏览器才会加载新文件）', () => {
  const html = read('public/training.html');
  const js = Number((html.match(/training\.js\?v=(\d+)/) || [])[1]);
  assert.ok(js >= 11, 'training.js 版本号需推进，当前 ' + js);
});
