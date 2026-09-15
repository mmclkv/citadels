'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');
const { recordAppliedAction } = require('../native/replay.js');
const { encodeReplayTrace } = require('../native/replay_protocol.js');

function finishDraft(state) {
  while (state.phase === 'draft') {
    const actor = train.currentActor(state);
    const action = train.enumerateLegalActions(state, actor.id)[0];
    assert.equal(Engine.applyAction(state, actor.id, action).ok, true);
  }
}

test('C++ 原生状态可以执行并比对一条 JS 基础行动', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过跨语言检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 37, charSetMode: 'base' });
  Engine.startGame(initial);
  finishDraft(initial);
  const state = JSON.parse(JSON.stringify(initial));
  const actor = train.currentActor(state);
  const action = train.enumerateLegalActions(state, actor.id).find(item => item.type === 'take_gold');
  assert.ok(action, '应找到领取金币动作');
  const record = recordAppliedAction(state, actor.id, action, Engine.applyAction);
  assert.equal(record.ok, true);
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, [record], 'action-1'));
  child.stdin.end();
  const native = await response;
  child.kill();
  assert.equal(native.ok, true, native.error || 'C++ 动作执行失败');
  assert.equal(native.phase, record.afterSummary.phase);
  assert.equal(native.round, record.afterSummary.round);
  assert.deepEqual(native.players, record.afterSummary.players.map(player => ({
    id: player.id, gold: player.gold, handCount: player.handCount,
    cityCount: player.cityCount, hasCrown: player.hasCrown, chars: player.chars
  })));
});

test('C++ 原生状态可以按顺序执行多步基础行动', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过跨语言检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 41, charSetMode: 'base' });
  Engine.startGame(initial);
  finishDraft(initial);
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (const type of ['take_gold', 'end_turn']) {
    const actor = train.currentActor(state);
    const action = train.enumerateLegalActions(state, actor.id).find(item => item.type === type);
    assert.ok(action, `应找到 ${type} 动作`);
    const record = recordAppliedAction(state, actor.id, action, Engine.applyAction);
    assert.equal(record.ok, true);
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'action-multi'));
  child.stdin.end();
  const native = await response;
  child.kill();
  const expected = records.at(-1).afterSummary;
  assert.equal(native.ok, true, native.error || 'C++ 多步动作执行失败');
  assert.equal(native.phase, expected.phase);
  assert.equal(native.round, expected.round);
  assert.deepEqual(native.players, expected.players.map(player => ({
    id: player.id, gold: player.gold, handCount: player.handCount,
    cityCount: player.cityCount, hasCrown: player.hasCrown, chars: player.chars
  })));
});

test('C++ 原生状态可以回放实验室与博物馆的指定手牌动作', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过紫色建筑回放检查'); return; }

  async function replay(initial, action) {
    const state = JSON.parse(JSON.stringify(initial));
    const actor = state.players[0].id;
    const record = recordAppliedAction(state, actor, action, Engine.applyAction);
    assert.equal(record.ok, true, `${action.type} 应由 JS 执行成功`);
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const response = new Promise((resolve, reject) => {
      let data = '';
      child.stdout.on('data', chunk => {
        data += chunk;
        const line = data.split(/\r?\n/)[0];
        if (line) resolve(JSON.parse(line));
      });
      child.on('error', reject);
    });
    child.stdin.write(encodeReplayTrace(initial, [record], `${action.type}-trace`));
    child.stdin.end();
    const native = await response;
    child.kill();
    assert.equal(native.ok, true, native.error || `${action.type} C++ 回放失败`);
    return { native, expected: record.afterSummary };
  }

  function makeInitial(effect) {
    const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
    const initial = Engine.createGame({ seats, seed: effect === 'lab' ? 107 : 109, charSetMode: 'base' });
    Engine.startGame(initial);
    initial.phase = 'action'; initial.draft = null; initial.roundConfirm = null; initial.reaction = null;
    initial.players[0].city = [{ uid: `${effect}-building`, name: effect === 'lab' ? '实验室' : '博物馆',
      color: 'purple', cost: 4, purple: { effect }, ...(effect === 'museum' ? { museum: [] } : {}) }];
    initial.turn = { charId: 'architect', num: 7, playerIdx: 0, phase: 'main', takenResources: true,
      incomeTaken: true, abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false,
      usedSmithy: false, usedMuseum: false, pending: null, bonusDone: false };
    return initial;
  }

  const labInitial = makeInitial('lab');
  const labCard = labInitial.players[0].hand[1];
  const lab = await replay(labInitial, { type: 'lab', uid: 'lab-building', discardUid: labCard.uid });
  assert.equal(lab.native.players[0].handCount, lab.expected.players[0].handCount);
  assert.equal(lab.native.players[0].gold, lab.expected.players[0].gold);

  const museumInitial = makeInitial('museum');
  const museumCard = museumInitial.players[0].hand[1];
  const museum = await replay(museumInitial, { type: 'museum', uid: 'museum-building', cardUid: museumCard.uid });
  assert.equal(museum.native.players[0].handCount, museum.expected.players[0].handCount);
  assert.equal(museum.native.players[0].cityCount, museum.expected.players[0].cityCount);
});

