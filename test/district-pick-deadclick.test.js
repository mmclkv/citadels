/* 回归测试：需要「选择建筑」时，UI 不该给出点了会被拒绝的选项。
 *
 * 背景（浏览器自动跑 10 局时发现）：
 *   艺术家（artist）美化建筑时，pendingActions 只排除「已选」与「已美化」的
 *   建筑，却没有考虑「最多 2 栋」和「每栋 1 金」两条限制。于是在已选满 2 栋
 *   （或金币为 0）时，引擎依然把剩余建筑列成 choose_district 动作，前端照常
 *   把它们渲染成高亮可点的建筑；玩家一点，applyAction 就用
 *   err('最多美化 2 栋') / err('金币不足') 挡回来 —— 表现就是「点了没反应」。
 *   10 局里共 15 次，全部落在艺术家这个分支上。
 *
 * 修复：pendingActions 的 artist 分支在满足上限或金币不足时只返回 artist_done，
 *       不再给出任何建筑选项；提示语也改成说明原因的那一条。
 *
 * 同时锁住卡片点击的绑定方式：必须把渲染时拿到的动作对象带进 pickDistrict，
 * 而不是点击时再按 (playerId, uid) 回查 available —— 回查落空就变成死点，
 * 而面板上同名按钮因为自带动作对象始终有效，两条入口表现不一致。
 */
'use strict';
const fs = require('fs');
const path = require('path');
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

/** 3 人局、行动阶段、当前是我的回合且角色是艺术家 */
function artistState(gold, city, selected) {
  const seats = [];
  for (let i = 0; i < 3; i++) {
    seats.push({ id: 'p' + i, name: '玩家' + (i + 1), isBot: true, botLevel: 'normal' });
  }
  const st = Engine.createGame({
    roomId: 't', endDistricts: 8, charSetMode: 'dark', seed: 5, seats: seats
  });
  Engine.startGame(st);
  st.phase = 'action';
  st.reaction = null;
  st.roundConfirm = null;
  st.players[0].gold = gold;
  st.players[0].city = city.map(c => c);
  st.turn = {
    charId: 'artist', num: 9, playerIdx: 0, phase: 'main',
    takenResources: true, incomeTaken: true, abilityUsed: false,
    builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: { kind: 'artist', selected: (selected || []).slice() },
    bonusDone: false
  };
  return st;
}

const CITY = [card('d1', '酒馆', 1, 'green'), card('d2', '集市', 2, 'green'),
  card('d3', '监狱', 2, 'red'), card('d4', '堡垒', 3, 'purple')];

function actsOf(st) {
  const av = Engine.getAvailableActions(st, 'p0');
  return {
    all: av.actions || [],
    picks: (av.actions || []).filter(a => a.type === 'choose_district'),
    done: (av.actions || []).filter(a => a.type === 'artist_done'),
    prompt: av.prompt || ''
  };
}

console.log('\n[场景1] 未选满 + 有金币：正常给出可选建筑');
{
  const st = artistState(3, CITY, []);
  const r = actsOf(st);
  check('给出 4 个建筑选项（堡垒也允许，艺术家可美化独特建筑）', r.picks.length === 4,
    '实际 ' + r.picks.length);
  check('同时给出「不美化，跳过」', r.done.length === 1 &&
    /不美化/.test(r.done[0].label), JSON.stringify(r.done.map(a => a.label)));
  check('提示语是常规那条', /选择要美化的建筑/.test(r.prompt), r.prompt);
  check('选项里的建筑都不在已选列表（此时为空）', r.picks.every(a => a.target === 'p0'));
}

console.log('\n[场景2] 已选 1 栋：排除已选，仍可再选 1 栋');
{
  const st = artistState(3, CITY, ['d1']);
  const r = actsOf(st);
  check('剩余 3 个建筑选项（已选的 d1 被排除）',
    r.picks.length === 3 && !r.picks.some(a => a.uid === 'd1'),
    JSON.stringify(r.picks.map(a => a.uid)));
  check('确认按钮显示「确定美化（1 栋）」',
    r.done.length === 1 && /确定美化（1 栋）/.test(r.done[0].label),
    JSON.stringify(r.done.map(a => a.label)));
}

console.log('\n[场景3] 已选满 2 栋：不再给出任何建筑选项（修复点）');
{
  const st = artistState(3, CITY, ['d1', 'd2']);
  const r = actsOf(st);
  check('建筑选项为 0 —— 修复前会给 2 个，点下去必被「最多美化 2 栋」拒绝',
    r.picks.length === 0, '实际 ' + r.picks.length + ' 个：' + JSON.stringify(r.picks.map(a => a.uid)));
  check('仍保留「确定美化（2 栋）」', r.done.length === 1 &&
    /确定美化（2 栋）/.test(r.done[0].label), JSON.stringify(r.done.map(a => a.label)));
  check('提示语说明已选满', /已选满/.test(r.prompt), r.prompt);
  // 直接发 choose_district 依然会被拒绝，说明限制本身在引擎里生效
  const res = Engine.applyAction(st, 'p0', { type: 'choose_district', target: 'p0', uid: 'd3' });
  check('硬发 choose_district 仍被引擎拒绝（限制未放松）', res.ok === false &&
    /最多美化 2 栋/.test(res.error || ''), JSON.stringify(res));
}

