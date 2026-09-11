'use strict';
const { fork } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await wait(10); }
  throw new Error('Timed out: ' + label);
}
async function fixture(configured = true) {
  const requests = [];
  const mock = { mode: 'ok', delay: 0, requests };
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const input = JSON.parse(body.messages[1].content);
    requests.push({ body, input });
    const mode = mock.mode;
    await wait(mock.delay);
    if (res.destroyed) return;
    res.setHeader('Content-Type', 'application/json');
    if (mode === 'error') { res.writeHead(401); res.end('private upstream diagnostic'); return; }
    const actionIndex = mode === 'invalid' ? 99999 : Math.min(1, input.actions.length - 1);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ actionIndex }) } }] }));
  }).listen(0, '127.0.0.1');
  await once(model, 'listening');
  const child = fork(path.join(__dirname, '..', 'server.js'), ['0'], {
    cwd: path.join(__dirname, '..'), silent: true,
    env: { ...process.env, CITADELS_AGENT_BASE_URL: 'http://127.0.0.1:' + model.address().port + '/v1',
      CITADELS_AGENT_MODEL: configured ? 'smoke-test-model' : '', CITADELS_AGENT_API_KEY: 'mock-only-secret', CITADELS_AGENT_TIMEOUT_MS: '1000' }
  });
  let port, output = '';
  child.on('message', m => { if (m.type === 'listening') port = m.port; });
  child.stdout.on('data', s => { output += s; }); child.stderr.on('data', s => { output += s; });
  const close = async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    model.closeAllConnections(); await new Promise(r => model.close(r));
  };
  try { await until(() => port || (child.exitCode !== null && Promise.reject(new Error(output))), 'server startup'); }
  catch (e) { await close(); throw e; }
  return { base: 'http://127.0.0.1:' + port, mock, close, output: () => output };
}
async function connect(base, name) {
  const ws = new WebSocket(base.replace(/^http/, 'ws'));
  const c = { ws, messages: [], state: null, id: null, token: null,
    send: msg => ws.send(JSON.stringify(msg)) };
  ws.onmessage = event => {
    const m = JSON.parse(event.data); c.messages.push(m);
    if (m.t === 'joined') { c.id = m.youId; c.token = m.resumeToken; c.state = m.state; }
    if (m.t === 'state') c.state = m.state;
  };
  await once(ws, 'open'); c.send({ t: 'hello', name });
  const timer = setInterval(() => { if (ws.readyState === 1) c.send({ t: 'heartbeat' }); }, 2000);
  c.close = () => { clearInterval(timer); ws.close(); };
  return c;
}
module.exports = { fixture, connect, until, wait };
