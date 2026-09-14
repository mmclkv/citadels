'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 资源规则参数与 JS 引擎定义一致', () => {
  const executable = process.env.CITADELS_NATIVE_RESOURCE_RULES_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_RESOURCE_RULES_PROBE，跳过跨语言检查');
    return;
  }
  const output = execFileSync(executable, { encoding: 'utf8' }).trim();
  assert.equal(output, '3,4,3,2,2');
});
