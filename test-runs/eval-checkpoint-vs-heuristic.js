'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Engine = require('../src/engine.js');
const AI = require('../src/ai.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const {
  enumerateLegalActions, currentActor, alignedParticlePool, particleBeliefWeights,
  BELIEF_DECAY
} = require('../training/train.js');
const { NativeSearchClient } = require('../training/native-search.js');

const ROOT = path.join(__dirname, '..');
const CHECKPOINT = process.env.CHECKPOINT || 'training-data/checkpoint-004000-plarge-m300-egpu-crandom-s20260913.json.gz';
const GAMES = Number(process.env.GAMES || 100);
const SIMULATIONS = Number(process.env.SIMULATIONS || 500);
const HEURISTIC_LEVEL = process.env.HEURISTIC_LEVEL || '';
const PARTICLES = Number(process.env.PARTICLES || 4);
const MAX_DEPTH = Number(process.env.MAX_DEPTH || 700);
const MCTS_BATCH_SIZE = Number(process.env.MCTS_BATCH_SIZE || 32);
const MCTS_C_PUCT = Number(process.env.MCTS_C_PUCT || 1);
const SEED = Number(process.env.SEED || 20260913);

function seededRng(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const checkpointPath = path.join(ROOT, CHECKPOINT);
  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(checkpointPath)));
  const profile = payload.config.profile || 'large';
  const model = new PolicyValueNetwork({ profile, stateSize: 672, actionSize: 256 });
  model.import(payload.model);
  const flatPath = path.join(ROOT, 'training-data', 'eval-model-' + process.pid + '.bin');
  const flat = model.exportFlat();
  fs.writeFileSync(flatPath, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));

  let client;
  let wins = 0, top3 = 0, totalSteps = 0, totalGameMs = 0, totalSearchMs = 0;
  const playerWins = Array(6).fill(0);
  const playerRanks = Array.from({ length: 6 }, () => Array(6).fill(0));
  try {
    client = new NativeSearchClient({
      root: ROOT, executable: path.join(ROOT, 'native', 'mcts_worker_libtorch.exe'),
      simulations: SIMULATIONS, maxDepth: MAX_DEPTH, batchSize: MCTS_BATCH_SIZE,
      cPuct: MCTS_C_PUCT, seed: SEED, gpuEvaluator: true, profile,
      device: process.env.EVAL_DEVICE || 'cuda', inferenceBackend: 'libtorch'
    });
    client.setModelPath(flatPath);

    for (let game = 1; game <= GAMES; game++) {
      // 每局从基本、黑暗、混合三种角色组中伪随机选择；使用固定种子
      // 让评测可复现，同时避免按固定周期暴露角色组分布。
      const charSetSeed = Math.imul(SEED + game * 7919, 1664525) + 1013904223;
      const charSet = ['base', 'dark', 'mixed'][(charSetSeed >>> 0) % 3];
      const seats = [{ id: 'nn', name: '策略网络', isBot: true, botType: 'neural', botLevel: 'hard' }];
      for (let i = 1; i < 6; i++) seats.push({
        id: 'h' + i, name: '启发式' + i, isBot: true, botType: 'heuristic',
        botLevel: HEURISTIC_LEVEL || ['easy', 'normal', 'hard'][(game + i) % 3]
      });
      const state = Engine.createGame({
        roomId: 'eval-' + game, endDistricts: 8, charSetMode: charSet,
        seed: SEED + game * 7919, seats
      });
      Engine.startGame(state);
      let steps = 0, searchMs = 0, gameStarted = Date.now();
      while (state.phase !== 'gameover' && steps < 100000) {
        const actor = currentActor(state);
        if (!actor) throw new Error('没有当前行动者，phase=' + state.phase);
        const legal = enumerateLegalActions(state, actor.id);
        if (!legal.length) throw new Error('没有合法行动，player=' + actor.id);
        let action;
        if (actor.id === 'nn') {
          const searchStarted = Date.now();
          // 与训练一致：4 个粒子共用一棵信息集搜索树，并按公开信息对粒子加权。
          // 不能把真实 state 直接交给 MCTS，否则会偷看对手手牌和牌库顺序。
          const rng = seededRng(SEED ^ Math.imul(game, 0x9E3779B9) ^
            Math.imul(steps + 1, 0x85EBCA6B));
          const pool = alignedParticlePool(state, actor.id, legal, rng, PARTICLES);
          if (!pool.length) throw new Error('确定化无法复现合法动作列表，game=' + game + ' step=' + steps);
          const weights = particleBeliefWeights(pool, actor.id, BELIEF_DECAY);
          const result = await client.search(pool.map(entry => entry.state), actor.id,
            pool[0].legal, game, weights);
          searchMs += Date.now() - searchStarted;
          let best = 0;
          for (let i = 1; i < result.policy.length; i++)
            if (result.policy[i] > result.policy[best]) best = i;
          action = pool[0].legal[best];
        } else {
          action = AI.decide(state, actor.id) || legal[0];
        }
        const applied = Engine.applyAction(state, actor.id, action);
        if (!applied.ok) {
          const fallback = legal.find(candidate => Engine.applyAction(state, actor.id, candidate).ok);
          if (!fallback) throw new Error('动作执行失败：' + JSON.stringify(applied));
        }
        steps++;
      }
      if (state.phase !== 'gameover') throw new Error('单局超过最大步数');
      const scores = state.scores || [];
      const mine = scores.find(row => row.playerIdx === 0);
      const rank = 1 + scores.filter(row => row.total > mine.total).length;
      if (rank === 1) wins++;
      if (rank <= 3) top3++;
      scores.forEach(row => {
        const playerRank = 1 + scores.filter(other => other.total > row.total).length;
        if (playerRank === 1) playerWins[row.playerIdx]++;
        if (playerRank >= 1 && playerRank <= 6) playerRanks[row.playerIdx][playerRank - 1]++;
      });
      const gameMs = Date.now() - gameStarted;
      totalSteps += steps; totalGameMs += gameMs; totalSearchMs += searchMs;
      console.log(JSON.stringify({ game, charSet, rank, win: rank === 1, steps, gameMs,
        nnSearchMs: searchMs, wins, winRate: (wins / game).toFixed(3) }));
    }
    console.log(JSON.stringify({
      type: 'final', checkpoint: CHECKPOINT, simulations: SIMULATIONS, maxDepth: MAX_DEPTH,
      mctsBatchSize: MCTS_BATCH_SIZE, cPuct: MCTS_C_PUCT, particles: PARTICLES,
      beliefDecay: BELIEF_DECAY, inferenceBackend: 'libtorch', games: GAMES,
      wins, winRate: wins / GAMES, top3, top3Rate: top3 / GAMES,
      totalSteps, avgSteps: totalSteps / GAMES, totalGameMs,
      avgGameMs: totalGameMs / GAMES, totalSearchMs,
      avgSearchMsPerGame: totalSearchMs / GAMES, avgSearchMsPerStep: totalSearchMs / totalSteps,
      playerWins, playerWinRates: playerWins.map(count => count / GAMES), playerRanks,
      totalWallMs: Date.now() - started
    }));
  } finally {
    if (client) client.close();
    try { fs.unlinkSync(flatPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
