'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const hand = [{ uid: 'h1', name: '酒馆' }, { uid: 'h2', name: '城堡' }, { uid: 'n1', name: '大墓园' }];
const city = [{ uid: 'l1', name: '实验室' }, { uid: 'm1', name: '博物馆' },
  { uid: 'f1', name: '脚手架' }, { uid: 'c1', name: '教堂' }];
const actions = hand.slice(0, 2).flatMap(card => [
  { type: 'lab', uid: 'l1', discardUid: card.uid },
  { type: 'museum', uid: 'm1', cardUid: card.uid },
  { type: 'district_effect', name: 'framework', uid: 'f1', secondaryUid: card.uid }
]).concat(city.slice(0, 2).map(card => ({ type: 'district_effect', name: 'necropolis',
  uid: card.uid, secondaryUid: 'n1' })), [
  { type: 'district_effect', name: 'thieves_begin', uid: 't1' },
  { type: 'end_turn', label: '结束回合' }
]);

for (const mobile of [false, true]) {
  const source = fs.readFileSync(path.join(__dirname, '../public', mobile ? 'mobile.js' : 'app.js'), 'utf8');
  const boxes = {};
  const $ = id => boxes[id] || (boxes[id] = { children: [], textContent: '',
    appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; },
    set innerHTML(value) { this.html = value; this.children = []; }, get innerHTML() { return this.html || ''; } });
  const model = { id: 'me', myId: 'me', state: { phase: 'action', players: [{ id: 'me', hand, city }],
    turn: { playerId: 'me' }, available: { actions } } };
  const sent = [];
  const context = vm.createContext({ App: model, M: model, $, Set, Map,
    legal: () => model.state.available.actions.filter(a => !a.disabled),
    myPlayer: () => model.state.players[0], choiceItems: () => null, renderAgentStatus: () => false,
    isMobileGameUI: () => false, districtSelectMode: () => false, escapeHtml: String, esc: String,
    el: (tag, cls, label) => ({ label }), onTap: (node, click) => { node.click = click; },
    actionBtn: a => ({ label: a.label, action: a }), actionsClass: String,
    render: () => draw(), send: a => sent.push(a), action: a => { sent.push(a); model.districtPick = null; }
  });
  vm.runInContext(extract(source, '  function ownDistrictEffectGroups(',
    mobile ? '  function renderLighthousePicker(' : '  function appendTargetActionButtons('), context);
  if (mobile) vm.runInContext(extract(source, '  function handleGeneric(', '  function confirmSelection('), context);
  const draw = () => mobile ? context.renderFooter() : context.renderActions(model.state);
  const groups = context.ownDistrictEffectGroups(actions, model.state.players[0]);
  assert.equal(groups.length, 4);
  for (const group of groups) {
    draw();
    assert.equal(sent.length, 0, 'rendering never submits an effect');
    if (mobile) {
      assert.equal(model.actions.filter(a => a._districtStart).length, 4);
      assert.ok(!model.actions.some(a => a.type === 'museum' || a.type === 'lab' || a.name === 'framework' || a.name === 'necropolis'));
      context.handleGeneric(model.actions.find(a => a._districtStart === group.key));
    } else {
      assert.equal($('#actions').children.filter(b => b.label === group.label).length, 1);
      assert.ok(!$('#actions').children.some(b => b.action?.type === 'museum' || b.action?.name === 'necropolis'));
      $('#actions').children.find(b => b.label === group.label).click();
    }
    assert.equal(sent.length, 0, 'activation only opens the selection interface');
    const prompt = mobile ? $('selectedInfo').textContent : $('#prompt').textContent;
    assert.ok(prompt.includes(group.hint));
    assert.equal(group.choices.length, 2);
    assert.ok(group.choices.every(choice => choice.card), 'each action resolves the correct hand/city card');
    if (mobile) {
      assert.equal(model.actions.length, 2);
      assert.ok($('actions').innerHTML.includes('取消发动'));
      assert.ok(model.actions.every(a => a.label.startsWith('选择『')));
      // Exercise the real delegated handlers without unrelated page events.
      let click;
      context.document = { addEventListener: (_, handler) => { click = handler; } };
      vm.runInContext(extract(source, "  document.addEventListener('click',e=>{", '    const fold=') + '\n  });', context);
      click({ target: { id: 'districtPickCancel' } });
      assert.equal(model.districtPick, null);
      assert.equal(sent.length, 0);
      context.handleGeneric(model.actions.find(a => a._districtStart === group.key));
      click({ target: { id: '', closest: selector => selector === '[data-district-choice]' ? { dataset: { districtChoice: '1' } } : null } });
    } else {
      assert.equal($('#actions').children.length, 3);
      $('#actions').children[2].click();
      assert.equal(model.sel, null);
      assert.equal(sent.length, 0);
      $('#actions').children.find(b => b.label === group.label).click();
      $('#actions').children[1].click();
    }
    assert.equal(sent.pop(), group.choices[1].action, 'the selected native action is submitted unchanged');
  }
  draw();
  if (mobile) assert.ok(model.actions.some(a => a.label === '发动盗贼巢穴效果'));
  else assert.ok($('#actions').children.some(b => b.label === '发动盗贼巢穴效果'));
  model.sel = { kind: 'districtpick', key: 'museum:m1' };
  model.districtPick = 'museum:m1';
  model.state.available.actions = [{ type: 'end_turn', label: '结束回合' }];
  draw();
  assert.equal(mobile ? model.districtPick : model.sel, null, 'stale choices close when legal actions change');
  assert.equal(context.ownDistrictEffectGroups([{ ...actions[0], disabled: true }], model.state.players[0]).length, 0);
  const copies = context.ownDistrictEffectGroups([
    { type: 'museum', uid: 'm1', cardUid: 'h1' },
    { type: 'museum', uid: 'm2', cardUid: 'h2' }
  ], model.state.players[0]);
  assert.equal(copies.length, 2, 'separate copies retain their own effect actions');
  assert.equal(copies[1].choices[0].action.uid, 'm2');
  model.state.turn.pending = { kind: 'thieves_den' };
  model.state.available.actions = [
    { type: 'district_effect', name: 'thieves_discard', uid: 'h1', label: '用酒馆抵扣1金币' },
    { type: 'district_effect', name: 'thieves_pay', uid: 't1', label: '确认支付并建造盗贼巢穴' },
    { type: 'district_effect', name: 'thieves_cancel', label: '取消建造' }
  ];
  draw();
  const choices = mobile ? model.actions : $('#actions').children.map(b => b.action);
  assert.ok(choices.some(a => a.name === 'thieves_discard'), 'activated thieves den exposes discard choices');
  assert.ok(choices.some(a => a.name === 'thieves_cancel'), 'thieves payment keeps its native cancellation');
}
console.log('PASS: desktop/mobile unique buildings activate before choosing, cancel safely, and submit exact legal actions');
