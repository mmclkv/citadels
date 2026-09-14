'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');
const { recordAppliedAction, replayActions } = require('../native/replay.js');

test('native replay 基线可记录并重放真实引擎动作', () => {
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 31, charSetMode: 'base' });
  Engine.startGame(initial);
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (let i = 0; i < 20 && state.phase !== 'gameover'; i++) {
    const actor = train.currentActor(state);
    assert.ok(actor, '每个回放步骤都应有行动者');
    const legal = train.enumerateLegalActions(state, actor.id);
    assert.ok(legal.length, '每个回放步骤都应有合法动作');
    const record = recordAppliedAction(state, actor.id, legal[0], (s, p, a) => Engine.applyAction(s, p, a));
    assert.equal(record.ok, true);
    records.push(record);
  }
  const replay = replayActions(initial, records, (s, p, a) => Engine.applyAction(s, p, a));
  assert.equal(replay.ok, true, replay.error || '重放失败');
  assert.equal(replay.state.phase, state.phase);
});
