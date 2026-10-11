'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('public/mobile.js', 'utf8');
const players = { classList: { toggle() {} }, innerHTML: '' };
const state = { phase: 'action', turn: { playerId: 'witch' }, players: [
  { id: 'witch', name: '女巫玩家', revealedCharId: 'witch', city: [] },
  { id: 'target', name: '目标玩家', revealedCharId: null, takenOverCharId: 'king', city: [] }
] };
const context = vm.createContext({
  M: { state, id: 'witch', bubbles: [] }, $: () => players,
  stageStep: () => null, legal: () => [], bubbleFor: () => null,
  role: id => ({ id, num: id === 'king' ? 4 : 1, name: id === 'king' ? '国王' : '女巫' }),
  esc: String, attr: String, score: () => ({ total: 0 }),
  coin: () => '', points: () => '', hand: () => '', mini: () => ''
});
vm.runInContext(source.slice(source.indexOf('  function orderedPlayers('),
  source.indexOf('  function renderHand(')), context);
context.renderPlayers();
const rows = players.innerHTML.split('<article').slice(1);
assert.ok(rows[1].includes('国王 · 被接管'), 'original owner keeps the role and takeover label');
assert.ok(!rows[0].includes('被接管'), 'the acting Witch is not labelled as the victim');
assert.ok(rows[1].indexOf('目标玩家') < rows[1].indexOf('国王 · 被接管'));
state.players[1].takenOverCharId = null;
state.phase = 'draft';
context.renderPlayers();
assert.ok(!players.innerHTML.includes('被接管'), 'next draft clears the label');
console.log('PASS: Witch takeover label on the original player, beside the name, and reset');
