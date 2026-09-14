const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('C++ 原生自对弈循环可以完成一局并记录搜索统计', () => {
  const exe = process.env.CITADELS_NATIVE_SELFPLAY_PROBE;
  if (!exe) return;
  const [terminal, turns, winner, expansions] = execFileSync(exe, { encoding: 'utf8' })
    .trim().split(',').map(Number);
  assert.equal(terminal, 1);
  assert.ok(turns > 0);
  assert.equal(winner, 0);
  assert.ok(expansions > 0);
});
