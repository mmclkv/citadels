const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('C++ 艺术家最多美化两栋并按栋扣金', () => {
  const exe = process.env.CITADELS_NATIVE_ARTIST_PROBE;
  if (!exe) return;
  assert.equal(execFileSync(exe, { encoding: 'utf8' }).trim(), '1,1,1,0,0,beautified,beautified');
});
