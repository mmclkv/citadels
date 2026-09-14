'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');
const { projectSearchState } = require('../native/state_projection.js');

test('搜索状态投影保留阶段、行动者和玩家资源摘要', () => {
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true }));
  const state = Engine.createGame({ seats, seed: 41, charSetMode: 'base' });
  Engine.startGame(state);
  const projection = projectSearchState(state);
  const actor = train.currentActor(state);
  assert.equal(projection.version, 1);
  assert.equal(projection.phase, state.phase);
  assert.equal(projection.stateHash.length, 64);
  assert.equal(projection.actorId, actor.id);
  assert.equal(projection.players.length, 4);
  assert.deepEqual(projection.players.map(p => p.handCount), state.players.map(p => p.hand.length));
  assert.equal(projection.draft.currentPlayerIdx, state.draft.steps[state.draft.stepIdx].player);
});
