/* 状态机压力测试驱动（engine.js + ai.js）：跑完整对局，
 * 系统性地抓问题：崩溃、不终止、非法动作、空决策、计分异常、卡死，
 * 以及不变量违规：卡牌/角色总量守恒（按 uid 去重）、金币非负。
 *
 * 可作为模块被批量矩阵脚本 require：
 *   const { playOne, currentActor, collectCards, cardNameCounts, charIdCounts } = require('./play-100-mixed-6.js');
 * 也可直接执行（默认 6 人 / mixed / 100 局）：
 *   node test-runs/play-100-mixed-6.js
 * 环境变量：GAMES 局数；PLAYERS 人数；CHAR_SET 角色组(base|dark|mixed)；END_DISTRICTS 结束建筑数
 */
'use strict';
const fs = require('fs');
const CitEngine = require('../src/engine.js');
const CitAI = require('../src/ai.js');

const GAMES = parseInt(process.env.GAMES || '100', 10);
const PLAYERS = parseInt(process.env.PLAYERS || '6', 10);
const END_DISTRICTS = parseInt(process.env.END_DISTRICTS || '8', 10);
const CHAR_SET = process.env.CHAR_SET || 'mixed';
const RANDOM_LEVELS = true;
const LEVELS = ['easy', 'normal', 'hard'];
const PER_GAME_STEP_CAP = 100000; // 超过视为不终止 / 死循环

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

