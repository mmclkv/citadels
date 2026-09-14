'use strict';

const { snapshotHash } = require('./replay.js');

const REPLAY_PROTOCOL_VERSION = 1;

function encodeReplayTrace(initialState, records, traceId) {
  const normalized = Array.isArray(records) ? records : [];
  return JSON.stringify({
    v: REPLAY_PROTOCOL_VERSION,
    t: 'replay',
    id: String(traceId),
    initialHash: snapshotHash(initialState),
    records: normalized.map(record => ({
      playerId: record.playerId,
      action: record.action,
      beforeHash: record.beforeHash,
      afterHash: record.afterHash,
      phaseBefore: record.phaseBefore,
      phaseAfter: record.phaseAfter
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
