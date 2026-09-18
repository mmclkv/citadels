/* 回归测试：贵族（Noble，4 号）的「皇冠 + 每张皇家建筑抽 1 张」必须在角色被叫到号
 * 的瞬间结算，且不会因为回合随后被打断而丢失或落到别人头上。
 *
 * 背景（真实 bug）：这两项原本写在 beginNextCall 的正常分支末尾，于是只要回合在
 * 到达那里之前提前 return，就整个消失 —— 被勒索者威胁时皇冠和抽牌全丢；被女巫施咒
 * 时抽牌被延后到 finishBewitchedTurn，那时 state.turn.playerIdx 已经换成女巫，
 * 于是变成「女巫按女巫自己的皇家建筑抽牌」，贵族本人一张都拿不到。
 *
 * 现在统一走 applyNum4TurnStart：叫号瞬间结算给角色持有者，与后续打断无关。
 * 例外是刺杀 —— 整回合被跳过，皇冠改在轮末补发，抽牌随回合一起失去（规则如此）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Engine = require('../src/engine.js');

function card(uid, name, color) {
  return { uid: uid, name: name, en: name, color: color || 'yellow',
    cost: 3, desc: '', scoreValue: 3 };
}

function mkState() {
  const seats = [];
  for (let i = 0; i < 3; i++) {
    seats.push({ id: 'p' + i, name: '玩家' + (i + 1), isBot: true, botLevel: 'normal' });
  }
  const st = Engine.createGame({
    roomId: 't', endDistricts: 8, charSetMode: 'dark', seed: 11, seats: seats
  });
  Engine.startGame(st);
  st.phase = 'action';
  st.reaction = null;
  st.roundConfirm = null;
  return st;
}

/** 叫号队列：商人 → 目标角色（4 号）。setUp 里配好打断效果后调用本函数推进。 */
function advanceToChar4(st, charId, yellowCount) {
  st.callQueue = [
    { charId: 'merchant', num: 6, playerIdx: 0 },
    { charId: charId, num: 4, playerIdx: 1 }
  ];
  st.callIdx = 0;
  st.turn = {
    charId: 'merchant', num: 6, playerIdx: 0, phase: 'main',
    takenResources: true, incomeTaken: false, abilityUsed: false,
    builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: null, bonusDone: false
  };
  st.players.forEach(p => { p.hasCrown = false; });
  // 贵族（玩家2）有 yellowCount 栋皇家建筑；玩家3 一间都没有，用来识别「算错人」
  st.players[1].gold = 0;
  st.players[1].city = [];
  for (let i = 0; i < yellowCount; i++) st.players[1].city.push(card('y' + i, '皇家' + i));
  st.players[2].city = [];
  return Engine.applyAction(st, 'p0', { type: 'end_turn' });
}

function nobleDraws(st) { return st.notices.filter(n => n.kind === 'noble_draw'); }
function crownOf(st) { return st.players.findIndex(p => p.hasCrown); }

test('正常回合：贵族取得皇冠并按自己的皇家建筑抽牌', () => {
  const st = mkState();
  const before = st.players[1].hand.length;
  advanceToChar4(st, 'noble', 3);
  assert.equal(crownOf(st), 1, '皇冠归贵族');
  assert.equal(st.players[1].hand.length, before + 3, '手牌 +3');
  assert.equal(nobleDraws(st).length, 1, '只发一次 noble_draw');
  assert.equal(nobleDraws(st)[0].playerIdx, 1);
  assert.equal(nobleDraws(st)[0].amount, 3);
});

