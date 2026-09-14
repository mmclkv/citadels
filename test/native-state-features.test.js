const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('原生状态可编码为固定长度网络特征', () => {
  const exe = process.env.CITADELS_NATIVE_STATE_FEATURES_PROBE;
  if (!exe) return;
  const [size, players, p0Gold, p1Active] = execFileSync(exe, { encoding: 'utf8' })
    .trim().split(',').map(Number);
  assert.equal(size, 52);
  assert.ok(Math.abs(players - 2 / 6) < 1e-5);
  assert.equal(p0Gold, 0.25);
  assert.equal(p1Active, 1);
});
