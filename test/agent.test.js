'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const Engine = require('../src/engine.js');
const { createAgent, configFromEnv, prepareDecision, resolveDecision } = require('../src/agent.js');
const { createBotDriver } = require('../lib/bot-driver.js');

const wait = ms => new Promise(r => setTimeout(r, ms));
const clone = x => JSON.parse(JSON.stringify(x));
function state() {
  const st = Engine.createGame({ seed: 73, seats: Array.from({ length: 4 }, (_, i) => ({
    id: 'p' + i, name: 'P' + i, isBot: true, botType: 'agent'
  })) });
  Engine.startGame(st);
  return st;
}
const actor = st => st.phase === 'draft' ? st.players[st.draft.steps[st.draft.stepIdx].player] :
  st.reaction ? st.players[st.reaction.playerIdx] : st.roundConfirm ?
  st.players[st.roundConfirm.confirmed.findIndex(x => !x)] : st.turn && st.players[st.turn.playerIdx];

test('actual HTTP request waits for model, follows its choice and masks hidden information', async t => {
  const st = state(), id = actor(st).id, before = clone(st);
  let body, authorization, release;
  const gate = new Promise(r => { release = r; });
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    authorization = req.headers.authorization;
    let raw = ''; for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
    await gate;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"actionIndex":1}' } }] }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const agent = createAgent({ config: configFromEnv({ CITADELS_AGENT_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1',
    CITADELS_AGENT_MODEL: 'mock-model', CITADELS_AGENT_API_KEY: 'test-only-key' }) });
  let done = false;
  const pending = agent.decide(st, id).then(result => { done = true; return result; });
  for (let i = 0; !body && i < 100; i++) await wait(10);
  assert(body);
  assert.equal(done, false, 'must not execute a heuristic action while waiting');
  assert.equal(authorization, 'Bearer test-only-key');
  assert.equal(body.model, 'mock-model');
  const input = JSON.parse(body.messages[1].content);
  assert(!('deck' in input.observation));
  assert(!('rngState' in input.observation));
  for (const p of input.observation.players.filter(p => p.id !== id)) {
    assert.equal(p.hand, undefined); assert.deepEqual(p.chars, []);
  }
  assert(!JSON.stringify(input).includes('test-only-key'));
  release();
  const result = await pending;
  assert.deepEqual(result.action, input.actions[1]);
  assert.deepEqual(st, before, 'decision cannot mutate real state');
  assert.equal(Engine.applyAction(st, id, result.action).ok, true);
});

test('missing config, auth failure, malformed and illegal model output never fall back', async () => {
  const st = state(), id = actor(st).id;
  await assert.rejects(createAgent({ config: configFromEnv({}) }).decide(st, id), { code: 'not_configured' });
  const config = { configured: true, endpoint: 'http://mock', model: 'mock', timeoutMs: 1000 };
  for (const [content, code] of [['bad-json', 'invalid_response'], ['{"actionIndex":9999}', 'invalid_action'],
    ['{"actionIndex":0,"cardUids":["other-player-secret"]}', 'invalid_action']]) {
    const agent = createAgent({ config, fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }) });
    await assert.rejects(agent.decide(st, id), { code });
  }
  const denied = createAgent({ config, fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(denied.decide(st, id), { code: 'http_error', message: '模型服务返回 HTTP 401' });
  const stalled = createAgent({ config: { ...config, timeoutMs: 20 }, fetchImpl: (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })) });
  await assert.rejects(stalled.decide(st, id), { code: 'timeout' });
});

test('hand subset decisions validate ownership and reject duplicates', () => {
  const st = state();
  while (st.phase === 'draft') {
    const id = actor(st).id;
    Engine.applyAction(st, id, Engine.getAvailableActions(st, id).actions[0]);
  }
  const id = actor(st).id, p = st.players.find(p => p.id === id);
  st.turn.pending = { kind: 'magician_redraw' };
  const input = prepareDecision(st, id);
  const uid = p.hand[0].uid;
  assert.deepEqual(resolveDecision(input, { actionIndex: 0, cardUids: [uid] }, st, id).uids, [uid]);
  assert.throws(() => resolveDecision(input, { actionIndex: 0, cardUids: [uid, uid] }, st, id), { code: 'invalid_action' });
  assert.throws(() => resolveDecision(input, { actionIndex: 0, cardUids: ['missing'] }, st, id), { code: 'invalid_action' });
});

test('room driver serializes requests, discards restart answers, and pauses on model error', async () => {
  let calls = 0, release;
  const st = state();
  const r = { state: st, config: { botPace: 1 } };
  const agent = { status: () => ({ model: 'test' }), decide: () => {
    calls++; return new Promise(resolve => { release = resolve; });
  } };
  const driver = createBotDriver({ Engine, AI: { decide() { throw new Error('must not use heuristic'); } },
    agent, currentActor: actor, send() {}, delay: () => 10000 });
  driver.tick(r); driver.tick(r);
  await wait(20);
  assert.equal(calls, 1); assert.equal(r.agentStatus.state, 'thinking');
  const old = clone(st), action = Engine.getAvailableActions(st, actor(st).id).actions[0];
  driver.cancel(r); r.state = null;
  release({ action, model: 'test' });
  await wait(20); assert.deepEqual(st, old);
  r.state = state();
  agent.decide = async () => { throw Object.assign(new Error('模型超时'), { code: 'timeout' }); };
  driver.tick(r); await wait(20);
  assert.equal(r.agentStatus.state, 'error'); assert.equal(r.botJob, null);
  const errorState = clone(r.state);
  driver.tick(r); await wait(20); assert.deepEqual(r.state, errorState);
  driver.cancel(r);
});

test('Agent candidate path completes full games across all character sets', async () => {
  const agent = createAgent({ config: { configured: true, endpoint: 'http://mock', model: 'mock', timeoutMs: 1000 },
    fetchImpl: async (_url, request) => {
      const input = JSON.parse(JSON.parse(request.body).messages[1].content);
      const weights = { draft_pick: 1, draft_discard: 1, build: 10, income: 8, take_gold: 7, take_cards: 6,
        end_turn: 4, artist_done: 12, ability: 0 };
      const me = input.observation.players.find(p => p.id === input.observation.you);
      // The fake model must replenish usable hand cards, otherwise it can choose
      // gold forever even though every returned action remains perfectly legal.
      if (!me.hand.some(c => !me.city.some(d => d.name === c.name))) weights.take_cards = 9;
      const index = input.actions.reduce((best, a, i, arr) => (weights[a.type] || 0) > (weights[arr[best].type] || 0) ? i : best, 0);
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ actionIndex: index }) } }] }) };
    } });
  for (const n of [2, 4, 6, 8]) for (const charSetMode of ['base', 'dark', 'mixed']) {
    const st = Engine.createGame({ seed: 400 + n, charSetMode, endDistricts: 7,
      seats: Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'agent' })) });
    Engine.startGame(st);
    let step = 0;
    while (st.phase !== 'gameover' && step++ < 4000) {
      const p = actor(st); assert(p);
      const { action } = await agent.decide(st, p.id);
      assert.equal(Engine.applyAction(st, p.id, action).ok, true);
    }
    assert.equal(st.phase, 'gameover', n + '/' + charSetMode);
  }
});
