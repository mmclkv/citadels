'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 刺客/盗贼宣告规则拒绝 1 号和非当前角色编号', () => {
  const executable = process.env.CITADELS_NATIVE_DECLARATION_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_DECLARATION_PROBE，跳过跨语言检查');
    return;
  }
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '0,1,2,0,0,1,3');
});
