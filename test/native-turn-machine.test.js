'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 回合结束逻辑覆盖炼金术士退款和待决动作阻塞', () => {
  const executable = process.env.CITADELS_NATIVE_TURN_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_TURN_PROBE，跳过跨语言检查');
    return;
  }
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '1,5,3,1,8,1,8,0');
});
