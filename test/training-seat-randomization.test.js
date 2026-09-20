'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../src/engine.js');
const Train = require('../training/train.js');

test('训练会轮换策略网络座位和开局皇冠', () => {
  const config = { seed: 20260913 };
  const seenNetwork = new Set();
  const seenCrown = new Set();
  for (let game = 1; game <= 96; game++) {
    const placement = Train.trainingPlacement(config, game, 6, 1);
    assert.equal(placement.networkSeats.size, 1);
    seenNetwork.add([...placement.networkSeats][0]);
    seenCrown.add(placement.initialCrownSeat);
  }
  assert.equal(seenNetwork.size, 6, '策略网络应覆盖全部物理座位');
  assert.equal(seenCrown.size, 6, '皇冠应覆盖全部物理座位');
});

test('引擎支持显式设置开局皇冠座位，默认仍为座位 1', () => {
  const seats = Array.from({ length: 4 }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
  const rotated = Engine.createGame({ seats, initialCrownSeat: 2 });
  Engine.startGame(rotated);
  assert.equal(rotated.players.findIndex(player => player.hasCrown), 2);

  const legacy = Engine.createGame({ seats });
  Engine.startGame(legacy);
  assert.equal(legacy.players.findIndex(player => player.hasCrown), 0);
});

test('状态编码不再暴露物理座位号', () => {
  const seats = Array.from({ length: 4 }, (_, i) => ({ id: 'p' + i, name: 'P' + i }));
  const state = Engine.createGame({ seats, seed: 7 });
  Engine.startGame(state);
  const view = Engine.sanitize(state, state.players[0].id);
  const encoded = Train.encodeState(view, state.players[0].id).vector;
  for (let slot = 0; slot < 4; slot++) assert.equal(encoded[32 + slot * 80 + 18], 0);
});
