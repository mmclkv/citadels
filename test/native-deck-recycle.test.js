'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

test('C++ 牌库耗尽后按 JS Fisher-Yates 顺序回收弃牌堆', () => {
  const executable = process.env.CITADELS_NATIVE_DECK_RECYCLE_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_DECK_RECYCLE_PROBE，跳过跨语言检查');
    return;
  }
  const state = { rngState: 17 };
  const next = () => {
    state.rngState = (state.rngState + 0x6D2B79F5) >>> 0;
    let t = state.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // 前两次 draw 消耗空牌库时不消耗随机数；回收时只洗 c,d,e。
  const expected = ['c', 'd', 'e'];
  for (let i = expected.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [expected[i], expected[j]] = [expected[j], expected[i]];
  }
  const actual = execFileSync(executable, [], { encoding: 'utf8' }).trim();
  assert.equal(actual, expected.join(','));
});
