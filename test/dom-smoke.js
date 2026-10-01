/*
 * Browser UI smoke test: single-player must create a Python-authoritative room
 * instead of instantiating the old in-browser game engine.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this._cls = ''; this.children = []; this.dataset = {};
    this._html = ''; this._text = ''; this.hidden = false;
    this.style = { setProperty() {} }; this.value = ''; this.title = '';
    this.classList = {
      add: c => { const s = new Set(this._cls.split(' ').filter(Boolean)); s.add(c); this._cls = [...s].join(' '); },
      remove: c => { const s = new Set(this._cls.split(' ').filter(Boolean)); s.delete(c); this._cls = [...s].join(' '); },
      contains: c => this._cls.split(' ').includes(c),
      toggle: (c, force) => {
        const add = force == null ? !this.classList.contains(c) : !!force;
        this.classList[add ? 'add' : 'remove'](c);
        return add;
      }
    };
  }
  get className() { return this._cls; }
  set className(v) { this._cls = v || ''; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  addEventListener() {}
  querySelectorAll() { return []; }
  setAttribute() {}
}

const registry = {};
const getEl = selector => (registry[selector] || (registry[selector] = new El('div')));
const document = {
  createElement: tag => new El(tag),
  querySelector: getEl,
  querySelectorAll: selector => selector === '.screen'
    ? ['home', 'setup', 'lobby', 'game', 'over'].map(name => getEl('#screen-' + name)) : [],
  addEventListener() {}
};
const sockets = [];
class MockWebSocket {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; }
}
const sandbox = {
  document, console, setTimeout, clearTimeout, setInterval, clearInterval,
  Math, JSON, Date, String, Number, Array, Object, Set, Map, Promise, URL,
  WebSocket: MockWebSocket, location: { protocol: 'http:', host: 'localhost:8787',
    origin: 'http://localhost:8787' },
  addEventListener() {}, confirm: () => true, alert() {}
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const file of ['src/cards.js', 'public/app.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), sandbox,
    { filename: file });
}

async function main() {
  getEl('#cfg-players').value = '4';
  getEl('#cfg-level').value = 'normal';
  getEl('#cfg-end').value = '8';
  getEl('#cfg-chars').value = 'base';
  getEl('#cfg-name').value = '测试玩家';
  getEl('#cfg-bot-type').value = 'npc-normal';
  getEl('#btn-start-single').onclick();
  assert.equal(sockets.length, 1, 'single-player should connect to the Python server');

  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  assert.equal(socket.sent[0].t, 'hello');
  socket.onmessage({ data: JSON.stringify({ t: 'hello', youId: 'client-1', resumed: false }) });
  await new Promise(resolve => setTimeout(resolve, 0));

  const create = socket.sent.find(message => message.t === 'createRoom');
  assert.ok(create, 'single-player should create a Python room');
  assert.equal(create.config.playerCount, 4);
  assert.equal(create.config.bots, 3);
  assert.equal(create.config.botType, 'npc');
  assert.equal(create.config.botLevel, 'normal');
  assert.equal(create.config.voice, false);
  assert.equal(sandbox.__CitadelsApp.mode, 'net');
  assert.equal(sandbox.__CitadelsApp.localServerGame, true);
  assert.equal(sandbox.__CitadelsApp.__local, undefined,
    'the browser-local game driver must be removed');
  console.log('✓ 单人模式已切换为 Python 权威房间，浏览器不再运行 JS 引擎/NPC。');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
