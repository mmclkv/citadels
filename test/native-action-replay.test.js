'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');
const { recordAppliedAction } = require('../native/replay.js');
const { encodeReplayTrace } = require('../native/replay_protocol.js');

function finishDraft(state) {
  while (state.phase === 'draft') {
    const actor = train.currentActor(state);
    const action = train.enumerateLegalActions(state, actor.id)[0];
    assert.equal(Engine.applyAction(state, actor.id, action).ok, true);
  }
}

test('C++ 原生状态可以执行并比对一条 JS 基础行动', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过跨语言检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 37, charSetMode: 'base' });
  Engine.startGame(initial);
  finishDraft(initial);
  const state = JSON.parse(JSON.stringify(initial));
  const actor = train.currentActor(state);
  const action = train.enumerateLegalActions(state, actor.id).find(item => item.type === 'take_gold');
  assert.ok(action, '应找到领取金币动作');
  const record = recordAppliedAction(state, actor.id, action, Engine.applyAction);
  assert.equal(record.ok, true);
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, [record], 'action-1'));
  child.stdin.end();
  const native = await response;
  child.kill();
  assert.equal(native.ok, true, native.error || 'C++ 动作执行失败');
  assert.equal(native.phase, record.afterSummary.phase);
  assert.equal(native.round, record.afterSummary.round);
  assert.deepEqual(native.players, record.afterSummary.players.map(player => ({
    id: player.id, gold: player.gold, handCount: player.handCount,
    cityCount: player.cityCount, hasCrown: player.hasCrown, chars: player.chars
  })));
});

test('C++ 原生状态可以按顺序执行多步基础行动', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过跨语言检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 41, charSetMode: 'base' });
  Engine.startGame(initial);
  finishDraft(initial);
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (const type of ['take_gold', 'end_turn']) {
    const actor = train.currentActor(state);
    const action = train.enumerateLegalActions(state, actor.id).find(item => item.type === type);
    assert.ok(action, `应找到 ${type} 动作`);
    const record = recordAppliedAction(state, actor.id, action, Engine.applyAction);
    assert.equal(record.ok, true);
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'action-multi'));
  child.stdin.end();
  const native = await response;
  child.kill();
  const expected = records.at(-1).afterSummary;
  assert.equal(native.ok, true, native.error || 'C++ 多步动作执行失败');
  assert.equal(native.phase, expected.phase);
  assert.equal(native.round, expected.round);
  assert.deepEqual(native.players, expected.players.map(player => ({
    id: player.id, gold: player.gold, handCount: player.handCount,
    cityCount: player.cityCount, hasCrown: player.hasCrown, chars: player.chars
  })));
});

test('C++ 原生状态可以逐动作回放选角阶段', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过选角回放检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 73, charSetMode: 'base' });
  Engine.startGame(initial);
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (let i = 0; i < 3; i++) {
    const actor = train.currentActor(state);
    const action = train.enumerateLegalActions(state, actor.id)[0];
    assert.equal(action.type, 'draft_pick');
    const record = recordAppliedAction(state, actor.id, action, Engine.applyAction);
    assert.equal(record.ok, true);
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'draft-trace'));
  child.stdin.end();
  const native = await response;
  child.kill();
  const expected = records.at(-1).afterSummary;
  assert.equal(native.ok, true, native.error || 'C++ 选角回放失败');
  assert.equal(native.phase, expected.phase);
  assert.deepEqual(native.players.map(p => ({ id: p.id, chars: p.chars })),
    expected.players.map(p => ({ id: p.id, chars: p.chars })));
});

test('C++ 原生状态可以回放皇帝转移皇冠并拿金币', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过皇帝回放检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 79, charSetMode: 'base' });
  Engine.startGame(initial);
  initial.phase = 'action';
  initial.draft = null;
  initial.roundConfirm = null;
  initial.reaction = null;
  initial.players.forEach((player, index) => { player.hasCrown = index === 1; });
  initial.turn = { charId: 'emperor', num: 4, playerIdx: 0, phase: 'main', takenResources: true,
    incomeTaken: true, abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false,
    usedSmithy: false, usedMuseum: false, pending: { kind: 'emperor_crown' }, bonusDone: false };
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (const action of [
    { type: 'emperor_crown', target: 'p2' },
    { type: 'emperor_take', mode: 'gold' }
  ]) {
    const record = recordAppliedAction(state, 'p0', action, Engine.applyAction);
    assert.equal(record.ok, true);
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'emperor-trace'));
  child.stdin.end();
  const native = await response;
  child.kill();
  const expected = records.at(-1).afterSummary;
  assert.equal(native.ok, true, native.error || 'C++ 皇帝回放失败');
  assert.deepEqual(native.players.map(p => ({ id: p.id, gold: p.gold, hasCrown: p.hasCrown })),
    expected.players.map(p => ({ id: p.id, gold: p.gold, hasCrown: p.hasCrown })));
});
