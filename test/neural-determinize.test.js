'use strict';

// 确定化（determinization）的安全边界：
// 隐藏信息换成随机猜测，公开信息必须一字不改 —— 否则搜索既不公平也不可信。

const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const AI = require('../src/ai.js');
const { determinize } = require('../training/determinize.js');
const { currentActor, enumerateLegalActions } = require('../training/train.js');

function makeState(seed, players) {
  const seats = [];
  for (let i = 0; i < players; i++) seats.push({ id: 'p' + i, name: 'P' + i, isBot: true, botType: 'npc' });
  const state = Engine.createGame({ roomId: 'det-' + seed, seats, endDistricts: 7,
    charSetMode: seed % 2 ? 'base' : 'dark', seed });
  Engine.startGame(state);
  return state;
}

/** 沿真实规则往前推 `steps` 步，返回途中的 (状态, 行动方) 采样点。 */
function samplePositions(count) {
  const samples = [];
  let seed = 1;
  while (samples.length < count && seed < 30) {
    const state = makeState(seed++, 5);
    let guard = 0;
    while (state.phase !== 'gameover' && guard++ < 3000 && samples.length < count) {
      const actor = currentActor(state);
      if (!actor) break;
      const legal = enumerateLegalActions(state, actor.id);
      if (!legal.length) break;
      if (legal.length > 1 && state.players.some(p => p.hand.length)) {
        samples.push({ state: JSON.parse(JSON.stringify(state)), playerId: actor.id, legal });
      }
      const action = AI.decide(state, actor.id) || legal[0];
      if (!Engine.applyAction(state, actor.id, action).ok) break;
    }
  }
  return samples;
}

