const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('C++ 统一对局状态接通资源领取与回合结束', () => {
  const exe = process.env.CITADELS_NATIVE_GAME_STATE_PROBE;
  if (!exe) return;
  assert.equal(execFileSync(exe, { encoding: 'utf8' }).trim(), '1,0,1,4');
});
