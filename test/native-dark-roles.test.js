const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Engine = require('../src/engine.js');

test('C++ 原生 MCTS 规则模拟覆盖六个新增暗版角色的多步效果', t => {
  const exe = process.env.CITADELS_NATIVE_DARK_ROLES_PROBE;
  if (!exe) { t.skip('未设置 CITADELS_NATIVE_DARK_ROLES_PROBE，跳过 C++ 暗版规则探针'); return; }
  assert.equal(execFileSync(exe, { encoding: 'utf8' }).trim(), 'dark-role-native-rules-ok');
});

test('新增角色的 C++ MCTS 根节点合法动作与 JS 引擎逐项一致', t => {
  const exe = process.env.CITADELS_NATIVE_MCTS_WORKER;
  if (!exe) { t.skip('未设置 CITADELS_NATIVE_MCTS_WORKER，跳过 JS/C++ 根动作对齐检查'); return; }
  const roles = ['assassin', 'thief', 'magician', 'king', 'abbot', 'merchant', 'architect', 'warlord', 'tax_collector'];
  const make = (kind, pending, role, num) => {
    const state = Engine.createGame({ seats: Array.from({ length: 4 }, (_, i) => ({ id: 'p' + i, name: 'P' + i })), seed: 317 });
    Engine.startGame(state);
    state.phase = 'action'; state.charDeck = roles.slice(); state.draft.faceUp = [];
    state.players.forEach(p => { p.chars = []; p.hand = []; });
    state.players[0].chars = [role];
    state.players[1].chars = ['king'];
    state.players[2].chars = ['merchant'];
    state.players[3].chars = ['tax_collector'];
    state.players[1].hand = [{ uid: 'w1', name: 'Tower', color: 'red', cost: 2 }];
    state.players[0].city = [{ uid: 'blue-1', name: 'Chapel', color: 'blue', cost: 2 }];
    state.turn = { charId: role, num, playerIdx: 0, phase: 'main', takenResources: true, incomeTaken: true,
      abilityUsed: false, builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false,
      usedMuseum: false, bonusDone: false, pending: pending || null };
    state.reaction = null; state.roundConfirm = null;
    if (kind === 'magistrate_second') state.turn.pending = { kind, used: [4], signed: 4 };
    return state;
  };
  const cases = [
    make('magistrate_declare', { kind: 'magistrate_declare', used: [] }, 'magistrate', 1),
    make('magistrate_second', null, 'magistrate', 1),
    make('blackmailer_declare', { kind: 'blackmailer_declare' }, 'blackmailer', 2),
    make('blackmailer_second', { kind: 'blackmailer_second', first: 3 }, 'blackmailer', 2),
    make('blackmailer_signed', { kind: 'blackmailer_signed', nums: [3, 4] }, 'blackmailer', 2),
    make('spy_target', { kind: 'spy_target' }, 'spy', 2),
    make('spy_color', { kind: 'spy_color', targetIdx: 1 }, 'spy', 2),
    make('wizard_target', { kind: 'wizard_target' }, 'wizard', 3),
    make('wizard_card', { kind: 'wizard_card', targetIdx: 1, cards: [{ uid: 'w1', name: 'Tower', color: 'red', cost: 2 }] }, 'wizard', 3),
    make('wizard_choice', { kind: 'wizard_choice', targetIdx: 1, card: { uid: 'w1', name: 'Tower', color: 'red', cost: 2 } }, 'wizard', 3),
    make('tax_collect', { kind: 'tax_collect' }, 'tax_collector', 9),
  ];
  const abbotIncome = make('abbot-income', null, 'abbot', 5);
  abbotIncome.turn.incomeTaken = false;
  cases.push(abbotIncome);
  const bishopIncome = make('bishop-income', null, 'bishop', 5);
  bishopIncome.charDeck = roles.map(role => role === 'abbot' ? 'bishop' : role);
  bishopIncome.turn.incomeTaken = false;
  cases.push(bishopIncome);
  const bishopBuild = make('bishop-build', null, 'bishop', 5);
  bishopBuild.charDeck = roles.map(role => role === 'abbot' ? 'bishop' : role);
  bishopBuild.players[0].gold = 1;
  bishopBuild.players[0].hand = [
    { uid: 'bishop-build-card', name: 'Tower', color: 'red', cost: 3 },
    { uid: 'bishop-repay-a', name: 'Chapel', color: 'blue', cost: 2 },
    { uid: 'bishop-repay-b', name: 'Market', color: 'green', cost: 2 }
  ];
  bishopBuild.players[1].gold = 3;
  cases.push(bishopBuild);
  const bishopRepay = make('bishop-repay', { kind: 'bishop_repay', uid: 'bishop-build-card', payerIdx: 1,
    targetIdx: 1, amount: 2 }, 'bishop', 5);
  bishopRepay.charDeck = roles.map(role => role === 'abbot' ? 'bishop' : role);
  bishopRepay.players[0].gold = 1;
  bishopRepay.players[0].hand = [
    { uid: 'bishop-build-card', name: 'Tower', color: 'red', cost: 3 },
    { uid: 'bishop-repay-a', name: 'Chapel', color: 'blue', cost: 2 },
    { uid: 'bishop-repay-b', name: 'Market', color: 'green', cost: 2 },
    { uid: 'bishop-repay-c', name: 'Keep', color: 'yellow', cost: 2 }
  ];
  bishopRepay.players[1].gold = 3;
  cases.push(bishopRepay);
  const special = make('blackmailer_threat', { kind: 'blackmailer_threat', targetIdx: 0, signed: true }, 'wizard', 3);
  special.effects.blackmailer = { nums: [3], signed: 3, playerIdx: 1, done: [], revealed: [] };
  cases.push(special);
  const magReaction = make('reaction-magistrate', null, 'king', 4);
  magReaction.turn.playerIdx = 1;
  magReaction.reaction = { kind: 'magistrate', playerIdx: 0, build: { uid: 'w1', targetIdx: 1 },
    card: { uid: 'w1', name: 'Tower', cost: 2 }, queue: [0] };
  magReaction.effects.magistrate = { nums: [4, 5, 6], signed: 4, playerIdx: 0, claimed: true };
  cases.push(magReaction);
  const blackReaction = make('reaction-blackmailer', null, 'wizard', 3);
  blackReaction.turn.playerIdx = 0;
  blackReaction.reaction = { kind: 'blackmailer', playerIdx: 1, targetIdx: 0, num: 3 };
  blackReaction.effects.blackmailer = { nums: [3], signed: 3, playerIdx: 1, done: [], revealed: [] };
  cases.push(blackReaction);

  const requests = cases.map((state, i) => {
    const actor = state.reaction ? state.reaction.playerIdx : state.turn.playerIdx;
    const actions = state.turn.pending && state.turn.pending.kind === 'bishop_repay'
      ? [['bishop-repay-a', 'bishop-repay-b'], ['bishop-repay-a', 'bishop-repay-c'], ['bishop-repay-b', 'bishop-repay-c']]
        .map(uids => ({ type: 'choose_cards', uids }))
      : Engine.getAvailableActions(state, state.players[actor].id).actions;
    assert.ok(actions.length, `JS legal actions for case ${i}`);
    return { v: 1, id: `dark-${i}`, t: 'search', state, rootPlayerId: state.players[actor].id,
      legalActions: actions, simulations: 2, maxDepth: 4, seed: 317 };
  });
  const outputs = execFileSync(exe, { input: requests.map(x => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8' })
    .trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.equal(outputs.length, requests.length);
  outputs.forEach((result, i) => assert.equal(result.fallback, false, `native action mismatch in case ${i}: ${JSON.stringify(result)}`));
});