test('C++ 原生状态可以回放预言家逐个归还手牌', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过预言家回放检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 113, charSetMode: 'base' });
  Engine.startGame(initial);
  initial.phase = 'action'; initial.draft = null; initial.roundConfirm = null; initial.reaction = null;
  const taken1 = initial.players[1].hand[0];
  const taken2 = initial.players[2].hand[0];
  initial.players[1].hand = initial.players[1].hand.slice(1);
  initial.players[2].hand = initial.players[2].hand.slice(1);
  initial.players[0].hand.push(taken1, taken2);
  initial.turn = { charId: 'prophet', num: 2, playerIdx: 0, phase: 'main', takenResources: true,
    incomeTaken: true, abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false,
    usedSmithy: false, usedMuseum: false, pending: { kind: 'prophet_give', targetIdx: 1, queue: [1, 2] }, bonusDone: false };
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (const uid of [taken1.uid, taken2.uid]) {
    const record = recordAppliedAction(state, 'p0', { type: 'prophet_give', uid }, Engine.applyAction);
    assert.equal(record.ok, true, 'JS 应成功归还预言家抽到的手牌');
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'prophet-trace'));
  child.stdin.end();
  const native = await response; child.kill();
  const expected = records.at(-1).afterSummary;
  assert.equal(native.ok, true, native.error || 'C++ 预言家回放失败');
  assert.deepEqual(native.players.map(p => ({ id: p.id, handCount: p.handCount })),
    expected.players.map(p => ({ id: p.id, handCount: p.handCount })));
});

test('C++ 原生状态可以回放轮末确认并初始化下一轮选角', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过轮末确认回放检查'); return; }
  const seats = [0, 1].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 131, charSetMode: 'base' });
  Engine.startGame(initial);
  initial.phase = 'roundConfirm'; initial.turn = null; initial.draft = null; initial.reaction = null;
  initial.roundConfirm = { round: initial.round, confirmed: [false, false] };
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (const playerId of ['p0', 'p1']) {
    const record = recordAppliedAction(state, playerId, { type: 'confirm_round' }, Engine.applyAction);
    assert.equal(record.ok, true, 'JS 应成功确认轮末战果');
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'round-confirm-trace'));
  child.stdin.end();
  const native = await response; child.kill();
  const expected = records.at(-1).afterSummary;
  assert.equal(native.ok, true, native.error || 'C++ 轮末确认回放失败');
  assert.equal(native.phase, expected.phase);
  assert.equal(native.round, expected.round);
  assert.deepEqual(native.players.map(p => ({ id: p.id, chars: p.chars })),
    expected.players.map(p => ({ id: p.id, chars: p.chars })));
});

