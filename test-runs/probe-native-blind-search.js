'use strict';
// 临时探针：真实 C++ worker 在「确定化根」上搜索，检查动作列表被 worker 接受
// （接受了才会有非均匀的访问分布；对不上时它会退化成均匀先验）。
const path = require('path');
const Engine = require('../src/engine.js');
const AI = require('../src/ai.js');
const { NativeSearchClient } = require('../training/native-search.js');
const { currentActor, enumerateLegalActions, alignedDeterminization } = require('../training/train.js');

let printed = 0;
const ROOT = path.join(__dirname, '..');
const client = new NativeSearchClient({
  root: ROOT, executable: path.join(ROOT, 'native', 'mcts_worker.exe'),
  simulations: 40, maxDepth: 40, cPuct: 1, seed: 20260919
});

function makeState(seed) {
  const seats = [0, 1, 2].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'npc' }));
  const state = Engine.createGame({ roomId: 'probe', seats, endDistricts: 7, charSetMode: 'mixed', seed });
  Engine.startGame(state);
  return state;
}

(async () => {
  let searched = 0, uniform = 0, skipped = 0, short = 0, rejected = 0;
  for (let seed = 1; seed <= 60 && searched < 250; seed++) {
    const state = makeState(seed);
    let guard = 0;
    while (state.phase !== 'gameover' && guard++ < 2000 && searched < 250) {
      const actor = currentActor(state);
      if (!actor) break;
      const legal = enumerateLegalActions(state, actor.id);
      if (!legal.length) break;
      const root = process.env.PEEK ? { state, legal }
        : alignedDeterminization(state, actor.id, legal, Math.random);
      if (!root) { skipped++; }
      else {
        const result = await client.search(root.state, actor.id, root.legal, seed);
        const policy = result.policy;
        searched++;
        if (printed++ < 0) console.log(JSON.stringify({ peek: !!process.env.PEEK, phase: state.phase,
          kinds: root.legal.map(a => a.type), policy: Array.from(policy).map(v => +v.toFixed(4)),
          visits: result.visits, expansions: result.expansions }));
        if (policy.length !== legal.length) short++;
        // worker 自己比对动作列表；不一致时它不跑树，只用均匀先验兜底
        if (result.fallback) {
          rejected++;
          console.log(JSON.stringify({ fallback: { peek: !!process.env.PEEK,
            native: result.nativeActionTypes, supplied: result.suppliedActionTypes, mismatchIndex: result.mismatchIndex,
            pending: state.turn && state.turn.pending && state.turn.pending.kind } }));
        }
        else if (Math.abs(Math.max.apply(null, Array.from(policy)) - 1 / legal.length) < 1e-6 && legal.length > 1) uniform++;
      }
      const action = AI.decide(state, actor.id) || legal[0];
      if (!Engine.applyAction(state, actor.id, action).ok) break;
    }
  }
  console.log(JSON.stringify({ searched, uniform, short, skipped }));
  client.close();
})();
