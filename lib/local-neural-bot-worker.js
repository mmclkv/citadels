'use strict';

const fs = require('fs');
const zlib = require('zlib');
const { parentPort } = require('worker_threads');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const { encodeState, encodeAction } = require('../training/train.js');

const TTA_VARIANTS_CAP = 16;

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

function decide({ checkpoint, view, playerId, actions, variants, deadlineAt }) {
  const active = loadModel(checkpoint);
  const count = Math.max(1, Math.min(TTA_VARIANTS_CAP, Number(variants) || TTA_VARIANTS_CAP));
  const aggregate = new Float64Array(actions.length);
  let completed = 0;

  for (let variant = 0; variant < count; variant++) {
    if (Date.now() >= deadlineAt) break;
    const encoded = encodeState(augmentedView(view, playerId, variant), playerId);
    const actionVectors = actions.map(action => encodeAction(action, encoded.context));
    const output = active.model.forward(encoded.vector, actionVectors, 1);
    for (let i = 0; i < aggregate.length; i++) aggregate[i] += output.logits[i];
    completed++;
  }

  if (!completed) {
    const error = new Error('本地神经网络推理超时');
    error.code = 'timeout';
    throw error;
  }

  let selected = 0;
  for (let i = 1; i < aggregate.length; i++) {
    if (aggregate[i] > aggregate[selected]) selected = i;
  }
  return {
    selected,
    variants: completed,
    timedOut: completed < count,
    profile: active.profile
  };
}

parentPort.on('message', message => {
  if (!message || message.type !== 'decide') return;
  try {
    parentPort.postMessage({ id: message.id, ...decide(message) });
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: { message: error.message, code: error.code || '' } });
  }
});
