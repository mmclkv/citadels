'use strict';

/**
 * 测量脚本：统计 MCTS 每次搜索里，各次模拟（runOne）的返回路径占比。
 *   - simTerminal   : 走到 gameover 终局
 *   - simDepthCapped: 撞到 maxDepth 截断
 *   - simLeaf       : 命中未展开叶子（正常 MCTS 叶子，用网络价值兜底）
 *   - simOther      : 无合法动作 / 落子失败兜底
 * 用随机策略 CPU 评估器（不依赖 GPU，不干扰正在跑的训练）。
 */

const path = require('path');
const Engine = require('../src/engine.js');
const HeuristicAI = require('../src/ai.js');
const mcts = require('./mcts.js');
const { cloneTrimmed } = require('./search-state.js');
const { applyRecorded } = require('./undo.js');
const { encodeState, encodeAction } = require('./train.js');

function uniqueActions(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const key = JSON.stringify(a);
    if (!seen.has(key)) { seen.add(key); out.push(a); }
  }
  return out;
}

function enumerateLegalActions(state, playerId) {
  const available = Engine.getAvailableActions(state, playerId);
  const player = state.players.find(p => p.id === playerId);
  let candidates = [];
  for (const action of available.actions || []) {
    if (action.disabled) continue;
    if (action.type === 'lab') {
      for (const card of player.hand) candidates.push({ ...action, discardUid: card.uid });
    } else if (action.type === 'museum') {
      for (const card of player.hand) candidates.push({ ...action, cardUid: card.uid });
    } else if (action.type === 'choose_cards') {
      // 简化：跳过 redraw 复杂分支（测量场景极少触发）
      continue;
    } else candidates.push(Object.assign({}, action));
  }
  const base = cloneTrimmed(state);
  candidates = uniqueActions(candidates).filter(action => {
    const { ok, undo } = applyRecorded(base, playerId, action);
    undo();
    return ok;
  });
  if (!candidates.length) {
    try {
      const fallback = HeuristicAI.decide(state, playerId);
      if (fallback) {
        const { ok, undo } = applyRecorded(base, playerId, fallback);
        undo();
        if (ok) candidates.push(fallback);
      }
    } catch (_) { /* ignore */ }
  }
  return candidates;
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

function gameRewards(state) {
  const scores = (state.scores || []).slice();
  const rewards = new Map();
  scores.forEach(row => {
    const rank = scores.reduce((count, other) => count + (other.total > row.total ? 1 : 0), 0);
    const rankTerm = scores.length === 1 ? 1 : 1 - 2 * rank / (scores.length - 1);
    rewards.set(state.players[row.playerIdx].id, rankTerm);
  });
  return rewards;
}

// 随机策略模型：仅用于测量搜索树的形态，与策略质量无关（终局占比主要由深度/步数决定）
function makeRandomModel(actionSize) {
  return {
    forward(_vector, actionVectors, _t) {
      const n = Math.max(1, actionVectors.length);
      const probs = new Float32Array(n);
      for (let i = 0; i < n; i++) probs[i] = 1 / n;
      return { probs, value: 0 };
    }
  };
}

function parseArgs(argv) {
  const out = { depth: 400, games: 3, sims: 50, maxPlayers: 8, minPlayers: 4, seed: 20260913 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--depth') out.depth = parseInt(argv[++i], 10);
    else if (a === '--games') out.games = parseInt(argv[++i], 10);
    else if (a === '--sims') out.sims = parseInt(argv[++i], 10);
    else if (a === '--maxPlayers') out.maxPlayers = parseInt(argv[++i], 10);
    else if (a === '--minPlayers') out.minPlayers = parseInt(argv[++i], 10);
    else if (a === '--seed') out.seed = parseInt(argv[++i], 10);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[measure] depth=${args.depth} games=${args.games} sims/move=${args.sims} players=${args.minPlayers}-${args.maxPlayers} seed=${args.seed}`);

  const model = makeRandomModel(0);
  const agg = { terminal: 0, depthCapped: 0, leaf: 0, other: 0, sims: 0, searches: 0, searchesWithTerminal: 0 };
  const perGame = [];

  for (let g = 0; g < args.games; g++) {
    const playerCount = args.minPlayers + Math.floor((g / Math.max(1, args.games)) * (args.maxPlayers - args.minPlayers + 1));
    const seats = Array.from({ length: playerCount }, (_, i) => ({
      id: 'm-' + g + '-' + i, name: 'M' + (i + 1), isBot: true, botType: 'neural'
    }));
    const state = Engine.createGame({
      roomId: 'measure-' + g, endDistricts: 8, charSetMode: 'random',
      seed: args.seed + g * 7919, seats
    });
    Engine.startGame(state);

    let steps = 0, gameTerminal = 0, gameDepthCapped = 0, gameLeaf = 0, gameOther = 0, gameSims = 0, searches = 0, searchesWithTerminal = 0;
    while (state.phase !== 'gameover' && steps < 60000) {
      const actor = currentActor(state);
      if (!actor) throw new Error('no actor, phase=' + state.phase);
      const legal = enumerateLegalActions(state, actor.id);
      if (!legal.length) throw new Error('no legal actions for ' + actor.name);
      const res = await mcts.search({
        rootState: state,
        rootPlayerId: actor.id,
        model,
        Engine,
        sanitize: Engine.sanitize,
        legalFn: enumerateLegalActions,
        rewardFn: gameRewards,
        encodeState,
        encodeAction,
        simulate: args.sims,
        cPuct: 1.0,
        dirichletAlpha: 0.3,
        dirichletEpsilon: 0.03,
        maxDepth: args.depth,
        rng: Math.random
      });
      gameTerminal += res.simTerminal;
      gameDepthCapped += res.simDepthCapped;
      gameLeaf += res.simLeaf;
      gameOther += res.simOther;
      gameSims += res.simTerminal + res.simDepthCapped + res.simLeaf + res.simOther;
      searches++;
      if (res.simTerminal > 0) searchesWithTerminal++;
      // 按访问分布抽样走子（与训练一致）
      let r = Math.random(), chosen = Math.max(0, legal.length - 1);
      for (let i = 0; i < res.pi.length; i++) { r -= res.pi[i]; if (r <= 0) { chosen = i; break; } }
      const applied = Engine.applyAction(state, actor.id, legal[chosen]);
      if (!applied.ok) {
        const fb = legal.find(a => Engine.applyAction(cloneTrimmed(state), actor.id, a).ok);
        if (fb) Engine.applyAction(state, actor.id, fb);
      }
      steps++;
    }
    perGame.push({ g, playerCount, steps, terminal: gameTerminal, depthCapped: gameDepthCapped, leaf: gameLeaf, other: gameOther, sims: gameSims, searches, searchesWithTerminal });
    agg.terminal += gameTerminal; agg.depthCapped += gameDepthCapped; agg.leaf += gameLeaf; agg.other += gameOther;
    agg.sims += gameSims; agg.searches += searches; agg.searchesWithTerminal += searchesWithTerminal;
    console.log(`[game ${g}] players=${playerCount} steps=${steps} sims=${gameSims} | terminal=${gameTerminal} depthCapped=${gameDepthCapped} leaf=${gameLeaf} other=${gameOther} | 有终局的搜索=${searchesWithTerminal}/${searches}`);
  }

  const fmt = pct => agg.sims ? (100 * pct / agg.sims).toFixed(2) + '%' : 'n/a';
  console.log('\n==== 汇总 ====');
  console.log(`总模拟次数 sims        = ${agg.sims}`);
  console.log(`  - 走到终局 terminal  = ${agg.terminal}  (${fmt(agg.terminal)})`);
  console.log(`  - 撞深度截断 capped  = ${agg.depthCapped}  (${fmt(agg.depthCapped)})`);
  console.log(`  - 命中叶子 leaf      = ${agg.leaf}  (${fmt(agg.leaf)})`);
  console.log(`  - 其它兜底 other      = ${agg.other}  (${fmt(agg.other)})`);
  console.log(`搜索次数(move)        = ${agg.searches}`);
  console.log(`含≥1终局模拟的搜索占比 = ${agg.searches ? (100 * agg.searchesWithTerminal / agg.searches).toFixed(2) + '%' : 'n/a'}  (${agg.searchesWithTerminal}/${agg.searches})`);
  console.log(`结论：在 maxDepth=${args.depth}、sims/move=${args.sims} 下，单次搜索能搜到终局的比例 ≈ ${fmt(agg.terminal)}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
