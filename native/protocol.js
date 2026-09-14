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
 */
function encodeSearchRequest(state, rootPlayerId, legalActions, requestId) {
  const snapshot = cloneTrimmed(state);
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    t: 'search',
    id: String(requestId),
    rootPlayerId,
    state: snapshot,
    legalActions: Array.isArray(legalActions) ? legalActions : [],
    stateHash: stableFingerprint(snapshot)
  }) + '\n';
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
  if (stableFingerprint(request.state) !== request.stateHash) {
    throw new Error('native 搜索请求 stateHash 不匹配');
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
  return response;
}

module.exports = {
  PROTOCOL_VERSION, stableFingerprint, encodeSearchRequest, decodeSearchRequest, decodeSearchResponse
};
