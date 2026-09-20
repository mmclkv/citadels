const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');

test('原生状态可编码为固定长度网络特征', () => {
  const exe = process.env.CITADELS_NATIVE_STATE_FEATURES_PROBE;
  if (!exe) return;
  const [size, players, p0Gold, p1Active] = execFileSync(exe, { encoding: 'utf8' })
    .trim().split(',').map(Number);
  assert.equal(size, 52);
  assert.ok(Math.abs(players - 2 / 6) < 1e-5);
  assert.equal(p0Gold, 0.25);
  assert.equal(p1Active, 1);
});

function seats(count) {
  return Array.from({ length: count }, (_, i) => ({ id: 'feature-p' + i, name: 'P' + i, isBot: i % 2 === 0 }));
}

function finishDraft(state) {
  while (state.phase === 'draft') {
    const actor = train.currentActor(state);
    const action = train.enumerateLegalActions(state, actor.id)[0];
    assert.equal(Engine.applyAction(state, actor.id, action).ok, true);
  }
}

test('JS/C++ 状态编码 v6 在 4/5/6 人、阶段、隐藏信息和 pending 上逐维一致', t => {
  const exe = process.env.CITADELS_NATIVE_STATE_ENCODING_PROBE;
  if (!exe) { t.skip('未设置 CITADELS_NATIVE_STATE_ENCODING_PROBE，跳过跨语言状态编码检查'); return; }
  for (const count of [4, 5, 6]) {
    const state = Engine.createGame({ seats: seats(count), seed: 8000 + count, charSetMode: 'mixed' });
    const cases = [];
    cases.push(['lobby', JSON.parse(JSON.stringify(state))]);
    Engine.startGame(state);
    cases.push(['draft', JSON.parse(JSON.stringify(state))]);
    finishDraft(state);
    cases.push(['action', JSON.parse(JSON.stringify(state))]);
    const reaction = JSON.parse(JSON.stringify(state));
    reaction.phase = 'reaction'; reaction.turn = null;
    reaction.reaction = { kind: 'graveyard', playerIdx: 1, queue: [1], prompt: '' };
    cases.push(['reaction', reaction]);
    const gameover = JSON.parse(JSON.stringify(state));
    gameover.phase = 'gameover';
    cases.push(['gameover', gameover]);
    const pending = JSON.parse(JSON.stringify(state));
    const actor = pending.turn.playerIdx;
    pending.turn.pending = {
      kind: 'draw_keep', targetIdx: actor, _fromCrownIdx: 0,
      prompt: 'choose', cards: pending.deck.slice(0, 2)
    };
    cases.push(['pending', pending]);
    for (const [label, snapshot] of cases) {
      const perspective = Math.min(2, count - 1);
      const view = Engine.sanitize(snapshot, snapshot.players[perspective].id);
      const expected = Array.from(train.encodeState(view, view.players[perspective].id).vector);
      const actual = execFileSync(exe, [String(perspective)], {
        input: JSON.stringify(snapshot) + '\n', encoding: 'utf8'
      }).trim().split(',').map(Number);
      assert.equal(actual.length, expected.length, `${count}/${label} length`);
      for (let i = 0; i < expected.length; i++) {
        assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6,
          `${count}/${label}/${i}: native=${actual[i]} js=${expected[i]}`);
      }
    }
  }
  const state = Engine.createGame({ seats: seats(4), seed: 9917, charSetMode: 'mixed' });
  Engine.startGame(state);
  finishDraft(state);
  const darkRoles = ['magistrate', 'spy', 'blackmailer', 'wizard', 'abbot', 'tax_collector'];
  const darkPending = ['magistrate_declare', 'magistrate_second', 'magistrate_third', 'blackmailer_declare',
    'blackmailer_second', 'blackmailer_signed', 'blackmailer_threat', 'spy_target', 'spy_color',
    'wizard_target', 'wizard_card', 'wizard_choice', 'abbot_declare', 'tax_collect'];
  const cases = [];
  for (const role of darkRoles) {
    const snapshot = JSON.parse(JSON.stringify(state));
    snapshot.players[0].played = [role];
    cases.push([`role-${role}`, snapshot]);
  }
  for (const kind of darkPending) {
    const snapshot = JSON.parse(JSON.stringify(state));
    snapshot.turn.pending = { kind, targetIdx: 0 };
    cases.push([`pending-${kind}`, snapshot]);
  }
  for (const [label, snapshot] of cases) {
    const perspective = 1;
    const view = Engine.sanitize(snapshot, snapshot.players[perspective].id);
    const expected = Array.from(train.encodeState(view, view.players[perspective].id).vector);
    const actual = execFileSync(exe, [String(perspective)], {
      input: JSON.stringify(snapshot) + '\n', encoding: 'utf8'
    }).trim().split(',').map(Number);
    assert.equal(actual.length, expected.length, `${label} length`);
    for (let i = 0; i < expected.length; i++)
      assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `${label}/${i}: native=${actual[i]} js=${expected[i]}`);
  }
});

