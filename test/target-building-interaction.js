'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = file => fs.readFileSync(require('node:path').join(__dirname, '../public', file), 'utf8');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const players = [{ id: 'me', city: [{ uid: 'a1', name: '军械库' }, { uid: 'a2', name: '军械库' }] },
  { id: 'other', name: '对手', city: [{ uid: 'c1', name: '教堂' }, { uid: 'c2', name: '要塞', fortress: true }] }];
const actions = players[0].city.flatMap(source => players[1].city.map(card =>
  // Native state_writer.hpp serializes the second card identifier as cardUid.
  ({ type: 'district_effect', name: 'armory', uid: source.uid, target: 'other', cardUid: card.uid })));
const state = () => ({ players, phase: 'action', turn: { playerId: 'me', charId: 'warlord' }, available: { actions } });

{
  const source = read('app.js'), App = { state: state(), myId: 'me' }, sent = [];
  const context = vm.createContext({ App, send: a => sent.push(a), render: () => {},
    availableMobileActions: () => App.state.available.actions });
  vm.runInContext(extract(source, '  function districtSelectMode(', '  /* ============================== 卡牌选择弹窗'), context);
  vm.runInContext(extract(source, '  function runAction(', '  function onHandClick('), context);
  vm.runInContext(extract(source, '  function mobileDistrictActionsFor(', '  function mobileHasTargetChoice('), context);
  vm.runInContext(extract(source, '  function mobileActionStillAvailable(', '  function refreshMobileDetail('), context);
  assert.equal(context.districtSelectMode(), false, 'armory targets remain inactive until activation');
  App.sel = { kind: 'armory', buildingUid: 'a2' };
  assert.equal(context.districtSelectMode(), true);
  const selected = context.districtActionFor(players[1], players[1].city[1]);
  assert.equal(selected, actions[3], 'highlighted keep targets the activated copy of armory');
  assert.equal(context.districtActionFor(players[0], players[0].city[1]), null);
  assert.equal(context.mobileDistrictActionsFor('other')[1], selected);
  assert.equal(context.mobileActionStillAvailable(selected), selected, 'preview preserves the victim as well as source');
  App.state.available.actions = actions.filter(action => action !== selected);
  assert.equal(context.mobileActionStillAvailable(selected), null, 'another victim of the same player must not replace a stale target');
  App.state.available.actions = actions;
  context.pickDistrict('other', 'c2');
  assert.equal(sent.pop(), selected);
  assert.equal(App.sel, null);
  for (const kind of ['warlord_destroy', 'marshal_seize', 'diplomat_theirs']) {
    App.state.turn.pending = { kind };
    const action = { type: 'choose_district', target: 'other', uid: 'c1' };
    App.state.available.actions = [action];
    assert.equal(context.districtSelectMode(), true);
    assert.equal(context.districtActionFor(players[1], players[1].city[0]), action);
    assert.equal(context.districtActionFor(players[1], players[1].city[1]), null);
  }
  App.state.spectating = true;
  assert.equal(context.districtSelectMode(), false);
}

{
  const source = read('mobile.js'), M = { id: 'me', state: state() }, sent = [];
  const context = vm.createContext({ M, Set, legal: () => M.state.available.actions,
    role: () => ({ num: 8 }), render: () => {}, closeSheet: () => {}, closeViewer: () => {},
    myPlayer: () => players[0], action: a => sent.push(a), message: text => { M.message = text; } });
  vm.runInContext(extract(source, '  function stageOptions(', '  function startStage('), context);
  context.stageCls = vm.runInContext('stageCls', context);
  vm.runInContext(extract(source, '  function chooseStageOption(', '  function sequenceSteps('), context);
  vm.runInContext(extract(source, '  function confirmStage(', '  const actionsClass'), context);
  vm.runInContext(extract(source, '  function handleGeneric(', '  function confirmSelection('), context);
  context.handleGeneric({ _armoryStart: true, uid: 'a2' });
  assert.equal(sent.length, 0, 'activation stays local');
  assert.equal(context.stageStep().surface, 'district', 'same board surface as warlord');
  assert.equal(context.stageOptions().length, 2, 'armory retains its legal keep target');
  assert.ok(context.stageCls('district', 'c2').includes('buildable'));
  assert.equal(context.stageCls('district', 'a2'), '');
  context.chooseStageOption(1);
  assert.equal(M.stage.ready, true);
  assert.equal(sent.length, 0, 'preview choice waits for confirmation');
  context.backStage();
  assert.equal(M.stage.ready, false);
  assert.equal(sent.length, 0);
  context.chooseStageOption(1);
  context.confirmStage();
  assert.equal(sent.pop(), actions[3]);
  assert.equal(M.stage, null);
  context.handleGeneric({ _armoryStart: true, uid: 'a1' });
  context.chooseStageOption(0);
  M.state.available.actions = [];
  context.confirmStage();
  assert.equal(sent.length, 0, 'a changed target is never submitted');
  assert.equal(M.stage.ready, false);
  context.backStage();
  assert.equal(M.stage, null, 'back cancels activation');
  for (const role of ['warlord', 'marshal', 'diplomat']) {
    M.stage = { role, step: role === 'diplomat' ? 1 : 0, picks: [], selected: new Set() };
    assert.equal(context.stageStep().surface, 'district', 'role effects share city-card picking');
  }
}
console.log('PASS: armory and role effects share board building selection, preserve targets, and support back/cancel');