// mulberry32：确定性 PRNG，用于把 AI 决策的随机抖动也纳入可复现范围。
function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---- 不变量快照 ---- */
// 注：charDeck 与 draft.pool 在引擎里是同一数组引用（startRound 原地洗牌后赋给 pool），
// 故角色守恒只统计「活跃」位置：pool/faceUp/faceDown/各玩家 chars，排除 charDeck。
function transientCardArrays(state) {
  // take_cards / draw_keep 等动作会把抽到的牌暂存在 state.turn.pending.cards，
  // 某些反应也可能在 state.reaction 里临时持牌。这些都属于「在游戏中」的牌，必须纳入守恒统计。
  const arrs = [];
  const tp = state.turn && state.turn.pending;
  if (tp && typeof tp === 'object') for (const k in tp) if (Array.isArray(tp[k])) arrs.push(tp[k]);
  const r = state.reaction;
  if (r && typeof r === 'object') for (const k in r) if (Array.isArray(r[k])) arrs.push(r[k]);
  if (tp && tp.card && tp.card.name) arrs.push([tp.card]);
  if (r && r.card && r.card.name) arrs.push([r.card]);
  return arrs;
}
function collectCards(state) {
  // 统一收集所有 district 牌对象，按 uid 去重（同一对象被多槽位引用只算一次，
  // 如墓地反应中 pendingDestroy.card 与 reaction.card 指向同一张牌）。
  // 若同一 uid 对应「不同对象引用」则记为真实重复（交叉污染真 bug）。
  const seen = new Map();   // uid -> object reference
  const byUid = new Map();  // uid -> card (去重后)
  const dups = [];          // uid：出现为 >1 个不同对象
  const visit = c => {
    if (!c || c.uid == null) return;
    if (seen.has(c.uid)) {
      if (seen.get(c.uid) !== c && !dups.includes(c.uid)) dups.push(c.uid);
    } else { seen.set(c.uid, c); byUid.set(c.uid, c); }
  };
  const visitArr = arr => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) { visit(c); if (c && Array.isArray(c.museum)) for (const mc of c.museum) visit(mc); }
  };
  visitArr(state.deck); visitArr(state.discard);
  if (state.pendingDestroy && state.pendingDestroy.card) visit(state.pendingDestroy.card);
  for (const p of state.players) { visitArr(p.hand); visitArr(p.city); }
  for (const a of transientCardArrays(state)) visitArr(a);
  if (state.reaction && state.reaction.card) visit(state.reaction.card);
  return { byUid, dups };
}
function cardNameCounts(state) {
  // district 牌按 name 多重集合（去重后）
  const { byUid } = collectCards(state);
  const m = new Map();
  for (const c of byUid.values()) if (c.name) m.set(c.name, (m.get(c.name) || 0) + 1);
  return m;
}
function cardUidDup(state) {
  // 仅当同一 uid 对应「不同对象」才视为真重复
  const { dups } = collectCards(state);
  return dups;
}
function charIdCounts(state) {
  // 角色按 id 多重集合（排除 charDeck，因其与 draft.pool 同引用）
  const m = new Map();
  const add = arr => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) if (x != null) m.set(x, (m.get(x) || 0) + 1);
  };
  if (state.draft) { add(state.draft.pool); add(state.draft.faceUp); add(state.draft.faceDown); }
  for (const p of state.players) add(p.chars);
  return m;
}
function goldViolations(state) {
  const out = [];
  for (const p of state.players) {
    if (typeof p.gold !== 'number' || !isFinite(p.gold) || p.gold < 0 || p.gold % 1 !== 0) {
      out.push({ pid: p.id, gold: p.gold });
    }
  }
  return out;
}
function sameNameViolations(state) {
  // 注：事后按当前采石场数判断会误伤「曾有采石场时建第 2 张、后被摧毁」的合法局面，
  // 且引擎在建造时已由 canBuildCard 强制 same < maxSameName(p)。此处仅作为辅助参考，不计入失败。
  const out = [];
  for (const p of state.players) {
    const cap = 1 + p.city.filter(d => d.purple && d.purple.effect === 'quarry').length;
    const cnt = new Map();
    for (const d of p.city) if (d && d.name) cnt.set(d.name, (cnt.get(d.name) || 0) + 1);
    for (const [name, c] of cnt) if (c > cap) out.push({ pid: p.id, name, count: c, cap });
  }
  return out;
}
function mapsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function playOne(seed, opts) {
  opts = opts || {};
  const players = opts.players != null ? opts.players : PLAYERS;
  const charSet = opts.charSet != null ? opts.charSet : CHAR_SET;
  const endDistricts = opts.endDistricts != null ? opts.endDistricts : END_DISTRICTS;
  const randomLevels = opts.randomLevels != null ? opts.randomLevels : RANDOM_LEVELS;
  const seats = [];
  const levels = [];
  for (let i = 0; i < players; i++) {
    const botLevel = (opts.levels && opts.levels[i]) || (randomLevels ? LEVELS[Math.floor(Math.random() * LEVELS.length)] : 'normal');
    levels.push(botLevel);
    seats.push({ id: 'p' + i, name: '电脑' + (i + 1), isBot: true, botLevel });
  }
  const state = CitEngine.createGame({
    roomId: 'sim', endDistricts: endDistricts, charSetMode: charSet, seed: seed, seats
  });
  CitEngine.startGame(state);

  // AI 决策的随机抖动也走确定性 RNG：同一 (seed, players, charSet, levels) → 完全可复现。
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const useDeterministicAi = opts.deterministicAi !== false;

  const initialCards = cardNameCounts(state);
  const initialChars = charIdCounts(state);

  const problems = [];
  let steps = 0, fallbacks = 0, illegal = 0, stalls = 0;

  function checkInvariants(where) {
    const cards = cardNameCounts(state);
    if (!mapsEqual(cards, initialCards)) {
      const diff = [];
      const names = new Set([...initialCards.keys(), ...cards.keys()]);
      for (const n of names) {
        const a = initialCards.get(n) || 0, b = cards.get(n) || 0;
        if (a !== b) diff.push({ name: n, before: a, after: b });
      }
      problems.push({ kind: 'card_name_changed', where, diff: diff.slice(0, 8) });
    }
    const dups = cardUidDup(state);
    if (dups.length) problems.push({ kind: 'card_uid_dup', where, uids: dups.slice(0, 3) });
    const chars = charIdCounts(state);
    if (!mapsEqual(chars, initialChars)) {
      problems.push({ kind: 'char_set_changed', where });
    }
    const gv = goldViolations(state);
    if (gv.length) problems.push({ kind: 'gold_invalid', where, detail: gv.slice(0, 3) });
  }

  while (state.phase !== 'gameover') {
    steps++;
    if (steps > PER_GAME_STEP_CAP) {
      problems.push({ kind: 'nonterminate', steps, phase: state.phase, round: state.round });
      return { ok: false, reason: 'nonterminate', steps, rounds: state.round, problems, scoreProblems: [], scores: null, state };
    }

    if (state.roundConfirm) {
      state.players.forEach(p => {
        if (state.phase === 'gameover' || !state.roundConfirm) return;
        const r = CitEngine.applyAction(state, p.id, { type: 'confirm_round' });
        if (!r.ok) { fallbacks++; problems.push({ kind: 'confirm_fail', pid: p.id, error: r.error }); }
      });
      continue;
    }

    const actor = currentActor(state);
    if (!actor) {
      stalls++;
      if (stalls > 50) {
        problems.push({ kind: 'stall', phase: state.phase, round: state.round });
        return { ok: false, reason: 'stall', steps, rounds: state.round, problems, scoreProblems: [], scores: null, state };
      }
      break;
    }

    let action = null;
    try { action = useDeterministicAi ? CitAI.decide(state, actor.id, rng) : CitAI.decide(state, actor.id); }
    catch (e) {
      problems.push({ kind: 'ai_throw', pid: actor.id, phase: state.phase, msg: String(e && e.stack || e) });
      fallbacks++; action = { type: 'end_turn' };
    }

    if (!action) {
      fallbacks++;
      problems.push({ kind: 'ai_null', pid: actor.id, phase: state.phase, turn: !!state.turn });
      if (state.turn) { CitEngine.applyAction(state, actor.id, { type: 'end_turn' }); continue; }
      break;
    }

    const res = CitEngine.applyAction(state, actor.id, action);
    if (!res.ok) {
      illegal++;
      problems.push({ kind: 'illegal_action', pid: actor.id, phase: state.phase, action, error: res.error });
      if (state.turn && state.turn.pending) {
        const r2 = CitEngine.applyAction(state, actor.id, { type: 'ability_skip' });
        if (!r2.ok) CitEngine.applyAction(state, actor.id, { type: 'end_turn' });
      } else if (state.turn) {
        CitEngine.applyAction(state, actor.id, { type: 'end_turn' });
      } else {
        break;
      }
    }
    checkInvariants('after_action:' + (steps));
    if (process.env.DBG_STEP && problems.length && !playOne._dbgOnce) {
      playOne._dbgOnce = true;
      const p = problems[0];
      console.log('[DBG] 首个问题 step=' + steps + ' phase=' + state.phase + ' round=' + state.round + ' actor=' + actor.id);
      console.log('[DBG] action=' + JSON.stringify(action).slice(0, 200));
      console.log('[DBG] problem=' + JSON.stringify(p).slice(0, 300));
      console.log('[DBG] turn=' + JSON.stringify(state.turn ? { pid: state.turn.playerIdx, charId: state.turn.charId, phase: state.turn.phase, pending: state.turn.pending } : null).slice(0, 240));
      console.log('[DBG] reaction=' + JSON.stringify(state.reaction).slice(0, 200));
    }
  }

  const ok = state.phase === 'gameover';
  let scoreProblems = [];
  let scores = null;
  if (ok && state.scores) {
    scores = state.scores.map(r => ({ name: r.name, total: r.total }));
    for (const row of state.scores) {
      const manual = row.detail.reduce((s, d) => s + d.value, 0);
      if (manual !== row.total) scoreProblems.push({ kind: 'score_mismatch', name: row.name, total: row.total, manual });
      if (!isFinite(row.total) || isNaN(row.total)) scoreProblems.push({ kind: 'score_nan', name: row.name, total: row.total });
    }
    const reached = state.players.some(p => p.city.length >= END_DISTRICTS);
    if (!reached && state.deck.length > 0) scoreProblems.push({ kind: 'ended_without_winner', deck: state.deck.length });
  } else if (ok && !state.scores) {
    scoreProblems.push({ kind: 'no_scores' });
  }
  // 终局再校验一次不变量
  if (ok) checkInvariants('final');

  return {
    ok, reason: ok ? 'finished' : 'unfinished', steps, rounds: state.round,
    fallbacks, illegal, stalls, problems, scoreProblems, scores,
    seed, levels, players, charSet
  };
}

