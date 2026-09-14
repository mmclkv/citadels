'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');

test('C++ 选角状态机与 JS 真实回放的行动者轮转一致', () => {
  const executable = process.env.CITADELS_NATIVE_DRAFT_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    assert.ok(true, '未设置 CITADELS_NATIVE_DRAFT_PROBE，跳过跨语言检查');
    return;
  }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true }));
  const state = Engine.createGame({ seats, seed: 43, charSetMode: 'base' });
  Engine.startGame(state);
  const crown = state.draft.crown;
  const actions = [];
  const expected = [];
  while (state.phase === 'draft') {
    const actor = train.currentActor(state);
    const action = train.enumerateLegalActions(state, actor.id)[0];
    actions.push(action.type);
    assert.equal(Engine.applyAction(state, actor.id, action).ok, true);
    expected.push(state.phase === 'draft' ? train.currentActor(state).seat : -1);
  }
  const output = execFileSync(executable, ['4', String(crown), ...actions], {
    env: { ...process.env }, encoding: 'utf8'
  }).trim();
  const actual = output ? output.split(',').map(Number) : [];
  assert.deepEqual(actual, expected);
});