test('被女巫施咒：抽牌仍归贵族本人，且按贵族自己的皇家建筑计算', () => {
  const st = mkState();
  st.effects.bewitched = 4;
  st.effects.witchBy = 2;                 // 女巫是玩家3（城里没有皇家建筑）
  const nobleBefore = st.players[1].hand.length;
  const witchBefore = st.players[2].hand.length;

  advanceToChar4(st, 'noble', 3);
  assert.equal(crownOf(st), 1, '皇冠归被施咒的贵族本人，不是女巫');
  assert.equal(st.players[1].hand.length, nobleBefore + 3, '贵族本人抽 3 张');
  assert.equal(st.players[2].hand.length, witchBefore, '女巫一张都不该多拿');

  const draws = nobleDraws(st);
  assert.equal(draws.length, 1, '只在叫号时发一次');
  assert.equal(draws[0].playerIdx, 1, '通知里的收牌人是贵族');
  assert.equal(draws[0].amount, 3);

  // 被施咒者领完资源 → 女巫接管，此时不能再补发一次贵族抽牌
  const r = Engine.applyAction(st, 'p1', { type: 'take_gold' });
  assert.equal(r.ok, true, r.error);
  assert.equal(nobleDraws(st).length, 1, '女巫接管时不得重复发放');
  assert.equal(st.players[1].hand.length, nobleBefore + 3);
  assert.equal(st.players[2].hand.length, witchBefore);
});

test('被勒索者威胁（付赎金）：皇冠与抽牌都不丢', () => {
  const st = mkState();
  st.effects.blackmailer = { nums: [4], signed: 4, playerIdx: 2, done: [], revealed: [] };
  const before = st.players[1].hand.length;

  advanceToChar4(st, 'noble', 2);
  assert.equal(crownOf(st), 1, '皇冠照常给贵族（威胁只是插到回合开头问一句）');
  assert.equal(st.players[1].hand.length, before + 2, '抽牌照常结算');
  assert.deepEqual(st.turn.pending.kind, 'blackmailer_threat', '仍然停在威胁待处理');

  const r = Engine.applyAction(st, 'p1', { type: 'blackmailer_bribe' });
  assert.equal(r.ok, true, r.error);
  assert.equal(nobleDraws(st).length, 1, '处理完威胁不会重复结算');
  assert.equal(st.players[1].hand.length, before + 2);
});

test('被勒索者威胁（拒绝赎金 → 翻开标记）：皇冠与抽牌同样不丢', () => {
  const st = mkState();
  st.effects.blackmailer = { nums: [4], signed: 4, playerIdx: 2, done: [], revealed: [] };
  const before = st.players[1].hand.length;

  advanceToChar4(st, 'noble', 2);
  assert.equal(crownOf(st), 1);
  assert.equal(st.players[1].hand.length, before + 2);

  const refuse = Engine.applyAction(st, 'p1', { type: 'blackmailer_refuse' });
  assert.equal(refuse.ok, true, refuse.error);
  assert.equal(st.reaction && st.reaction.kind, 'blackmailer', '冻结等勒索者决定');

  // 勒索者翻开 → 真标记，拿走受害者全部金币
  const reveal = Engine.applyAction(st, 'p2', { type: 'reaction', use: true });
  assert.equal(reveal.ok, true, reveal.error);
  assert.equal(nobleDraws(st).length, 1, '整条威胁链结束后仍然只结算一次');
  assert.equal(crownOf(st), 1, '皇冠不会被威胁流程冲掉');
  assert.equal(st.players[1].hand.length, before + 2);
});

test('被刺杀：失去整回合（不抽牌），皇冠在轮末补发', () => {
  const st = mkState();
  st.effects.assassinated = 4;
  const before = st.players[1].hand.length;

  advanceToChar4(st, 'noble', 2);
  assert.equal(nobleDraws(st).length, 0, '被刺杀不结算抽牌');
  assert.equal(st.players[1].hand.length, before);
  assert.equal(crownOf(st), 1, '皇冠轮末补发给贵族');
});

test('国王被施咒：皇冠仍归国王本人（4 号即时收益不被女巫接管）', () => {
  const st = mkState();
  st.effects.bewitched = 4;
  st.effects.witchBy = 2;
  advanceToChar4(st, 'king', 3);
  assert.equal(crownOf(st), 1, '皇冠归国王');
  assert.equal(nobleDraws(st).length, 0, '国王不是贵族，不抽牌');
});
