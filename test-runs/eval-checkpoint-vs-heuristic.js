'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Engine = require('../src/engine.js');
const AI = require('../src/ai.js');
const { PolicyValueNetwork, mulberry32 } = require('../training/neural-policy.js');
const {
  enumerateLegalActions, currentActor, alignedParticlePool, particleBeliefWeights,
  BELIEF_DECAY, trainingPlacement, heuristicLevelFor
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
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS || 6);
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || MIN_PLAYERS);
const NETWORK_PLAYERS = Number(process.env.NETWORK_PLAYERS || 1);
const MAX_ROUNDS = Number(process.env.MAX_ROUNDS || 100);
const START_GAME_INDEX = Number(process.env.START_GAME_INDEX || 200001);
const NATIVE_WORKER = process.env.NATIVE_WORKER || path.join(ROOT, 'native', 'mcts_worker_libtorch.exe');

async function main() {
  const started = Date.now();
  const checkpointPath = path.join(ROOT, CHECKPOINT);
  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(checkpointPath)));
  const profile = payload.config.profile || 'large';
  const model = new PolicyValueNetwork({ profile, stateSize: 672, actionSize: 256 });
  model.import(payload.model);
  const flatPath = path.join(ROOT, 'training-data', 'eval-model-' + process.pid + '.bin');
  const flat = model.exportFlat();
  fs.writeFileSync(flatPath, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));

  let client;
  let wins = 0, top3 = 0, truncatedGames = 0, totalSteps = 0, totalGameMs = 0, totalSearchMs = 0;
  const searchStats = { decisions: 0, fallback: 0, zeroVisits: 0, visits: 0,
    expansions: 0, particlesUsed: 0, partialParticles: 0, beliefApplied: 0,
    actionFailures: 0, byPhase: {} };
  const playerWins = Array(MAX_PLAYERS).fill(0);
  const playerRanks = Array.from({ length: MAX_PLAYERS }, () => Array(MAX_PLAYERS).fill(0));
  try {
    client = new NativeSearchClient({
      root: ROOT, executable: NATIVE_WORKER,
      simulations: SIMULATIONS, maxDepth: MAX_DEPTH, batchSize: MCTS_BATCH_SIZE,
      cPuct: MCTS_C_PUCT, seed: SEED, gpuEvaluator: true, profile,
      device: process.env.EVAL_DEVICE || 'cuda', inferenceBackend: 'libtorch'
    });
    client.setModelPath(flatPath);

    for (let game = 1; game <= GAMES; game++) {
      const gameIndex = START_GAME_INDEX + game - 1;
      // 训练 worker 为每局创建一条随机流；人数、角色组、粒子、落子和对手
      // 共用它。保持相同消费顺序，评测训练范围外的未见对局。
      const rng = mulberry32(SEED ^ (gameIndex * 2246822519));
      const playerCount = MIN_PLAYERS + Math.floor(rng() *
        (MAX_PLAYERS - MIN_PLAYERS + 1));
      const charSet = ['base', 'dark', 'mixed'][Math.floor(rng() * 3)];
      // 训练会轮换策略网络的物理座位和开局皇冠；评测也必须保持这一点，
      // 否则固定 seat 0 会把座位/先手偏差误算成模型强弱。
      const placement = trainingPlacement({ seed: SEED }, gameIndex, playerCount, NETWORK_PLAYERS);
      const networkSeats = [...placement.networkSeats];
      const networkSeat = networkSeats[0];
      const seats = Array.from({ length: playerCount }, (_, i) => {
        const neural = placement.networkSeats.has(i);
        return {
          id: neural ? 'nn-' + i : 'h' + i,
          name: neural ? '策略网络' + i : '启发式' + i,
          isBot: true,
          botType: neural ? 'neural' : 'heuristic',
          botLevel: neural ? undefined : (HEURISTIC_LEVEL || heuristicLevelFor({
            seed: SEED, heuristicDifficulty: 'random'
          }, i, gameIndex))
        };
      });
      const state = Engine.createGame({
        roomId: 'eval-' + gameIndex, endDistricts: 8, charSetMode: charSet,
        seed: SEED + gameIndex * 7919, seats,
        initialCrownSeat: placement.initialCrownSeat
      });
      Engine.startGame(state);
      let steps = 0, searchMs = 0, gameStarted = Date.now();
      while (state.phase !== 'gameover' && steps < 100000 && state.round <= MAX_ROUNDS) {
        const actor = currentActor(state);
        if (!actor) throw new Error('没有当前行动者，phase=' + state.phase);
        const legal = enumerateLegalActions(state, actor.id);
        if (!legal.length) throw new Error('没有合法行动，player=' + actor.id);
        let action;
        if (actor.id.startsWith('nn-')) {
          const searchStarted = Date.now();
          // 与训练一致：4 个粒子共用一棵信息集搜索树，并按公开信息对粒子加权。
          // 不能把真实 state 直接交给 MCTS，否则会偷看对手手牌和牌库顺序。
          const pool = alignedParticlePool(state, actor.id, legal, rng, PARTICLES);
          if (!pool.length) throw new Error('确定化无法复现合法动作列表，game=' + game + ' step=' + steps);
          const weights = particleBeliefWeights(pool, actor.id, BELIEF_DECAY);
          const result = await client.search(pool.map(entry => entry.state), actor.id,
            pool[0].legal, 0, weights);
          searchMs += Date.now() - searchStarted;
          const phase = state.phase === 'draft' ? 'draft' : state.reaction ? 'reaction' :
            state.roundConfirm ? 'roundConfirm' : state.turn && state.turn.pending ?
              'pending' : 'action';
          const phaseStats = searchStats.byPhase[phase] ||
            (searchStats.byPhase[phase] = { decisions: 0, fallback: 0, zeroVisits: 0 });
          searchStats.decisions++;
          phaseStats.decisions++;
          if (result.fallback) { searchStats.fallback++; phaseStats.fallback++; }
          if (!(result.visits > 0)) { searchStats.zeroVisits++; phaseStats.zeroVisits++; }
          searchStats.visits += Number(result.visits) || 0;
          searchStats.expansions += Number(result.expansions) || 0;
          searchStats.particlesUsed += Number(result.particlesUsed) || 0;
          if (Number(result.particlesUsed) < PARTICLES) searchStats.partialParticles++;
          if (result.belief) searchStats.beliefApplied++;
          // 训练自对弈按 MCTS 访问分布采样，而不是始终取 argmax；保持同一行为策略。
          let r = rng();
          let chosen = Math.max(0, result.policy.length - 1);
          for (let i = 0; i < result.policy.length; i++) {
            r -= result.policy[i];
            if (r <= 0) { chosen = i; break; }
          }
          action = pool[0].legal[chosen];
        } else {
          const heuristicAction = AI.decide(state, actor.id, rng);
          const heuristicKey = heuristicAction && JSON.stringify(heuristicAction);
          action = legal.find(candidate => JSON.stringify(candidate) === heuristicKey) || legal[0];
        }
        const applied = Engine.applyAction(state, actor.id, action);
        if (!applied.ok) {
          if (actor.id.startsWith('nn-')) searchStats.actionFailures++;
          const fallback = legal.find(candidate => Engine.applyAction(state, actor.id, candidate).ok);
          if (!fallback) throw new Error('动作执行失败：' + JSON.stringify(applied));
        }
        steps++;
      }
      if (state.phase !== 'gameover') {
        if (state.round > MAX_ROUNDS) {
          state.scores = Engine.computeScores(state);
          truncatedGames++;
        } else {
          throw new Error('单局超过最大步数');
        }
      }
      const scores = state.scores || [];
      const networkIndices = state.players
        .map((player, index) => player.id.startsWith('nn-') ? index : -1)
        .filter(index => index >= 0);
      const networkRows = scores.filter(row => networkIndices.includes(row.playerIdx));
      const mine = networkRows[0];
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
      console.log(JSON.stringify({ game, gameIndex, playerCount, networkSeats, charSet, networkSeat,
        truncated: state.phase !== 'gameover',
        crownSeat: placement.initialCrownSeat,
        rank, win: rank === 1, steps, gameMs,
        nnSearchMs: searchMs, wins, winRate: (wins / game).toFixed(3) }));
    }
    console.log(JSON.stringify({
      type: 'final', checkpoint: CHECKPOINT, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS,
      startGameIndex: START_GAME_INDEX,
      maxRounds: MAX_ROUNDS, truncatedGames,
      networkPlayers: NETWORK_PLAYERS, simulations: SIMULATIONS, maxDepth: MAX_DEPTH,
      mctsBatchSize: MCTS_BATCH_SIZE, cPuct: MCTS_C_PUCT, particles: PARTICLES,
      beliefDecay: BELIEF_DECAY, inferenceBackend: 'libtorch', games: GAMES,
      wins, winRate: wins / GAMES, top3, top3Rate: top3 / GAMES,
      searchStats: { ...searchStats,
        fallbackRate: searchStats.fallback / Math.max(1, searchStats.decisions),
        zeroVisitsRate: searchStats.zeroVisits / Math.max(1, searchStats.decisions),
        avgVisits: searchStats.visits / Math.max(1, searchStats.decisions),
        avgExpansions: searchStats.expansions / Math.max(1, searchStats.decisions),
        avgParticlesUsed: searchStats.particlesUsed / Math.max(1, searchStats.decisions) },
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
