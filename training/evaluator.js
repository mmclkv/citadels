'use strict';

const VALUE_SLOTS = 8;

function normalizeValueVector(valueVector, scalar) {
  const out = new Float32Array(VALUE_SLOTS);
  if (valueVector && typeof valueVector.length === 'number') {
    for (let i = 0; i < Math.min(VALUE_SLOTS, valueVector.length); i++) {
      out[i] = Number(valueVector[i]) || 0;
    }
  } else {
    out[0] = Number(scalar) || 0;
  }
  return out;
}

function resultValueVector(result) {
  return normalizeValueVector(result && (result.valueVector || result.Vv || result.values),
    result && (result.value != null ? result.value : result.V));
}

/**
 * Evaluator 抽象层 — 把"神经网络对 (state, legalActions) 的前向评估"做成可替换组件，
 * 让 MCTS 能在不同后端间切换：
 *
 *  - JsEvaluator       同步调用 PolicyValueNetwork.forward（CPU JS forward）
 *  - BatchEvaluator    攒一批请求后通过 forwardBatch 一次性送 GPU
 *
 * 调用方一般不需要关心底层细节：MCTS 调用 evaluator.evaluate(node)，拿到 (P, V) 后
 * 立刻填进 node 并返回。同步实现 (JsEvaluator) 把 forward 跑在主线程的 microtask 里；
 * 异步实现把 forward 推迟到 GPU 批次满 / 显式 flush。
 *
 * 缓存键：实体化状态向量的 FNV-1a hash（去重 + 跨节点命中）。
 */

function fnv1a64(bytes) {
  // FNV-1a 64-bit，仅用作 hash key，目的不是密码学强度
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < bytes.length; i++) {
    h = (h ^ BigInt(bytes[i] & 0xff)) & mask;
    h = (h * prime) & mask;
  }
  return h.toString(16);
}

function hashStateVector(stateVector) {
  return fnv1a64(new Uint8Array(stateVector.buffer, stateVector.byteOffset, stateVector.byteLength));
}

class Evaluator {
  async evaluate(/* node, ctx */) {
    throw new Error('Evaluator.evaluate must be implemented by subclass');
  }

  async evaluateMany(/* nodes, ctxs */) {
    throw new Error('Evaluator.evaluateMany must be implemented by subclass');
  }

  async flush() {}

  async close() {}

  reset() {}
}

class JsEvaluator extends Evaluator {
  constructor({ model, sanitize, encodeState, encodeAction }) {
    super();
    this.model = model;
    this.sanitize = sanitize;
    this.encodeState = encodeState;
    this.encodeAction = encodeAction;
  }

  async evaluate(node, state) {
    if (node.expanded) return { P: node.P, V: node.value, valueVector: node.valueVector };
    // 兼容旧调用方式：未显式传 state 时回退到 node.state（测试桩节点通常带 .state）
    if (state === undefined) state = node && node.state;
    const view = this.sanitize(state, node.playerId);
    const encoded = this.encodeState(view, node.playerId);
    const actionVectors = node.legalActions.map(action => this.encodeAction(action, encoded.context));
    const out = this.model.forward(encoded.vector, actionVectors, 1.0);
    node.P = out.probs;
    node.valueVector = normalizeValueVector(out.valueVector, out.value);
    node.value = Number.isFinite(Number(out.value)) ? out.value : node.valueVector[0];
    node.expanded = true;
    return { P: out.probs, V: node.value, valueVector: node.valueVector };
  }

  async evaluateMany(nodes) {
    const results = [];
    for (const node of nodes) results.push(await this.evaluate(node));
    return results;
  }
}

class BatchEvaluator extends Evaluator {
  constructor({
    forwardBatch, batchSize = 32, maxWaitMs = 1,
    sanitize, encodeState, encodeAction, cacheSize = 65536
  }) {
    super();
    if (typeof forwardBatch !== 'function') {
      throw new Error('BatchEvaluator 需要 forwardBatch(stateVectors, actionVectorsList) 函数');
    }
    this.forwardBatch = forwardBatch;
    this.batchSize = Math.max(1, batchSize | 0);
    this.maxWaitMs = Math.max(0, maxWaitMs | 0);
    this.sanitize = sanitize;
    this.encodeState = encodeState;
    this.encodeAction = encodeAction;
    this.cacheSize = Math.max(0, cacheSize | 0);
    this.queue = [];
    this.timer = null;
    this.cache = new Map();
    this.stats = { calls: 0, expansions: 0, cacheHits: 0, forwardBatches: 0, forwardNodes: 0 };
  }

