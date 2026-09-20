'use strict';

const VALUE_SLOTS = 8;

const PROFILES = {
  fast: { label: '快速', stateHidden: 256, latent: 128, policyHidden: 128, policyMid: 64, valueHidden: 64 },
  balanced: { label: '均衡', stateHidden: 384, latent: 256, policyHidden: 256, policyMid: 128, valueHidden: 128 },
  large: { label: '增强', stateHidden: 512, latent: 384, policyHidden: 384, policyMid: 192, valueHidden: 192 }
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
function eluGradFromOutput(y) { return y >= 0 ? 1 : y + 1; }

class Dense {
  constructor(inputSize, outputSize, rng) {
    this.inputSize = inputSize;
    this.outputSize = outputSize;
    this.w = new Float32Array(inputSize * outputSize);
    this.b = new Float32Array(outputSize);
    this.gw = new Float32Array(this.w.length);
    this.gb = new Float32Array(outputSize);
    this.mw = new Float32Array(this.w.length);
    this.vw = new Float32Array(this.w.length);
    this.mb = new Float32Array(outputSize);
    this.vb = new Float32Array(outputSize);
    const limit = Math.sqrt(6 / (inputSize + outputSize));
    for (let i = 0; i < this.w.length; i++) this.w[i] = (rng() * 2 - 1) * limit;
  }

  forward(input, activate = true) {
    const output = new Float32Array(this.outputSize);
    for (let o = 0; o < this.outputSize; o++) {
      let sum = this.b[o];
      const base = o * this.inputSize;
      for (let i = 0; i < this.inputSize; i++) sum += this.w[base + i] * input[i];
      output[o] = activate ? elu(sum) : sum;
    }
    return { input, output, activate };
  }

  backward(cache, gradOutput) {
    const gradInput = new Float32Array(this.inputSize);
    for (let o = 0; o < this.outputSize; o++) {
      let g = gradOutput[o];
      if (cache.activate) g *= eluGradFromOutput(cache.output[o]);
      this.gb[o] += g;
      const base = o * this.inputSize;
      for (let i = 0; i < this.inputSize; i++) {
        this.gw[base + i] += g * cache.input[i];
        gradInput[i] += this.w[base + i] * g;
      }
    }
    return gradInput;
  }

  zeroGrad() { this.gw.fill(0); this.gb.fill(0); }

  step(learningRate, scale, stepNo) {
    const beta1 = 0.9, beta2 = 0.999, eps = 1e-8;
    const b1 = 1 - Math.pow(beta1, stepNo);
    const b2 = 1 - Math.pow(beta2, stepNo);
    const update = (param, grad, m, v) => {
      for (let i = 0; i < param.length; i++) {
        const g = Math.max(-5, Math.min(5, grad[i] * scale));
        m[i] = beta1 * m[i] + (1 - beta1) * g;
        v[i] = beta2 * v[i] + (1 - beta2) * g * g;
        param[i] -= learningRate * (m[i] / b1) / (Math.sqrt(v[i] / b2) + eps);
      }
    };
    update(this.w, this.gw, this.mw, this.vw);
    update(this.b, this.gb, this.mb, this.vb);
  }

  export() { return { in: this.inputSize, out: this.outputSize, w: Array.from(this.w), b: Array.from(this.b) }; }
  import(data) {
    if (!data || data.in !== this.inputSize || data.out !== this.outputSize || data.w.length !== this.w.length) {
      throw new Error('checkpoint 网络结构与当前配置不一致');
    }
    this.w.set(data.w); this.b.set(data.b);
  }
  get parameterCount() { return this.w.length + this.b.length; }
}

function softmax(logits, temperature = 1) {
  const t = Math.max(0.15, Number(temperature) || 1);
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) max = Math.max(max, logits[i] / t);
  const probs = new Float32Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) { probs[i] = Math.exp(logits[i] / t - max); sum += probs[i]; }
  if (!Number.isFinite(sum) || sum <= 0) { probs.fill(1 / Math.max(1, logits.length)); return probs; }
  for (let i = 0; i < probs.length; i++) probs[i] /= sum;
  return probs;
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0); out.set(b, a.length);
  return out;
}

