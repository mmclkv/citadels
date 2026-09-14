const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('C++ 紫色建筑能力满足条件且每回合只能使用一次', () => {
  const exe = process.env.CITADELS_NATIVE_SPECIAL_BUILDINGS_PROBE;
  if (!exe) return;
  const out = execFileSync(exe, { encoding: 'utf8' }).trim();
  assert.equal(out, '1,0,1,1,1,1,0,0,1,1,0,0,3');
});
