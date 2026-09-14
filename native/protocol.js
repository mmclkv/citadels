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

function decodeSearchResponse(line) {
  const response = typeof line === 'string' ? JSON.parse(line) : line;
  if (!response || response.v !== PROTOCOL_VERSION || response.t !== 'search_result') {
    throw new Error('native 搜索响应协议版本或类型不匹配');
  }
  if (!Array.isArray(response.policy)) throw new Error('native 搜索响应缺少 policy');
  return response;
}

module.exports = { PROTOCOL_VERSION, stableFingerprint, encodeSearchRequest, decodeSearchResponse };
