'use strict';
const CitEngine = require('../src/engine.js');
const CitAI = require('../src/ai.js');

function currentActor(state) {
  if (state.phase === 'draft' && state.draft) {
    const step = state.draft.steps[state.draft.stepIdx];
    if (step) return state.players[step.player];
    return null;
  }
  if (state.reaction) return state.players[state.reaction.playerIdx];
  if (state.turn) return state.players[state.turn.playerIdx];
  return null;
}

const n = Number(process.argv[2] || 3);
const cs = process.argv[3] || 'dark';
const seed = Number(process.argv[4] || 1000);

const seats = [];
for (let i = 0; i < n; i++) seats.push({ id: 'p' + i, name: 'P' + (i + 1), isBot: true, botLevel: 'normal' });
const state = CitEngine.createGame({ roomId: 'dbg', endDistricts: 8, charSetMode: cs, seed: seed, seats: seats });
CitEngine.startGame(state);
console.log('角色组：', state.charDeck.join(','));

const seen = new Map();
let steps = 0;
while (state.phase !== 'gameover' && steps < 3000) {
  steps++;
  const actor = currentActor(state);
  if (!actor) { console.log('!! 无行动者，phase=' + state.phase); break; }
  const action = CitAI.decide(state, actor.id);
  if (!action) { console.log('!! AI 返回空行动'); break; }
  const sig = [state.phase, actor.id, state.turn ? state.turn.charId + ':' + state.turn.phase : '-',
    state.turn && state.turn.pending ? state.turn.pending.kind : '-',
    action.type, JSON.stringify(action)].join('|');
  seen.set(sig, (seen.get(sig) || 0) + 1);
  if (seen.get(sig) > 12) {
    console.log('\n### 检测到重复循环 ###');
    console.log('签名：' + sig);
    console.log('玩家：', state.players.map(p => p.name + ' 金' + p.gold + ' 城' + p.city.length + ' 手' + p.hand.length).join(' | '));
    console.log('turn：', JSON.stringify(state.turn && { charId: state.turn.charId, phase: state.turn.phase,
      takenResources: state.turn.takenResources, incomeTaken: state.turn.incomeTaken,
      abilityUsed: state.turn.abilityUsed, builds: state.turn.builds, pending: state.turn.pending }));
    console.log('\n最近日志：');
    state.log.slice(-25).forEach(l => console.log('  ' + l.text));
    break;
  }
  const res = CitEngine.applyAction(state, actor.id, action);
  if (!res.ok) {
    console.log('行动失败：' + res.error + ' / ' + JSON.stringify(action));
    if (state.turn && state.turn.pending) CitEngine.applyAction(state, actor.id, { type: 'ability_skip' });
    else if (state.turn) CitEngine.applyAction(state, actor.id, { type: 'end_turn' });
    else break;
  }
}
console.log('\n结束：phase=' + state.phase + ' 步数=' + steps + ' 轮次=' + state.round);
