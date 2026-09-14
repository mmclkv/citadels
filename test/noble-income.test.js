/* 回归测试：贵族（Noble，4 号 deluxe）每张皇家（黄）建筑抽取 1 张建筑牌。
 *
 * 角色效果：贵族在回合开始（engine.js beginNextCall → doNobleIncome）自动结算，
 * 每有1栋皇家（黄）建筑就抽1张建筑牌，并发出 noble_draw 通知供 UI 做提示动画。
 * 注意：贵族不拿金币（拿金币的是国王/皇帝），抽牌不泄露给对手（牌面只在本人可见）。
 *
 * 触发方式：用 end_turn 把叫号推进到贵族来复现回合开始结算。
 */
'use strict';
const Engine = require('../src/engine.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

function card(uid, name, cost, color) {
  return { uid: uid, name: name, en: name, color: color || 'yellow',
    cost: cost, desc: '', scoreValue: cost };
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

// 叫号队列：先一个普通角色，再叫到贵族；用 end_turn 推进到贵族回合，
// 触发 beginNextCall → doNobleIncome（每张皇家建筑抽 1 张建筑牌）。
function setupNobleTurn(st, yellowCount) {
  st.callQueue = [
    { charId: 'merchant', num: 6, playerIdx: 0 },
    { charId: 'noble', num: 4, playerIdx: 1 }
  ];
  st.callIdx = 0;
  st.turn = {
    charId: 'merchant', num: 6, playerIdx: 0, phase: 'main',
    takenResources: true, incomeTaken: false, abilityUsed: false,
    builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: null, bonusDone: false
  };
  st.players[1].gold = 0;
  st.players[1].city = [];
  for (let i = 0; i < yellowCount; i++) {
    st.players[1].city.push(card('y' + i, '皇家建筑' + i, 3, 'yellow'));
  }
}

function lastNobleDraw(st) {
  const draws = st.notices.filter(n => n.kind === 'noble_draw');
  return draws.length ? draws[draws.length - 1] : null;
}

console.log('\n[场景1] 贵族有 3 栋皇家建筑 → 回合开始立刻抽 3 张建筑牌');
{
  const st = mkState();
  setupNobleTurn(st, 3);
  const handBefore = st.players[1].hand.length;
  const r = Engine.applyAction(st, 'p0', { type: 'end_turn' });
  check('推进到贵族回合成功', r.ok === true, r.error);
  check('贵族手牌 +3（抽牌而非拿金）', st.players[1].hand.length === handBefore + 3,
    'hand=' + st.players[1].hand.length + ' (before ' + handBefore + ')');
  check('贵族金币不变（仍为 0，不是拿金）', st.players[1].gold === 0, 'gold=' + st.players[1].gold);
  const got = st.log.slice(-12).some(l => /贵族.*因 3 栋皇家建筑抽取 3 张建筑牌/.test(l.text || ''));
  check('日志记录了贵族抽牌', got === true);
  const nd = lastNobleDraw(st);
  check('发出了 noble_draw 通知（amount=3）', nd && nd.amount === 3, JSON.stringify(nd));
  check('收入已标记为领取（incomeTaken）', st.turn && st.turn.incomeTaken === true);
}

console.log('\n[场景2] 贵族 0 栋皇家建筑 → 不抽牌、不拿金，但仍取得皇冠');
{
  const st = mkState();
  setupNobleTurn(st, 0);
  const handBefore = st.players[1].hand.length;
  const r = Engine.applyAction(st, 'p0', { type: 'end_turn' });
  check('推进成功', r.ok === true, r.error);
  check('贵族手牌不变', st.players[1].hand.length === handBefore, 'hand=' + st.players[1].hand.length);
  check('贵族金币不变（仍为 0）', st.players[1].gold === 0, 'gold=' + st.players[1].gold);
  check('贵族仍取得皇冠', st.players[1].hasCrown === true);
  check('无 noble_draw 通知（amount=0 不发）', lastNobleDraw(st) === null);
}

console.log('\n[场景3] 贵族有 1 栋皇家建筑 → 仅抽 1 张（拿 0 金）');
{
  const st = mkState();
  setupNobleTurn(st, 1);
  const handBefore = st.players[1].hand.length;
  const r = Engine.applyAction(st, 'p0', { type: 'end_turn' });
  check('推进成功', r.ok === true, r.error);
  check('贵族手牌 +1', st.players[1].hand.length === handBefore + 1,
    'hand=' + st.players[1].hand.length + ' (before ' + handBefore + ')');
  check('贵族金币不变（仍为 0）', st.players[1].gold === 0, 'gold=' + st.players[1].gold);
  const nd = lastNobleDraw(st);
  check('发出了 noble_draw 通知（amount=1）', nd && nd.amount === 1, JSON.stringify(nd));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
