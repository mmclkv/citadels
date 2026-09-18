'use strict';
// 临时探针：统计真实局面上「确定化后能否复现合法动作列表」的失败率与重试次数。
const Engine = require('../src/engine.js');
const AI = require('../src/ai.js');
const { determinize } = require('../training/determinize.js');
const { currentActor, enumerateLegalActions } = require('../training/train.js');

function makeState(seed, players) {
  const seats = [];
  for (let i = 0; i < players; i++) seats.push({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'npc' });
  const state = Engine.createGame({ roomId: 'probe', seats, endDistricts: 8,
    charSetMode: ['base', 'dark', 'mixed'][seed % 3], seed });
  Engine.startGame(state);
  return state;
}

const ATTEMPTS = Number(process.env.ATTEMPTS || 4);
const tally = { positions: 0, firstTry: 0, retried: 0, missed: 0, attempts: 0 };
const misses = new Map(); let printed = 0;
let seed = 1;
while (seed <= Number(process.env.GAMES || 60)) {
  const state = makeState(seed++, 5);
  let guard = 0;
  while (state.phase !== 'gameover' && guard++ < 4000) {
    const actor = currentActor(state);
    if (!actor) break;
    const legal = enumerateLegalActions(state, actor.id);
    if (!legal.length) break;
    tally.positions++;
    const baseline = JSON.stringify(legal);
    let used = 0, ok = false, last = null;
    for (let i = 0; i < ATTEMPTS; i++) {
      used++;
      const guess = determinize(state, actor.id);
      const actions = enumerateLegalActions(guess, actor.id);
      last = { guess, actions };
      if (actions.length === legal.length && JSON.stringify(actions) === baseline) { ok = true; break; }
    }
    tally.attempts += used;
    if (ok) { if (used === 1) tally.firstTry++; else tally.retried++; }
    else {
      tally.missed++;
      const kind = (state.turn && state.turn.pending && state.turn.pending.kind) || state.phase;
      misses.set(kind, (misses.get(kind) || 0) + 1);
      if (kind !== "wizard_choice" && printed++ < 8) console.log(JSON.stringify({
        kind, player: actor.id, char: state.turn && state.turn.charId,
        reaction: state.reaction && state.reaction.kind,
        truth: legal.map(a => a.type + ':' + (a.uid || a.target || a.num || '')),
        guess: last.actions.map(a => a.type + ':' + (a.uid || a.target || a.num || '')),
        errors: legal.map(a => {
          const probe = Engine.applyAction(JSON.parse(JSON.stringify(last.guess)), actor.id, a);
          return probe.ok ? 'ok' : probe.error;
        }),
        handKept: JSON.stringify(last.guess.players.find(p => p.id === actor.id).hand) ===
          JSON.stringify(state.players.find(p => p.id === actor.id).hand)
      }));
    }
    const action = AI.decide(state, actor.id) || legal[0];
    if (!Engine.applyAction(state, actor.id, action).ok) break;
  }
}
console.log(JSON.stringify({ ...tally, missKinds: Object.fromEntries(misses) }, null, 1));
