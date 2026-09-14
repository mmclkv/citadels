'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 领主摧毁与元帅抢夺规则覆盖费用、免疫和金币转移', () => {
  const executable = process.env.CITADELS_NATIVE_MILITARY_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_MILITARY_PROBE，跳过跨语言检查');
    return;
  }
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '1,5,0,1,3,3,1,1');
});