console.log('\n[场景4] 金币不足：不再给出建筑选项');
{
  const st = artistState(0, CITY, []);
  const r = actsOf(st);
  check('金币 0 时建筑选项为 0', r.picks.length === 0,
    '实际 ' + r.picks.length);
  check('提示语说明金币不足', /金币不足/.test(r.prompt), r.prompt);
  const st2 = artistState(1, CITY, ['d1']);
  const r2 = actsOf(st2);
  check('金币 1 且已选 1 栋（再选就要 2 金）时也不再给出选项',
    r2.picks.length === 0, '实际 ' + r2.picks.length);
  const res2 = Engine.applyAction(st2, 'p0', { type: 'choose_district', target: 'p0', uid: 'd2' });
  check('硬发也被引擎以「金币不足」拒绝（选第 N+1 栋前须还剩 1 金）',
    res2.ok === false && /金币不足/.test(res2.error || ''), JSON.stringify(res2));
}

console.log('\n[场景5] 已美化的建筑始终不可选');
{
  const city = CITY.map(c => c);
  city[0].beautified = 1;
  const st = artistState(3, city, []);
  const r = actsOf(st);
  check('已美化的 d1 不在选项里', !r.picks.some(a => a.uid === 'd1'),
    JSON.stringify(r.picks.map(a => a.uid)));
}

console.log('\n[场景6] 其余需要选建筑的角色不受影响');
{
  // 领主：摧毁选项仍按金币过滤，且会给出「放弃」兜底
  const seats = [];
  for (let i = 0; i < 3; i++) seats.push({ id: 'p' + i, name: '玩家' + (i + 1), isBot: true, botLevel: 'normal' });
  const st = Engine.createGame({ roomId: 't', endDistricts: 8, charSetMode: 'dark', seed: 7, seats: seats });
  Engine.startGame(st);
  st.phase = 'action'; st.reaction = null; st.roundConfirm = null;
  st.players[0].gold = 10;
  st.players[0].city = [card('m1', '酒馆', 1, 'green')];
  st.players[1].city = [card('o1', '集市', 2, 'green'), card('o2', '监狱', 2, 'red')];
  st.turn = {
    charId: 'warlord', num: 8, playerIdx: 0, phase: 'main',
    takenResources: true, incomeTaken: true, abilityUsed: false,
    builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: { kind: 'warlord_destroy' }, bonusDone: false
  };
  const av = Engine.getAvailableActions(st, 'p0');
  const picks = (av.actions || []).filter(a => a.type === 'choose_district');
  // 领主可以连自己的建筑一起摧毁，所以是「2 个敌方 + 1 个己方」
  check('领主摧毁仍给出 3 个目标（2 敌 + 1 己，未被本次改动波及）', picks.length === 3,
    '实际 ' + picks.length);
  check('其中 2 个指向对手 p1', picks.filter(a => a.target === 'p1').length === 2,
    JSON.stringify(picks.map(a => a.target + ':' + a.uid)));
}

console.log('\n[场景7] 前端绑定方式：卡片点击必须带动作对象，不能只按 uid 回查');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const pickFn = src.slice(src.indexOf('function pickDistrict'), src.indexOf('function pickDistrict') + 700);
  check('pickDistrict 接受 boundAction 参数', /function pickDistrict\([^)]*boundAction/.test(pickFn), pickFn.slice(0, 80));
  check('优先使用绑定的动作对象（不再先回查）', /if \(boundAction\) \{ runAction\(boundAction\); return; \}/.test(pickFn));
  check('回查落空时重绘同步高亮，不留死点', /else render\(\);/.test(pickFn));
  const binds = (src.match(/pickDistrict\([^)]*act\)/g) || []);
  check('我的城区与对手城区两处都已传入动作对象（2 处）', binds.length === 2,
    '实际 ' + binds.length + ' 处');
  check('渲染时用 districtActionFor 取动作（不再只判断布尔）',
    (src.match(/const act = districtActionFor\(/g) || []).length >= 4,
    '实际 ' + (src.match(/const act = districtActionFor\(/g) || []).length + ' 处');
}

console.log('\n[场景8] 多选时不再出现两个「确定」');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('渲染动作时跳过与「✓ 确定（N）」重复的 choose_cards 按钮',
    /a\.type === 'choose_cards' && App\.sel && App\.sel\.kind === 'multi'/.test(src));
}

console.log('\n结果：通过 ' + pass + '，失败 ' + fail);
process.exit(fail ? 1 : 0);