  async evaluate(node, state) {
    if (node.expanded) return { P: node.P, V: node.value, valueVector: node.valueVector };
    // 兼容旧调用方式：未显式传 state 时回退到 node.state（测试桩节点通常带 .state）
    if (state === undefined) state = node && node.state;
    this.stats.calls++;
    const view = this.sanitize(state, node.playerId);
    const encoded = this.encodeState(view, node.playerId);
    const stateVector = encoded.vector;
    const actionVectors = node.legalActions.map(action => this.encodeAction(action, encoded.context));
    const cacheKey = hashStateVector(stateVector);
    if (this.cacheSize > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        node.P = cached.P;
        node.valueVector = new Float32Array(cached.valueVector || normalizeValueVector(null, cached.V));
        node.value = node.valueVector[0];
        node.expanded = true;
        this.stats.cacheHits++;
        return cached;
      }
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ node, cacheKey, stateVector, actionVectors, resolve, reject });
      this.scheduleFlush();
    });
  }

  async evaluateMany(nodes) {
    return Promise.all(nodes.map(node => this.evaluate(node)));
  }

  scheduleFlush() {
    if (this.pendingFlush) return;
    this.pendingFlush = true;
    if (this.queue.length >= this.batchSize) {
      setImmediate(() => {
        this.pendingFlush = false;
        this.flush().catch(err => this.rejectAll(err));
      });
      return;
    }
    // maxWaitMs === 0 表示"不限制等待 / 即时发送"：setTimeout(..., 0) 在下一个事件循环 tick
    // 就 flush（不强制等待）。这与 mcts.js 的串行 await 兼容——expand 的 await 能在下一 tick
    // 被 flush 唤醒，不会死锁。N>0 时则最多等 N ms 再攒一批。
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pendingFlush = false;
      this.flush().catch(err => this.rejectAll(err));
    }, this.maxWaitMs);
  }

  async flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.pendingFlush = false;
    while (this.queue.length) {
      const batch = this.queue.splice(0, this.batchSize);
      try {
        // 按 cacheKey 去重：同 state hash 只 forward 一次，结果广播回所有原请求
        const seenKeyIndex = new Map();
        const uniqueOrder = [];
        const stateVectors = [];
        const actionVectorsList = [];
        for (let i = 0; i < batch.length; i++) {
          const key = batch[i].cacheKey;
          if (seenKeyIndex.has(key)) continue;
          seenKeyIndex.set(key, uniqueOrder.length);
          uniqueOrder.push(i);
          stateVectors.push(Array.from(batch[i].stateVector));
          actionVectorsList.push(batch[i].actionVectors.map(av => Array.from(av)));
        }
        const forwardNeeded = uniqueOrder.length;
        if (forwardNeeded === 0) continue;
        const batchResult = await this.forwardBatch(stateVectors, actionVectorsList);
        const probsList = batchResult.probsList;
        const valueVectors = batchResult.valueVectors || batchResult.values;
        if (probsList.length !== forwardNeeded || valueVectors.length !== forwardNeeded) {
          throw new Error('forwardBatch 返回长度与 batch 不一致');
        }
        this.stats.forwardBatches++;
        this.stats.forwardNodes += forwardNeeded;
        const uniqueResults = new Array(uniqueOrder.length);
        for (let u = 0; u < uniqueOrder.length; u++) {
          const P = new Float32Array(probsList[u]);
          const valueVector = resultValueVector({ valueVector: valueVectors[u], value: valueVectors[u] });
          const V = valueVector[0];
          uniqueResults[u] = { P, V, valueVector };
          const key = batch[uniqueOrder[u]].cacheKey;
          if (this.cacheSize > 0) {
            this.cache.set(key, { P, V, valueVector });
            if (this.cache.size > this.cacheSize) {
              const firstKey = this.cache.keys().next().value;
              this.cache.delete(firstKey);
            }
          }
        }
        for (let i = 0; i < batch.length; i++) {
          const item = batch[i];
          const u = seenKeyIndex.get(item.cacheKey);
          const { P, V, valueVector } = uniqueResults[u];
          // 同一 hash 共享 buffer — 复制一份给原始 node，避免后续覆盖影响兄弟
          const Pclone = new Float32Array(P);
          item.node.P = Pclone;
          item.node.valueVector = new Float32Array(valueVector);
          item.node.value = V;
          item.node.expanded = true;
          this.stats.expansions++;
          item.resolve({ P: Pclone, V, valueVector: item.node.valueVector });
        }
      } catch (error) {
        for (const item of batch) item.reject(error);
        throw error;
      }
    }
  }

  rejectAll(error) {
    while (this.queue.length) this.queue.shift().reject(error);
  }

  reset() {
    this.cache.clear();
    this.queue = [];
    this.stats = { calls: 0, expansions: 0, cacheHits: 0, forwardBatches: 0, forwardNodes: 0 };
  }

  async close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.queue = [];
    this.cache.clear();
  }

  get batchStats() {
    return Object.assign({}, this.stats, {
      cacheRatio: this.stats.calls ? this.stats.cacheHits / this.stats.calls : 0
    });
  }
}

module.exports = {
  Evaluator,
  JsEvaluator,
  BatchEvaluator,
  hashStateVector,
  fnv1a64
};
