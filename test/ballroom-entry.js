'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const thanks = { type: 'district_effect', name: 'ballroom_thanks', label: '舞厅：向皇冠持有者致谢，继续回合' };
const skip = { type: 'district_effect', name: 'ballroom_skip', label: '舞厅：不致谢，跳过本回合' };
const ballroom = { uid: 'crown-ballroom', name: '舞厅', color: 'purple', cost: 6, purpleEffect: 'ballroom' };
const other = { ...ballroom, uid: 'other-ballroom' };
const state = {
  phase: 'action', turn: { playerId: 'me', pending: { kind: 'ballroom' } },
  players: [{ id: 'king', hasCrown: true, city: [ballroom] }, { id: 'other', city: [other] }, { id: 'me', city: [] }],
  available: { prompt: '舞厅：向皇冠持有者致谢才能继续回合', actions: [thanks, skip] }
};
const element = () => ({ children: [], style: {}, classList: { add() {} },
  appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });

for (const mobile of [false, true]) {
  const source = read(mobile ? 'mobile.js' : 'app.js');
  const boxes = {};
  const $ = id => boxes[id] || (boxes[id] = element());
  const model = { state: structuredClone(state), ...(mobile ? { id: 'me' } : { myId: 'me' }) };
  const sent = [];
  const context = vm.createContext({ [mobile ? 'M' : 'App']: model, $, Set, Map,
    legal: () => model.state.spectating ? [] : model.state.available.actions.filter(a => !a.disabled),
    availableMobileActions: () => model.state.available.actions,
    esc: String, escapeHtml: String, choiceItems: () => null, actionsClass: n => 'count-' + n,
    renderAgentStatus: () => false, districtSelectMode: () => false, isMobileGameUI: () => false,
    actionBtn: a => ({ action: a }), el: () => element(),
    onTap: (node, callback) => { node.click = callback; }, districtCardAsset: () => 'ballroom.jpg',
    closeModal: () => { $('#modal').hidden = true; }, send: a => sent.push(a),
    window: { CitadelMobileTheme: { cardAsset: () => 'ballroom.jpg' } },
    districtImg: () => 'ballroom.jpg', artSrc: String, C: { purple: 'purple' }, CN: { purple: '独特' }
  });
  vm.runInContext(extract(source, '  function ballroomThanksFor(', mobile ? '  const mini =' : '  function mobilePlayerActionsFor('), context);
  assert.equal(context.ballroomThanksFor(ballroom), model.state.available.actions[0]);
  assert.equal(context.ballroomThanksFor(other), null, 'another player’s ballroom does not offer thanks');
  assert.equal(context.ballroomThanksFor({ ...ballroom, uid: undefined }), null, 'reference cards do not offer thanks');
  assert.equal(context.ballroomThanksFor(ballroom, 'other'), null, 'the owner must match');
  model.state.spectating = true;
  assert.equal(context.ballroomThanksFor(ballroom), null);
  model.state.spectating = false;
  vm.runInContext(extract(source, mobile ? '  function renderFooter(' : '  function renderActions(',
    mobile ? '  function renderLighthousePicker(' : '  function appendTargetActionButtons('), context);
  if (mobile) {
    context.renderFooter();
    assert.equal(model.actions.length, 1);
    assert.equal(model.actions[0].name, 'ballroom_skip');
    assert.ok(!$('actions').innerHTML.includes('致谢'));
    assert.ok(!$('selectedInfo').textContent.includes('舞厅'));
    vm.runInContext(extract(source, '  function openViewer(', '  function closeViewer('), context);
    context.openViewer('district', other);
    assert.ok(!$('viewerActions').innerHTML.includes('viewerConfirm'));
    context.openViewer('district', ballroom);
    assert.ok($('viewerActions').innerHTML.includes('>致谢</button>'));
    model.state.available.actions = [];
    context.openViewer('district', ballroom, model.viewer.confirm);
    assert.ok(!$('viewerActions').innerHTML.includes('viewerConfirm'), 'stale thanks disappears');
  } else {
    context.renderActions(model.state);
    assert.equal($('#actions').children.length, 1);
    assert.equal($('#actions').children[0].action.name, 'ballroom_skip');
    assert.equal($('#actions').children[0].action.label, '跳过本回合');
    assert.equal($('#prompt').innerHTML, '请选择行动');
    context.openBallroom(ballroom, 'king');
    assert.equal($('#modal').hidden, false);
    const button = $('#modal-body').children[1];
    button.click();
    assert.equal(sent[0], model.state.available.actions[0]);
    model.state.available.actions = [];
    button.click();
    assert.equal(sent.length, 1, 'stale dialog cannot submit thanks');
  }
}
console.log('PASS: ballroom thanks appears only after opening the crown holder’s building');
