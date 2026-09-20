'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { stableJson, informationSetKey } = require('../training/information-set.js');

test('信息集 key 忽略日志、通知和随机状态', () => {
  const a = { phase: 'action', players: [{ id: 'p0', hand: [{ uid: 'c1' }] }], log: ['a'], notices: ['x'], rngState: 1 };
  const b = { rngState: 99, notices: ['y'], log: ['b'], phase: 'action', players: [{ id: 'p0', hand: [{ uid: 'c1' }] }] };
  assert.equal(stableJson(a), stableJson(b));
});

test('信息集 key 由观察者视角生成，隐藏对手信息不应进入 sanitized 视图', () => {
  const sanitize = (state, playerId) => ({
    you: playerId,
    phase: state.phase,
    me: state.players.find(p => p.id === playerId),
    opponents: state.players.map(p => ({ id: p.id, handCount: p.hand.length }))
  });
  const a = { phase: 'action', players: [{ id: 'p0', hand: [{ uid: 'a' }] }, { id: 'p1', hand: [{ uid: 'x' }] }] };
  const b = { phase: 'action', players: [{ id: 'p0', hand: [{ uid: 'a' }] }, { id: 'p1', hand: [{ uid: 'y' }] }] };
  assert.equal(informationSetKey(a, 'p0', sanitize), informationSetKey(b, 'p0', sanitize));
  assert.notEqual(informationSetKey(a, 'p1', sanitize), informationSetKey(b, 'p1', sanitize));
});
