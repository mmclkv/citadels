'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');
const { encodeSearchRequest, decodeSearchResponse, PROTOCOL_VERSION } = require('../native/protocol.js');

test('native 搜索协议裁剪 UI 历史并保留完整动作字段', () => {
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const state = Engine.createGame({ seats, seed: 17, charSetMode: 'base' });
  Engine.startGame(state);
  state.log.push({ text: '不能进入搜索快照' });
  state.notices.push({ kind: 'ui-only' });
  const actor = train.currentActor(state);
  const actions = train.enumerateLegalActions(state, actor.id);
  const line = encodeSearchRequest(state, actor.id, actions, 42);
  const request = JSON.parse(line);
  assert.equal(request.v, PROTOCOL_VERSION);
  assert.equal(request.t, 'search');
  assert.equal(request.id, '42');
  assert.deepEqual(request.state.log, []);
  assert.deepEqual(request.state.notices, []);
  assert.deepEqual(request.legalActions, actions);
  assert.equal(typeof request.stateHash, 'string');
});

test('native 搜索协议拒绝错误响应', () => {
  assert.throws(() => decodeSearchResponse(JSON.stringify({ v: 0, t: 'search_result', policy: [] })), /协议版本/);
  assert.deepEqual(decodeSearchResponse(JSON.stringify({ v: 1, t: 'search_result', policy: [1], value: 0 })).policy, [1]);
});
