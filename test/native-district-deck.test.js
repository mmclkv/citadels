'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Cards = require('../src/cards.js');

test('C++ 基本建筑牌堆与 JS 的 UID 洗牌顺序一致', () => {
  const executable = process.env.CITADELS_NATIVE_DECK_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_DECK_PROBE，跳过跨语言检查');
    return;
  }
  const seed = 0x12345678;
  const rng = { state: seed >>> 0 };
  const jsDeck = Cards.buildDistrictDeck(() => {
    // 用与引擎相同的 JS 实现生成随机序列。
    const s = rng;
    s.state = (s.state + 0x6D2B79F5) >>> 0;
    let t = s.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
  const actual = execFileSync(executable, [String(seed)], { encoding: 'utf8' }).trim().split(',');
  assert.deepEqual(actual, jsDeck.map(card => card.uid));
});
