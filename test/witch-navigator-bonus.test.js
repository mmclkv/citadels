/* 回归测试：女巫施咒航海家后，航海家的额外奖励仍属于被接管的剩余行动。 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../src/engine.js');

function mkState() {
  const seats = [0, 1, 2].map(i => ({
    id: 'p' + i, name: '玩家' + (i + 1), isBot: true, botLevel: 'normal'
  }));
  const state = Engine.createGame({
    roomId: 'witch-navigator-test', endDistricts: 8,
    charSetMode: 'dark', seed: 17, seats
  });
  Engine.startGame(state);
  state.phase = 'action';
  state.draft = null;
  state.reaction = null;
  state.roundConfirm = null;
  state.callQueue = [{ charId: 'navigator', num: 7, playerIdx: 1 }];
  state.callIdx = 0;
  state.effects = {
    assassinated: null, thief: null, bewitched: 7,
    witchBy: 0, thiefBy: null
  };
  state.turn = {
    charId: 'navigator', num: 7, playerIdx: 1, phase: 'bewitched',
    takenResources: false, incomeTaken: false, abilityUsed: false,
    builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false,
    usedMuseum: false, pending: null, bonusDone: false
  };
  return state;
}

test('女巫接管被施咒的航海家后仍可领取额外奖励', () => {
  const state = mkState();
  const witch = state.players[0];
  const goldBefore = witch.gold;

  const resource = Engine.applyAction(state, 'p1', { type: 'take_gold' });
  assert.equal(resource.ok, true, resource.error);
  assert.equal(state.turn.phase, 'witch_resume');
  assert.equal(state.turn.playerIdx, 0);
  assert.equal(state.turn.charId, 'navigator');
  assert.equal(state.turn.bonusDone, false);

  const available = Engine.getAvailableActions(state, 'p0');
  const types = (available.actions || []).map(action => action.type);
  assert.ok(types.includes('ability'), '女巫接管后应显示航海家能力入口');

  const ability = Engine.applyAction(state, 'p0', { type: 'ability' });
  assert.equal(ability.ok, true, ability.error);
  assert.equal(state.turn.pending && state.turn.pending.kind, 'navigator_bonus');

  const bonus = Engine.applyAction(state, 'p0', { type: 'navigator_bonus', mode: 'gold' });
  assert.equal(bonus.ok, true, bonus.error);
  assert.equal(witch.gold, goldBefore + 4, '女巫接管后应领取航海家额外金币');
  assert.equal(state.turn.bonusDone, true);
  assert.equal(state.turn.abilityUsed, true);
});
