const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('统一原生状态可以驱动 MCTS 搜索', () => {
  const exe = process.env.CITADELS_NATIVE_GAME_ADAPTER_PROBE;
  if (!exe) return;
  const [visits, expansions, actions] = execFileSync(exe, { encoding: 'utf8' })
    .trim().split(',').map(Number);
  assert.equal(visits, 8);
  assert.ok(expansions > 0);
  assert.ok(actions >= 2);
});
