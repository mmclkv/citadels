'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const Engine = require('../src/engine.js');
const { enumerateLegalActions } = require('../training/train.js');
const { determinize } = require('../training/determinize.js');
const { beliefWeights } = require('../training/belief.js');

const TTA_VARIANTS = 64;
const MAX_INFERENCE_MS = 20000;
// 信息集搜索的粒子池大小：每条模拟从池里抽一份「隐藏信息猜测」。
// 注意与旧实现的区别 —— 模拟预算不再在几份猜测之间平摊，而是全部进同一棵树。
const MCTS_DETERMINIZATIONS = 4;
const MCTS_MAX_DETERMINIZATIONS = 8;
const MCTS_MAX_SIMULATIONS = 2000;
const MCTS_DEFAULT_MAX_DEPTH = 60;
const MCTS_MAX_DEPTH_CAP = 200;
// 信念强度：粒子每违反一张「他有钱却没建」的牌，权重乘一次这个数。
// 1 = 关掉信念（退回均匀采样）；越小越相信「对手是理性的」。
const MCTS_BELIEF_DECAY = 0.15;

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 归一化房主的 MCTS 设置；模拟数为 0（默认）表示关闭搜索，退回纯策略网络走子。 */
function normalizeMcts(mcts) {
  const requested = Math.floor(Number(mcts && mcts.simulations) || 0);
  const simulations = Math.max(0, Math.min(MCTS_MAX_SIMULATIONS, requested));
  if (!simulations) return null;
  const depth = Math.floor(Number(mcts && mcts.maxDepth) || 0);
  const particles = Math.max(1, Math.min(MCTS_MAX_DETERMINIZATIONS,
    Math.floor(Number(mcts && mcts.particles) || MCTS_DETERMINIZATIONS)));
  return { simulations,
    maxDepth: Math.max(1, Math.min(MCTS_MAX_DEPTH_CAP, depth || MCTS_DEFAULT_MAX_DEPTH)),
    particles };
}