class PolicyValueNetwork {
  constructor({ profile = 'balanced', stateSize = 672, actionSize = 256, seed = 2026, encodingVersion = 7 } = {}) {
    this.profileName = PROFILES[profile] ? profile : 'balanced';
    this.profile = PROFILES[this.profileName];
    this.stateSize = stateSize;
    this.actionSize = actionSize;
    this.encodingVersion = encodingVersion;
    this.rng = mulberry32(seed);
    const p = this.profile;
    this.state1 = new Dense(stateSize, p.stateHidden, this.rng);
    this.state2 = new Dense(p.stateHidden, p.latent, this.rng);
    this.policy1 = new Dense(p.latent + actionSize, p.policyHidden, this.rng);
    this.policy2 = new Dense(p.policyHidden, p.policyMid, this.rng);
    this.policyOut = new Dense(p.policyMid, 1, this.rng);
    this.value1 = new Dense(p.latent, p.valueHidden, this.rng);
    this.valueOut = new Dense(p.valueHidden, VALUE_SLOTS, this.rng);
    this.layers = [this.state1, this.state2, this.policy1, this.policy2, this.policyOut, this.value1, this.valueOut];
    this.optimizerStep = 0;
  }

  exportFlat() {
    const flat = new Float32Array(this.parameterCount);
    let offset = 0;
    for (const layer of this.layers) {
      flat.set(layer.w, offset); offset += layer.w.length;
      flat.set(layer.b, offset); offset += layer.b.length;
    }
    return flat;
  }

  importFlat(flat) {
    const legacyValueHeadSize = this.profile.valueHidden * (VALUE_SLOTS - 1) + (VALUE_SLOTS - 1);
    const legacy = flat && flat.length === this.parameterCount - legacyValueHeadSize;
    if (!flat || (flat.length !== this.parameterCount && !legacy)) throw new Error('模型二进制参数数量不匹配');
    let offset = 0;
    for (const layer of this.layers) {
      if (legacy && layer === this.valueOut) {
        layer.w.fill(0); layer.b.fill(0);
        for (let i = 0; i < layer.inputSize; i++) layer.w[i] = flat[offset + i];
        layer.b[0] = flat[offset + layer.inputSize];
        offset += layer.inputSize + 1;
      } else {
        layer.w.set(flat.subarray(offset, offset + layer.w.length)); offset += layer.w.length;
        layer.b.set(flat.subarray(offset, offset + layer.b.length)); offset += layer.b.length;
      }
    }
  }

  forward(state, actions, temperature = 1) {
    const s1 = this.state1.forward(state);
    const s2 = this.state2.forward(s1.output);
    const v1 = this.value1.forward(s2.output);
    const vo = this.valueOut.forward(v1.output, false);
    const policies = [];
    const logits = new Float32Array(actions.length);
    for (let i = 0; i < actions.length; i++) {
      const p1 = this.policy1.forward(concat(s2.output, actions[i]));
      const p2 = this.policy2.forward(p1.output);
      const po = this.policyOut.forward(p2.output, false);
      logits[i] = po.output[0];
      policies.push({ p1, p2, po });
    }
    return {
      stateCaches: { s1, s2, v1, vo }, policies, logits,
      probs: softmax(logits, temperature),
      valueVector: vo.output,
      value: vo.output[0]
    };
  }

  choose(state, actions, temperature = 1) {
    const out = this.forward(state, actions, temperature);
    let r = this.rng(), chosen = actions.length - 1;
    for (let i = 0; i < out.probs.length; i++) { r -= out.probs[i]; if (r <= 0) { chosen = i; break; } }
    return {
      chosen, probability: out.probs[chosen], valueVector: out.valueVector,
      value: out.value, entropy: entropy(out.probs)
    };
  }

