/* 冒烟测试：在 Node 里用纯电脑玩家跑完整对局，检查引擎不会卡死或报错 */
'use strict';
const CitCards = require('../src/cards.js');
const CitEngine = require('../src/engine.js');
const CitAI = require('../src/ai.js');

function currentActor(state) {
  if (state.phase === 'draft' && state.draft) {
    const step = state.draft.steps[state.draft.stepIdx];
    if (step) return state.players[step.player];
    return null;
  }
  if (state.reaction) return state.players[state.reaction.playerIdx];
  if (state.turn) return state.players[state.turn.playerIdx];
  return null;
}

function runGame(n, charSet, end, seed) {
  const seats = [];
  for (let i = 0; i < n; i++) seats.push({ id: 'p' + i, name: '电脑' + (i + 1), isBot: true, botLevel: 'normal' });
  const state = CitEngine.createGame({
    roomId: 'sim', endDistricts: end, charSetMode: charSet, seed: seed, seats: seats
  });
  CitEngine.startGame(state);

  let steps = 0, fallbacks = 0;
  const MAX = 60000;
  while (state.phase !== 'gameover' && steps < MAX) {
    steps++;
    const actor = currentActor(state);
    if (!actor) {
      // 没有行动者：可能处于轮次之间
      if (state.phase === 'action' && (!state.turn || state.turn === null) && state.callIdx >= state.callQueue.length) {
        // 理论上不会停留，engine 已自动推进
      }
      break;
    }
    let action = null;
    try { action = CitAI.decide(state, actor.id); }
    catch (e) { console.error('  AI 异常', e); fallbacks++; action = { type: 'end_turn' }; }
    if (!action) {
      fallbacks++;
      if (state.turn) { CitEngine.applyAction(state, actor.id, { type: 'end_turn' }); continue; }
      break;
    }
    const res = CitEngine.applyAction(state, actor.id, action);
    if (!res.ok) {
      fallbacks++;
      if (state.turn && state.turn.pending) {
        const r2 = CitEngine.applyAction(state, actor.id, { type: 'ability_skip' });
        if (!r2.ok) CitEngine.applyAction(state, actor.id, { type: 'end_turn' });
      } else if (state.turn) {
        CitEngine.applyAction(state, actor.id, { type: 'end_turn' });
      } else {
        console.error('  无法推进：' + res.error);
        break;
      }
    }
  }
  const ok = state.phase === 'gameover';
  const sc = state.scores ? state.scores.map(r => r.name + ':' + r.total).join(' ') : '(未结算)';
  return { ok, steps, rounds: state.round, fallbacks, scores: sc, state };
}

let pass = 0, fail = 0;
const combos = [];
[2, 3, 4, 5, 6, 7, 8].forEach(n => ['base', 'dark', 'mixed'].forEach(cs => combos.push([n, cs, 8])));
combos.push([4, 'base', 7]);

console.log('=== 富饶之城 引擎冒烟测试 ===\n');
combos.forEach(([n, cs, end], i) => {
  let good = 0, bad = 0, totalSteps = 0, totalFb = 0, rounds = 0;
  const RUNS = 3;
  for (let k = 0; k < RUNS; k++) {
    const r = runGame(n, cs, end, 1000 + i * 37 + k);
    if (r.ok) good++; else bad++;
    totalSteps += r.steps; totalFb += r.fallbacks; rounds += r.rounds;
    if (!r.ok) console.log('  ✗ 失败 n=' + n + ' ' + cs + ' 轮次=' + r.rounds + ' 步数=' + r.steps);
  }
  const line = '  n=' + n + ' 角色组=' + cs.padEnd(5) + ' 结束=' + end +
    ' → 完成 ' + good + '/' + RUNS + '，平均步数 ' + Math.round(totalSteps / RUNS) +
    '，平均轮次 ' + (rounds / RUNS).toFixed(1) + '，兜底 ' + totalFb;
  console.log(line);
  if (good === RUNS) pass++; else fail++;
});

// 计分校验
console.log('\n=== 计分校验 ===');
const r = runGame(5, 'base', 8, 4242);
if (r.state.scores) {
  r.state.scores.forEach(row => {
    const manual = row.detail.reduce((s, d) => s + d.value, 0);
    const okRow = manual === row.total;
    console.log('  ' + row.name + ' 总分 ' + row.total + '（明细合计 ' + manual + '）' + (okRow ? ' ✓' : ' ✗'));
    if (!okRow) fail++;
  });
}

console.log('\n结果：通过 ' + pass + ' 组，失败 ' + fail + ' 组');
process.exit(fail > 0 ? 1 : 0);
