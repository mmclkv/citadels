'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const Engine = require('../src/engine.js');
const { createAgent, configFromEnv } = require('../src/agent.js');
const {
  createCodexAgentGateway,
  detectCodex,
  isLoopback,
  childEnvironment,
  parseAgentOutput
} = require('../lib/codex-agent-gateway.js');

function actor(state) {
  const step = state.draft.steps[state.draft.stepIdx];
  return state.players[step.player];
}

test('local Codex gateway completes the existing model HTTP contract', async t => {
  let receivedPrompt = '';
  const gateway = createCodexAgentGateway({
    modelName: 'codex-test',
    runner: async prompt => {
      receivedPrompt = prompt;
      const messages = JSON.parse(prompt.split('MESSAGES_JSON:\n')[1]);
      const prepared = JSON.parse(messages[1].content);
      assert(prepared.actions.length > 0);
      return { actionIndex: 0 };
    }
  });
  const server = http.createServer(async (req, res) => {
    if (!await gateway.handle(req, res)) { res.writeHead(404); res.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });

  const port = server.address().port;
  const agent = createAgent({ config: configFromEnv({
    CITADELS_AGENT_BASE_URL: 'http://127.0.0.1:' + port + '/api/codex/v1',
    CITADELS_AGENT_MODEL: 'codex-test',
    CITADELS_AGENT_TIMEOUT_MS: '1000'
  }) });
  const state = Engine.createGame({ seed: 41, seats: Array.from({ length: 4 }, (_, index) => ({
    id: 'p' + index, name: 'P' + index, isBot: true, botType: 'agent'
  })) });
  Engine.startGame(state);
  const player = actor(state);
  const result = await agent.decide(state, player.id);
  assert.equal(Engine.applyAction(state, player.id, result.action).ok, true);
  assert.match(receivedPrompt, /Do not call tools/);
  assert(!receivedPrompt.includes('CITADELS_AGENT_API_KEY'));
  const simpleBrowserPost = await fetch('http://127.0.0.1:' + port + '/api/codex/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}'
  });
  assert.equal(simpleBrowserPost.status, 415, 'simple cross-site browser posts must not trigger Codex');
});

test('gateway validates output, loopback addresses, CLI presence and child environment', () => {
  assert.deepEqual(parseAgentOutput('{"actionIndex":2,"cardUids":["a","b"]}'),
    { actionIndex: 2, cardUids: ['a', 'b'] });
  assert.throws(() => parseAgentOutput('{"actionIndex":-1}'), { code: 'invalid_response' });
  assert.throws(() => parseAgentOutput('{"actionIndex":1,"cardUids":["a","a"]}'), { code: 'invalid_response' });
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.10'), false);
  assert.equal(detectCodex(process.execPath).available, true);
  const env = childEnvironment({ PATH: 'safe-path', USERPROFILE: 'safe-home',
    CITADELS_AGENT_API_KEY: 'must-not-leak', OTHER_SECRET: 'must-not-leak' });
  assert.equal(env.PATH, 'safe-path');
  assert.equal(env.USERPROFILE, 'safe-home');
  assert.equal(env.HOME, 'safe-home');
  assert.equal(env.CODEX_HOME, require('node:path').join('safe-home', '.codex'));
  assert.equal(env.CITADELS_AGENT_API_KEY, undefined);
  assert.equal(env.OTHER_SECRET, undefined);
});
