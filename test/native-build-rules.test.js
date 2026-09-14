'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 建造合法性规则覆盖限额、同名、采石场和角色例外', () => {
  const executable = process.env.CITADELS_NATIVE_BUILD_RULES_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_BUILD_RULES_PROBE，跳过跨语言检查');
    return;
  }
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '1,0,1,0,1,0');
});
