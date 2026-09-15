'use strict';

const { snapshotHash } = require('./replay.js');
const { cloneTrimmed } = require('../training/search-state.js');

const REPLAY_PROTOCOL_VERSION = 1;

function encodeReplayTrace(initialState, records, traceId) {
  const normalized = Array.isArray(records) ? records : [];
  return JSON.stringify({
    v: REPLAY_PROTOCOL_VERSION,
    t: 'replay',
    id: String(traceId),
    // native 必须用与 JS 完全相同的初始局面执行第一步，只有 hash 无法初始化规则状态。
    initialState: cloneTrimmed(initialState),
    initialHash: snapshotHash(initialState),
    records: normalized.map(record => ({
      playerId: record.playerId,
      action: record.action,
      beforeHash: record.beforeHash,
      afterHash: record.afterHash,
      phaseBefore: record.phaseBefore,
      phaseAfter: record.phaseAfter,
      beforeSummary: record.beforeSummary,
      afterSummary: record.afterSummary
    }))
  }) + '\n';
}

function decodeReplayResult(line) {
  const result = typeof line === 'string' ? JSON.parse(line) : line;
  if (!result || result.v !== REPLAY_PROTOCOL_VERSION || result.t !== 'replay_result') {
    throw new Error('native 回放响应协议版本或类型不匹配');
  }
  if (typeof result.ok !== 'boolean') throw new Error('native 回放响应缺少 ok');
  return result;
}

module.exports = { REPLAY_PROTOCOL_VERSION, encodeReplayTrace, decodeReplayResult };
