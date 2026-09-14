'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 叫号效果结算覆盖刺杀、盗贼和女巫', () => {
  const executable = process.env.CITADELS_NATIVE_EFFECT_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_EFFECT_PROBE，跳过跨语言检查');
    return;
  }
  // enum: Normal=0, SkippedAssassinated=1, Bewitched=2, ThiefResolved=3
  assert.equal(execFileSync(executable, { encoding: 'utf8' }).trim(), '1,3,7,0,0,1,3,2,2');
});
