'use strict';

const crypto = require('node:crypto');
const { cloneTrimmed } = require('../training/search-state.js');

const PROTOCOL_VERSION = 1;

function stableFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * 生成发给 native worker 的一条 NDJSON 请求。
 * 搜索状态去掉 log/notices，避免把 UI 历史带入每个 MCTS 节点；动作仍保留完整
 * JSON 字段，保证技能选择、目标玩家和 card uid 不会因压缩协议丢失。
 *
 * state 可以传单个局面，也可以传「粒子池」数组（对未知手牌的若干份猜测）。
 * 传数组时第一份仍是 state，其余放进 particles —— 旧 worker 不认识 particles，
 * 只会按第一份搜，于是天然退化成单粒子而不会报错。
 */
function encodeSearchRequest(state, rootPlayerId, legalActions, requestId, particleWeights) {
  const pool = (Array.isArray(state) ? state : [state]).map(entry => cloneTrimmed(entry));
  const [primary, ...particles] = pool;
  const request = {
    v: PROTOCOL_VERSION,
    t: 'search',
    id: String(requestId),
    rootPlayerId,
    state: primary,
    legalActions: Array.isArray(legalActions) ? legalActions : [],
    // 覆盖整池而不只是第一份：粒子被截断/串位同样是灾难（会把错的世界当成真的）
    stateHash: stableFingerprint(pool)
  };
  if (particles.length) request.particles = particles;
  // 长度对不上就不发：宁可让那边均匀采样，也不能把权重套到错的世界头上
  if (Array.isArray(particleWeights) && particleWeights.length === pool.length) {
    request.particleWeights = particleWeights.map(w => Number(w) || 0);
  }
  return JSON.stringify(request) + '\n';
}

function decodeSearchRequest(line) {
  const request = typeof line === 'string' ? JSON.parse(line) : line;
  if (!request || request.v !== PROTOCOL_VERSION || request.t !== 'search') {
    throw new Error('native 搜索请求协议版本或类型不匹配');
  }
  if (request.id == null || request.id === '') throw new Error('native 搜索请求缺少 id');
  if (!request.state || typeof request.state !== 'object' || Array.isArray(request.state)) {
    throw new Error('native 搜索请求缺少完整 state');
  }
  if (typeof request.rootPlayerId !== 'string' || !request.rootPlayerId) {
    throw new Error('native 搜索请求缺少 rootPlayerId');
  }
  if (!Array.isArray(request.legalActions)) throw new Error('native 搜索请求缺少 legalActions');
  if (typeof request.stateHash !== 'string' || !/^[0-9a-f]{64}$/.test(request.stateHash)) {
    throw new Error('native 搜索请求缺少有效 stateHash');
  }
  // 粒子池 = state + particles（顺序与 encodeSearchRequest 一致），哈希覆盖整池
  const particles = Array.isArray(request.particles) ? request.particles : null;
  if (particles) {
    particles.forEach((particle, i) => {
      if (!particle || typeof particle !== 'object' || Array.isArray(particle)) {
        throw new Error('native 搜索请求 particles[' + i + '] 不是完整 state');
      }
      if (!Array.isArray(particle.players) || !particle.players.length) {
        throw new Error('native 搜索请求 particles[' + i + '] 缺少 players');
      }
    });
  }
  const pool = particles ? [request.state, ...particles] : [request.state];
  if (stableFingerprint(pool) !== request.stateHash) {
    throw new Error('native 搜索请求 stateHash 不匹配');
  }
  if (request.particleWeights != null) {
    if (!Array.isArray(request.particleWeights) ||
        request.particleWeights.length !== pool.length ||
        request.particleWeights.some(w => !Number.isFinite(Number(w)) || Number(w) < 0)) {
      throw new Error('native 搜索请求 particleWeights 必须是与粒子池等长的非负数组');
    }
  }
  if (!request.state.players || !Array.isArray(request.state.players)) {
    throw new Error('native 搜索请求 state 缺少 players');
  }
  if (!request.state.players.some(player => player && player.id === request.rootPlayerId)) {
    throw new Error('native 搜索请求 rootPlayerId 不在 players 中');
  }
  return request;
}

function decodeSearchResponse(line) {
  const response = typeof line === 'string' ? JSON.parse(line) : line;
  if (!response || response.v !== PROTOCOL_VERSION || response.t !== 'search_result') {
    throw new Error('native 搜索响应协议版本或类型不匹配');
  }
  if (!Array.isArray(response.policy)) throw new Error('native 搜索响应缺少 policy');
  if (response.valueVector == null) {
    const value = Number(response.value) || 0;
    response.valueVector = [value, 0, 0, 0, 0, 0, 0, 0];
  } else if (!Array.isArray(response.valueVector) || response.valueVector.length !== 8) {
    throw new Error('native 搜索响应 valueVector 必须为 8 维');
  }
  if (response.value == null) response.value = response.valueVector[0];
  return response;
}

module.exports = {
  PROTOCOL_VERSION, stableFingerprint, encodeSearchRequest, decodeSearchRequest, decodeSearchResponse
};
