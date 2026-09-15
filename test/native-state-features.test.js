const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Engine = require('../src/engine.js');
const train = require('../training/train.js');

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

test('JS/C++ 状态编码 v2 在 4/5/6 人、阶段、隐藏信息和 pending 上逐维一致', t => {
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
});

test('JS/C++ 动作编码 v2 逐元素一致并固定类型位置', t => {
  const exe = process.env.CITADELS_NATIVE_ACTION_ENCODING_PROBE;
  if (!exe) { t.skip('未设置 CITADELS_NATIVE_ACTION_ENCODING_PROBE，跳过跨语言动作编码检查'); return; }
  const actions = [
    { type: 'end_turn' }, { type: 'build', uid: 'd-1' },
    { type: 'lab', uid: 'd-2', discardUid: 'h-1' },
    { type: 'choose_char', charId: 'king' },
    { type: 'choose_cards', uids: ['h-1', 'h-2'] },
    { type: 'navigator_bonus', mode: 'gold' },
    { type: 'ability', use: true },
    { type: 'artist_done', uids: ['d-3'] }
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
