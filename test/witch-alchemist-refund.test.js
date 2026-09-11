/* 回归测试：女巫对炼金术士施咒后的「回合末回收建造花费」归属。
 *
 * 官方规则（Citadels / Dark City rulebook）：
 *   Witch — "You now resume this player's turn as if you were playing the
 *   bewitched character, using all the character's powers in your city...
 *   You still build districts from your hand of cards and pay with your gold."
 * 即女巫接管时是以被施咒角色的身份行动：用自己的金币、建在自己的城区，
 * 因此同样享有该角色的能力收益 —— 炼金术士的建造花费返还归女巫。
 * 被施咒者本人此时只能领资源、无法建造，自然拿不到退款。
 *
 * 修复前：endTurn 里 `t.phase !== 'witch_resume'` 把女巫接管排除在外，
 * 导致女巫花的钱不返还，与规则不符。
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
  st.callQueue = [
    { charId: 'witch', num: 1, playerIdx: 0 },
    { charId: 'alchemist', num: 6, playerIdx: 1 }
  ];
  st.callIdx = 0;
  return st;
}

function mkTurn(playerIdx, phase) {
  return {
    charId: 'alchemist', num: 6, playerIdx: playerIdx, phase: phase,
    takenResources: true, incomeTaken: false, abilityUsed: false,
    builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: null, bonusDone: (phase === 'witch_resume')
  };
}

console.log('\n[场景1] 女巫接管被施咒的炼金术士 → 女巫建造 → 回合末退款给女巫');
{
  const st = mkState();
  const witch = st.players[0];
  witch.gold = 10;
  witch.hand = [card('w1', '庄园', 3)];
  st.effects.bewitched = 6;
  st.effects.witchBy = 0;
  st.turn = mkTurn(0, 'witch_resume');

  const cityBefore = witch.city.length;
  const r1 = Engine.applyAction(st, 'p0', { type: 'build', uid: 'w1' });
  check('女巫接管时可以建造', r1.ok === true, r1.error);
  check('建造从女巫金币扣除（10 → 7）', witch.gold === 7, 'gold=' + witch.gold);
  check('建筑进入女巫自己的城区', witch.city.length === cityBefore + 1);

  const r2 = Engine.applyAction(st, 'p0', { type: 'end_turn' });
  check('结束回合成功', r2.ok === true, r2.error);
  check('回合末女巫回收 3 枚建造花费（7 → 10）', witch.gold === 10, 'gold=' + witch.gold);

  const refundLog = st.log.slice(-8).some(l => /回收了本回合 3 枚建造花费/.test(l.text || ''));
  check('日志记录了本次回收', refundLog === true);
  const witchMark = st.log.slice(-8).some(l => /女巫接管/.test(l.text || ''));
  check('日志标注了「女巫接管」', witchMark === true);
}

console.log('\n[场景2] 普通炼金术士回合：建造花费仍返还给本人（回归）');
{
  const st = mkState();
  const al = st.players[1];
  al.gold = 8;
  al.hand = [card('a1', '商栈', 2, 'green')];
  st.turn = mkTurn(1, 'main');

  const r1 = Engine.applyAction(st, 'p1', { type: 'build', uid: 'a1' });
  check('炼金术士建造成功', r1.ok === true, r1.error);
  check('建造扣 2 金（8 → 6）', al.gold === 6, 'gold=' + al.gold);
  const r2 = Engine.applyAction(st, 'p1', { type: 'end_turn' });
  check('结束回合成功', r2.ok === true, r2.error);
  check('回合末回收 2 枚（6 → 8）', al.gold === 8, 'gold=' + al.gold);
}

console.log('\n[场景3] 被施咒的炼金术士本人：只能领资源，无法建造，也就无退款');
{
  const st = mkState();
  st.effects.bewitched = 6;
  st.effects.witchBy = 0;
  st.turn = mkTurn(1, 'bewitched');
  st.turn.takenResources = false;   // 尚未领资源
  const avail = Engine.getAvailableActions(st, 'p1');
  const types = (avail.actions || []).map(a => a.type);
  check('被施咒者没有建造行动', types.indexOf('build') < 0, types.join(','));
  check('被施咒者只能领取资源',
    types.indexOf('take_gold') >= 0 || types.indexOf('take_cards') >= 0, types.join(','));
  check('被施咒者无「结束回合」（由女巫接管）', types.indexOf('end_turn') < 0, types.join(','));
}

console.log('\n[场景4] 女巫接管但没建造 → 不应产生退款');
{
  const st = mkState();
  const witch = st.players[0];
  witch.gold = 5;
  st.effects.bewitched = 6;
  st.effects.witchBy = 0;
  st.turn = mkTurn(0, 'witch_resume');
  const r = Engine.applyAction(st, 'p0', { type: 'end_turn' });
  check('结束回合成功', r.ok === true, r.error);
  check('未建造则金币不变（仍为 5）', witch.gold === 5, 'gold=' + witch.gold);
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
