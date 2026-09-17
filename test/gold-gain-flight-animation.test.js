'use strict';

/*
 * 系统 check：只要某个玩家的金币在某一步里增加了，就必须有一条「金币动画」通知跟着产生，
 * 否则客户端无从播放飞行动画。**这里用运行期不变量来兜底**，而不是逐个 effect 写断言——
 * 新增规则效果时如果忘了上报，这个测试会直接红。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CitEngine = require('../src/engine.js');
const CitAI = require('../src/ai.js');

const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

assert.match(engineSrc, /function notifyGoldGain\(state, toIdx, amount, fromIdx, why\)/,
  '规则层应提供统一的金币获得通知');
assert.match(appSrc, /case 'got_gold':[\s\S]*?flyCoins\(n\.fromIdx, n\.playerIdx, n\.amount\)[\s\S]*?flyGoldIn\(n\.playerIdx, n\.amount\)/,
  '客户端应根据金币来源播放玩家间转移或金库飞入动画');

// 每种通知「给谁记入多少金币」。返回 { idx, amount } 或 null（不涉金币）。
const CREDITORS = {
  got_gold: n => ({ idx: n.playerIdx, amount: n.amount }),
  thief_steal: n => ({ idx: n.byIdx, amount: n.amount }),
  spy_result: n => ({ idx: n.byIdx, amount: n.gold || 0 }),
  monk_take: n => ({ idx: n.toIdx, amount: n.amount || 0 }),
  tax_collected: n => ({ idx: n.playerIdx, amount: n.amount }),
  alchemist_refund: n => ({ idx: n.playerIdx, amount: n.amount }),
  emperor_gold: n => ({ idx: n.toIdx, amount: n.amount || 0 }),
  navigator_bonus: n => (n.mode === 'gold' ? { idx: n.playerIdx, amount: n.amount } : null),
  blackmailer_reveal: n => (n.revealed && n.isReal ? { idx: n.toIdx, amount: n.amount } : null)
};

function currentActor(state) {
  if (state.phase === 'draft' && state.draft) {
    const step = state.draft.steps[state.draft.stepIdx];
    return step ? state.players[step.player] : null;
  }
  if (state.reaction) return state.players[state.reaction.playerIdx];
  if (state.turn) return state.players[state.turn.playerIdx];
  return null;
}

// 汇总某一步产生的新通知里，每位玩家被「记入」了多少金币。
function creditedGold(notices, fromSeq) {
  const map = new Map();
  for (const n of notices || []) {
    if (n.seq <= fromSeq) continue;
    const cred = CREDITORS[n.kind];
    if (!cred) continue;
    const got = cred(n);
    if (!got || !(got.amount > 0) || got.idx == null) continue;
    map.set(got.idx, (map.get(got.idx) || 0) + got.amount);
  }
  return map;
}

function runGame(n, charSet, seed) {
  const seats = [];
  for (let i = 0; i < n; i++) seats.push({ id: 'p' + i, name: '电脑' + (i + 1), isBot: true, botLevel: 'normal' });
  const state = CitEngine.createGame({ roomId: 'gold-anim', charSetMode: charSet, seed: seed, seats });
  CitEngine.startGame(state);

  let steps = 0;
  // AI 带随机性，极少数对局会绕很久；上限只是用来兜底，正常对局几百步内结束。
  const MAX = 8000;
  while (state.phase !== 'gameover' && steps < MAX) {
    steps++;
    if (state.roundConfirm) {
      state.players.forEach(p => {
        if (state.roundConfirm && state.phase !== 'gameover') {
          CitEngine.applyAction(state, p.id, { type: 'confirm_round' });
        }
      });
      continue;
    }
    const actor = currentActor(state);
    if (!actor) break;

    const goldBefore = state.players.map(p => p.gold);
    const seqBefore = state.noticeSeq || 0;

    let action = null;
    try { action = CitAI.decide(state, actor.id); } catch (_) { action = { type: 'end_turn' }; }
    if (!action) {
      if (state.turn) { CitEngine.applyAction(state, actor.id, { type: 'end_turn' }); continue; }
      break;
    }
    const res = CitEngine.applyAction(state, actor.id, action);
    if (!res.ok && state.turn) CitEngine.applyAction(state, actor.id, { type: 'end_turn' });

    const credits = creditedGold(state.notices, seqBefore);
    state.players.forEach((p, idx) => {
      const delta = p.gold - goldBefore[idx];
      if (delta <= 0) return;
      const credited = credits.get(idx) || 0;
      assert.ok(credited >= delta,
        '第 ' + idx + ' 号玩家本步金币 +' + delta + '，但金币动画通知只覆盖 ' + credited +
        ' 枚；步数=' + steps + '，动作=' + JSON.stringify(action));
    });
  }
  return { steps: steps, gold: state.players.map(p => p.gold).join('/') };
}

const cases = [
  { n: 3, charSet: 'base', seed: 101 },
  { n: 4, charSet: 'dark', seed: 202 },
  { n: 5, charSet: 'dark', seed: 303 },
  { n: 6, charSet: 'mixed', seed: 404 },
  { n: 7, charSet: 'dark', seed: 505 }
];
for (const c of cases) {
  const r = runGame(c.n, c.charSet, c.seed);
  console.log('  ' + c.n + ' 人 / ' + c.charSet + '：步数 ' + r.steps + '，终局金币 ' + r.gold);
}

console.log('所有金币增加均伴随飞行动画通知');
