'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Engine = require('../src/engine.js');
const AI = require('../src/ai.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const { enumerateLegalActions, currentActor } = require('../training/train.js');
const { NativeSearchClient } = require('../training/native-search.js');
const { SharedInferenceDaemon } = require('../training/shared-inference.js');

const ROOT = path.join(__dirname, '..');
const CHECKPOINT = process.env.CHECKPOINT || 'training-data/checkpoint-004000-plarge-m300-egpu-crandom-s20260913.json.gz';
const GAMES = Number(process.env.GAMES || 100);
const SIMULATIONS = Number(process.env.SIMULATIONS || 500);

async function main() {
  const checkpointPath = path.join(ROOT, CHECKPOINT);
  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(checkpointPath)));
  const profile = payload.config.profile || 'large';
  const model = new PolicyValueNetwork({ profile, stateSize: 672, actionSize: 256 });
  model.import(payload.model);
  const flatPath = path.join(ROOT, 'training-data', 'eval-model-' + process.pid + '.bin');
  const flat = model.exportFlat();
  fs.writeFileSync(flatPath, Buffer.from(flat.buffer, flat.byteOffset, flat.byteLength));

  const started = Date.now();
  const daemon = new SharedInferenceDaemon({
    root: ROOT, modelPath: flatPath, profile, device: process.env.EVAL_DEVICE || 'cuda',
    onLog: text => console.log('[daemon] ' + text)
  });
  let client;
  let wins = 0, top3 = 0, totalSteps = 0, totalGameMs = 0, totalSearchMs = 0;
  const playerWins = Array(6).fill(0);
  const playerRanks = Array.from({ length: 6 }, () => Array(6).fill(0));
  try {
    const queue = await daemon.start();
    client = new NativeSearchClient({
      root: ROOT, executable: path.join(ROOT, 'native', 'mcts_worker.exe'),
      simulations: SIMULATIONS, maxDepth: 1000, batchSize: 256, cPuct: 1,
      seed: 20260913, gpuEvaluator: true, profile, device: process.env.EVAL_DEVICE || 'cuda',
      inferenceBackend: 'python-binary', sharedMemoryName: queue.name,
      sharedMemorySlots: queue.slots, sharedMemorySlotBytes: queue.slotBytes
    });
    client.setModelPath(flatPath);

    for (let game = 1; game <= GAMES; game++) {
      // 每局从基本、黑暗、混合三种角色组中伪随机选择；使用固定种子
      // 让评测可复现，同时避免按固定周期暴露角色组分布。
      const charSetSeed = Math.imul(20260913 + game * 7919, 1664525) + 1013904223;
      const charSet = ['base', 'dark', 'mixed'][(charSetSeed >>> 0) % 3];
      const seats = [{ id: 'nn', name: '策略网络', isBot: true, botType: 'neural', botLevel: 'hard' }];
      for (let i = 1; i < 6; i++) seats.push({
        id: 'h' + i, name: '启发式' + i, isBot: true, botType: 'heuristic',
        botLevel: ['easy', 'normal', 'hard'][(game + i) % 3]
      });
      const state = Engine.createGame({
        roomId: 'eval-' + game, endDistricts: 8, charSetMode: charSet,
        seed: 20260913 + game * 7919, seats
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
          const result = await client.search(state, actor.id, legal, game);
          searchMs += Date.now() - searchStarted;
          let best = 0;
          for (let i = 1; i < result.policy.length; i++)
            if (result.policy[i] > result.policy[best]) best = i;
          action = legal[best];
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
      type: 'final', checkpoint: CHECKPOINT, simulations: SIMULATIONS, games: GAMES,
      wins, winRate: wins / GAMES, top3, top3Rate: top3 / GAMES,
      totalSteps, avgSteps: totalSteps / GAMES, totalGameMs,
      avgGameMs: totalGameMs / GAMES, totalSearchMs,
      avgSearchMsPerGame: totalSearchMs / GAMES, avgSearchMsPerStep: totalSearchMs / totalSteps,
      playerWins, playerWinRates: playerWins.map(count => count / GAMES), playerRanks,
      totalWallMs: Date.now() - started
    }));
  } finally {
    if (client) client.close();
    await daemon.close();
    try { fs.unlinkSync(flatPath); } catch (_) { /* best effort */ }
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
