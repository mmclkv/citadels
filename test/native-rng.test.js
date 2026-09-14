'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function jsSequence(seed, count) {
  const state = { rngState: seed >>> 0 };
  function nextRand() {
    state.rngState = (state.rngState + 0x6D2B79F5) >>> 0;
    let t = state.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return Array.from({ length: count }, nextRand);
}

test('C++ RNG 与 JS 引擎随机序列一致', () => {
  const executable = process.env.CITADELS_NATIVE_RNG_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_RNG_PROBE，跳过跨语言检查');
    return;
  }
  const seed = 0xdecafbad;
  const expected = jsSequence(seed, 16);
  const actual = execFileSync(executable, [String(seed), '16'], {
    env: { ...process.env }, encoding: 'utf8'
  }).trim().split(',').map(Number);
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert.equal(value, expected[i]));
});
