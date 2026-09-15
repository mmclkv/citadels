'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');
const { recordAppliedAction, stateSummary } = require('../native/replay.js');
const { encodeReplayTrace, decodeReplayResult } = require('../native/replay_protocol.js');

test('native 回放协议携带完整初始状态而不是只有摘要哈希', () => {
  const initial = { phase: 'action', players: [{ id: 'p0' }], log: [{ text: 'ui' }], notices: [{ kind: 'ui' }] };
  const request = JSON.parse(encodeReplayTrace(initial, [], 'schema'));
  assert.deepEqual(request.initialState.players, [{ id: 'p0' }]);
  assert.deepEqual(request.initialState.log, []);
  assert.deepEqual(request.initialState.notices, []);
  assert.equal(typeof request.initialHash, 'string');
});

test('native 回放记录包含逐动作状态摘要', () => {
  const state = { phase: 'action', round: 2, rngState: 9, deck: [], discard: [],
    players: [{ id: 'p0', gold: 2, hand: [], city: [], chars: ['king'], hasCrown: true }], turn: null };
  const record = recordAppliedAction(state, 'p0', { type: 'end_turn' }, () => ({ ok: true }));
  assert.deepEqual(record.beforeSummary, record.afterSummary);
  const request = JSON.parse(encodeReplayTrace(state, [record], 'summary'));
  assert.equal(request.records[0].afterSummary.players[0].gold, 2);
  assert.deepEqual(request.records[0].afterSummary, stateSummary(state));
});

test('native 回放协议校验器接受 JS 真实回放记录', async t => {
  const executable = process.env.CITADELS_NATIVE_REPLAY_VERIFY;
  if (!executable || !fs.existsSync(executable)) {
    t.skip('需要先编译 native/replay_verify.cpp 并设置 CITADELS_NATIVE_REPLAY_VERIFY');
    return;
  }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const state = Engine.createGame({ seats, seed: 37, charSetMode: 'base' });
  Engine.startGame(state);
  const initial = JSON.parse(JSON.stringify(state));
  const records = [];
  for (let i = 0; i < 8 && !state.gameOver; i++) {
    const actor = train.currentActor(state);
    const action = train.enumerateLegalActions(state, actor.id)[0];
    const record = recordAppliedAction(state, actor.id, action, Engine.applyAction);
    assert.equal(record.ok, true);
    records.push(record);
  }
  const llvmBin = 'C:\\Users\\Jiaming Qiu\\Documents\\Codex\\llvm-mingw\\llvm-mingw-20260908-ucrt-x86_64\\bin';
  const child = spawn(executable, [], {
    stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PATH: llvmBin + ';' + (process.env.PATH || '') }
  });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => {
      data += chunk;
      const line = data.split(/\r?\n/)[0];
      if (line) resolve(line);
    });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'trace-1'));
  child.stdin.end();
  const result = decodeReplayResult(await response);
  assert.equal(result.id, 'trace-1');
  assert.equal(result.ok, true);
});
