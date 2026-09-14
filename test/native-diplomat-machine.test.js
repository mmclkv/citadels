'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 外交官交换建筑支持差价并拒绝堡垒', () => {
  const executable = process.env.CITADELS_NATIVE_DIPLOMAT_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_DIPLOMAT_PROBE，跳过跨语言检查');
    return;
  }
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '1,5,0,港口,城堡,0');
});