  trainPPO(transitions, options = {}) {
    if (!transitions.length) return { policyLoss: 0, valueLoss: 0, totalLoss: 0, entropy: 0, clipFraction: 0 };
    const lr = Number(options.learningRate) || 0.0003;
    const epochs = Math.max(1, Math.min(6, Number(options.epochs) || 2));
    const clip = Number(options.clip) || 0.2;
    const policyLossMode = ['auto', 'ppo', 'mcts_ce'].includes(options.policyLossMode) ? options.policyLossMode : 'auto';
    const valueCoef = Number(options.valueCoef) || 0.5;
    const entropyCoef = Number(options.entropyCoef) || 0.01;
    const rawAdvantages = transitions.map(t => {
      const reward = t.rewardVector && t.rewardVector.length ? t.rewardVector[0] : t.reward;
      const oldValue = t.oldValueVector && t.oldValueVector.length ? t.oldValueVector[0] : t.oldValue;
      return (Number(reward) || 0) - (Number(oldValue) || 0);
    });
    const mean = rawAdvantages.reduce((a, b) => a + b, 0) / rawAdvantages.length;
    const variance = rawAdvantages.reduce((a, b) => a + (b - mean) ** 2, 0) / rawAdvantages.length;
    const std = Math.sqrt(variance + 1e-8);
    const advantages = rawAdvantages.map(v => (v - mean) / std);
    let totals = { policyLoss: 0, valueLoss: 0, entropy: 0, clips: 0, samples: 0 };

    for (let epoch = 0; epoch < epochs; epoch++) {
      this.layers.forEach(l => l.zeroGrad());
      for (let k = 0; k < transitions.length; k++) {
        const tr = transitions[k];
        const out = this.forward(tr.state, tr.actions, tr.temperature || 1);
        const selected = tr.chosen;
        // π 目标既可能是 number[] 也可能是 Float32Array：自对弈侧为了省内存和省
        // postMessage 的克隆开销，发的就是 TypedArray，按「有没有长度」判断即可。
        const hasPi = !!(tr.pi && tr.pi.length);
        const useMctsCe = policyLossMode === 'mcts_ce' || (policyLossMode === 'auto' && hasPi);
        const target = new Float32Array(out.probs.length);
        if (useMctsCe && hasPi) {
          let total = 0;
          for (let i = 0; i < target.length; i++) { target[i] = Math.max(0, Number(tr.pi[i]) || 0); total += target[i]; }
          if (total > 0) for (let i = 0; i < target.length; i++) target[i] /= total;
          else target[selected] = 1;
        } else if (useMctsCe) target[selected] = 1;
        const prob = Math.max(1e-8, out.probs[selected]);
        const oldProb = Math.max(1e-8, tr.oldProb);
        const ratio = prob / oldProb;
        const advantage = advantages[k];
        const clippedRatio = Math.max(1 - clip, Math.min(1 + clip, ratio));
        const unclippedObjective = ratio * advantage;
        const clippedObjective = clippedRatio * advantage;
        const isClipped = !useMctsCe && ((advantage >= 0 && ratio > 1 + clip) || (advantage < 0 && ratio < 1 - clip));
        if (useMctsCe) {
          for (let i = 0; i < out.probs.length; i++) if (target[i] > 0) totals.policyLoss -= target[i] * Math.log(Math.max(1e-8, out.probs[i]));
        } else {
          totals.policyLoss += -Math.min(unclippedObjective, clippedObjective);
        }
        totals.clips += isClipped ? 1 : 0;
        const ent = entropy(out.probs);
        totals.entropy += ent;
        const gradLogits = new Float32Array(out.probs.length);
        const policyScale = isClipped ? 0 : advantage * ratio;
        let entropyCommon = 0;
        for (let i = 0; i < out.probs.length; i++) entropyCommon += out.probs[i] * (Math.log(Math.max(1e-8, out.probs[i])) + 1);
        for (let i = 0; i < out.probs.length; i++) {
          const p = out.probs[i];
          const policyGrad = useMctsCe ? (p - target[i]) : policyScale * (p - (i === selected ? 1 : 0));
          const entropyGrad = -entropyCoef * p * (entropyCommon - (Math.log(Math.max(1e-8, p)) + 1));
          gradLogits[i] = policyGrad + entropyGrad;
        }

        const gradLatent = new Float32Array(this.profile.latent);
        for (let i = 0; i < out.policies.length; i++) {
          const g0 = new Float32Array([gradLogits[i]]);
          const g2 = this.policyOut.backward(out.policies[i].po, g0);
          const g1 = this.policy2.backward(out.policies[i].p2, g2);
          const gi = this.policy1.backward(out.policies[i].p1, g1);
          for (let j = 0; j < gradLatent.length; j++) gradLatent[j] += gi[j];
        }

        const targetVector = tr.rewardVector && tr.rewardVector.length
          ? tr.rewardVector : [Number(tr.reward) || 0];
        const mask = tr.valueMask && tr.valueMask.length
          ? tr.valueMask : [1];
        let valid = 0;
        for (let i = 0; i < Math.min(VALUE_SLOTS, mask.length); i++) {
          if (Number(mask[i]) > 0) valid += 1;
        }
        valid = Math.max(1, valid);
        const gv0 = new Float32Array(VALUE_SLOTS);
        let sampleValueLoss = 0;
        for (let i = 0; i < VALUE_SLOTS; i++) {
          const targetValue = Number(targetVector[i]) || 0;
          const active = Number(mask[i]) > 0 ? 1 : 0;
          const error = out.valueVector[i] - targetValue;
          sampleValueLoss += active * error * error / valid;
          gv0[i] = 2 * valueCoef * active * error / valid;
        }
        totals.valueLoss += sampleValueLoss;
        const gv1 = this.valueOut.backward(out.stateCaches.vo, gv0);
        const gvs = this.value1.backward(out.stateCaches.v1, gv1);
        for (let j = 0; j < gradLatent.length; j++) gradLatent[j] += gvs[j];
        const gs1 = this.state2.backward(out.stateCaches.s2, gradLatent);
        this.state1.backward(out.stateCaches.s1, gs1);
        totals.samples++;
      }
      this.optimizerStep++;
      const scale = 1 / transitions.length;
      this.layers.forEach(l => l.step(lr, scale, this.optimizerStep));
    }
    const denom = Math.max(1, totals.samples);
    const policyLoss = totals.policyLoss / denom;
    const valueLoss = totals.valueLoss / denom;
    return {
      policyLoss, valueLoss, entropy: totals.entropy / denom,
      totalLoss: policyLoss + valueCoef * valueLoss - entropyCoef * totals.entropy / denom,
      clipFraction: totals.clips / denom
    };
  }

