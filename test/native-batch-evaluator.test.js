const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('C++ 批量评估接口按请求保留动作组形状', () => {
  const exe = process.env.CITADELS_NATIVE_BATCH_EVALUATOR_PROBE;
  if (!exe) return;
  assert.equal(execFileSync(exe, { encoding: 'utf8' }).trim(), '2,3,2,0.333333,2');
});
