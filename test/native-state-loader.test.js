'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

test('C++ 可以从完整 JS 快照初始化原生行动状态', () => {
  const executable = process.env.CITADELS_NATIVE_STATE_LOADER_PROBE;
  if (!executable) {
    assert.ok(true, '未设置 CITADELS_NATIVE_STATE_LOADER_PROBE，跳过跨语言检查');
    return;
  }
  const result = execFileSync(executable, { encoding: 'utf8' }).trim();
  assert.equal(result, '1,1,graveyard,1,0,1');
});