function main() {
  const samples = samplePositions(80);
  assert(samples.length >= 40, '应采到足够的真实局面样本');
  let sawDraft = false, sawAction = false, randomized = 0, queueChanged = 0, queueSamples = 0;

  samples.forEach(sample => {
    const before = JSON.stringify(sample.state);
    const view = JSON.stringify(Engine.sanitize(sample.state, sample.playerId));
    const guess = determinize(sample.state, sample.playerId);

    assert.equal(JSON.stringify(sample.state), before, '确定化不得改写服务器上的权威状态');
    assert.equal(JSON.stringify(Engine.sanitize(guess, sample.playerId)), view,
      '确定化后视角玩家的公开信息必须一字不差');
    assert.equal(JSON.stringify(enumerateLegalActions(guess, sample.playerId)), JSON.stringify(sample.legal),
      '确定化不得改变合法动作集合（否则 π 的下标会错位）');

    sample.state.players.forEach((player, i) => {
      assert.equal(guess.players[i].hand.length, player.hand.length, '每位玩家的手牌张数不变');
    });
    assert.equal(guess.deck.length, sample.state.deck.length, '牌库张数不变');
    assert.equal(guess.discard.length, sample.state.discard.length, '弃牌堆张数不变');
    assert.deepEqual(guess.players.find(p => p.id === sample.playerId).hand,
      sample.state.players.find(p => p.id === sample.playerId).hand, '自己的手牌原样保留');

    const meIdx = sample.state.players.findIndex(p => p.id === sample.playerId);
    const hiddenChanged = sample.state.players.some((p, i) =>
      i !== meIdx && JSON.stringify(p.hand) !== JSON.stringify(guess.players[i].hand));
    if (hiddenChanged) randomized++;

    // 叫号队列尾部写着「每个还没叫到的号握在谁手上」，这是整轮最大的隐藏信息块：
    // 它必须跟着打乱后的角色手牌重建，并且和猜测局面自身自洽。
    if (sample.state.phase === 'action') {
      const queue = sample.state.callQueue;
      const cut = Math.min(sample.state.callIdx || 0, queue.length - 1);
      assert.deepEqual(guess.callQueue.slice(0, cut + 1), queue.slice(0, cut + 1),
        '已经叫过的号（含正在行动的这条）是公开事实，不得改动');
      guess.callQueue.slice(cut + 1).forEach(entry => {
        const holder = guess.players[entry.playerIdx];
        assert(holder.chars.indexOf(entry.charId) >= 0 && !(holder.played || []).includes(entry.charId),
          '队列尾部必须与猜测局面里的角色手牌自洽');
      });
      if (JSON.stringify(guess.callQueue) !== JSON.stringify(queue)) queueChanged++;
      queueSamples++;
    }

    if (sample.state.phase === 'draft') sawDraft = true;
    if (sample.state.phase === 'action') sawAction = true;
  });

  assert(sawDraft && sawAction, '样本要同时覆盖选角与行动阶段');
  assert(queueSamples > 10 && queueChanged > queueSamples * 0.8,
    '确定化必须真的重排叫号归属（' + queueChanged + '/' + queueSamples + '）');
  assert(randomized > samples.length * 0.8,
    '确定化必须真的换掉对手手牌（' + randomized + '/' + samples.length + '）');

  // 7~8 人局最后一名玩家会从「传下来的牌 + 暗置牌」中选择角色。
  // 暗置牌此时对当前玩家已经可见，确定化不得改变其动作顺序。
  for (const playerCount of [7, 8]) {
    const draftState = makeState(200 + playerCount, playerCount);
    let sawFaceDownPick = false;
    let guard = 0;
    while (draftState.phase === 'draft' && guard++ < 100) {
      const actor = currentActor(draftState);
      if (!actor) break;
      const step = draftState.draft.steps[draftState.draft.stepIdx];
      const legal = enumerateLegalActions(draftState, actor.id);
      if (step && step.fromFaceDown && draftState.draft.sub === 'pick') {
        sawFaceDownPick = true;
        const guess = determinize(draftState, actor.id);
        assert.deepEqual(enumerateLegalActions(guess, actor.id), legal,
          playerCount + ' 人局从暗置角色牌选角时动作列表必须保持一致');
      }
      const action = AI.decide(draftState, actor.id) || legal[0];
      if (!action || !Engine.applyAction(draftState, actor.id, action).ok) break;
    }
    assert(sawFaceDownPick, playerCount + ' 人局应覆盖从暗置角色牌选角路径');
  }

  // 逮捕令：三个编号是公开的，哪张是真的保密 —— 猜测只能在公开集合里选
  const withWarrant = makeState(77, 5);
  withWarrant.effects = withWarrant.effects || {};
  withWarrant.effects.magistrate = { nums: [3, 5, 8], signed: 3, playerIdx: 4, claimed: false };
  const guesses = new Set();
  for (let i = 0; i < 40; i++) {
    const det = determinize(withWarrant, 'p0');
    const warrant = det.effects.magistrate;
    assert(warrant.nums.indexOf(warrant.signed) >= 0, '真逮捕令只能落在公开的三个编号里');
    assert.deepEqual(warrant.nums.slice(), [3, 5, 8], '逮捕令的公开编号集合不变');
    guesses.add(warrant.signed);
  }
  assert(guesses.size > 1, '对非行政官本人而言，哪张是真令应当被重新随机指定');

  // 真逮捕令一旦被没收就公开了（claimed），此时不能再猜，否则猜测局面与公开事实矛盾
  const usedWarrant = makeState(78, 5);
  usedWarrant.effects = usedWarrant.effects || {};
  usedWarrant.effects.magistrate = { nums: [3, 5, 8], signed: 5, playerIdx: 4, claimed: true };
  for (let i = 0; i < 10; i++) {
    assert.equal(determinize(usedWarrant, 'p0').effects.magistrate.signed, 5,
      '已公开的逮捕令真目标不得被改写');
  }

  // 勒索标记同理：公开的是编号集合，真的那个只有勒索者本人知道
  const withThreat = makeState(79, 5);
  withThreat.effects = withThreat.effects || {};
  withThreat.effects.blackmailer = { nums: [2, 6], signed: 2, playerIdx: 4, done: [6], revealed: [{ num: 6, isReal: false }] };
  const threatGuesses = new Set();
  for (let i = 0; i < 30; i++) {
    const threat = determinize(withThreat, 'p0').effects.blackmailer;
    assert.deepEqual(threat.nums.slice(), [2, 6], '威胁标记的公开编号集合不变');
    assert.equal(threat.signed, 2, '已经翻开证明是假的编号，真标记只可能剩下那个');
    threatGuesses.add(threat.signed);
  }
  assert.equal(threatGuesses.size, 1, '真标记的候选被公开事实唯一确定时不得再随机');
  withThreat.effects.blackmailer.done = []; withThreat.effects.blackmailer.revealed = [];
  const openGuesses = new Set();
  for (let i = 0; i < 30; i++) openGuesses.add(determinize(withThreat, 'p0').effects.blackmailer.signed);
  assert(openGuesses.size > 1, '两个编号都没处理时，真标记应当被重新随机指定');

  // 已经被点名的牌（法师看过的牌、逮捕令要没收的牌）必须钉在原处：那是行动者的
  // 合法知识，猜没了它，引擎在猜测局面上会拒绝自己刚刚允许的动作。
  const named = samples.map(sample => {
    const foe = sample.state.players.findIndex(p => p.id !== sample.playerId && p.hand.length >= 2);
    return foe >= 0 ? { sample, foe } : null;
  }).find(Boolean);
  const namedSample = named.sample;
  namedSample.state.reaction = { kind: 'magistrate', playerIdx: 0, card: namedSample.state.players[named.foe].hand[0] };
  namedSample.state.turn = { playerIdx: 0, pending: { kind: 'wizard_choice', targetIdx: named.foe,
    card: namedSample.state.players[named.foe].hand[1] } };
  const pinnedUid = namedSample.state.reaction.card.uid;
  const pinnedUid2 = namedSample.state.turn.pending.card.uid;
  for (let i = 0; i < 20; i++) {
    const det = determinize(namedSample.state, namedSample.playerId);
    const foeHand = det.players[named.foe].hand.map(card => card.uid);
    assert(foeHand.indexOf(pinnedUid) >= 0, '被逮捕令点名的牌不得被洗走');
    assert(foeHand.indexOf(pinnedUid2) >= 0, '被法师点名的牌不得被洗走');
    assert.equal(det.reaction.card.uid, pinnedUid, '待定区引用的牌面对象本身不变');
  }

  // 注入随机源后结果可复现（测试与排障都要能重放同一份猜测）
  const seeded = () => { let s = 12345; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648; };
  const target = samples[0];
  assert.equal(JSON.stringify(determinize(target.state, target.playerId, seeded())),
    JSON.stringify(determinize(target.state, target.playerId, seeded())),
    '同一随机源应产出完全相同的确定化局面');

  console.log('确定化：公开信息不变、合法动作不变、权威状态不被改写、隐藏信息确实重排');
}

main();
