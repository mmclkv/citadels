'use strict';

const { stableFingerprint } = require('./protocol.js');
const { cloneTrimmed } = require('../training/search-state.js');

function snapshotHash(state) {
  return stableFingerprint(cloneTrimmed(state));
}

function stateSummary(state) {
  return {
    phase: state.phase,
    round: state.round,
    rngState: state.rngState >>> 0,
    deckCount: (state.deck || []).length,
    discardCount: (state.discard || []).length,
    players: (state.players || []).map(player => ({
      id: player.id,
      gold: player.gold,
      handCount: (player.hand || []).length,
      cityCount: (player.city || []).length,
      hasCrown: !!player.hasCrown,
      chars: (player.chars || []).slice()
    })),
    turn: state.turn ? {
      playerIdx: state.turn.playerIdx,
      charId: state.turn.charId,
      phase: state.turn.phase,
      builds: state.turn.builds,
      takenResources: !!state.turn.takenResources
    } : null,
    reaction: state.reaction ? {
      kind: state.reaction.kind,
      playerIdx: state.reaction.playerIdx
    } : null
  };
}

function recordAppliedAction(state, playerId, action, apply) {
  const before = snapshotHash(state);
  const beforeSummary = stateSummary(state);
  const phaseBefore = state.phase;
  const result = apply(state, playerId, action);
  if (!result || !result.ok) return { ok: false, error: result && result.error };
  return {
    ok: true,
    playerId,
    action,
    phaseBefore,
    phaseAfter: state.phase,
    beforeSummary,
    beforeHash: before,
    afterHash: snapshotHash(state),
    afterSummary: stateSummary(state)
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

module.exports = { snapshotHash, stateSummary, recordAppliedAction, replayActions };
