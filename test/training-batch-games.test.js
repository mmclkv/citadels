'use strict';
// 回归：「每批对局」（batchGames）在面板上填多少都不生效。
//
// 现象：不管填 32 以上什么数，实际都攒够 32 局才做一次策略更新。
// 根因：training/train.js 的 sanitizeConfig 把该值硬夹在 Math.min(32, …)，
//       且夹逼是静默的 —— 用户看不到自己的输入被改写，只会以为参数坏了。
//       public/training.html 的输入框 max="32" 是同一限制的前端镜像。
//
// 本测试锁住三件事：
//   ① 上限之内（含放宽后的 64/128/256）必须原样生效；
//   ② 超出上限时夹到上限，并且能被 adjustedConfigFields 检出、写进启动日志；
//   ③ 前端输入框的 max 与后端上限保持一致，避免两端再次各写一个数。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { sanitizeConfig, MAX_BATCH_GAMES, adjustedConfigFields } = require('../training/train.js');

const at = value => sanitizeConfig({ targetGames: 1000, batchGames: value }).batchGames;

test('上限之内的「每批对局」原样生效（不再被压成 32）', () => {
  for (const value of [1, 2, 4, 8, 16, 32, 33, 48, 64, 100, 128, 200, 256]) {
    assert.strictEqual(at(value), value, '每批对局 ' + value + ' 应原样生效');
  }
});

test('超过上限的「每批对局」夹到上限，而不是夹到旧的 32', () => {
  assert.strictEqual(at(MAX_BATCH_GAMES + 1), MAX_BATCH_GAMES);
  assert.strictEqual(at(512), MAX_BATCH_GAMES);
  assert.strictEqual(at(100000), MAX_BATCH_GAMES);
  assert.ok(MAX_BATCH_GAMES > 32, '上限应高于旧的 32');
});

test('非法「每批对局」的兜底：0/空值走默认 4，负数下限为 1', () => {
  // 0 与「未填」同义（`Number(x) || 4`），回落到默认值；与其它数值字段的约定一致。
  assert.strictEqual(at(0), 4);
  assert.strictEqual(sanitizeConfig({ targetGames: 1000 }).batchGames, 4);
  assert.strictEqual(sanitizeConfig({ targetGames: 1000, batchGames: 'abc' }).batchGames, 4);
  assert.strictEqual(at(-5), 1);
});

test('被改写的配置项会被检出，用于启动日志回报（不再静默）', () => {
  const raw = { targetGames: 1000, batchGames: 512 };
  const config = sanitizeConfig(raw);
  const changed = adjustedConfigFields(raw, config);
  const batch = changed.find(item => item.key === 'batchGames');
  assert.ok(batch, '填 512 应被检出改写');
  assert.strictEqual(batch.from, 512);
  assert.strictEqual(batch.to, MAX_BATCH_GAMES);
  assert.match(batch.label, /每批对局/);

  // 合法输入不该产生任何提示
  const ok = { targetGames: 1000, batchGames: 64, workers: 2, miniBatch: 256 };
  assert.deepStrictEqual(adjustedConfigFields(ok, sanitizeConfig(ok)), []);

  // 完全没填的项（undefined / 空字符串）不算「被改写」
  assert.deepStrictEqual(adjustedConfigFields({ targetGames: 1000 }, sanitizeConfig({ targetGames: 1000 })), []);
});

test('前端输入框的 max 与后端上限一致（防止两端再次各写一个数）', () => {
  const html = read('public/training.html');
  const input = html.match(/<input[^>]*id="batch-games"[^>]*>/);
  assert.ok(input, '训练页应有 #batch-games 输入框');
  const max = Number((input[0].match(/max="(\d+)"/) || [])[1]);
  assert.strictEqual(max, MAX_BATCH_GAMES, '输入框 max 应等于后端 MAX_BATCH_GAMES');
  assert.match(input[0], /min="1"/, '输入框应保留下限 1');
});