function main() {
  const results = [];
  const t0 = Date.now();
  for (let g = 0; g < GAMES; g++) {
    const seed = (Math.floor(Math.random() * 0x7fffffff)) >>> 0;
    let r;
    try { r = playOne(seed); }
    catch (e) {
      r = { ok: false, reason: 'crash', seed, error: String(e && e.stack || e), problems: [], scoreProblems: [] };
    }
    r.seed = seed; r.game = g + 1;
    results.push(r);
    const pb = r.problems.length + (r.scoreProblems ? r.scoreProblems.length : 0);
    const tag = r.ok ? (pb ? 'WARN' : 'ok  ') : 'FAIL';
    console.log(
      `[${tag}] 局${String(g + 1).padStart(3)} seed=${seed} ` +
      `步=${String(r.steps).padStart(7)} 轮=${String(r.rounds).padStart(3)} ` +
      `兜底=${r.fallbacks || 0} 非法=${r.illegal || 0} 问题=${pb} ` + (r.reason || '')
    );
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  const finished = results.filter(r => r.ok && !r.scoreProblems.length && !r.problems.length);
  const finishedAny = results.filter(r => r.ok);
  const crashes = results.filter(r => r.reason === 'crash');
  const nonterm = results.filter(r => r.reason === 'nonterminate' || r.reason === 'stall');
  const unfinished = results.filter(r => !r.ok && r.reason !== 'crash' && r.reason !== 'nonterminate' && r.reason !== 'stall');
  const warn = results.filter(r => r.ok && (r.problems.length || (r.scoreProblems && r.scoreProblems.length)));

  const allSteps = results.map(r => r.steps || 0);
  const allRounds = results.map(r => r.rounds || 0);
  const sum = a => a.reduce((s, x) => s + x, 0);
  const max = a => a.reduce((m, x) => Math.max(m, x), 0);
  const min = a => a.reduce((m, x) => Math.min(m, x), 1e9);

  // 问题分类统计
  const kinds = {};
  for (const r of results) {
    for (const p of (r.problems || [])) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
    for (const p of (r.scoreProblems || [])) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
  }

  const summary = {
    games: GAMES, charSet: CHAR_SET, players: PLAYERS, endDistricts: END_DISTRICTS, randomLevels: RANDOM_LEVELS,
    elapsedSec: dt,
    cleanFinished: finished.length, finishedAny: finishedAny.length,
    crashes: crashes.length, nonterminateOrStall: nonterm.length, unfinishedOther: unfinished.length, finishedWithWarnings: warn.length,
    problemKinds: kinds,
    stepStats: { min: min(allSteps), max: max(allSteps), avg: Math.round(sum(allSteps) / GAMES) },
    roundStats: { min: min(allRounds), max: max(allRounds), avg: +(sum(allRounds) / GAMES).toFixed(1) },
    problemCount: crashes.length + nonterm.length + unfinished.length + warn.length,
  };

  console.log('\n================ 汇总 ================');
  console.log(JSON.stringify(summary, null, 2));

  if (crashes.length) {
    console.log('\n--- 崩溃明细 ---');
    crashes.forEach(c => console.log(`局${c.game} seed=${c.seed}\n${c.error}`));
  }
  if (nonterm.length) {
    console.log('\n--- 不终止/卡死明细 ---');
    nonterm.forEach(c => console.log(`局${c.game} seed=${c.seed} reason=${c.reason} steps=${c.steps} round=${c.rounds}`));
  }
  if (warn.length) {
    console.log('\n--- 完成但带警告明细 ---');
    warn.forEach(c => {
      console.log(`局${c.game} seed=${c.seed} 步=${c.steps} 轮=${c.rounds}`);
      (c.problems || []).forEach(p => console.log('   问题:', JSON.stringify(p).slice(0, 300)));
      (c.scoreProblems || []).forEach(p => console.log('   计分:', JSON.stringify(p).slice(0, 200)));
    });
  }

  const reportName = process.env.REPORT || 'play-100-mixed-6.report.json';
  const reportPath = __dirname + '/' + reportName;
  fs.writeFileSync(reportPath, JSON.stringify({ summary, results }, null, 2));
  console.log('\n报告已写入: ' + reportPath);

  const problemCount = crashes.length + nonterm.length + unfinished.length + warn.length;
  console.log(problemCount === 0 ? `\n结论：${GAMES} 局全部干净完成，未发现问题（含不变量校验）。` : `\n结论：发现 ${problemCount} 局存在问题，详见上方明细。`);
  return { summary, results, problemCount };
}

module.exports = {
  playOne, main, currentActor, collectCards, cardNameCounts, cardUidDup, charIdCounts,
  goldViolations, mapsEqual, LEVELS, PER_GAME_STEP_CAP,
};

if (require.main === module) {
  const { problemCount } = main();
  process.exit(problemCount === 0 ? 0 : 1);
}
