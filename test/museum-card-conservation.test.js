/* 回归测试：博物馆（museum）下压着的建筑牌在建筑易主/被摧毁/重新建造时不得丢失。
 *
 * 背景（真实 bug，由 6 人局状态机压力测试发现）：
 *   博物馆（紫色建筑 museum）允许把 1 张手牌放到「博物馆下」计分（card.museum 子数组）。
 *   这些卡是物理牌。此前两处缺陷会让它们从整局中永久消失：
 *     1) `build` 处理器用 Object.assign({}, card, { museum: [] }) 浅拷贝时，
 *        无条件把 museum 重置为空 —— 若该牌是从手牌重新建造（例如经墓地回收回到手牌），
 *        它附带的 museum 牌就被丢弃。
 *     2) 建筑离开城市的多条路径（领主摧毁 / 墓地回收 / 元帅抢夺 / 外交官交换）
 *        未处理附带的 museum 牌，浅拷贝/转移后同样丢失。
 *
 * 修复：新增 detachMuseum(state, card)（把附带牌收回弃牌堆）并接入所有离场路径；
 *       build 改为保留 card.museum 而非清空。
 * 本测试断言：任何操作前后，全场的建筑牌总数（deck+discard+各 hand+city+museum 子数组）守恒。
 */
'use strict';
const Engine = require('../src/engine.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

function card(uid, name, cost, color, purple) {
  const c = { uid: uid, name: name, en: name, color: color || 'yellow',
    cost: cost, desc: '', scoreValue: cost };
  if (purple) c.purple = purple;
  return c;
}

// 全场建筑牌计数（含博物馆子数组），按 uid 去重（同名/同 uid 对象只算一物理牌）
function totalCards(st) {
  const seen = new Set();
  const visit = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
      if (c && c.uid != null) seen.add(c.uid);
      if (c && Array.isArray(c.museum)) for (const m of c.museum) if (m && m.uid != null) seen.add(m.uid);
    }
  };
  visit(st.deck); visit(st.discard);
  if (st.pendingDestroy && st.pendingDestroy.card && st.pendingDestroy.card.uid != null) seen.add(st.pendingDestroy.card.uid);
  for (const p of st.players) { visit(p.hand); visit(p.city); }
  return seen.size;
}

function mkState(playerCount) {
  const seats = [];
  for (let i = 0; i < (playerCount || 3); i++) {
    seats.push({ id: 'p' + i, name: '玩家' + (i + 1), isBot: true, botLevel: 'normal' });
  }
  const st = Engine.createGame({ roomId: 't', endDistricts: 8, charSetMode: 'mixed', seed: 7, seats });
  Engine.startGame(st);
  st.phase = 'action';
  st.reaction = null;
  st.roundConfirm = null;
  st.callQueue = [];
  st.callIdx = 0;
  return st;
}

function mkTurn(playerIdx, charId, num) {
  return {
    charId: charId || 'architect', num: num || 7, playerIdx: playerIdx, phase: 'main',
    takenResources: true, incomeTaken: true, abilityUsed: false,
    builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: null, bonusDone: true
  };
}

console.log('\n[场景1] 墓地将「博物馆」收回手牌后重新建造：museum 子牌守恒（核心回归）');
{
  const st = mkState(3);
  const p2 = st.players[2];
  st.effects.assassinated = null;

  const museumCard = card('m1', '博物馆', 5, 'purple', { effect: 'museum' });
  const stored = card('s1', '了望塔', 3, 'red');
  museumCard.museum = [stored];
  p2.city = p2.city.concat([museumCard]);
  p2.gold = 5;

  const before = totalCards(st);

  // 模拟墓地回收的结果：博物馆离开城市、以原对象（仍带 museum:[s1]）进入手牌
  p2.city = p2.city.filter(c => c.uid !== 'm1');
  p2.hand = p2.hand.concat([museumCard]);

  const mid = totalCards(st);
  check('回收进手牌阶段牌数不变', mid === before, 'before=' + before + ' mid=' + mid);

  // 重新建造博物馆
  st.turn = mkTurn(2, 'architect', 7);
  const r = Engine.applyAction(st, 'p2', { type: 'build', uid: 'm1' });
  check('重新建造博物馆成功', r.ok === true, r.error);

  const after = totalCards(st);
  check('重建后牌数守恒（museum 下的 s1 未丢失）', after === before,
    'before=' + before + ' after=' + after + '（差 ' + (before - after) + '）');

  const builtMuseum = p2.city.find(c => c.uid === 'm1');
  check('重建后的博物馆仍压着 s1', builtMuseum && Array.isArray(builtMuseum.museum) &&
    builtMuseum.museum.some(m => m.uid === 's1'),
    builtMuseum ? JSON.stringify(builtMuseum.museum.map(m => m.uid)) : 'no museum');
}

console.log('\n[场景2] doDestroy 的 detachMuseum：摧毁带 museum 的建筑 → 子牌进弃牌堆，不丢');
{
  const st = mkState(3);
  const p0 = st.players[0], p2 = st.players[2];

  const museumCard = card('m1', '博物馆', 5, 'purple', { effect: 'museum' });
  const stored = card('s1', '了望塔', 3, 'red');
  museumCard.museum = [stored];
  p2.city = p2.city.concat([museumCard]);

  const before = totalCards(st);
  const discardBefore = st.discard.length;

  // p0 领主摧毁 p2 的博物馆（费用 = 5-1 = 4），p2 无墓地 → 直接进弃牌堆
  st.turn = mkTurn(0, 'warlord', 8);
  p0.gold = 10;
  st.turn.pending = { kind: 'warlord_destroy' };
  const r = Engine.applyAction(st, 'p0', { type: 'choose_district', target: 'p2', uid: 'm1' });
  check('领主摧毁博物馆成功', r.ok === true, r.error);

  const after = totalCards(st);
  check('摧毁后牌数守恒', after === before, 'before=' + before + ' after=' + after);
  check('被压的 s1 已进弃牌堆（未随摧毁消失）',
    st.discard.some(c => c.uid === 's1'),
    'discard=' + JSON.stringify(st.discard.map(c => c.uid)));

  // 被摧毁的博物馆本体也应进弃牌堆（或 reaction 暂存后进弃牌堆）
  check('被摧毁的博物馆本体也在弃牌堆或反应暂存中',
    st.discard.some(c => c.uid === 'm1') ||
    (st.pendingDestroy && st.pendingDestroy.card && st.pendingDestroy.card.uid === 'm1'),
    'discard=' + JSON.stringify(st.discard.map(c => c.uid)));
}

console.log('\n结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail > 0 ? 1 : 0);
