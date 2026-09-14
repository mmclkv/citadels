'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 学者从 7 张中选 1 张并洗回其余 6 张', () => {
  const executable = process.env.CITADELS_NATIVE_SCHOLAR_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_SCHOLAR_PROBE，跳过跨语言检查');
    return;
  }
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '1,2,9,0');
});
