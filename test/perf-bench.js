// Perf benchmark: 每个 (profile, mctsSims) 组合跑 N 局取平均
// 用 JS 模式避免 GPU/PPO 干扰，单独测量 self-play 阶段每步推理耗时
'use strict';
const path = require('path');
const root = path.resolve(__dirname, '..');
const { PolicyValueNetwork, PROFILES, mulberry32 } = require(path.join(root, 'training/neural-policy.js'));
const { runSelfPlayGame, sanitizeConfig } = require(path.join(root, 'training/train.js'));

async function bench(profile, mctsSimulations, games, seedStart) {
  const config = sanitizeConfig({
    targetGames: games, batchGames: games, ppoEpochs: 1, miniBatch: 64,
    minPlayers: 4, maxPlayers: 4, profile, backend: 'js',
    seed: seedStart, checkpointEvery: 999999, workers: 1,
    mctsSimulations, mctsDirichletAlpha: 0, mctsDirichletEpsilon: 0
  });
  const model = new PolicyValueNetwork({ profile, stateSize: 192, actionSize: 64, seed: seedStart });
  const samples = [];
  for (let g = 0; g < games; g++) {
    const t0 = Date.now();
    const result = await runSelfPlayGame(model, config, g + 1, mulberry32((seedStart + g) * 2654435761 >>> 0), () => false);
    const ms = Date.now() - t0;
    samples.push({
      ms,
      steps: result.steps,
      perStepMs: ms / result.steps,
      rounds: result.rounds,
      inferenceMs: result.avgInferenceMs
    });
  }
  const avg = samples.reduce((a, b) => ({
    ms: a.ms + b.ms, steps: a.steps + b.steps, rounds: a.rounds + b.rounds,
    inferenceMs: a.inferenceMs + b.inferenceMs
  }), { ms: 0, steps: 0, rounds: 0, inferenceMs: 0 });
  return {
    profile, mctsSimulations, games,
    avgMsPerGame: avg.ms / games,
    avgSteps: avg.steps / games,
    avgRounds: avg.rounds / games,
    avgMsPerStep: avg.ms / avg.steps,
    avgInferenceMs: avg.inferenceMs / games,
    gamesPerMinute: (games / (avg.ms / games)) * 60 * 1000 / 60,
    samples
  };
}

async function main() {
  const COMBOS = [
    { profile: 'fast', sims: 0 },
    { profile: 'fast', sims: 50 },
    { profile: 'fast', sims: 200 },
    { profile: 'balanced', sims: 0 },
    { profile: 'balanced', sims: 50 },
    { profile: 'balanced', sims: 200 },
    { profile: 'large', sims: 0 },
    { profile: 'large', sims: 50 },
    { profile: 'large', sims: 200 }
  ];
  const GAMES = 2;
  console.log('基准：4 人局 · JS 模式 · mctsDirichletAlpha=0（仅测推理） · 每组合 ' + GAMES + ' 局');
  console.log('');
  console.log('profile  | sims | 局均秒 | 单步 ms | 局/分 | 10000 局估算');
  console.log('---------|------|--------|---------|-------|-------------');
  for (let i = 0; i < COMBOS.length; i++) {
    const { profile, sims } = COMBOS[i];
    const r = await bench(profile, sims, GAMES, 100000 + i * 977);
    const eta10k = (10000 / r.gamesPerMinute / 60).toFixed(1);
    console.log(profile.padEnd(8), '|', String(sims).padStart(4), '|', r.avgMsPerGame.toFixed(0).padStart(6), '|',
      r.avgMsPerStep.toFixed(1).padStart(6), '|', r.gamesPerMinute.toFixed(2).padStart(5), '|', (eta10k + ' 小时').padStart(10));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
