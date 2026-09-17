'use strict';

/*
 * 回归：训练 / 自对弈卡死在「没有合法行动」。
 *
 * 背景：多步能力（pending）在某一步列不出任何候选时（例如法师选中了手牌为空的玩家，
 * 'wizard_card' 候选为空，且当时没有任何退出出口），整个房间就永久停在这个玩家身上。
 * 自对弈里 enumerateLegalActions 返回空数组 → train.js 直接抛「游戏停滞：…没有合法行动」。
 *
 * 这里做两层保护：
 *   1) 定点用例：法师选中空手玩家不会留下一无可选的 pending 状态；
 *   2) 不变量：随机对局每一步，当前行动者必须既有可选动作、也至少有一个真能落子的候选。
 */
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const { applyRecorded } = require('../training/undo.js');

function usableActions(state, playerId) {
  const av = Engine.getAvailableActions(state, playerId);
  return (av.actions || []).filter(a => !a.disabled);
}

function currentActor(state) {
  if (state.phase === 'draft' && state.draft) {
    const step = state.draft.steps[state.draft.stepIdx];
    return step ? state.players[step.player] : null;
  }
  if (state.reaction) return state.players[state.reaction.playerIdx];
  if (state.roundConfirm) {
    const index = (state.roundConfirm.confirmed || []).findIndex(v => !v);
    return index >= 0 ? state.players[index] : null;
  }
  return state.turn ? state.players[state.turn.playerIdx] : null;
}

// 与 training/train.js 的展开规则保持一致：choose_cards 这类「先选牌再提交」的动作，
// 引擎给的是占位候选（uids: []），必须自己展开成具体组合才是可落子的动作。
function exactCardCandidates(action, hand, count, excludedUid) {
  const cards = (hand || []).filter(card => card.uid !== excludedUid);
  const result = [];
  const selected = [];
  const visit = start => {
    if (selected.length === count) { result.push(Object.assign({}, action, { uids: selected.slice() })); return; }
    for (let i = start; i < cards.length; i++) { selected.push(cards[i].uid); visit(i + 1); selected.pop(); }
  };
  if (count >= 0 && count <= cards.length) visit(0);
  return result;
}

function combinations(action, hand) {
  const out = [Object.assign({}, action, { uids: [] })];
  const uids = (hand || []).map(c => c.uid);
  if (uids.length) out.push(Object.assign({}, action, { uids: uids.slice() }));
  for (let n = 1; n <= Math.min(3, uids.length); n++) {
    out.push(Object.assign({}, action, { uids: uids.slice(0, n) }));
    out.push(Object.assign({}, action, { uids: uids.slice(-n) }));
  }
  return out;
}

function expand(action, state, actor) {
  const pd = state.turn && state.turn.pending;
  if (action.type === 'lab') return actor.hand.map(c => Object.assign({}, action, { discardUid: c.uid }));
  if (action.type === 'museum') return actor.hand.map(c => Object.assign({}, action, { cardUid: c.uid }));
  if (action.type === 'choose_cards' && pd && pd.kind === 'bishop_repay') {
    return exactCardCandidates(action, actor.hand, pd.amount, pd.uid);
  }
  if (action.type === 'choose_cards') return combinations(action, actor.hand);
  return [Object.assign({}, action)];
}

/* ---------- 1) 法师选中没有手牌的玩家 ---------- */
{
  const seats = [{ id: 'w', name: '法师' }, { id: 'a', name: '空手者' }, { id: 'b', name: '有牌者' }];
  const state = Engine.createGame({ roomId: 'wizard', charSetMode: 'dark', seed: 4242, seats });
  Engine.startGame(state);
  state.phase = 'action';
  state.players.forEach(p => { p.chars = []; p.played = []; });
  state.players[0].chars = ['wizard'];
  state.players[1].hand = [];
  state.players[2].hand = [{ uid: 'c1', name: '哨塔', en: 'Watchtower', desc: '', color: 'red', cost: 1, scoreValue: 1 }];
  state.turn = { charId: 'wizard', num: 3, playerIdx: 0, playerId: 'w', phase: 'main',
    takenResources: true, incomeTaken: true, abilityUsed: false, builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };

  assert.equal(Engine.applyAction(state, 'w', { type: 'ability' }).ok, true, '法师能力可以发动');
  const targets = usableActions(state, 'w').filter(a => a.type === 'wizard_target');
  assert.deepEqual(targets.map(a => a.target), ['b'],
    '候选目标里不应列出手牌为空的玩家，否则下一步会无牌可选');

  // 即便客户端绕过 UI 直接发「空手目标」，也不能留下一个没有任何出口的 pending 状态
  const forced = Engine.applyAction(state, 'w', { type: 'wizard_target', target: 'a' });
  assert.equal(forced.ok, true, '选中空手玩家应当被优雅地处理掉');
  assert.equal(state.turn.pending, null, '能力应当直接结束，不留 dead pending');
  assert.ok(usableActions(state, 'w').length > 0, '结束后玩家仍有可行动作');
}

/* ---------- 2) 随机对局：每一步都必须有可行候选 ---------- */
function cloneTrimmed(state) {
  const copy = structuredClone(state);
  copy.log = [];
  copy.notices = [];
  return copy;
}

const games = 40;
let checked = 0;
for (let g = 0; g < games; g++) {
  const n = 2 + Math.floor(Math.random() * 6);
  const charSet = ['base', 'dark', 'mixed'][Math.floor(Math.random() * 3)];
  const seats = Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, isBot: true, botLevel: 'normal' }));
  const state = Engine.createGame({ roomId: 'deadlock-' + g, charSetMode: charSet, seed: 1000 + g * 7919, seats });
  Engine.startGame(state);

  let steps = 0;
  while (state.phase !== 'gameover' && steps < 3000) {
    steps++;
    if (state.roundConfirm) {
      state.players.forEach(p => { Engine.applyAction(state, p.id, { type: 'confirm_round' }); });
      continue;
    }
    const actor = currentActor(state);
    if (!actor) break;
    const usable = usableActions(state, actor.id);
    if (!usable.length) {
      throw new Error('第 ' + g + ' 局第 ' + steps + ' 步：' + actor.name + ' 没有任何可选动作，' +
        'pending=' + JSON.stringify(state.turn && state.turn.pending) +
        ' reaction=' + JSON.stringify(state.reaction));
    }
    let cands = [];
    usable.forEach(a => cands.push(...expand(a, state, actor)));
    const base = cloneTrimmed(state);
    const ok = [];
    cands.forEach(c => { const r = applyRecorded(base, actor.id, c); r.undo(); if (r.ok) ok.push(c); });
    if (!ok.length) {
      throw new Error('第 ' + g + ' 局第 ' + steps + ' 步：' + actor.name + ' 的 ' + cands.length +
        ' 个候选全部无法落子（self-play 会抛「没有合法行动」），pending=' +
        JSON.stringify(state.turn && state.turn.pending) + ' 样例=' + JSON.stringify(cands[0]));
    }
    checked++;
    Engine.applyAction(state, actor.id, ok[Math.floor(Math.random() * ok.length)]);
  }
}

console.log('多步能力不会留下无出口状态（校验 ' + checked + ' 步 / ' + games + ' 局）');
