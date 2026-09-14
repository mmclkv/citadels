'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');
const { encodeSearchRequest, decodeSearchResponse } = require('../native/protocol.js');

test('native protocol probe accepts a real JS search request', async t => {
  const executable = process.env.CITADELS_NATIVE_PROBE;
  if (!executable || !fs.existsSync(executable)) {
    t.skip('需要先编译 native/protocol_probe.cpp 并设置 CITADELS_NATIVE_PROBE');
    return;
  }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const state = Engine.createGame({ seats, seed: 19, charSetMode: 'base' });
  Engine.startGame(state);
  const actor = train.currentActor(state);
  const actions = train.enumerateLegalActions(state, actor.id);
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(line); });
    child.on('error', reject);
    child.stderr.on('data', chunk => { if (String(chunk)) {} });
  });
  child.stdin.write(encodeSearchRequest(state, actor.id, actions, 7));
  const result = decodeSearchResponse(await response);
  child.kill();
  assert.equal(result.id, '7');
  assert.equal(result.policy.length, actions.length);
  assert.ok(result.policy.every(value => value > 0));
  child.stdin.end();
});
