/* 回归测试：住持保护只能依赖公开信息。
 *
 * 规则依据：住持（5 号）若未被刺杀 / 施咒，其城市不受 8 号角色（领主、元帅、外交官）能力影响。
 *
 * 修复前：isAbbotProtected 读的是 p.chars —— 本轮选到、还没打出的角色牌，属于隐藏信息。
 * 于是候选目标列表会少掉「手握住持的那一整名玩家」，行动者直接从列表里读出谁拿住了持；
 * applyAction 的错误文案同样是条免费探测通道。
 * 修复后：判定改用 p.played（本轮已打出的角色，sanitize 对所有人公开）。
 * 8 号必然晚于 5 号被叫到，所以可到达局面里「握在住持」与「已打住持」是同一件事 ——
 * 场景 4 用真实牌局把这句论证钉住。
 * native/game_state.hpp 的 protected_from_rank8 同步读 played（回合结束才登记、轮初清空），
 * 否则两边在确定化猜出的世界里会给出不同的目标列表，根节点动作对不上就退化成均匀先验。
 */
'use strict';
const Engine = require('../src/engine.js');
const AI = require('../src/ai.js');
const { currentActor } = require('../training/train.js');
const { determinize } = require('../training/determinize.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

function redDistrict(uid, name, cost) {
  return { uid: uid, name: name, en: name, color: 'red', cost: cost, desc: '' };
}

function mkState(seats, seed) {
  const players = [];
  for (let i = 0; i < seats; i++) {
    players.push({ id: 'p' + i, name: '玩家' + (i + 1), isBot: true, botType: 'npc' });
  }
  const st = Engine.createGame({ roomId: 'abbot-' + seed, seats: players,
    endDistricts: 8, charSetMode: 'mixed', seed: seed || 3 });
  Engine.startGame(st);
  st.phase = 'action';
  st.reaction = null;
  st.roundConfirm = null;
  st.effects.assassinated = null;
  st.effects.bewitched = null;
  return st;
}

function mkTurn(charId, num, pending) {
  return {
    charId: charId, num: num, playerIdx: 0, phase: 'main',
    takenResources: true, incomeTaken: true, abilityUsed: false,
    builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: pending, bonusDone: false
  };
}

/** 8 号能力的候选目标：'玩家id:建筑uid' 集合 */
function targets(st) {
  const res = Engine.getAvailableActions(st, 'p0') || {};
  return (res.actions || []).filter(a => a.type === 'choose_district')
    .map(a => a.target + ':' + a.uid).sort();
}

/** 只看公开信息（sanitize 下发给任何人的字段）就能算出的保护名单 */
function publicProtection(view) {
  const off = view.effects.assassinated === 5 || view.effects.bewitched === 5;
  return view.players.map((p, i) => (!off && p.played.indexOf('abbot') >= 0 ? i : -1))
    .filter(i => i >= 0);
}

function warlordScene() {
  const st = mkState(4, 9);
  st.turn = mkTurn('warlord', 8, { kind: 'warlord_destroy' });
  st.players.forEach(p => { p.gold = 12; });
  st.players[1].city.push(redDistrict('r1', '兵营', 5));
  st.players[2].city.push(redDistrict('r2', '城墙', 4));
  st.players[3].city.push(redDistrict('r3', '塔楼', 3));
  return st;
}

console.log('\n[场景1] 住持还扣在手里（未打出）：不得从目标列表里露出来');
{
  const holding = warlordScene();
  holding.players[1].chars = ['abbot'];
  const plain = warlordScene();
  plain.players[1].chars = ['monk'];
  const list = targets(holding);
  check('列表里仍有住持持有者的建筑', list.indexOf('p1:r1') >= 0, JSON.stringify(list));
  check('候选目标与住持在不在手里完全无关', JSON.stringify(list) === JSON.stringify(targets(plain)),
    JSON.stringify(list) + ' vs ' + JSON.stringify(targets(plain)));
  check('领主真的摧毁了「受保护」玩家那一栋（此局面本就不该保护）',
    Engine.applyAction(holding, 'p0', { type: 'choose_district', target: 'p1', uid: 'r1' }).ok === true);
}

console.log('\n[场景2] 住持已经打出（公开信息）：保护照常生效');
{
  const st = warlordScene();
  st.players[1].played = ['abbot'];
  const list = targets(st);
  check('已打出住持的玩家整列目标消失', list.indexOf('p1:r1') < 0, JSON.stringify(list));
  check('其余玩家不受影响', list.indexOf('p2:r2') >= 0 && list.indexOf('p3:r3') >= 0, JSON.stringify(list));
  const res = Engine.applyAction(st, 'p0', { type: 'choose_district', target: 'p1', uid: 'r1' });
  check('强行指定受保护目标仍被规则拒绝', res.ok !== true, JSON.stringify(res));
  check('拒绝理由本身就是公开可算的（保护名单来自 played）', /保护/.test(res.error || ''), res.error);
}

console.log('\n[场景3] 被刺杀 / 被施咒的住持失去保护，判定依旧只读公开量');
{
  const st = warlordScene();
  st.players[1].played = ['abbot'];
  st.effects.bewitched = 5;
  check('被施咒（5 号）后保护解除', targets(st).indexOf('p1:r1') >= 0, JSON.stringify(targets(st)));
  st.effects.bewitched = null;
  st.effects.assassinated = 5;
  check('被刺杀（5 号）后保护同样解除', targets(st).indexOf('p1:r1') >= 0, JSON.stringify(targets(st)));
  st.effects.assassinated = null;
  check('保护名单可由任一观看者的公开视图复算',
    JSON.stringify(publicProtection(Engine.sanitize(st, 'p2'))) === JSON.stringify([1]),
    JSON.stringify(publicProtection(Engine.sanitize(st, 'p2'))));
  check('别人视角复算出同一份名单',
    JSON.stringify(publicProtection(Engine.sanitize(st, 'p0'))) === JSON.stringify([1]));
  const view = Engine.sanitize(st, 'p2');
  check('公开视图里根本不含别人的 chars',
    (view.players || []).every((p, i) => i === 2 || !Array.isArray(p.chars) ||
      p.chars.every(c => c.played !== false)),
    JSON.stringify(view.players[1].chars));
}

console.log('\n[场景4] 真实牌局：新旧判定的保护名单逐回合逐座位完全一致');
{
  const mismatches = [];
  let compared = 0, protectedSeen = 0;
  [[1, 4], [2, 5], [3, 3], [4, 6], [5, 2], [6, 8], [7, 4], [8, 5], [9, 7], [10, 4],
   [11, 5], [12, 6], [13, 3], [14, 8], [15, 4], [16, 5]].forEach(([seed, seats]) => {
    const players = [];
    for (let i = 0; i < seats; i++) players.push({ id: 'p' + i, isBot: true, botType: 'npc' });
    const st = Engine.createGame({ roomId: 'abbot-real-' + seed, seats: players, endDistricts: 6,
      charSetMode: ['base', 'dark', 'mixed'][seed % 3], seed: seed });
    Engine.startGame(st);
    let guard = 0;
    while (st.phase !== 'gameover' && guard++ < 3000) {
      if (st.phase === 'action' && st.turn) {
        st.players.forEach((p, i) => {
          const truth = Engine.isAbbotProtected(st, i);
          const publicVerdict = (p.played || []).indexOf('abbot') >= 0 &&
            st.effects.assassinated !== 5 && st.effects.bewitched !== 5;
          compared++;
          if (truth) protectedSeen++;
          if (truth !== publicVerdict) {
            mismatches.push('seed ' + seed + ' 第 ' + st.round + ' 轮 ' + p.id + '：真=' + truth + ' 公开=' + publicVerdict);
          }
        });
      }
      const actor = currentActor(st);
      if (!actor) break;
      const id = actor.id;
      const action = AI.decide(st, id);
      if (!action) break;
      const res = Engine.applyAction(st, id, action);
      if (!res.ok) {
        const fb = (Engine.getAvailableActions(st, id).actions || []).find(a => !a.disabled);
        if (!fb || !Engine.applyAction(st, id, fb).ok) break;
      }
    }
    if (st.phase !== 'gameover') mismatches.push('seed ' + seed + ' 没打完，样本可信度不足');
  });
  check('采样到足够多的判定（' + compared + ' 次）', compared > 2000, 'compared=' + compared);
  check('样本里确实出现过生效中的住持保护', protectedSeen > 0, 'protectedSeen=' + protectedSeen);
  check('隐藏信息判定与公开信息判定从不分歧', mismatches.length === 0, mismatches.slice(0, 5).join(' | '));
}

console.log('\n[场景5] 确定化后的猜测局面不再改变保护名单（旧判定会被猜出来的手牌改写）');
{
  // 保护只读 played，而 played 是公开信息、确定化不动它 —— 所以 8 号角色的候选目标
  // 在每一份猜测世界里都一样，JS 与 native（同样改成读 played）不会因此对不上动作列表。
  // 反过来，旧的 chars 判定会被猜测随机挪动的「还没打出的住持」改写出不同的目标列表，
  // 那既说明它确实在用隐藏信息，也会让这类猜测局面整批退化成均匀先验。
  const kinds = ['warlord_destroy', 'marshal_seize', 'diplomat_theirs'];
  let checked = 0, oldJudgeMoved = 0, changed = 0;
  const bad = [];
  for (let seed = 1; seed <= 24; seed++) {
    const players = [];
    for (let i = 0; i < 5; i++) players.push({ id: 'p' + i, isBot: true, botType: 'npc' });
    const st = Engine.createGame({ roomId: 'abbot-det-' + seed, seats: players, endDistricts: 6,
      charSetMode: 'mixed', seed: seed });
    Engine.startGame(st);
    let guard = 0;
    while (st.phase !== 'gameover' && guard++ < 3000) {
      const actor = currentActor(st);
      if (!actor) break;
      const t = st.turn;
      if (t && t.pending && kinds.indexOf(t.pending.kind) >= 0) {
        for (let k = 0; k < 8; k++) {
          const g = determinize(st, actor.id);
          g.players.forEach((p, i) => {
            const neutral = g.effects.assassinated !== 5 && g.effects.bewitched !== 5;
            checked++;
            if (Engine.isAbbotProtected(g, i) !== Engine.isAbbotProtected(st, i)) changed++;
            const oldReal = (st.players[i].chars || []).indexOf('abbot') >= 0 && neutral;
            const oldGuess = (p.chars || []).indexOf('abbot') >= 0 && neutral;
            if (oldReal !== oldGuess) oldJudgeMoved++;
            if (oldReal !== oldGuess && !bad.length) {
              bad.push('seed ' + seed + '：猜测把住持挪给了 ' + p.id + '（旧判定会跟着改目标列表）');
            }
          });
        }
      }
      const action = AI.decide(st, actor.id);
      if (!action || !Engine.applyAction(st, actor.id, action).ok) break;
    }
  }
  check('在 8 号能力的待定局面里比较过猜测（' + checked + ' 次）', checked > 500, 'checked=' + checked);
  check('新判定在每一份猜测世界里都不变', changed === 0, 'changed=' + changed);
  check('旧判定确实会被猜测挪动（说明它读的是隐藏信息）', oldJudgeMoved > 0,
    bad.join(' | ') || 'oldJudgeMoved=' + oldJudgeMoved);
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