  export() {
    return {
      version: 1, profile: this.profileName, stateSize: this.stateSize, actionSize: this.actionSize,
      encodingVersion: this.encodingVersion,
      optimizerStep: this.optimizerStep, layers: this.layers.map(l => l.export())
    };
  }
  import(data) {
    if (!data || data.version !== 1 || data.profile !== this.profileName ||
        data.stateSize !== this.stateSize || data.actionSize !== this.actionSize ||
        (data.encodingVersion != null && data.encodingVersion !== this.encodingVersion) ||
        data.layers.length !== this.layers.length) {
      throw new Error('不兼容的 checkpoint');
    }
    this.layers.forEach((layer, i) => {
      const source = data.layers[i];
      if (layer === this.valueOut && source && source.out === 1 && source.in === layer.inputSize) {
        layer.w.fill(0); layer.b.fill(0);
        for (let input = 0; input < layer.inputSize; input++) layer.w[input] = source.w[input];
        layer.b[0] = source.b[0];
      } else layer.import(source);
    });
    this.optimizerStep = Number(data.optimizerStep) || 0;
  }
  get parameterCount() { return this.layers.reduce((sum, l) => sum + l.parameterCount, 0); }
}

function entropy(probs) {
  let value = 0;
  for (let i = 0; i < probs.length; i++) if (probs[i] > 0) value -= probs[i] * Math.log(probs[i]);
  return value;
}

module.exports = { PolicyValueNetwork, PROFILES, VALUE_SLOTS, mulberry32, softmax };
