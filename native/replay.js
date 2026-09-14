'use strict';

const { stableFingerprint } = require('./protocol.js');
const { cloneTrimmed } = require('../training/search-state.js');

function snapshotHash(state) {
  return stableFingerprint(cloneTrimmed(state));
}

function recordAppliedAction(state, playerId, action, apply) {
  const before = snapshotHash(state);
  const phaseBefore = state.phase;
  const result = apply(state, playerId, action);
  if (!result || !result.ok) return { ok: false, error: result && result.error };
  return {
    ok: true,
    playerId,
    action,
    phaseBefore,
    phaseAfter: state.phase,
    beforeHash: before,
    afterHash: snapshotHash(state)
  };
}

function replayActions(initialState, records, apply) {
  const state = cloneTrimmed(initialState);
  for (const record of records || []) {
    const result = apply(state, record.playerId, record.action);
    if (!result || !result.ok) return { ok: false, error: result && result.error, state, record };
    if (snapshotHash(state) !== record.afterHash) {
      return { ok: false, error: '状态哈希不一致', state, record };
    }
  }
  return { ok: true, state };
}

module.exports = { snapshotHash, recordAppliedAction, replayActions };
