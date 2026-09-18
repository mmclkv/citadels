'use strict';

// 训练自对弈的搜索必须只看公开信息：JS MCTS 与 native(C++) MCTS 拿到的根局面
// 都必须是确定化（隐藏信息换成随机猜测）后的克隆，而不是服务器上的真局面。
// 这里把 determinize 与两个搜索引擎的入口都装上探针，逐个搜索调用比对：
//   根局面 === 确定化产出的那份克隆（身份相等），且
//   根局面的公开视角与真局面一字不差，隐藏牌堆却确实被换掉了。

const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const { PolicyValueNetwork } = require('../training/neural-policy.js');
const mcts = require('../training/mcts.js');
const determinizeModule = require('../training/determinize.js');

// train.js 在加载时就解构了 determinize，必须先装探针再 require 它。
const probes = [];
const realDeterminize = determinizeModule.determinize;
determinizeModule.determinize = function (state, playerId, rng) {
  const guess = realDeterminize(state, playerId, rng);
  probes.push({
    playerId,
    truthHidden: hiddenSignature(state),
    guessHidden: hiddenSignature(guess),
    publicViewEqual: JSON.stringify(Engine.sanitize(guess, playerId)) ===
      JSON.stringify(Engine.sanitize(state, playerId)),
    guess
  });
  return guess;
};

const Train = require('../training/train.js');

function hiddenSignature(state) {
  return JSON.stringify({
    deck: (state.deck || []).map(card => card.uid),
    hands: (state.players || []).map(p => (p.hand || []).map(card => card.uid)),
    chars: (state.players || []).map(p => p.chars || []),
    faceDown: state.draft ? state.draft.faceDown : null
  });
}

function uniformPolicy(size) {
  return new Float32Array(size).fill(1 / size);
}

const realMctsSearch = mcts.search;

async function runWithJsSearch(config) {
  probes.length = 0;
  const roots = [];
  mcts.search = async options => {
    const legal = options.legalFn(options.rootState, options.rootPlayerId);
    roots.push({ root: options.rootState, playerId: options.rootPlayerId, legal });
    return { pi: uniformPolicy(legal.length), value: 0, valueVector: null, visits: legal.length,
      expansions: 1, simTerminal: 0, simDepthCapped: 0, simLeaf: 0, simOther: 0 };
  };
  let searches = 0;
  const model = new PolicyValueNetwork({ profile: 'fast', seed: 7 });
  try {
    await Train.runSelfPlayGame(model, config, 1, Math.random, () => ++searches >= 6 && roots.length >= 5);
  } finally {
    mcts.search = realMctsSearch;
  }
  return roots;
}

function assertBlind(roots, label) {
  assert(roots.length >= 3, label + '：应记录到若干次搜索调用');
  assert.equal(probes.length, roots.length, label + '：每次搜索恰好消费一份确定化根局面');
  let randomized = 0;
  roots.forEach((entry, i) => {
    const probe = probes[i];
    assert(probe.publicViewEqual, label + '：第 ' + i + ' 次搜索的根局面公开信息与真局面一字不差');
    assert.strictEqual(entry.root, probe.guess, label + '：第 ' + i + ' 次搜索用的就是确定化出来的那份克隆');
    assert.equal(hiddenSignature(entry.root), probe.guessHidden,
      label + '：搜索期间根局面没有被换回真牌');
    assert.deepEqual(entry.legal, Train.enumerateLegalActions(entry.root, entry.playerId),
      label + '：交给搜索的动作列表与根局面自枚举结果一致');
    if (entry.playerId === probe.playerId && probe.truthHidden !== probe.guessHidden) randomized++;
  });
  assert(randomized >= Math.min(2, roots.length),
    label + '：确定化必须真的换掉隐藏牌堆（' + randomized + '/' + roots.length + '）');
}

(async () => {
  const base = { targetGames: 1, minPlayers: 3, maxPlayers: 3, charSet: 'base', profile: 'fast',
    batchGames: 1, ppoEpochs: 1, seed: 42, endDistricts: 7, selfPlayMode: 'all-network' };

  // ---- JS MCTS ----
  const jsRoots = await runWithJsSearch(Train.sanitizeConfig(Object.assign({}, base, {
    mctsSimulations: 8, mctsEngine: 'js', mctsMaxDepth: 30
  })));
  assertBlind(jsRoots, 'JS MCTS');

  // ---- native(C++) MCTS：用假 client 截获 encodeSearchRequest 之前的三个参数 ----
  probes.length = 0;
  const sent = [];
  const fakeNative = {
    search: async (state, playerId, legal, modelVersion) => {
      sent.push({ state, playerId, legal, modelVersion });
      return { policy: Array.from(uniformPolicy(legal.length)), value: 0, visits: legal.length,
        expansions: 1, valueVector: null };
    }
  };
  const nativeConfig = Train.sanitizeConfig(Object.assign({}, base, {
    mctsSimulations: 8, mctsEngine: 'cpp', backend: 'native',
    neuralNetworkFramework: 'libtorch', mctsMaxDepth: 30
  }));
  let nativeSearches = 0;
  await Train.runSelfPlayGame(new PolicyValueNetwork({ profile: 'fast', seed: 8 }), nativeConfig, 1,
    Math.random, () => ++nativeSearches >= 6 && sent.length >= 5, null, fakeNative);
  assert.equal(sent.length, probes.length, 'native：每次搜索只消耗一份确定化根局面');
  sent.forEach((entry, i) => {
    const probe = probes[i];
    assert(probe.publicViewEqual, 'native：第 ' + i + ' 次搜索的根局面公开信息与真局面一字不差');
    assert.strictEqual(entry.state, probe.guess, 'native：送给 C++ worker 的是确定化后的克隆，不是真局面');
    assert.deepEqual(entry.legal, Train.enumerateLegalActions(probe.guess, entry.playerId),
      'native：动作列表在确定化局面上重新枚举（uid 类动作下标才不会错位）');
  });
  assert(sent.some((entry, i) => probes[i].truthHidden !== probes[i].guessHidden),
    'native：确定化确实换掉了隐藏牌堆');

  // ---- alignedDeterminization：动作列表对不上时必须拒绝，而不是回退成真局面 ----
  const state = Engine.createGame({ roomId: 'aligned', endDistricts: 7, charSetMode: 'base',
    seed: 99, seats: [0, 1, 2].map(i => ({ id: 'a' + i, name: 'A' + i, isBot: true })) });
  Engine.startGame(state);
  const actorId = Train.currentActor(state).id;
  const legal = Train.enumerateLegalActions(state, actorId);
  const before = JSON.stringify(state);
  const root = Train.alignedDeterminization(state, actorId, legal, Math.random);
  assert.equal(JSON.stringify(state), before, 'alignedDeterminization 不得改写权威状态');
  assert(root && root.state !== state, 'alignedDeterminization 返回的是克隆');
  assert.deepEqual(root.legal, legal, ' alignedDeterminization 保证动作列表与真局面逐字节一致');
  assert.equal(Train.alignedDeterminization(state, 'nobody', legal, Math.random), null,
    '找不到视角玩家时不得返回任何根局面');
  assert.equal(Train.alignedDeterminization(state, actorId, [{ type: 'not_a_real_action' }], Math.random), null,
    '动作列表对不上时宁可拒绝搜索');

  console.log('训练搜索：JS 与 native 两条路径都只在确定化局面上搜索');
})();
