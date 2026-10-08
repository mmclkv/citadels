'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual mobile preselection functions without initializing the DOM.
const source = fs.readFileSync(path.join(__dirname, '../public/mobile.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const M = { state: {
  turn: { charId: 'blackmailer' },
  charDeck: [
    { id: 'magistrate', num: 1 }, { id: 'blackmailer', num: 2 },
    { id: 'wizard', num: 3 }, { id: 'emperor', num: 4 },
    { id: 'bishop', num: 5 }, { id: 'alchemist', num: 6 },
    { id: 'navigator', num: 7 }, { id: 'diplomat', num: 8 },
  ],
  players: [], removed: { faceUp: [] },
  effects: { assassinated: null, bewitched: 3, magistrate: { nums: [4, 5, 7] } },
} };
const context = vm.createContext({ M, Set, Number,
  STAGED_ROLES: new Set(['blackmailer']),
  role: id => M.state.charDeck.find(c => c.id === id), render: () => {},
});
vm.runInContext(extract('  function blackmailerRoles(', '  function stageTitle(') +
  extract('  function startStage(', '  function chooseStageOption('), context);
const options = () => Array.from(context.stageOptions(), x => x.value);

assert.equal(context.startStage(), true);
assert.deepEqual(options(), [6, 8], 'exclude rank 1, self, bewitched role and warrants');
M.stage.picks = [{ value: 6 }]; M.stage.step = 1;
assert.deepEqual(options(), [8], 'second mark must target a different eligible role');
M.stage.picks.push({ value: 8 }); M.stage.step = 2;
assert.deepEqual(options(), [6, 8], 'real mark must belong to the selected pair');

M.stage = null;
M.state.removed.faceUp = [{ num: 8 }];
assert.equal(context.startStage(), false, 'one target uses the direct engine ability');
assert.equal(M.stage, null, 'do not start a two-target sequence for only the alchemist');
M.state.effects.assassinated = 6;
assert.equal(context.startStage(), false, 'no targets also uses the direct engine ability');

M.state.effects = { assassinated: 4, bewitched: null, magistrate: null };
assert.equal(context.startStage(), true);
assert.deepEqual(options(), [3, 5, 6, 7], 'exclude assassinated and face-up roles');
console.log('PASS: mobile blackmailer target selection');
