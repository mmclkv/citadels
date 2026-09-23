'use strict';

// Entity Transformer v1.
// The input protocol intentionally reuses the current entity layout:
//   state[0..31]       global features
//   state[32..671]     8 relative player slots x 80 features
// This file is deliberately separate from neural-policy.js so old flat/PPO
// checkpoints remain loadable without any migration or shape ambiguity.

const VALUE_SLOTS = 8;
const ENTITY_ENCODING_VERSION = 'entity-v1';
const ENTITY_PROFILES = {
  fast: { modelDim: 128, heads: 4, layers: 2, ffDim: 256, actionHidden: 128 },
  balanced: { modelDim: 192, heads: 4, layers: 3, ffDim: 384, actionHidden: 192 },
  large: { modelDim: 256, heads: 4, layers: 3, ffDim: 512, actionHidden: 256 }
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function elu(x) { return x >= 0 ? x : Math.expm1(x); }
function softmax(logits) {
  let max = -Infinity;
  for (const x of logits) max = Math.max(max, x);
  const out = new Float32Array(logits.length);
  let total = 0;
  for (let i = 0; i < logits.length; i++) { out[i] = Math.exp(logits[i] - max); total += out[i]; }
  if (!(total > 0) || !Number.isFinite(total)) { out.fill(1 / Math.max(1, logits.length)); return out; }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

class Dense {
  constructor(inputSize, outputSize, rng) {
    this.inputSize = inputSize; this.outputSize = outputSize;
    this.w = new Float32Array(inputSize * outputSize);
    this.b = new Float32Array(outputSize);
    const limit = Math.sqrt(6 / (inputSize + outputSize));
    for (let i = 0; i < this.w.length; i++) this.w[i] = (rng() * 2 - 1) * limit;
  }
  forward(input, activate = true) {
    const out = new Float32Array(this.outputSize);
    for (let o = 0; o < this.outputSize; o++) {
      let sum = this.b[o]; const base = o * this.inputSize;
      for (let i = 0; i < this.inputSize; i++) sum += this.w[base + i] * input[i];
      out[o] = activate ? elu(sum) : sum;
    }
    return out;
  }
  get parameterCount() { return this.w.length + this.b.length; }
}

function layerNorm(x, gamma, beta) {
  let mean = 0;
  for (const value of x) mean += value;
  mean /= x.length;
  let variance = 0;
  for (const value of x) variance += (value - mean) ** 2;
  variance /= x.length;
  const scale = 1 / Math.sqrt(variance + 1e-5);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = (x[i] - mean) * scale * gamma[i] + beta[i];
  return out;
}

class TransformerBlock {
  constructor(dim, heads, ffDim, rng) {
    this.dim = dim; this.heads = heads; this.headDim = dim / heads;
    this.q = new Dense(dim, dim, rng); this.k = new Dense(dim, dim, rng); this.v = new Dense(dim, dim, rng);
    this.attnOut = new Dense(dim, dim, rng);
    this.ff1 = new Dense(dim, ffDim, rng); this.ff2 = new Dense(ffDim, dim, rng);
    this.norm1Gamma = new Float32Array(dim); this.norm1Beta = new Float32Array(dim);
    this.norm2Gamma = new Float32Array(dim); this.norm2Beta = new Float32Array(dim);
    this.norm1Gamma.fill(1); this.norm2Gamma.fill(1);
  }
  forward(tokens) {
    const n = tokens.length, d = this.dim;
    const q = tokens.map(x => this.q.forward(x, false));
    const k = tokens.map(x => this.k.forward(x, false));
    const v = tokens.map(x => this.v.forward(x, false));
    const attended = [];
    const scale = 1 / Math.sqrt(this.headDim);
    for (let i = 0; i < n; i++) {
      const row = new Float32Array(d);
      for (let h = 0; h < this.heads; h++) {
        const start = h * this.headDim;
        const scores = new Float32Array(n);
        let max = -Infinity;
        for (let j = 0; j < n; j++) {
          let score = 0;
          for (let z = 0; z < this.headDim; z++) score += q[i][start + z] * k[j][start + z];
          scores[j] = score * scale; max = Math.max(max, scores[j]);
        }
        let total = 0;
        for (let j = 0; j < n; j++) { scores[j] = Math.exp(scores[j] - max); total += scores[j]; }
        for (let j = 0; j < n; j++) {
          const weight = scores[j] / total;
          for (let z = 0; z < this.headDim; z++) row[start + z] += weight * v[j][start + z];
        }
      }
      attended.push(this.attnOut.forward(row, false));
    }
    const residual = tokens.map((token, i) => {
      const x = new Float32Array(d);
      for (let j = 0; j < d; j++) x[j] = token[j] + attended[i][j];
      return layerNorm(x, this.norm1Gamma, this.norm1Beta);
    });
    return residual.map(token => {
      const ff = this.ff2.forward(this.ff1.forward(token));
      const x = new Float32Array(d);
      for (let j = 0; j < d; j++) x[j] = token[j] + ff[j];
      return layerNorm(x, this.norm2Gamma, this.norm2Beta);
    });
  }
  get parameterCount() {
    return [this.q, this.k, this.v, this.attnOut, this.ff1, this.ff2]
      .reduce((n, layer) => n + layer.parameterCount, 0) + this.norm1Gamma.length * 4;
  }
}

class EntityTransformerPolicy {
  constructor({ profile = 'balanced', stateSize = 672, actionSize = 256, seed = 2026 } = {}) {
    if (stateSize !== 672 || actionSize !== 256) throw new Error('entity-transformer-v1 需要672维状态和256维动作编码');
    this.profileName = ENTITY_PROFILES[profile] ? profile : 'balanced';
    this.profile = ENTITY_PROFILES[this.profileName];
    this.stateSize = stateSize; this.actionSize = actionSize;
    this.architecture = ENTITY_ENCODING_VERSION;
    const p = this.profile, rng = mulberry32(seed), d = p.modelDim;
    this.globalEmbed = new Dense(32, d, rng);
    this.playerEmbed = new Dense(80, d, rng);
    this.actionEmbed = new Dense(actionSize, d, rng);
    this.blocks = Array.from({ length: p.layers }, () => new TransformerBlock(d, p.heads, p.ffDim, rng));
    this.action1 = new Dense(d * 2, p.actionHidden, rng);
    this.actionOut = new Dense(p.actionHidden, 1, rng);
    this.valueOut = new Dense(d, 1, rng);
    this.layers = [this.globalEmbed, this.playerEmbed, this.actionEmbed, ...this.blocks,
      this.action1, this.actionOut, this.valueOut];
  }
  encodeTokens(state) {
    if (!state || state.length !== 672) throw new Error('entity-transformer-v1 状态维度错误');
    const tokens = [this.globalEmbed.forward(state.subarray(0, 32))];
    for (let i = 0; i < 8; i++) tokens.push(this.playerEmbed.forward(state.subarray(32 + i * 80, 112 + i * 80)));
    return tokens;
  }
  forward(state, actions) {
    let tokens = this.encodeTokens(state);
    for (const block of this.blocks) tokens = block.forward(tokens);
    const global = tokens[0];
    const logits = new Float32Array(actions.length);
    for (let i = 0; i < actions.length; i++) {
      const action = this.actionEmbed.forward(actions[i]);
      const joined = new Float32Array(global.length + action.length);
      joined.set(global); joined.set(action, global.length);
      logits[i] = this.actionOut.forward(this.action1.forward(joined), false)[0];
    }
    const values = new Float32Array(VALUE_SLOTS);
    for (let i = 0; i < VALUE_SLOTS; i++) values[i] = this.valueOut.forward(tokens[i + 1], false)[0];
    return { logits, probs: softmax(logits), valueVector: values, value: values[0], tokens };
  }
  choose(state, actions) {
    const out = this.forward(state, actions);
    let random = Math.random(), chosen = Math.max(0, actions.length - 1);
    for (let i = 0; i < out.probs.length; i++) {
      random -= out.probs[i];
      if (random <= 0) { chosen = i; break; }
    }
    return { chosen, probability: out.probs[chosen] || 0, valueVector: out.valueVector,
      value: out.value, entropy: 0 };
  }
  exportFlat() {
    const flat = new Float32Array(this.parameterCount); let offset = 0;
    for (const layer of this.layers) {
      if (layer instanceof TransformerBlock) {
        for (const dense of [layer.q, layer.k, layer.v, layer.attnOut, layer.ff1, layer.ff2]) {
          flat.set(dense.w, offset); offset += dense.w.length; flat.set(dense.b, offset); offset += dense.b.length;
        }
        for (const vector of [layer.norm1Gamma, layer.norm1Beta, layer.norm2Gamma, layer.norm2Beta]) { flat.set(vector, offset); offset += vector.length; }
      } else { flat.set(layer.w, offset); offset += layer.w.length; flat.set(layer.b, offset); offset += layer.b.length; }
    }
    return flat;
  }
  importFlat(flat) {
    if (!flat || flat.length !== this.parameterCount) {
      throw new Error('entity-transformer-v1 参数数量不匹配');
    }
    let offset = 0;
    const copyDense = layer => {
      layer.w.set(flat.subarray(offset, offset + layer.w.length)); offset += layer.w.length;
      layer.b.set(flat.subarray(offset, offset + layer.b.length)); offset += layer.b.length;
    };
    for (const layer of this.layers) {
      if (layer instanceof TransformerBlock) {
        for (const dense of [layer.q, layer.k, layer.v, layer.attnOut, layer.ff1, layer.ff2]) copyDense(dense);
        for (const vector of [layer.norm1Gamma, layer.norm1Beta, layer.norm2Gamma, layer.norm2Beta]) {
          vector.set(flat.subarray(offset, offset + vector.length)); offset += vector.length;
        }
      } else copyDense(layer);
    }
  }
  export() {
    return {
      version: 1, architecture: ENTITY_ENCODING_VERSION, profile: this.profileName,
      stateSize: this.stateSize, actionSize: this.actionSize,
      parameterCount: this.parameterCount, flat: Array.from(this.exportFlat())
    };
  }
  import(data) {
    if (!data || data.version !== 1 || data.architecture !== ENTITY_ENCODING_VERSION ||
        data.profile !== this.profileName || data.stateSize !== this.stateSize ||
        data.actionSize !== this.actionSize) throw new Error('不兼容的 entity-transformer-v1 checkpoint');
    this.importFlat(Float32Array.from(data.flat || []));
  }
  get parameterCount() { return this.layers.reduce((n, layer) => n + layer.parameterCount, 0); }
}

module.exports = { EntityTransformerPolicy, ENTITY_PROFILES, ENTITY_ENCODING_VERSION, VALUE_SLOTS };