test('JS/C++ 动作编码 v5 逐元素一致并固定类型位置', t => {
  const exe = process.env.CITADELS_NATIVE_ACTION_ENCODING_PROBE;
  if (!exe) { t.skip('未设置 CITADELS_NATIVE_ACTION_ENCODING_PROBE，跳过跨语言动作编码检查'); return; }
  const actions = [
    { type: 'end_turn' }, { type: 'build', uid: 'd-1' },
    { type: 'lab', uid: 'd-2', discardUid: 'h-1' },
    { type: 'choose_char', charId: 'king' },
    { type: 'choose_cards', uids: ['h-1', 'h-2'] },
    { type: 'navigator_bonus', mode: 'gold' },
    { type: 'ability', use: true },
    { type: 'artist_done', uids: ['d-3'] },
    { type: 'magistrate_signed', charId: 'magistrate', num: 1, target: 'feature-p1' },
    { type: 'spy_color', charId: 'spy', color: 'purple', target: 'feature-p2' },
    { type: 'blackmailer_bribe', charId: 'blackmailer', gold: 3, target: 'feature-p3' },
    { type: 'wizard_card', charId: 'wizard', cards: 2, mode: 'card' },
    { type: 'abbot_resource', charId: 'abbot', mode: 'gold', gold: 1 },
    { type: 'tax_collect', charId: 'tax_collector', num: 9, target: 'feature-p1' },
    { type: 'wizard_build', charId: 'wizard', uid: 'd-17', use: true },
    { type: 'spy_target', charId: 'spy', target: 'feature-p3' },
    { type: 'blackmailer_signed', charId: 'blackmailer', use: false },
    { type: 'blackmailer_char', num: 2 },
    { type: 'magistrate_char', num: 3 }
  ];
  for (const action of actions) {
    const expected = Array.from(train.encodeAction(action));
    const actual = execFileSync(exe, { input: JSON.stringify(action) + '\n', encoding: 'utf8' })
      .trim().split(',').map(Number);
    assert.deepEqual(actual.length, expected.length);
    for (let i = 0; i < expected.length; i++)
      assert.ok(Math.abs(actual[i] - expected[i]) < 1e-6, `${action.type}/${i}`);
  }
});

test('JS 编码为全部 6 个新角色及其专属状态/动作分配独立槽位', () => {
  const newRoles = ['magistrate', 'spy', 'blackmailer', 'wizard', 'abbot', 'tax_collector'];
  const typeNames = ['abbot_resource', 'blackmailer_bribe', 'blackmailer_refuse', 'blackmailer_signed',
    'blackmailer_char', 'magistrate_signed', 'magistrate_char', 'spy_color', 'spy_target', 'tax_collect', 'wizard_build', 'wizard_card',
    'wizard_take', 'wizard_target'];
  assert.equal(train.STATE_ENCODING_VERSION, 8);
  assert.equal(train.ACTION_ENCODING_VERSION, 6);
  for (const role of newRoles) {
    assert.ok(train.ROLE_IDS.includes(role), `${role} role feature`);
    const action = Array.from(train.encodeAction({ type: 'choose_char', charId: role }));
    assert.ok(action.some((value, index) => index >= 68 && index < 95 && value > 0), `${role} exact action feature`);
  }
  for (const type of typeNames) {
    assert.ok(train.ACTION_TYPES.includes(type), `${type} action feature`);
    const vector = Array.from(train.encodeAction({ type }));
    assert.equal(vector.slice(1, 44).filter(value => value > 0).length, 1, `${type} has unique type slot`);
  }
  for (const pending of ['magistrate_declare', 'magistrate_second', 'magistrate_third',
    'blackmailer_declare', 'blackmailer_second', 'blackmailer_signed', 'blackmailer_threat',
    'spy_target', 'spy_color', 'wizard_target', 'wizard_card', 'wizard_choice', 'abbot_declare', 'tax_collect', 'bishop_payer', 'bishop_repay'])
    assert.ok(train.PENDING_CODES[pending], `${pending} pending feature`);
});

test('六个新增暗版角色已由 C++ MCTS 规则模拟支持；独立 C++ 训练后端仍明确拒绝', () => {
  assert.equal(train.nativeMctsSupportsGame({ charDeck: ['king', 'merchant'] }), true);
  for (const role of ['magistrate', 'spy', 'blackmailer', 'wizard', 'abbot', 'tax_collector'])
    assert.equal(train.nativeMctsSupportsGame({ charDeck: ['king', role] }), true, role);
  assert.throws(() => train.sanitizeConfig({ rulesEngine: 'cpp' }), /尚未实现完整对局规则/);
});

test('动作编码升级后拒绝 v5 旧 checkpoint，防止错配策略槽位', () => {
  const model = new PolicyValueNetwork({ profile: 'fast' });
  assert.equal(model.encodingVersion, 7);
  const oldCheckpoint = model.export();
  oldCheckpoint.encodingVersion = 5;
  assert.throws(() => model.import(oldCheckpoint), /不兼容的 checkpoint/);
});
