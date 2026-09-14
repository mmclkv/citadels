'use strict';

const { snapshotHash } = require('./replay.js');
const { currentActor } = require('../training/train.js');

function projectSearchState(state) {
  const actor = currentActor(state);
  return {
    version: 1,
    stateHash: snapshotHash(state),
    phase: state.phase,
    round: state.round,
    rngState: state.rngState >>> 0,
    playerCount: state.players.length,
    config: {
      endDistricts: state.config.endDistricts,
      charSetMode: state.config.charSetMode
    },
    actorId: actor ? actor.id : null,
    players: state.players.map(player => ({
      id: player.id,
      seat: player.seat,
      gold: player.gold,
      handCount: player.hand.length,
      cityCount: player.city.length,
      charIds: player.chars.slice(),
      hasCrown: !!player.hasCrown,
      connected: player.connected !== false
    })),
    draft: state.draft ? {
      stepIdx: state.draft.stepIdx,
      sub: state.draft.sub,
      currentPlayerIdx: state.draft.steps[state.draft.stepIdx]?.player ?? null,
      poolCount: state.draft.pool.length,
      faceUp: state.draft.faceUp.slice(),
      faceDownCount: state.draft.faceDown.length
    } : null,
    turn: state.turn ? {
      playerIdx: state.turn.playerIdx,
      charId: state.turn.charId,
      callIdx: state.callIdx
    } : null,
    reaction: state.reaction ? {
      kind: state.reaction.kind,
      playerIdx: state.reaction.playerIdx
    } : null
  };
}

module.exports = { projectSearchState };