test('C++ 原生状态可以逐动作回放选角阶段', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过选角回放检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 73, charSetMode: 'base' });
  Engine.startGame(initial);
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (let i = 0; i < 3; i++) {
    const actor = train.currentActor(state);
    const action = train.enumerateLegalActions(state, actor.id)[0];
    assert.equal(action.type, 'draft_pick');
    const record = recordAppliedAction(state, actor.id, action, Engine.applyAction);
    assert.equal(record.ok, true);
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'draft-trace'));
  child.stdin.end();
  const native = await response;
  child.kill();
  const expected = records.at(-1).afterSummary;
  assert.equal(native.ok, true, native.error || 'C++ 选角回放失败');
  assert.equal(native.phase, expected.phase);
  assert.deepEqual(native.players.map(p => ({ id: p.id, chars: p.chars })),
    expected.players.map(p => ({ id: p.id, chars: p.chars })));
});

test('C++ 原生状态可以回放皇帝转移皇冠并拿金币', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过皇帝回放检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 79, charSetMode: 'base' });
  Engine.startGame(initial);
  initial.phase = 'action';
  initial.draft = null;
  initial.roundConfirm = null;
  initial.reaction = null;
  initial.players.forEach((player, index) => { player.hasCrown = index === 1; });
  initial.turn = { charId: 'emperor', num: 4, playerIdx: 0, phase: 'main', takenResources: true,
    incomeTaken: true, abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false,
    usedSmithy: false, usedMuseum: false, pending: { kind: 'emperor_crown' }, bonusDone: false };
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (const action of [
    { type: 'emperor_crown', target: 'p2' },
    { type: 'emperor_take', mode: 'gold' }
  ]) {
    const record = recordAppliedAction(state, 'p0', action, Engine.applyAction);
    assert.equal(record.ok, true);
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'emperor-trace'));
  child.stdin.end();
  const native = await response;
  child.kill();
  const expected = records.at(-1).afterSummary;
  assert.equal(native.ok, true, native.error || 'C++ 皇帝回放失败');
  assert.deepEqual(native.players.map(p => ({ id: p.id, gold: p.gold, hasCrown: p.hasCrown })),
    expected.players.map(p => ({ id: p.id, gold: p.gold, hasCrown: p.hasCrown })));
});

test('C++ 原生状态可以回放外交官两阶段建筑交换', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过外交官回放检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 83, charSetMode: 'base' });
  Engine.startGame(initial);
  initial.phase = 'action'; initial.draft = null; initial.roundConfirm = null; initial.reaction = null;
  initial.players[0].city = [{ uid: 'mine1', name: '小屋', color: 'red', cost: 1 }];
  initial.players[1].city = [{ uid: 'target1', name: '城堡', color: 'yellow', cost: 3 }];
  initial.turn = { charId: 'diplomat', num: 6, playerIdx: 0, phase: 'main', takenResources: true,
    incomeTaken: true, abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false,
    usedSmithy: false, usedMuseum: false, pending: { kind: 'diplomat_mine' }, bonusDone: false };
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (const action of [
    { type: 'choose_district', target: 'p0', uid: 'mine1' },
    { type: 'choose_district', target: 'p1', uid: 'target1' }
  ]) {
    const record = recordAppliedAction(state, 'p0', action, Engine.applyAction);
    assert.equal(record.ok, true);
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'diplomat-trace'));
  child.stdin.end();
  const native = await response;
  child.kill();
  const expected = records.at(-1).afterSummary;
  assert.equal(native.ok, true, native.error || 'C++ 外交官回放失败');
  assert.deepEqual(native.players.map(p => ({ id: p.id, gold: p.gold, cityCount: p.cityCount })),
    expected.players.map(p => ({ id: p.id, gold: p.gold, cityCount: p.cityCount })));
});

