'use strict';
// 回归：训练控制台「事件与错误」日志框必须真的能滚动，且新日志不能冲掉用户已经翻到的位置。
//
// 曾经的两个 bug：
//   1) .logs 没有高度上限，而 .detail-grid 是 auto 行高的 grid → 行高被日志内容一起撑高，
//      pre 的高度恒等于内容高度、永远不溢出，右侧滚动条成了摆设（压根滚不动）。
//   2) 每秒用 log.textContent = ... 全量重建 → 内容先被清空，scrollTop 归零，
//      用户往上翻看历史，下一秒就被弹回顶部。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('日志框高度被钉住，否则 grid 行高被内容撑开、滚动条失效', () => {
  const css = read('public/training.css');
  const rule = (css.match(/\.logs\{[^}]*\}/g) || []).find(item => /max-height/.test(item));
  assert.ok(rule, '.logs 必须设置 max-height；.detail-grid 是 auto 行高，否则 pre 会被撑到与内容同高');
  assert.match(rule, /max-height:\s*\d+px/);
  const preRule = (css.match(/\.logs pre\{[^}]*\}/g) || [])[0] || '';
  assert.match(preRule, /overflow-y:scroll/, 'pre 需要纵向滚动');
  assert.match(preRule, /min-height:0/, 'pre 不能靠 min-height 撑高，否则高度失去约束');
});

test('日志按行增量追加，不再每秒整框重建', () => {
  const js = read('public/training.js');
  assert.doesNotMatch(js, /lines\.slice\(-30\)/, '不应只渲染最后 30 行：窗口滑动会让内容整体上移、滚动位置漂移');
  assert.match(js, /log\.appendChild\(frag\)/, '新日志应追加到内容末尾');
  assert.match(js, /seqOf\(row\) > lastLogSeq/, '只渲染尚未渲染过的新行');
  assert.match(js, /document\.createDocumentFragment\(\)/, '新行先装进片段再一次性插入，避免多次重排');
});

test('只有本来就贴底时才自动跟随，用户翻看历史时位置保持不动', () => {
  const js = read('public/training.js');
  assert.match(js, /const atBottom = isLogAtBottom\(log\);/);
  assert.match(js, /if \(atBottom\) log\.scrollTop = log\.scrollHeight;/);
  assert.doesNotMatch(js, /logAutoFollow/, '旧的「一旦跟随过就永远跟随」状态已移除');
});

test('淘汰顶部旧行时补偿 scrollTop，避免用户视线跳行', () => {
  const js = read('public/training.js');
  assert.match(js, /function trimLogLines/);
  assert.match(js, /log\.scrollTop = Math\.max\(0, log\.scrollTop - removedHeight\)/);
  assert.match(js, /LOG_MAX_LINES = \d+/);
});

test('错误行单独维护，不随每次刷新重复追加', () => {
  const js = read('public/training.js');
  assert.match(js, /function syncLogError/);
  assert.match(js, /if \(errorText === logErrorText\) return;/);
});

test('服务端日志带单调递增序号，供前端做增量渲染', () => {
  const lib = read('lib/training-manager.js');
  assert.match(lib, /let logSeq = 0;/);
  assert.match(lib, /seq:\s*\+\+logSeq/, '每条日志都要带 seq，且重启后不回退（前端据此识别整框重画）');
});

test('训练页静态资源版本号已推进（浏览器才会加载新文件）', () => {
  const html = read('public/training.html');
  const css = Number((html.match(/training\.css\?v=(\d+)/) || [])[1]);
  const js = Number((html.match(/training\.js\?v=(\d+)/) || [])[1]);
  assert.ok(css >= 6, 'training.css 版本号需推进，当前 ' + css);
  assert.ok(js >= 10, 'training.js 版本号需推进，当前 ' + js);
});
