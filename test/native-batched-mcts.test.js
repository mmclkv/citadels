const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('批量 MCTS 按 batch 收集叶节点并调用批量评估器', () => {
  const exe = process.env.CITADELS_NATIVE_BATCHED_MCTS_PROBE;
  if (!exe) return;
  const [visits, calls, actions] = execFileSync(exe, { encoding: 'utf8' }).trim().split(',').map(Number);
  assert.equal(visits, 12);
  assert.equal(calls, 3);
  assert.ok(actions >= 2);
});
