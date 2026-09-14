'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 建造状态更新正确扣费并累计城市与本回合花费', () => {
  const executable = process.env.CITADELS_NATIVE_CITY_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_CITY_PROBE，跳过跨语言检查');
    return;
  }
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '1,2,1,8,1,4,1');
});
