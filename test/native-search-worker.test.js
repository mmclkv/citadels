'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');
const { encodeSearchRequest, decodeSearchResponse } = require('../native/protocol.js');

function finishDraft(state) {
  while (state.phase === 'draft') {
    const actor = train.currentActor(state);
    const action = train.enumerateLegalActions(state, actor.id)[0];
    assert.equal(Engine.applyAction(state, actor.id, action).ok, true);
  }
}

test('原生搜索 worker 返回与 JS 合法动作对齐的策略', async t => {
  const executable = process.env.CITADELS_NATIVE_SEARCH_WORKER;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_SEARCH_WORKER，跳过原生搜索 worker 检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const state = Engine.createGame({ seats, seed: 53, charSetMode: 'base' });
  Engine.startGame(state);
  finishDraft(state);
  const actor = train.currentActor(state);
  const legal = train.enumerateLegalActions(state, actor.id);
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => {
      data += chunk;
      const line = data.split(/\r?\n/)[0];
      if (line) resolve(JSON.parse(line));
    });
    child.on('error', reject);
  });
  const request = JSON.parse(encodeSearchRequest(state, actor.id, legal, 'worker-1'));
  request.simulations = 4;
  request.maxDepth = 8;
  child.stdin.write(JSON.stringify(request) + '\n');
  child.stdin.end();
  const raw = await response;
  child.kill();
  const result = decodeSearchResponse(raw);
  assert.equal(result.id, 'worker-1');
  assert.equal(result.policy.length, legal.length);
  assert.ok(result.policy.every(value => Number.isFinite(value) && value >= 0));
});

test('原生搜索 worker 协议返回非零终局 root value', async t => {
  const executable = process.env.CITADELS_NATIVE_SEARCH_WORKER;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_SEARCH_WORKER，跳过 root value 协议检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'value-p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const state = Engine.createGame({ seats, seed: 71, charSetMode: 'base', endDistricts: 1 });
  Engine.startGame(state);
  finishDraft(state);
  const actor = train.currentActor(state);
  const actorIndex = state.players.findIndex(player => player.id === actor.id);
  const built = { ...state.players[actorIndex].hand[0], builtRound: state.round, beautified: 0, museum: [] };
  state.players[actorIndex].city.push(built);
  state.firstToFinish = actorIndex;
  const legal = train.enumerateLegalActions(state, actor.id);
  assert.ok(legal.length > 0);
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => {
      data += chunk;
      const line = data.split(/\r?\n/)[0];
      if (line) resolve(JSON.parse(line));
    });
    child.on('error', reject);
  });
  const request = JSON.parse(encodeSearchRequest(state, actor.id, legal, 'worker-value-1'));
  request.simulations = 4;
  request.maxDepth = 8;
  child.stdin.write(JSON.stringify(request) + '\n');
  child.stdin.end();
  const raw = await response;
  child.kill();
  const result = decodeSearchResponse(raw);
  assert.equal(result.id, 'worker-value-1');
  assert.equal(result.policy.length, legal.length);
  assert.ok(Number.isFinite(result.value));
  assert.ok(Math.abs(result.value) > 1e-6, `expected non-zero terminal root value, got ${result.value}`);
});
