'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');
const Engine = require('../src/engine.js');
const HeuristicAI = require('../src/ai.js');
const { PolicyValueNetwork, PROFILES, mulberry32 } = require('./neural-policy.js');
const { TorchBridge } = require('./torch-bridge.js');
const { SelfPlayPool } = require('./selfplay-pool.js');
const { cloneTrimmed } = require('./search-state.js');
const { applyRecorded } = require('./undo.js');
const mcts = require('./mcts.js');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'training-data');
const STATE_SIZE = 192;
const ACTION_SIZE = 64;
const IGNORE_KEYS = new Set(['log', 'notices', 'available', 'roomName', 'name', 'label', 'desc', 'resumeToken']);

function hash32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function addFeature(vector, token, value = 1) {
  if (!Number.isFinite(value) || value === 0) return;
  const h = hash32(token);
  const index = h % vector.length;
  vector[index] += (h & 0x80000000 ? -1 : 1) * Math.max(-3, Math.min(3, value));
}

function walkFeatures(vector, value, pathName, context, depth = 0) {
  if (depth > 7 || value == null) return;
  if (typeof value === 'number') {
    addFeature(vector, pathName + ':number', Math.tanh(value / 10));
    addFeature(vector, pathName + ':bucket:' + Math.round(Math.max(-50, Math.min(50, value))));
    return;
  }
  if (typeof value === 'boolean') { addFeature(vector, pathName + ':' + value); return; }
  if (typeof value === 'string') {
    const mapped = context.playerIds.get(value);
    addFeature(vector, pathName + ':' + (mapped == null ? value.slice(0, 48) : 'player-rel-' + mapped));
    return;
  }
  if (Array.isArray(value)) {
    addFeature(vector, pathName + ':length', Math.tanh(value.length / 8));
    value.forEach((item, i) => walkFeatures(vector, item, pathName + '[' + Math.min(i, 15) + ']', context, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    Object.keys(value).sort().forEach(key => {
      if (IGNORE_KEYS.has(key) || key === 'uid') return;
      walkFeatures(vector, value[key], pathName + '.' + key, context, depth + 1);
    });
  }
}

function observationContext(view, playerId) {
  const players = view.players || [];
  const meIndex = Math.max(0, players.findIndex(p => p.id === playerId));
  const playerIds = new Map();
  players.forEach((p, i) => playerIds.set(p.id, (i - meIndex + players.length) % players.length));
  const cardIds = new Map();
  const collect = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (value.uid) cardIds.set(value.uid, value.id || value.en || value.name || (value.color + ':' + value.cost));
    Object.keys(value).forEach(k => { if (!IGNORE_KEYS.has(k)) collect(value[k]); });
  };
  collect(view);
  return { meIndex, playerIds, cardIds };
}

function encodeState(view, playerId) {
  const vector = new Float32Array(STATE_SIZE);
  const context = observationContext(view, playerId);
  addFeature(vector, 'bias');
  addFeature(vector, 'players', Math.tanh((view.players || []).length / 8));
  const players = view.players || [];
  for (let rel = 0; rel < players.length; rel++) {
    const p = players[(context.meIndex + rel) % players.length];
    walkFeatures(vector, p, 'player[' + rel + ']', context);
  }
  const global = {};
  Object.keys(view).forEach(k => { if (k !== 'players' && !IGNORE_KEYS.has(k)) global[k] = view[k]; });
  walkFeatures(vector, global, 'game', context);
  normalizeVector(vector);
  return { vector, context };
}

function encodeAction(action, context) {
  const vector = new Float32Array(ACTION_SIZE);
  addFeature(vector, 'bias');
  const normalized = {};
  Object.keys(action || {}).forEach(key => {
    if (key === 'label') return;
    const value = action[key];
    if ((key === 'uid' || key === 'discardUid' || key === 'cardUid') && context.cardIds.has(value)) {
      normalized[key] = 'card:' + context.cardIds.get(value);
    } else if (key === 'uids' && Array.isArray(value)) {
      normalized.uids = value.map(uid => 'card:' + (context.cardIds.get(uid) || 'unknown'));
    } else normalized[key] = value;
  });
  walkFeatures(vector, normalized, 'action', context);
  normalizeVector(vector);
  return vector;
}

function normalizeVector(vector) {
  let norm = 0;
  for (let i = 0; i < vector.length; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (norm > 1) for (let i = 0; i < vector.length; i++) vector[i] /= norm;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function uniqueActions(actions) {
  const seen = new Set();
  return actions.filter(action => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function redrawCandidates(action, hand) {
  const cards = (hand || []).slice();
  const byCost = cards.slice().sort((a, b) => a.cost - b.cost || String(a.uid).localeCompare(String(b.uid)));
  const out = [{ ...action, uids: [] }];
  if (cards.length) out.push({ ...action, uids: cards.map(c => c.uid) });
  for (let n = 1; n <= Math.min(4, cards.length); n++) {
    out.push({ ...action, uids: byCost.slice(0, n).map(c => c.uid) });
    out.push({ ...action, uids: byCost.slice(-n).map(c => c.uid) });
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
    } else if (action.type === 'choose_cards') candidates.push(...redrawCandidates(action, player.hand));
    else candidates.push(clone(action));
  }
  // 增量落子 + 撤销：只拷贝一份 base（掐掉 UI 字段），每个候选在 base 上 apply 后立刻
  // 撤销还原，而不是每个候选都做一次完整深拷贝。分支数越高省得越多（详见 training/undo.js）。
  // base 是 cloneTrimmed 出来的独立副本，applyRecorded 原地修改它、undo 再精确还原，
  // 因此循环结束后 base 与原始 state 逐字节等价（log/notices 始终为空）。
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
    } catch (_) { /* surfaced below */ }
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
  const totals = scores.map(row => row.total);
  const mean = totals.reduce((a, b) => a + b, 0) / Math.max(1, totals.length);
  const variance = totals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, totals.length);
  const std = Math.sqrt(variance + 1);
  const sorted = scores.slice().sort((a, b) => b.total - a.total);
  const rewards = new Map();
  scores.forEach(row => {
    const rank = sorted.findIndex(x => x.playerIdx === row.playerIdx);
    const rankTerm = scores.length === 1 ? 1 : 1 - 2 * rank / (scores.length - 1);
    const scoreTerm = (row.total - mean) / std;
    rewards.set(state.players[row.playerIdx].id, Math.max(-2, Math.min(2, 0.65 * scoreTerm + 0.35 * rankTerm)));
  });
  return rewards;
}

async function runSelfPlayGame(model, config, gameIndex, rng, shouldStop, evaluator = null, nativeSearch = null) {
  const playerCount = config.minPlayers + Math.floor(rng() * (config.maxPlayers - config.minPlayers + 1));
  const charSets = config.charSet === 'random' ? ['base', 'dark', 'mixed'] : [config.charSet];
  const charSet = charSets[Math.floor(rng() * charSets.length)];
  const seats = Array.from({ length: playerCount }, (_, i) => ({
    id: 'nn-' + gameIndex + '-' + i, name: '神经网络 ' + (i + 1), isBot: true, botType: 'neural'
  }));
  const state = Engine.createGame({
    roomId: 'training-' + gameIndex, endDistricts: config.endDistricts,
    charSetMode: charSet, seed: config.seed + gameIndex * 7919, seats
  });
  Engine.startGame(state);
  const transitions = [];
  let steps = 0, inferenceMs = 0, fallbackCount = 0;
  const startedAt = Date.now();
  while (state.phase !== 'gameover' && steps < config.maxSteps) {
    if (shouldStop()) break;
    const actor = currentActor(state);
    if (!actor) throw new Error('游戏停滞：当前没有行动玩家（阶段 ' + state.phase + '）');
    const legal = enumerateLegalActions(state, actor.id);
    if (!legal.length) throw new Error('游戏停滞：' + actor.name + ' 没有合法行动');
    const view = Engine.sanitize(state, actor.id);
    const encoded = encodeState(view, actor.id);
    const actionVectors = legal.map(action => encodeAction(action, encoded.context));
    const t0 = performance.now();
    const temperatureProgress = Math.min(1, gameIndex / Math.max(1, config.targetGames * 0.7));
    const temperature = config.temperatureStart + (config.temperatureEnd - config.temperatureStart) * temperatureProgress;
    let decision;
    let piVector = null;
    let mctsValue = null;
    if (config.backend === 'native' && nativeSearch) {
      const nativeResult = await nativeSearch.search(state, actor.id, legal, config.modelVersion || 0);
      piVector = nativeResult.policy;
      mctsValue = nativeResult.value;
      let r = rng();
      let chosen = Math.max(0, piVector.length - 1);
      for (let i = 0; i < piVector.length; i++) { r -= piVector[i]; if (r <= 0) { chosen = i; break; } }
      decision = { chosen, probability: piVector[chosen], value: mctsValue,
        entropy: 0, mctsVisits: nativeResult.visits || 0, mctsExpansions: nativeResult.expansions || 0 };
    } else if (config.mctsSimulations > 0) {
      const mctsResult = await mcts.search({
        rootState: state,
        rootPlayerId: actor.id,
        model,
        Engine,
        sanitize: Engine.sanitize,
        legalFn: enumerateLegalActions,
        rewardFn: gameRewards,
        encodeState,
        encodeAction,
        simulate: config.mctsSimulations,
        cPuct: config.mctsC_puct,
        dirichletAlpha: config.mctsDirichletAlpha,
        dirichletEpsilon: config.mctsDirichletEpsilon != null ? config.mctsDirichletEpsilon : 0.03,
        maxDepth: config.mctsMaxDepth,
        rng,
        evaluator
      });
      piVector = mctsResult.pi;
      mctsValue = mctsResult.value;
      // 按访问分布比例抽样；既然分布已含 Dirichlet 噪声，这里不再额外加 temperature
      let r = rng();
      let chosen = Math.max(0, piVector.length - 1);
      for (let i = 0; i < piVector.length; i++) {
        r -= piVector[i];
        if (r <= 0) { chosen = i; break; }
      }
      decision = { chosen, probability: piVector[chosen], value: mctsValue, entropy: 0,
        mctsVisits: mctsResult.visits, mctsExpansions: mctsResult.expansions };
    } else {
      decision = model.choose(encoded.vector, actionVectors, temperature);
    }
    inferenceMs += performance.now() - t0;
    if (legal.length > 1) {
      const transition = {
        playerId: actor.id, state: encoded.vector, actions: actionVectors, chosen: decision.chosen,
        oldProb: decision.probability, oldValue: decision.value, temperature
      };
      if (piVector) {
        // 序列化为普通数组以便后续 JSON 序列化（MCTS 模式向 GPU 训练侧暴露 π 目标）
        transition.pi = Array.from(piVector);
        transition.mctsValue = mctsValue;
      }
      transitions.push(transition);
    }
    let result = Engine.applyAction(state, actor.id, legal[decision.chosen]);
    if (!result.ok) {
      fallbackCount++;
      const fallback = legal.find(action => Engine.applyAction(cloneTrimmed(state), actor.id, action).ok);
      if (!fallback) throw new Error('神经网络选择无法执行且没有兜底行动：' + result.error);
      result = Engine.applyAction(state, actor.id, fallback);
    }
    steps++;
    // Yield periodically so the child process can receive a stop command even
    // during unusually long games instead of waiting for the whole game to end.
    if (steps % 16 === 0) await immediate();
  }
  if (state.phase !== 'gameover') {
    if (shouldStop()) return { stopped: true, transitions: [] };
    throw new Error('游戏超过最大步数 ' + config.maxSteps);
  }
  const rewards = gameRewards(state);
  transitions.forEach(tr => { tr.reward = rewards.get(tr.playerId) || 0; });
  const winning = state.winner == null ? [] : [state.winner];
  return {
    transitions, steps, rounds: state.round, durationMs: Date.now() - startedAt,
    avgInferenceMs: inferenceMs / Math.max(1, steps), fallbackCount, playerCount, charSet,
    rewards: Array.from(rewards.values()), scores: state.scores.map(s => s.total), winners: winning
  };
}

function sanitizeConfig(input = {}) {
  const minPlayers = Math.max(2, Math.min(8, Number(input.minPlayers) || 4));
  const maxPlayers = Math.max(minPlayers, Math.min(8, Number(input.maxPlayers) || minPlayers));
  const mctsSimulations = Math.max(0, Math.min(10000, Number(input.mctsSimulations) || 0));
  return {
    targetGames: Math.max(1, Math.min(1000000, Number(input.targetGames) || 10000)),
    minPlayers, maxPlayers,
    charSet: ['base', 'dark', 'mixed', 'random'].includes(input.charSet) ? input.charSet : 'random',
    endDistricts: [7, 8].includes(Number(input.endDistricts)) ? Number(input.endDistricts) : 8,
    profile: PROFILES[input.profile] ? input.profile : 'balanced',
    backend: ['gpu', 'cpu', 'js', 'native'].includes(input.backend) ? input.backend : 'gpu',
    nativeSearchWorker: input.nativeSearchWorker ? String(input.nativeSearchWorker) : '',
    learningRate: Math.max(1e-6, Math.min(0.01, Number(input.learningRate) || 0.0003)),
    batchGames: Math.max(1, Math.min(32, Number(input.batchGames) || 4)),
    ppoEpochs: Math.max(1, Math.min(6, Number(input.ppoEpochs) || 2)),
    miniBatch: Math.max(32, Math.min(2048, Number(input.miniBatch) || 256)),
    workers: Math.max(1, Math.min(6, Number(input.workers) || Math.max(1, Math.min(4, os.cpus().length - 2)))),
    checkpointEvery: Math.max(1, Math.min(10000, Number(input.checkpointEvery) || 100)),
    seed: Math.floor(Number(input.seed) || 20260913),
    maxSteps: Math.max(1000, Math.min(100000, Number(input.maxSteps) || 60000)),
    temperatureStart: Math.max(0.2, Math.min(2, Number(input.temperatureStart) || 1.1)),
    temperatureEnd: Math.max(0.15, Math.min(1.5, Number(input.temperatureEnd) || 0.65)),
    resumeCheckpoint: input.resumeCheckpoint ? path.basename(String(input.resumeCheckpoint)) : '',
    mctsSimulations,
    mctsC_puct: Math.max(0, Math.min(10, Number(input.mctsC_puct) || 1.0)),
    mctsDirichletAlpha: Math.max(0, Math.min(1, Number(input.mctsDirichletAlpha) || 0.3)),
    mctsDirichletEpsilon: Math.max(0.001, Math.min(1, Number(input.mctsDirichletEpsilon) || 0.03)),
    mctsMaxDepth: Math.max(10, Math.min(2000, Number(input.mctsMaxDepth) || 200)),
    mctsEvaluator: ['js', 'gpu'].includes(input.mctsEvaluator) ? input.mctsEvaluator : 'js',
    mctsBatchSize: Math.max(1, Math.min(256, Number(input.mctsBatchSize) || 32)),
    // 0 是合法值，表示"不限制等待"（等满批或显式 flush 才发）；仅 undefined/NaN 取默认 1
    mctsMaxWaitMs: Math.max(0, Math.min(50, Number.isFinite(Number(input.mctsMaxWaitMs)) ? Number(input.mctsMaxWaitMs) : 1)),
    mctsCacheSize: Math.max(0, Math.min(1048576, Number(input.mctsCacheSize) || 65536)),
    policyLossMode: ['auto', 'ppo', 'mcts_ce'].includes(input.policyLossMode) ? input.policyLossMode : 'auto'
  };
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data); fs.renameSync(tmp, file);
}

function sampleHistory(history, limit = 400) {
  if (history.length <= limit) return history.slice();
  const sampled = [];
  for (let i = 0; i < limit; i++) sampled.push(history[Math.round(i * (history.length - 1) / (limit - 1))]);
  return sampled;
}

// 把训练配置里「会影响模型走向」的几个维度拼成可读、ASCII 安全、不带歧义的
// checkpoint 后缀。训练者一眼就能从文件名区分出不同配置的产物：
//   p<profile>    fast / balanced / large，决定网络层宽与深度
//   m<mctsSims>   每步 MCTS 模拟数（0 = 未启用），决定训练目标分布的平滑度
//   e<evaluator>  js / gpu，js 是 worker 内本地网络；gpu 是 PyTorch 批量 forward
//   c<charSet>    random / base / dark / mixed，决定训练分布
//   s<seed>       随机种子，决定初始权重与采样路径
function configTag(config) {
  const profile = PROFILES[config.profile] ? config.profile : 'balanced';
  const mcts = Math.max(0, Math.min(10000, Math.round(Number(config.mctsSimulations) || 0)));
  const evaluator = (config.mctsEvaluator === 'gpu') ? 'gpu' : 'js';
  const charSet = ['base', 'dark', 'mixed', 'random'].includes(config.charSet) ? config.charSet : 'random';
  const seed = Math.floor(Number(config.seed) || 0);
  return ['p' + profile, 'm' + mcts, 'e' + evaluator, 'c' + charSet, 's' + seed].join('-');
}

function saveCheckpoint(model, config, game, history) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const name = 'checkpoint-' + String(game).padStart(6, '0') + '-' + configTag(config) + '.json.gz';
  const payload = JSON.stringify({ createdAt: new Date().toISOString(), game, config, model: model.export(), history: sampleHistory(history) });
  atomicWrite(path.join(DATA_DIR, name), zlib.gzipSync(payload, { level: 6 }));
  return name;
}

