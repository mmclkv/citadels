'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const Engine = require('../src/engine.js');
const { enumerateLegalActions } = require('../training/train.js');

const TTA_VARIANTS = 16;
const MAX_INFERENCE_MS = 20000;

function createError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createLocalNeuralBot({
  root = path.join(__dirname, '..'),
  maxInferenceMs = MAX_INFERENCE_MS,
  ttaVariants = TTA_VARIANTS
} = {}) {
  const dataDir = path.join(root, 'training-data');
  const repositoryModel = path.join(root, 'models', 'policy-default.json.gz');
  const repositoryMeta = path.join(root, 'models', 'policy-default.meta.json');
  const workerFile = path.join(__dirname, 'local-neural-bot-worker.js');
  const configuredTimeout = Number(maxInferenceMs);
  const inferenceTimeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(1, Math.min(MAX_INFERENCE_MS, Math.floor(configuredTimeout)))
    : MAX_INFERENCE_MS;
  const configuredVariants = Number(ttaVariants);
  const variants = Number.isFinite(configuredVariants)
    ? Math.max(1, Math.min(TTA_VARIANTS, Math.floor(configuredVariants)))
    : TTA_VARIANTS;
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
        .filter(item => /^checkpoint-\d+\.json\.gz$/.test(item))
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
      durationMs: Date.now() - entry.startedAt };
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

  function requestDecision(checkpoint, view, playerId, actions, signal) {
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
        active.postMessage({ type: 'decide', id, checkpoint, view, playerId, actions, variants, deadlineAt });
      } catch (error) {
        pending.delete(id);
        clearEntry(entry);
        reject(error);
      }
    });
  }

  function status() {
    const checkpoint = latestCheckpoint();
    const tta = { variants, maxInferenceMs: inferenceTimeoutMs, lastInference };
    if (!checkpoint) return { configured: false, checkpoint: '', game: 0,
      message: '没有可用的本地神经网络 checkpoint，请先在训练控制台完成训练', tta };
    const sourceLabel = checkpoint.source === 'repository' ? '仓库默认模型' : '本地训练模型';
    return { configured: true, checkpoint: checkpoint.name, game: checkpoint.game,
      source: checkpoint.source,
      profile: loaded && loaded.key === checkpointKey(checkpoint) ? loaded.profile : checkpoint.profile,
      message: sourceLabel + '：' + checkpoint.name +
        (checkpoint.game ? '（已训练 ' + checkpoint.game + ' 局）' : ''), tta };
  }

  function decide(state, playerId, { signal } = {}) {
    const checkpoint = latestCheckpoint();
    if (!checkpoint) throw new Error('没有可用的本地神经网络 checkpoint，请先完成训练');
    const actions = enumerateLegalActions(state, playerId);
    if (!actions.length) throw new Error('本地神经网络没有可执行的合法行动');
    return requestDecision(checkpoint, Engine.sanitize(state, playerId), playerId, actions, signal);
  }

  function close() {
    stopWorker(createError('本地神经网络已关闭', 'closed'));
  }

  return { status, decide, close };
}

module.exports = { createLocalNeuralBot, MAX_INFERENCE_MS, TTA_VARIANTS };