test('C++ 原生状态可以回放领主摧毁后的墓地响应', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过墓地回放检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 89, charSetMode: 'base' });
  Engine.startGame(initial);
  initial.phase = 'action'; initial.draft = null; initial.roundConfirm = null; initial.reaction = null;
  initial.players[1].city = [{ uid: 'target1', name: '小屋', color: 'red', cost: 1 }];
  initial.players[2].city = [{ uid: 'grave1', name: '墓地', color: 'purple', cost: 2, purple: { effect: 'graveyard' } }];
  initial.turn = { charId: 'warlord', num: 8, playerIdx: 0, phase: 'main', takenResources: true,
    incomeTaken: true, abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false,
    usedSmithy: false, usedMuseum: false, pending: { kind: 'warlord_destroy' }, bonusDone: false };
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (const action of [
    { type: 'choose_district', target: 'p1', uid: 'target1' },
    { type: 'reaction', use: false }
  ]) {
    const player = action.type === 'reaction' ? 'p2' : 'p0';
    const record = recordAppliedAction(state, player, action, Engine.applyAction);
    assert.equal(record.ok, true);
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'graveyard-trace'));
  child.stdin.end();
  const native = await response;
  child.kill();
  const expected = records.at(-1).afterSummary;
  assert.equal(native.ok, true, native.error || 'C++ 墓地回放失败');
  assert.equal(native.phase, expected.phase);
  assert.equal(native.round, expected.round);
  assert.deepEqual(native.players.map(p => ({ id: p.id, gold: p.gold, handCount: p.handCount, cityCount: p.cityCount })),
    expected.players.map(p => ({ id: p.id, gold: p.gold, handCount: p.handCount, cityCount: p.cityCount })));
});

test('C++ 原生状态可以回放航海家奖励和修士资源组合', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过角色奖励回放检查'); return; }
  async function replay(initial, actions) {
    const state = JSON.parse(JSON.stringify(initial));
    const records = [];
    for (const item of actions) {
      const record = recordAppliedAction(state, item.playerId, item.action, Engine.applyAction);
      assert.equal(record.ok, true);
      records.push(record);
    }
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const response = new Promise((resolve, reject) => {
      let data = '';
      child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
      child.on('error', reject);
    });
    child.stdin.write(encodeReplayTrace(initial, records, 'resource-trace'));
    child.stdin.end();
    const result = await response; child.kill();
    assert.equal(result.ok, true, result.error || 'C++ 角色奖励回放失败');
    return { result, expected: records.at(-1).afterSummary };
  }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const navigator = Engine.createGame({ seats, seed: 97, charSetMode: 'base' });
  Engine.startGame(navigator); navigator.phase = 'action'; navigator.draft = null; navigator.roundConfirm = null; navigator.reaction = null;
  navigator.turn = { charId: 'navigator', num: 9, playerIdx: 0, phase: 'main', takenResources: true, incomeTaken: true,
    abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: { kind: 'navigator_bonus' }, bonusDone: false };
  const nav = await replay(navigator, [{ playerId: 'p0', action: { type: 'navigator_bonus', mode: 'gold' } }]);
  assert.deepEqual(nav.result.players.map(p => ({ id: p.id, gold: p.gold })), nav.expected.players.map(p => ({ id: p.id, gold: p.gold })));

  const monk = JSON.parse(JSON.stringify(navigator));
  monk.turn.charId = 'monk'; monk.turn.pending = { kind: 'monk_declare' }; monk.players[0].city = [{ uid: 'blue1', name: '教堂', color: 'blue', cost: 2 }];
  const mon = await replay(monk, [{ playerId: 'p0', action: { type: 'monk_resource', gold: 1, cards: 0 } }]);
  assert.deepEqual(mon.result.players.map(p => ({ id: p.id, gold: p.gold, handCount: p.handCount })),
    mon.expected.players.map(p => ({ id: p.id, gold: p.gold, handCount: p.handCount })));
});