function loadCheckpoint(model, name) {
  if (!name) return { game: 0, history: [] };
  const file = path.join(DATA_DIR, path.basename(name));
  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  model.import(payload.model);
  return { game: Number(payload.game) || 0, history: Array.isArray(payload.history) ? payload.history : [] };
}

function send(message) { if (process.send) process.send(message); else console.log(JSON.stringify(message)); }
// 训练过程中各阶段产出的人读日志。事件流：
//   启动横幅 / 设备 / resume / worker 池 / 进度点 / PPO 更新 / 存档 / 异常 / 收尾
// 通过 {type:'log'} 推到 training-manager → UI 右下「事件与错误」面板，
// 同时附加在父进程 stdout 上，方便命令行直接看。
function log(text) {
  const line = '[train] ' + String(text || '');
  send({ type: 'log', text: line });
  if (!process.send) console.log(line);
}
function immediate() { return new Promise(resolve => setImmediate(resolve)); }

async function train(rawConfig, hooks = {}) {
  const config = sanitizeConfig(rawConfig);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const model = new PolicyValueNetwork({ profile: config.profile, stateSize: STATE_SIZE, actionSize: ACTION_SIZE, seed: config.seed });
  const restored = loadCheckpoint(model, config.resumeCheckpoint);
  let completedGames = restored.game;
  const initialCompletedGames = completedGames;
  let stopping = false, pool = null;
  process.on('message', msg => {
    if (msg && msg.type === 'stop') { stopping = true; if (pool) pool.stop(); }
  });
  let torch = null, accelerator = { device: 'JavaScript CPU', torch: '', cuda: '', gpu: '' };
  // 启动横幅：让用户在事件日志里一眼确认配置与设备
  log('启动训练：profile=' + config.profile + ' · 玩家 ' + config.minPlayers + '-' + config.maxPlayers +
    ' · 目标 ' + config.targetGames + ' 局 · 每批 ' + config.batchGames + ' 局 · ' +
    'workers=' + config.workers + ' · 策略损失=' + (config.policyLossMode === 'auto' && config.mctsSimulations > 0 ? 'MCTS 交叉熵' : config.policyLossMode.toUpperCase()) +
    ' · PPO epochs=' + config.ppoEpochs + ' · miniBatch=' + config.miniBatch +
    ' · lr=' + config.learningRate + ' · seed=' + config.seed);
  if (config.mctsSimulations > 0) {
    log('MCTS 已启用：每步 ' + config.mctsSimulations + ' 模拟 · c_puct=' + config.mctsC_puct +
      ' · α=' + config.mctsDirichletAlpha + ' · ε=' + config.mctsDirichletEpsilon +
      ' · maxDepth=' + config.mctsMaxDepth +
      ' · 评估器=' + config.mctsEvaluator + '（' +
      (config.mctsEvaluator === 'gpu'
        ? 'GPU 批量 forward 走 PyTorch 桥，批 ' + config.mctsBatchSize + ' · 等待 ' + config.mctsMaxWaitMs + 'ms'
        : 'worker 内 JS 网络同步 forward') + '）');
  } else {
    log('MCTS 未启用，自对弈按网络 softmax 采样');
  }
  if (config.resumeCheckpoint) {
    log('从存档继续：' + config.resumeCheckpoint + '（已训 ' + restored.game + ' 局，历史 ' + restored.history.length + ' 帧）');
  }
  if (config.backend !== 'js') {
    torch = new TorchBridge({ root: ROOT, model, config, onLog: text => log('PyTorch: ' + text) });
    accelerator = await torch.start(config.resumeCheckpoint);
    log('训练器已启动：设备=' + accelerator.device + (accelerator.gpu ? ' · 显卡=' + accelerator.gpu : '') +
      (accelerator.torch ? ' · PyTorch ' + accelerator.torch : '') +
      (accelerator.cuda ? ' · CUDA ' + accelerator.cuda : ''));
  } else {
    log('训练器：JavaScript CPU（无 PyTorch 桥）');
  }
  const startedAt = Date.now();
  const rng = mulberry32(config.seed ^ 0xA53C9E11);
  let history = restored.history.slice();
  const recentGames = [];
  const winSeats = Array(8).fill(0);
  let totalSteps = 0, totalInferenceMs = 0, totalFallbacks = 0;
  let rollout = [];
  if (torch && !stopping) {
    const poolOpts = { root: ROOT, config,
      size: Math.min(config.workers, config.batchGames), onLog: text => log(text) };
    if (config.mctsSimulations > 0 && config.mctsEvaluator === 'gpu') {
      // MCTS 在 worker 里跑，但神经网络 forward 走 PyTorch 子进程：主进程把 IPC 转发给 torch.batchForward。
      // 多个 worker 会同时发起 forwardBatch，靠 selfplay-pool 内部按到达顺序代理，靠 torch-bridge 的
      // FIFO 串行发给 Python；不会出现响应错位。
      poolOpts.batchForward = (stateVectors, actionVectorsList) =>
        torch.batchForward({ stateVectors, actionVectorsList });
      log('MCTS 评估：worker 把批量 forward 转发给主进程 → torch.batchForward（PyTorch）');
    } else if (config.mctsSimulations > 0) {
      log('MCTS 评估：worker 内本地 JS 网络 forward（mctsEvaluator=js）');
    }
    pool = new SelfPlayPool(poolOpts);
  }
  if (pool) log('Worker 池已起：' + pool.size + ' 个并行自对弈 worker（每批并发跑 ' + config.batchGames + ' 局）');
  const shouldStop = () => stopping || (hooks.shouldStop && hooks.shouldStop());
  send({ type: 'started', config, parameterCount: model.parameterCount, completedGames,
    hardware: { cpu: os.cpus()[0] && os.cpus()[0].model, logicalCores: os.cpus().length,
      memoryGB: +(os.totalmem() / 2 ** 30).toFixed(1), runtime: process.version,
      device: accelerator.device, torch: accelerator.torch, cuda: accelerator.cuda, gpu: accelerator.gpu } });

  try {
  while (completedGames < config.targetGames && !shouldStop()) {
    let results;
    if (pool) {
      const count = Math.min(config.batchGames, config.targetGames - completedGames);
      const indices = Array.from({ length: count }, (_, i) => completedGames + i + 1);
      results = await pool.run(indices, torch.modelPath, completedGames);
    } else {
      const result = await runSelfPlayGame(model, config, completedGames + 1, rng, shouldStop);
      results = result.stopped ? [] : [{ gameIndex: completedGames + 1, ...result }];
    }
    if (!results.length) break;
    for (const result of results) {
      completedGames++;
      rollout.push(...result.transitions);
      totalSteps += result.steps;
      totalInferenceMs += result.avgInferenceMs * result.steps;
      totalFallbacks += result.fallbackCount;
      result.winners.forEach(seat => { if (seat >= 0 && seat < winSeats.length) winSeats[seat]++; });
      recentGames.push(result);
      if (recentGames.length > 50) recentGames.shift();
      // 异常局：单局时间显著高于近期均值时打印一次，便于训练者定位慢局
      const SLOW_GAME_FACTOR = 5;
      const slowThreshold = recentGames.length > 1
        ? (recentGames.slice(0, -1).reduce((sum, g) => sum + g.durationMs, 0) / (recentGames.length - 1)) * SLOW_GAME_FACTOR
        : Infinity;
      if (result.durationMs > slowThreshold) {
        log('游戏 #' + result.gameIndex + ' 异常耗时 ' + (result.durationMs / 1000).toFixed(1) + 's · ' +
          result.steps + ' 步 · ' + result.playerCount + ' 人 · rounds=' + result.rounds);
      }
    }
    let losses = history.length ? history[history.length - 1] :
      { policyLoss: 0, valueLoss: 0, totalLoss: 0, entropy: 0, clipFraction: 0, approxKl: 0, gradientNorm: 0 };
    let justTrained = false;
    if ((pool || completedGames % config.batchGames === 0) && rollout.length) {
      losses = torch ? await torch.train(rollout) :
        model.trainPPO(rollout, { learningRate: config.learningRate, epochs: config.ppoEpochs, policyLossMode: config.policyLossMode });
      justTrained = true;
      // 打印最近一次 PPO 的指标摘要（每批一次），方便在事件日志里看趋势
      log('策略更新（' + (config.policyLossMode === 'auto' && config.mctsSimulations > 0 ? 'MCTS 交叉熵' : config.policyLossMode.toUpperCase()) + '）：策略损失 ' + losses.policyLoss.toExponential(2) +
        ' · 价值损失 ' + Number(losses.valueLoss).toFixed(4) +
        ' · 熵 ' + Number(losses.entropy).toFixed(3) +
        ' · 裁剪率 ' + (losses.clipFraction * 100).toFixed(1) + '%' +
        ' · KL ' + Number(losses.approxKl || 0).toFixed(4) +
        ' · 梯度 ' + Number(losses.gradientNorm || 0).toFixed(3) +
        (losses.gpuMemoryMB ? ' · 显存 ' + losses.gpuMemoryMB + ' MB' : ''));
      rollout = [];
    }
    const checkpointDue = completedGames % config.checkpointEvery === 0 || completedGames === config.targetGames;
    let checkpoint = '';
    const elapsedMs = Date.now() - startedAt;
    const recentDuration = recentGames.reduce((sum, g) => sum + g.durationMs, 0) / recentGames.length;
    const recentScore = recentGames.reduce((sum, g) => sum + g.scores.reduce((a, b) => a + b, 0) / g.scores.length, 0) / recentGames.length;
    const recentReward = recentGames.reduce((sum, g) => sum + g.rewards.reduce((a, b) => a + b, 0) / g.rewards.length, 0) / recentGames.length;
    const point = {
      game: completedGames, elapsedMs, steps: totalSteps, policyLoss: losses.policyLoss,
      valueLoss: losses.valueLoss, totalLoss: losses.totalLoss, entropy: losses.entropy,
      clipFraction: losses.clipFraction, approxKl: losses.approxKl || 0, gradientNorm: losses.gradientNorm || 0,
      gpuMemoryMB: losses.gpuMemoryMB || 0,
      gamesPerMinute: (completedGames - initialCompletedGames) / Math.max(1e-6, elapsedMs / 60000),
      avgGameMs: recentDuration, avgInferenceMs: totalInferenceMs / Math.max(1, totalSteps),
      avgScore: recentScore, avgReward: recentReward, fallbacks: totalFallbacks,
      avgRounds: recentGames.reduce((sum, g) => sum + g.rounds, 0) / recentGames.length,
      winSeats: winSeats.slice(0, config.maxPlayers),
      mctsSimulations: config.mctsSimulations,
      mctsC_puct: config.mctsC_puct,
      mctsDirichletAlpha: config.mctsDirichletAlpha
    };
    history.push(point);
    if (history.length > 800) history = sampleHistory(history, 400);
    // 进度点：每 batch 一次打印一行总览，训练者不用打开 UI 也能看到节奏
    if (justTrained || results.some(r => r.gameIndex % Math.max(1, config.batchGames) === 0)) {
      const pct = (completedGames / config.targetGames * 100).toFixed(1);
      const etaMs = point.gamesPerMinute > 0 ? (config.targetGames - completedGames) / point.gamesPerMinute * 60000 : NaN;
      const etaStr = Number.isFinite(etaMs) ? ' · 预计剩余 ' + Math.round(etaMs / 60000) + ' 分钟' : '';
      log('进度 ' + completedGames + '/' + config.targetGames + ' 局（' + pct + '%）· ' +
        '整局 ' + (point.avgGameMs / 1000).toFixed(2) + 's · 单步 ' + point.avgInferenceMs.toFixed(2) + 'ms · ' +
        point.gamesPerMinute.toFixed(1) + ' 局/分 · avg_score=' + point.avgScore.toFixed(1) +
        ' · avg_reward=' + point.avgReward.toFixed(2) + ' · rounds=' + point.avgRounds.toFixed(1) +
        etaStr);
    }
    if (checkpointDue) {
      checkpoint = saveCheckpoint(model, config, completedGames, history);
      if (torch) await torch.checkpoint(checkpoint);
      const sizeKB = (fs.statSync(path.join(DATA_DIR, checkpoint)).size / 1024).toFixed(0);
      log('存档：' + checkpoint + '（' + sizeKB + ' KB）');
    }
    send({ type: 'progress', point, history: sampleHistory(history), checkpoint });
    if (hooks.onProgress) hooks.onProgress(point);
    await immediate();
  }

  if (rollout.length && !shouldStop()) {
    if (torch) await torch.train(rollout);
    else model.trainPPO(rollout, { learningRate: config.learningRate, epochs: 1, policyLossMode: config.policyLossMode });
  }
  const finalCheckpoint = completedGames > 0 ? saveCheckpoint(model, config, completedGames, history) : '';
  if (torch && finalCheckpoint) await torch.checkpoint(finalCheckpoint);
  const final = { type: shouldStop() ? 'stopped' : 'completed', completedGames,
    targetGames: config.targetGames, elapsedMs: Date.now() - startedAt, checkpoint: finalCheckpoint };
  send(final);
  const elapsedMin = (final.elapsedMs / 60000).toFixed(1);
  const reason = shouldStop() ? '被停止' : '完成';
  log('训练' + reason + '：共 ' + completedGames + ' / ' + config.targetGames + ' 局 · 用时 ' + elapsedMin + ' 分钟 · ' +
    'checkpoint=' + (finalCheckpoint || '(无)'));
  return final;
  } finally {
    if (pool) await pool.close();
    if (torch) await torch.close();
  }
}

if (require.main === module) {
  let config = {};
  try { config = JSON.parse(process.env.CITADELS_TRAIN_CONFIG || '{}'); }
  catch (e) { console.error('训练配置不是有效 JSON'); process.exit(2); }
  train(config)
    .then(() => { if (process.disconnect) process.disconnect(); })
    .catch(error => {
      send({ type: 'error', message: error.message, stack: error.stack });
      process.exitCode = 1;
      if (process.disconnect) process.disconnect();
    });
}

module.exports = {
  train, runSelfPlayGame, sanitizeConfig, encodeState, encodeAction,
  enumerateLegalActions, currentActor, gameRewards, sampleHistory, redrawCandidates,
  cloneTrimmed, STATE_SIZE, ACTION_SIZE, DATA_DIR
};