function createLocalNeuralBot({
  root = path.join(__dirname, '..'),
  maxInferenceMs = MAX_INFERENCE_MS,
  ttaVariants = TTA_VARIANTS,
  determinizationCount = MCTS_DETERMINIZATIONS,
  beliefDecay = MCTS_BELIEF_DECAY,
  rng
} = {}) {
  const dataDir = path.join(root, 'training-data');
  const repositoryModel = path.join(root, 'models', 'policy-default.json.gz');
  const repositoryMeta = path.join(root, 'models', 'policy-default.meta.json');
  const workerFile = path.join(__dirname, 'local-neural-bot-worker.js');
  const decay = Number.isFinite(Number(beliefDecay)) ? Number(beliefDecay) : MCTS_BELIEF_DECAY;
  const BELIEF_DECAY = Math.max(0, Math.min(1, decay));
  const configuredTimeout = Number(maxInferenceMs);
  const inferenceTimeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(1, Math.min(MAX_INFERENCE_MS, Math.floor(configuredTimeout)))
    : MAX_INFERENCE_MS;
  const configuredVariants = Number(ttaVariants);
  const variants = Number.isFinite(configuredVariants)
    ? Math.max(1, Math.min(TTA_VARIANTS, Math.floor(configuredVariants)))
    : TTA_VARIANTS;
  const configuredDeterminizations = Number(determinizationCount);
  const determinizations = Number.isFinite(configuredDeterminizations)
    ? Math.max(1, Math.min(MCTS_MAX_DETERMINIZATIONS, Math.floor(configuredDeterminizations)))
    : MCTS_DETERMINIZATIONS;
  let worker = null;
  let workerKey = '';
  let nextRequestId = 1;
  let loaded = null;
  let lastInference = null;
  const pending = new Map();

  function repositoryCheckpoint() {
    try {
      const stat = fs.statSync(repositoryModel);
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(repositoryMeta, 'utf8')); } catch (_) { /* optional */ }
      return { name: path.basename(repositoryModel), file: repositoryModel,
        stamp: stat.mtimeMs + ':' + stat.size, game: Number(meta.game) || 0,
        profile: meta.profile || '', source: 'repository' };
    } catch (_) { return null; }
  }

  function latestLocalCheckpoint() {
    try {
      const names = fs.readdirSync(dataDir)
        .filter(item => /^checkpoint-[\w-]+\.json\.gz$/.test(item))
        .sort((a, b) => Number((b.match(/\d+/) || [0])[0]) - Number((a.match(/\d+/) || [0])[0]));
      const name = names[0];
      if (!name) return null;
      const file = path.join(dataDir, name);
      const stat = fs.statSync(file);
      return { name, file, stamp: stat.mtimeMs + ':' + stat.size,
        game: Number((name.match(/\d+/) || [0])[0]) || 0, source: 'training' };
    } catch (_) { return null; }
  }

  function latestCheckpoint() { return repositoryCheckpoint() || latestLocalCheckpoint(); }

  function checkpointKey(checkpoint) {
    return checkpoint.file + ':' + checkpoint.stamp;
  }

  function clearEntry(entry) {
    clearTimeout(entry.timeout);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
  }

  function rejectPending(error) {
    for (const entry of pending.values()) {
      clearEntry(entry);
      entry.reject(error);
    }
    pending.clear();
  }

  function stopWorker(error) {
    const active = worker;
    worker = null;
    workerKey = '';
    if (active) active.terminate().catch(() => {});
    if (error) rejectPending(error);
  }

  function failWorker(active, error) {
    if (worker !== active) return;
    worker = null;
    workerKey = '';
    rejectPending(error);
  }

  function settle(message) {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearEntry(entry);
    if (message.error) {
      entry.reject(createError(message.error.message || '本地神经网络推理失败', message.error.code));
      return;
    }
    if (!Number.isInteger(message.selected) || message.selected < 0 || message.selected >= entry.actions.length) {
      entry.reject(createError('本地神经网络返回了无效行动索引', 'invalid_action'));
      return;
    }
    loaded = { key: entry.key, profile: message.profile || '' };
    lastInference = { variants: message.variants, timedOut: !!message.timedOut,
      method: message.method || 'tta', determinizations: message.determinizations || 0,
      visits: message.visits || 0, durationMs: Date.now() - entry.startedAt };
    entry.resolve(entry.actions[message.selected]);
  }

  function ensureWorker(checkpoint) {
    const key = checkpointKey(checkpoint);
    if (worker && workerKey === key) return worker;
    if (worker) stopWorker(createError('本地神经网络 checkpoint 已更新', 'checkpoint_changed'));
    const active = new Worker(workerFile);
    worker = active;
    workerKey = key;
    active.on('message', settle);
    active.on('error', error => failWorker(active, error));
    active.on('exit', code => {
      if (code !== 0) failWorker(active, createError('本地神经网络工作线程异常退出（code=' + code + '）', 'worker_exit'));
    });
    return active;
  }

  function requestDecision(checkpoint, view, playerId, actions, signal, search) {
    if (signal && signal.aborted) return Promise.reject(createError('本地神经网络推理已取消', 'aborted'));
    const active = ensureWorker(checkpoint);
    const id = nextRequestId++;
    const startedAt = Date.now();
    const deadlineAt = startedAt + inferenceTimeoutMs;
    const key = checkpointKey(checkpoint);
    return new Promise((resolve, reject) => {
      const entry = { actions, resolve, reject, signal, startedAt, key, timeout: null, onAbort: null };
      entry.timeout = setTimeout(() => {
        if (!pending.has(id)) return;
        stopWorker(createError('本地神经网络单步推理超过 ' + inferenceTimeoutMs + 'ms', 'timeout'));
      }, inferenceTimeoutMs);
      entry.onAbort = () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearEntry(entry);
        reject(createError('本地神经网络推理已取消', 'aborted'));
      };
      if (signal) signal.addEventListener('abort', entry.onAbort, { once: true });
      pending.set(id, entry);
      try {
        active.postMessage({ type: 'decide', id, checkpoint, view, playerId, actions, variants, deadlineAt,
          states: search ? search.states : null, weights: search ? search.weights : null,
          mcts: search ? search.mcts : null });
      } catch (error) {
        pending.delete(id);
        clearEntry(entry);
        reject(error);
      }
    });
  }

  /**
   * 生成搜索用的粒子池 —— 若干份与公开信息一致的确定化世界。
   *
   * 这些世界不各建一棵树，而是交给一次 ISMCTS：每条模拟从池里抽一份，树按信息集
   * 聚合。所以份数不再是「预算要切成几份」，而是「信念采样几个粒子」。
   *
   * 只有「合法动作集与真实局面逐字相同」的猜测才能进池：猜测改了合法动作，说明它
   * 已经不是当前这个公开局面，丢掉比将就搜更安全。
   */
  function determinizeRoots(state, playerId, actions, count) {
    const baseline = JSON.stringify(actions);
    const roots = [];
    for (let attempt = 0; attempt < count * 3 && roots.length < count; attempt++) {
      let candidate;
      try {
        candidate = determinize(state, playerId, rng);
        const legal = enumerateLegalActions(candidate, playerId);
        if (JSON.stringify(legal) !== baseline) continue;
      } catch (_) { continue; }
      roots.push(candidate);
    }
    return roots;
  }

  /**
   * 粒子池 + 信念权重。
   * 均匀重洗出来的每个世界在边际上都合法，但「他有钱却没建」这类公开事实能把一大
   * 半世界直接排除掉 —— 交给搜索前先按事实给它们定权重（training/belief.js）。
   */
  function beliefParticles(state, playerId, actions, count) {
    const particles = determinizeRoots(state, playerId, actions, count);
    if (particles.length < 2) return { particles, weights: null };
    return { particles, weights: beliefWeights(particles, playerId, { decay: BELIEF_DECAY }) };
  }

  function status() {
    const checkpoint = latestCheckpoint();
    const tta = { variants, maxInferenceMs: inferenceTimeoutMs, lastInference };
    const mcts = { determinizations, beliefDecay: BELIEF_DECAY,
      maxSimulations: MCTS_MAX_SIMULATIONS,
      defaultMaxDepth: MCTS_DEFAULT_MAX_DEPTH, maxDepthCap: MCTS_MAX_DEPTH_CAP };
    if (!checkpoint) return { configured: false, checkpoint: '', game: 0,
      message: '没有可用的本地神经网络 checkpoint，请先在训练控制台完成训练', tta, mcts };
    const sourceLabel = checkpoint.source === 'repository' ? '仓库默认模型' : '本地训练模型';
    return { configured: true, checkpoint: checkpoint.name, game: checkpoint.game,
      source: checkpoint.source,
      profile: loaded && loaded.key === checkpointKey(checkpoint) ? loaded.profile : checkpoint.profile,
      message: sourceLabel + '：' + checkpoint.name +
        (checkpoint.game ? '（已训练 ' + checkpoint.game + ' 局）' : ''), tta, mcts };
  }

  function decide(state, playerId, { signal, mcts } = {}) {
    const checkpoint = latestCheckpoint();
    if (!checkpoint) throw new Error('没有可用的本地神经网络 checkpoint，请先完成训练');
    const actions = enumerateLegalActions(state, playerId);
    if (!actions.length) throw new Error('本地神经网络没有可执行的合法行动');
    const plan = normalizeMcts(mcts);
    let search = null;
    if (plan) {
      const { particles, weights } = beliefParticles(state, playerId, actions, plan.particles || determinizations);
      if (particles.length) search = { states: particles, weights, mcts: plan };
    }
    return requestDecision(checkpoint, Engine.sanitize(state, playerId), playerId, actions, signal, search);
  }

  function close() {
    stopWorker(createError('本地神经网络已关闭', 'closed'));
  }

  return { status, decide, close };
}

module.exports = { createLocalNeuralBot, normalizeMcts, MAX_INFERENCE_MS, TTA_VARIANTS,
  MCTS_MAX_SIMULATIONS, MCTS_MAX_DEPTH_CAP };
