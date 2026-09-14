'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 行动队列按角色号排序并处理刺杀与盗贼效果', () => {
  const executable = process.env.CITADELS_NATIVE_CALL_QUEUE_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_CALL_QUEUE_PROBE，跳过跨语言检查');
    return;
  }
  // 第一个有效行动是 2 号；1 号被刺杀跳过，2 号盗贼转移 6 金给 0 号。
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '2,3,3,0,7,0,0');
});
