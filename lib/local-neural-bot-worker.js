'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { parentPort } = require('worker_threads');
const Engine = require('../src/engine.js');
const mcts = require('../training/mcts.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const { encodeState, encodeAction, enumerateLegalActions, gameRewards } = require('../training/train.js');

const TTA_VARIANTS_CAP = 64;

let loaded = null;

function hash32(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function randomFor(seed) {
  let value = seed >>> 0;
  return () => {
    value |= 0;
    value = value + 0x6D2B79F5 | 0;
    let mixed = Math.imul(value ^ value >>> 15, 1 | value);
    mixed = mixed + Math.imul(mixed ^ mixed >>> 7, 61 | mixed) ^ mixed;
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const value = result[i];
    result[i] = result[j];
    result[j] = value;
  }
  return result;
}

function augmentedView(view, playerId, variant) {
  if (variant === 0) return view;
  const random = randomFor(hash32(String(view.roomId || '') + ':' +
    String(view.round || 0) + ':' + String(view.phase || '') + ':' + playerId + ':' + variant));
  const players = (view.players || []).map(player => {
    const next = { ...player };
    if (Array.isArray(player.city)) next.city = shuffled(player.city, random);
    if (player.id === playerId && Array.isArray(player.hand)) next.hand = shuffled(player.hand, random);
    return next;
  });
  const next = { ...view, players };
  if (view.turn && view.turn.pending && Array.isArray(view.turn.pending.cards)) {
    next.turn = {
      ...view.turn,
      pending: { ...view.turn.pending, cards: shuffled(view.turn.pending.cards, random) }
    };
  }
  return next;
}

function loadModel(checkpoint) {
  const key = checkpoint.file + ':' + checkpoint.stamp;
  if (loaded && loaded.key === key) return loaded;
  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(checkpoint.file)).toString('utf8'));
  if (!payload.model) throw new Error('checkpoint 中缺少神经网络参数');
  const profile = payload.model.profile || payload.config && payload.config.profile || 'balanced';
  const model = new PolicyValueNetwork({ profile,
    stateSize: payload.model.stateSize || 192, actionSize: payload.model.actionSize || 64 });
  model.import(payload.model);
  loaded = { key, profile, model };
  return loaded;
}

function policyLogits(active, view, playerId, actions) {
  const encoded = encodeState(view, playerId);
  const actionVectors = actions.map(action => encodeAction(action, encoded.context));
  return active.model.forward(encoded.vector, actionVectors, 1);
}

function argmax(values) {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

function decideByTta({ checkpoint, view, playerId, actions, variants, deadlineAt }) {
  const active = loadModel(checkpoint);
  const count = Math.max(1, Math.min(TTA_VARIANTS_CAP, Number(variants) || TTA_VARIANTS_CAP));
  const aggregate = new Float64Array(actions.length);
  let completed = 0;

  for (let variant = 0; variant < count; variant++) {
    if (Date.now() >= deadlineAt) break;
    const output = policyLogits(active, augmentedView(view, playerId, variant), playerId, actions);
    for (let i = 0; i < aggregate.length; i++) aggregate[i] += output.logits[i];
    completed++;
  }

  if (!completed) {
    const error = new Error('本地神经网络推理超时');
    error.code = 'timeout';
    throw error;
  }

  return {
    selected: argmax(aggregate),
    method: 'tta',
    variants: completed,
    timedOut: completed < count,
    profile: active.profile
  };
}

/**
 * 确定化 MCTS：在若干份「隐藏信息猜测」上各搜一次，平均根节点访问分布后选动作。
 * 服务器已保证每份猜测的合法动作集与真实局面逐字一致，π 的下标可直接复用。
 * 临场关掉根节点 Dirichlet 噪声 —— 那是自对弈的探索手段，实战要的是稳定的最强手。
 */
async function decideBySearch({ checkpoint, states, view, playerId, actions, mcts: options, deadlineAt }) {
  const active = loadModel(checkpoint);
  const perDeterminization = Math.max(1, Math.ceil(options.simulations / states.length));
  const aggregate = new Float64Array(actions.length);
  let used = 0;
  let visits = 0;
  let expansions = 0;

  for (const state of states) {
    if (Date.now() >= deadlineAt) break;
    let result;
    try {
      result = await mcts.search({
        rootState: state,
        rootPlayerId: playerId,
        model: active.model,
        Engine,
        sanitize: Engine.sanitize,
        legalFn: enumerateLegalActions,
        rewardFn: gameRewards,
        encodeState,
        encodeAction,
        simulate: perDeterminization,
        cPuct: 1,
        dirichletAlpha: 0,
        maxDepth: options.maxDepth,
        rng: Math.random
      });
    } catch (_) { continue; }
    if (!result || result.fallback || !result.pi || result.pi.length !== actions.length) continue;
    for (let i = 0; i < aggregate.length; i++) aggregate[i] += Number(result.pi[i]) || 0;
    used++;
    visits += result.visits || 0;
    expansions += result.expansions || 0;
  }

  if (!used) return null;

  // 访问数取整后容易并列，用策略网络在同一批动作里挑一手，避免偏向靠前的动作
  const best = Math.max.apply(null, Array.from(aggregate));
  const tied = [];
  for (let i = 0; i < aggregate.length; i++) if (aggregate[i] >= best - 1e-9) tied.push(i);
  let selected = tied[0];
  if (tied.length > 1) {
    const logits = policyLogits(active, view, playerId, actions).logits;
    selected = tied.reduce((win, i) => (Number(logits[i]) > Number(logits[win]) ? i : win), tied[0]);
  }

  return {
    selected,
    method: 'mcts',
    variants: 0,
    timedOut: used < states.length,
    determinizations: used,
    visits,
    expansions,
    simulations: options.simulations,
    maxDepth: options.maxDepth,
    profile: active.profile
  };
}

function wantsSearch(message) {
  return !!(message.mcts && Number(message.mcts.simulations) > 0 &&
    Array.isArray(message.states) && message.states.length);
}

async function runDecision(message) {
  if (wantsSearch(message)) {
    const searched = await decideBySearch(message);
    if (searched) return searched;
  }
  return decideByTta(message);
}

// MCTS 是异步的，多个房间会并发投递请求；串成一条队列，避免同一线程里两棵搜索树互相抢时间。
let queue = Promise.resolve();

parentPort.on('message', message => {
  if (!message || message.type !== 'decide') return;
  queue = queue.then(() => runDecision(message))
    .then(result => parentPort.postMessage({ id: message.id, ...result }))
    .catch(error => parentPort.postMessage({ id: message.id,
      error: { message: error.message, code: error.code || '' } }));
});
