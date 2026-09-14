const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('原生状态和动作可批量编码并接入策略价值评估器', () => {
  const exe = process.env.CITADELS_NATIVE_NEURAL_EVALUATOR_PROBE;
  if (!exe) return;
  assert.equal(execFileSync(exe, { encoding: 'utf8' }).trim(), '2,2,0.5');
});