test('C++ 原生状态可以回放学者与抽牌保留选择', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过选牌回放检查'); return; }
  async function one(kind, actionType) {
    const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
    const initial = Engine.createGame({ seats, seed: kind === 'scholar_pick' ? 101 : 103, charSetMode: 'base' });
    Engine.startGame(initial); initial.phase = 'action'; initial.draft = null; initial.roundConfirm = null; initial.reaction = null;
    initial.turn = { charId: kind === 'scholar_pick' ? 'scholar' : 'architect', num: 7, playerIdx: 0, phase: 'main',
      takenResources: true, incomeTaken: true, abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false,
      usedSmithy: false, usedMuseum: false, pending: { kind, cards: [
        { uid: 'pending-a', name: '小屋', color: 'red', cost: 1 },
        { uid: 'pending-b', name: '城堡', color: 'yellow', cost: 3 }
      ] }, bonusDone: false };
    const state = JSON.parse(JSON.stringify(initial));
    const record = recordAppliedAction(state, 'p0', { type: actionType, uid: 'pending-b' }, Engine.applyAction);
    assert.equal(record.ok, true);
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const response = new Promise((resolve, reject) => {
      let data = '';
      child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
      child.on('error', reject);
    });
    child.stdin.write(encodeReplayTrace(initial, [record], kind + '-trace')); child.stdin.end();
    const native = await response; child.kill();
    assert.equal(native.ok, true, native.error || (kind + ' C++ 回放失败'));
    assert.deepEqual(native.players.map(p => ({ id: p.id, handCount: p.handCount })),
      record.afterSummary.players.map(p => ({ id: p.id, handCount: p.handCount })));
  }
  await one('scholar_pick', 'scholar_pick');
  await one('draw_keep', 'draw_keep');
});

test('C++ 原生状态可以回放魔术师弃牌重抽', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过魔术师重抽回放检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 107, charSetMode: 'base' });
  Engine.startGame(initial); initial.phase = 'action'; initial.draft = null; initial.roundConfirm = null; initial.reaction = null;
  initial.turn = { charId: 'magician', num: 3, playerIdx: 0, phase: 'main', takenResources: true, incomeTaken: true,
    abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: { kind: 'magician_redraw', selected: [] }, bonusDone: false };
  const state = JSON.parse(JSON.stringify(initial));
  const record = recordAppliedAction(state, 'p0', { type: 'choose_cards', uids: [state.players[0].hand[0].uid] }, Engine.applyAction);
  assert.equal(record.ok, true);
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, [record], 'magician-redraw-trace')); child.stdin.end();
  const native = await response; child.kill();
  assert.equal(native.ok, true, native.error || 'C++ 魔术师重抽回放失败');
  assert.deepEqual(native.players.map(p => ({ id: p.id, handCount: p.handCount })),
    record.afterSummary.players.map(p => ({ id: p.id, handCount: p.handCount })));
});

test('C++ 原生状态可以回放艺术家选择并确认美化', async t => {
  const executable = process.env.CITADELS_NATIVE_ACTION_REPLAY_PROBE;
  if (!executable) { t.skip('未设置 CITADELS_NATIVE_ACTION_REPLAY_PROBE，跳过艺术家回放检查'); return; }
  const seats = [0, 1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'neural' }));
  const initial = Engine.createGame({ seats, seed: 109, charSetMode: 'base' });
  Engine.startGame(initial); initial.phase = 'action'; initial.draft = null; initial.roundConfirm = null; initial.reaction = null;
  initial.players[0].city = [
    { uid: 'art-a', name: '小屋', color: 'red', cost: 1 },
    { uid: 'art-b', name: '教堂', color: 'blue', cost: 2 }
  ];
  initial.turn = { charId: 'artist', num: 9, playerIdx: 0, phase: 'main', takenResources: true, incomeTaken: true,
    abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: { kind: 'artist', selected: [] }, bonusDone: false };
  const state = JSON.parse(JSON.stringify(initial));
  const records = [];
  for (const action of [
    { type: 'choose_district', target: 'p0', uid: 'art-a' },
    { type: 'artist_done', uids: ['art-a'] }
  ]) {
    const record = recordAppliedAction(state, 'p0', action, Engine.applyAction);
    assert.equal(record.ok, true);
    records.push(record);
  }
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const response = new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', chunk => { data += chunk; const line = data.split(/\r?\n/)[0]; if (line) resolve(JSON.parse(line)); });
    child.on('error', reject);
  });
  child.stdin.write(encodeReplayTrace(initial, records, 'artist-trace')); child.stdin.end();
  const native = await response; child.kill();
  assert.equal(native.ok, true, native.error || 'C++ 艺术家回放失败');
  assert.deepEqual(native.players.map(p => ({ id: p.id, gold: p.gold, cityCount: p.cityCount })),
    records.at(-1).afterSummary.players.map(p => ({ id: p.id, gold: p.gold, cityCount: p.cityCount })));
});
