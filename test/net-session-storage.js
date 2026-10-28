'use strict';
// Exercise the lobby's real storage helpers without a browser or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/components/citadels-lobby.js'), 'utf8');
const helpers = source.slice(source.indexOf('      function loadNetSession()'),
  source.indexOf('      function loadNetName()'));
assert.ok(helpers.includes('function loadPlayerSession('), 'Storage helpers must be found');
const items = new Map();
let server = 'http://server-a.example:28288';
const context = vm.createContext({
  NET_SESSION_KEY: 'citadels.net.session',
  NET_PLAYER_SESSIONS_KEY: 'citadels.net.playerSessions',
  gameServerBase: () => server,
  window: { localStorage: {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
    removeItem: key => items.delete(key)
  } }
});
vm.runInContext(helpers, context);
const run = code => vm.runInContext(code, context);
run("saveNetSession('player-a', 'ABCD', 'Alice', false)");
run("saveNetSession('spectator-a', 'ABCD', 'Alice', true)");
assert.equal(run('loadNetSession().token'), 'spectator-a');
assert.equal(run("loadPlayerSession('ABCD').token"), 'player-a', 'Watching must preserve the original seat');
run('clearNetSession()');
assert.equal(run("loadPlayerSession('ABCD').token"), 'player-a', 'Menu navigation must preserve recovery');
run("saveNetSession('player-other-room', 'EFGH', 'Alice', false)");
assert.equal(run("loadPlayerSession('ABCD').token"), 'player-a', 'Other rooms must preserve recovery');
server = 'http://server-b.example:28288';
assert.equal(run("loadPlayerSession('ABCD')"), null, 'Credentials must be scoped to the server');
run("saveNetSession('player-b', 'ABCD', 'Alice', false)");
server = 'http://server-a.example:28288';
assert.equal(run("loadPlayerSession('ABCD').token"), 'player-a');
run("forgetPlayerSession('ABCD')");
run('clearNetSession()');
assert.equal(run("loadPlayerSession('ABCD')"), null, 'Explicit lobby departure must forget the released seat');
items.set('citadels.net.playerSessions', '{invalid');
run("saveNetSession('fresh', 'JKLM', 'Alice', false)");
assert.equal(run("loadPlayerSession('JKLM').token"), 'fresh', 'Corrupt history must not prevent saving new credentials');
items.clear();
items.set('citadels.net.session', JSON.stringify({token:'legacy', roomId:'ABCD', server}));
assert.equal(run("loadPlayerSession('ABCD').token"), 'legacy', 'Existing player sessions must still work');
console.log('PASS: player recovery survives watching, menu navigation and other rooms; server scoping and legacy sessions work');
