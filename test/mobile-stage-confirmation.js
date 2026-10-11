'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/mobile.js'), 'utf8');
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const M = { id: 'me', state: { turn: { charId: 'spy' }, players: [
  { id: 'me', name: '我', hand: [], city: [] },
  { id: 'other', name: '对手', handCount: 3, city: [] },
], available: { actions: [] } } };
const nodes = new Map();
const context = vm.createContext({ M, Set,
  $: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
  CN: { yellow: '贵族', blue: '宗教', green: '商业', red: '军事', purple: '特殊' },
  role: () => ({ num: 2 }), legal: () => [], choiceItems: () => null,
  myPlayer: () => M.state.players[0], esc: text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
  closeSheet: () => {}, closeViewer: () => {}, render: () => {},
});
vm.runInContext(extract('  const COLORS=', '  function startStage('), context);
vm.runInContext(extract('  function chooseStageOption(', '  function matchStep('), context);
vm.runInContext(extract('  const actionsClass', '  function renderLighthousePicker('), context);

function start(role) {
  M.stage = { role, step: 0, picks: [], selected: new Set(), ready: false };
}
function footer() {
  context.renderFooter();
  return nodes.get('actions').innerHTML;
}

start('spy');
context.chooseStageOption(0);
assert.equal((footer().match(/data-stage-option=/g) || []).length, 5, 'show all colors before choosing');
context.chooseStageOption(2);
const confirmation = footer();
assert.equal(M.stage.ready, true);
assert.ok(confirmation.includes('对手') && confirmation.includes('商业'), 'show the selected player and color');
assert.ok(!confirmation.includes('data-stage-option'), 'remove all selectable color buttons at confirmation');
assert.ok(!confirmation.includes('军事'), 'hide unselected colors');
assert.equal((confirmation.match(/<button /g) || []).length, 2, 'only confirm and back remain');
assert.ok(confirmation.indexOf('stage-selection') < confirmation.indexOf('stageConfirm') &&
  confirmation.indexOf('stageConfirm') < confirmation.indexOf('stageBack'), 'selection is left of confirm and back');
assert.equal(context.stageStep().options.length, 0, 'confirmation removes board selection affordances too');
context.chooseStageOption(0);
assert.equal(M.stage.picks[1].value, 'green', 'confirmation cannot silently change the choice');
assert.deepEqual(JSON.parse(JSON.stringify(context.sequenceSteps(M.stage))), [
  { type: 'ability' }, { type: 'spy_target', target: 'other' }, { type: 'spy_color', color: 'green' },
]);
context.backStage();
assert.equal(M.stage.ready, false);
assert.equal(M.stage.picks.length, 1, 'back keeps the earlier player selection');
assert.equal((footer().match(/data-stage-option=/g) || []).length, 5, 'back restores the full color picker');
context.chooseStageOption(3);
assert.equal(M.stage.picks[1].value, 'red', 'a different color can be selected after back');

start('navigator');
context.chooseStageOption(1);
assert.ok(footer().includes('额外抽取 4 张建筑牌'));
assert.ok(!footer().includes('额外获得 4 金币'), 'shared confirmation hides navigator alternatives');
context.backStage();
assert.equal((footer().match(/data-stage-option=/g) || []).length, 2);

start('artist');
assert.ok(footer().includes('stageConfirm'), 'multi-selection can still confirm an empty selection');
assert.ok(!nodes.get('actions').className.includes('stage-confirmation'), 'multi-selection retains its editable workflow');
console.log('PASS: mobile ability confirmation shows only selected choices and supports back/reselection');
