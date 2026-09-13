'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Engine = require('../src/engine.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const { encodeState, encodeAction, enumerateLegalActions } = require('../training/train.js');

function createLocalNeuralBot({ root = path.join(__dirname, '..') } = {}) {
  const dataDir = path.join(root, 'training-data');
  let loaded = null;

  function latestCheckpoint() {
    try {
      const name = fs.readdirSync(dataDir)
        .filter(item => /^checkpoint-\d+\.json\.gz$/.test(item))
        .sort().pop();
      if (!name) return null;
      const file = path.join(dataDir, name);
      const stat = fs.statSync(file);
      return { name, file, stamp: stat.mtimeMs + ':' + stat.size,
        game: Number((name.match(/\d+/) || [0])[0]) || 0 };
    } catch (_) { return null; }
  }

  function load() {
    const checkpoint = latestCheckpoint();
    if (!checkpoint) throw new Error('没有可用的本地神经网络 checkpoint，请先完成训练');
    if (loaded && loaded.name === checkpoint.name && loaded.stamp === checkpoint.stamp) return loaded;
    const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(checkpoint.file)).toString('utf8'));
    if (!payload.model) throw new Error('checkpoint 中缺少神经网络参数');
    const profile = payload.model.profile || payload.config && payload.config.profile || 'balanced';
    const model = new PolicyValueNetwork({ profile,
      stateSize: payload.model.stateSize || 192, actionSize: payload.model.actionSize || 64 });
    model.import(payload.model);
    loaded = { ...checkpoint, game: Number(payload.game) || checkpoint.game, profile, model };
    return loaded;
  }

  function status() {
    const checkpoint = latestCheckpoint();
    if (!checkpoint) return { configured: false, checkpoint: '', game: 0,
      message: '没有可用的本地神经网络 checkpoint，请先在训练控制台完成训练' };
    return { configured: true, checkpoint: checkpoint.name, game: checkpoint.game,
      profile: loaded && loaded.name === checkpoint.name ? loaded.profile : '',
      message: '将使用 ' + checkpoint.name + '（已训练 ' + checkpoint.game + ' 局）' };
  }

  function decide(state, playerId) {
    const active = load();
    const actions = enumerateLegalActions(state, playerId);
    if (!actions.length) throw new Error('本地神经网络没有可执行的合法行动');
    const encoded = encodeState(Engine.sanitize(state, playerId), playerId);
    const actionVectors = actions.map(action => encodeAction(action, encoded.context));
    const output = active.model.forward(encoded.vector, actionVectors, 1);
    let selected = 0;
    for (let i = 1; i < output.logits.length; i++) {
      if (output.logits[i] > output.logits[selected]) selected = i;
    }
    return actions[selected];
  }

  return { status, decide };
}

module.exports = { createLocalNeuralBot };
