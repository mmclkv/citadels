'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 魔术师支持整手交换和等量重抽', () => {
  const executable = process.env.CITADELS_NATIVE_MAGICIAN_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_MAGICIAN_PROBE，跳过跨语言检查');
    return;
  }
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '2,1,1,2,y,0');
});
