'use strict';

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
  constructor({ profile = 'balanced', stateSize = 192, actionSize = 64, seed = 2026 } = {}) {
    this.profileName = PROFILES[profile] ? profile : 'balanced';
    this.profile = PROFILES[this.profileName];
    this.stateSize = stateSize;
    this.actionSize = actionSize;
    this.rng = mulberry32(seed);
    const p = this.profile;
    this.state1 = new Dense(stateSize, p.stateHidden, this.rng);
    this.state2 = new Dense(p.stateHidden, p.latent, this.rng);
    this.policy1 = new Dense(p.latent + actionSize, p.policyHidden, this.rng);
    this.policy2 = new Dense(p.policyHidden, p.policyMid, this.rng);
    this.policyOut = new Dense(p.policyMid, 1, this.rng);
    this.value1 = new Dense(p.latent, p.valueHidden, this.rng);
    this.valueOut = new Dense(p.valueHidden, 1, this.rng);
    this.layers = [this.state1, this.state2, this.policy1, this.policy2, this.policyOut, this.value1, this.valueOut];
    this.optimizerStep = 0;
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
    return { stateCaches: { s1, s2, v1, vo }, policies, logits, probs: softmax(logits, temperature), value: vo.output[0] };
  }

  choose(state, actions, temperature = 1) {
    const out = this.forward(state, actions, temperature);
    let r = this.rng(), chosen = actions.length - 1;
    for (let i = 0; i < out.probs.length; i++) { r -= out.probs[i]; if (r <= 0) { chosen = i; break; } }
    return { chosen, probability: out.probs[chosen], value: out.value, entropy: entropy(out.probs) };
  }

  trainPPO(transitions, options = {}) {
    if (!transitions.length) return { policyLoss: 0, valueLoss: 0, totalLoss: 0, entropy: 0, clipFraction: 0 };
    const lr = Number(options.learningRate) || 0.0003;
    const epochs = Math.max(1, Math.min(6, Number(options.epochs) || 2));
    const clip = Number(options.clip) || 0.2;
    const valueCoef = Number(options.valueCoef) || 0.5;
    const entropyCoef = Number(options.entropyCoef) || 0.01;
    const rawAdvantages = transitions.map(t => t.reward - t.oldValue);
    const mean = rawAdvantages.reduce((a, b) => a + b, 0) / rawAdvantages.length;
    const variance = rawAdvantages.reduce((a, b) => a + (b - mean) ** 2, 0) / rawAdvantages.length;
    const std = Math.sqrt(variance + 1e-8);
    const advantages = rawAdvantages.map(v => (v - mean) / std);
    let totals = { policyLoss: 0, valueLoss: 0, entropy: 0, clips: 0, samples: 0 };

    for (let epoch = 0; epoch < epochs; epoch++) {
      this.layers.forEach(l => l.zeroGrad());
      for (let k = 0; k < transitions.length; k++) {
        const tr = transitions[k];
        const out = this.forward(tr.state, tr.actions, 1);
        const selected = tr.chosen;
        const prob = Math.max(1e-8, out.probs[selected]);
        const oldProb = Math.max(1e-8, tr.oldProb);
        const ratio = prob / oldProb;
        const advantage = advantages[k];
        const clippedRatio = Math.max(1 - clip, Math.min(1 + clip, ratio));
        const unclippedObjective = ratio * advantage;
        const clippedObjective = clippedRatio * advantage;
        const isClipped = (advantage >= 0 && ratio > 1 + clip) || (advantage < 0 && ratio < 1 - clip);
        totals.policyLoss += -Math.min(unclippedObjective, clippedObjective);
        totals.clips += isClipped ? 1 : 0;
        const ent = entropy(out.probs);
        totals.entropy += ent;
        const gradLogits = new Float32Array(out.probs.length);
        const policyScale = isClipped ? 0 : advantage * ratio;
        let entropyCommon = 0;
        for (let i = 0; i < out.probs.length; i++) entropyCommon += out.probs[i] * (Math.log(Math.max(1e-8, out.probs[i])) + 1);
        for (let i = 0; i < out.probs.length; i++) {
          const p = out.probs[i];
          const policyGrad = policyScale * (p - (i === selected ? 1 : 0));
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

        const valueError = out.value - tr.reward;
        totals.valueLoss += valueError * valueError;
        const gv0 = new Float32Array([2 * valueCoef * valueError]);
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
      optimizerStep: this.optimizerStep, layers: this.layers.map(l => l.export())
    };
  }
  import(data) {
    if (!data || data.version !== 1 || data.profile !== this.profileName || data.layers.length !== this.layers.length) {
      throw new Error('不兼容的 checkpoint');
    }
    this.layers.forEach((layer, i) => layer.import(data.layers[i]));
    this.optimizerStep = Number(data.optimizerStep) || 0;
  }
  get parameterCount() { return this.layers.reduce((sum, l) => sum + l.parameterCount, 0); }
}

function entropy(probs) {
  let value = 0;
  for (let i = 0; i < probs.length; i++) if (probs[i] > 0) value -= probs[i] * Math.log(probs[i]);
  return value;
}

module.exports = { PolicyValueNetwork, PROFILES, mulberry32, softmax };
