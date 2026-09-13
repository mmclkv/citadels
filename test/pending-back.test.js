/* 回归测试：多步能力选项列表中的「返回上一步」按钮
 *
 * 锁定四项核心规则：
 *   1. 魔术师 swap/redraw 步骤末尾有 pending_back，回退到 magician_choice，不丢任何资源
 *   2. 外交官 theirs 步骤末尾有 pending_back，回退到 diplomat_mine，未发生任何交换
 *   3. 皇帝 take 步骤末尾有 pending_back，回退到 emperor_crown，皇冠还给原持有者
 *   4. 回退按钮一律 disabled:true，电脑/AI 不会自动选它 */
'use strict';
const assert = require('node:assert/strict');
const CitEngine = require('../src/engine.js');

function freshState() {
  const seats = [];
  for (let i = 0; i < 4; i++) seats.push({ id: 'p' + i, name: '玩家' + (i + 1), isBot: false });
  const s = CitEngine.createGame({ roomId: 'b', endDistricts: 8, charSetMode: 'base', seed: 11, seats });
  CitEngine.startGame(s);
  s.phase = 'action';
  s.roundConfirm = null;
  s.reaction = null;
  // 玩家 0 是当前行动玩家
  s.turn = {
    charId: 'magician', num: 3, playerIdx: 0, phase: 'main',
    takenResources: true, incomeTaken: true, abilityUsed: false,
    builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: null, bonusDone: false
  };
  return s;
}

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// ============ 1. 魔术师 ============
{
  const s = freshState();
  s.turn.charId = 'magician';
  // 直接进入 swap 步骤（先设 choice 再发 magician_mode swap）
  s.turn.pending = { kind: 'magician_choice' };
  let r = CitEngine.applyAction(s, 'p0', { type: 'magician_mode', mode: 'swap' });
  check('魔术师选择 swap 后 pending 进入 magician_swap', r.ok && s.turn.pending.kind === 'magician_swap');
  const swapActions = (CitEngine.getAvailableActions(s, 'p0').actions || []);
  const back = swapActions.find(a => a.type === 'pending_back');
  check('magician_swap 步骤列出 pending_back 按钮', !!back);
  check('pending_back 按钮对电脑/AI 禁用', back && back.disabled === true);
  // 退回 choice
  r = CitEngine.applyAction(s, 'p0', { type: 'pending_back', to: 'magician_choice' });
  check('回退到 magician_choice 成功', r.ok && s.turn.pending.kind === 'magician_choice');
  // 再切到 redraw
  r = CitEngine.applyAction(s, 'p0', { type: 'magician_mode', mode: 'redraw' });
  check('magician_choice → magician_redraw', r.ok && s.turn.pending.kind === 'magician_redraw');
  const redrawActions = (CitEngine.getAvailableActions(s, 'p0').actions || []);
  check('magician_redraw 步骤也列出 pending_back', redrawActions.some(a => a.type === 'pending_back'));
  r = CitEngine.applyAction(s, 'p0', { type: 'pending_back', to: 'magician_choice' });
  check('magician_redraw 回退到 magician_choice', r.ok && s.turn.pending.kind === 'magician_choice');
}

// ============ 2. 外交官 ============
{
  const s = freshState();
  s.turn.charId = 'diplomat';
  s.players[0].city = [{ uid: 'mine1', name: '小屋', cost: 1, color: 'red' }];
  s.turn.pending = { kind: 'diplomat_mine' };
  // 选自己的小屋 → theirs 步骤
  let r = CitEngine.applyAction(s, 'p0', { type: 'choose_district', target: 'p0', uid: 'mine1' });
  check('外交官 mine → theirs 步骤', r.ok && s.turn.pending.kind === 'diplomat_theirs');
  const theirsActions = (CitEngine.getAvailableActions(s, 'p0').actions || []);
  const back = theirsActions.find(a => a.type === 'pending_back');
  check('diplomat_theirs 步骤列出 pending_back 按钮', !!back);
  check('外交官 pending_back 也禁用', back && back.disabled === true);
  // 退回 mine
  r = CitEngine.applyAction(s, 'p0', { type: 'pending_back', to: 'diplomat_mine' });
  check('外交官 theirs 回退到 mine', r.ok && s.turn.pending.kind === 'diplomat_mine');
  check('回退后自己城市没有变化', s.players[0].city.length === 1 && s.players[0].city[0].uid === 'mine1');
}

// ============ 3. 皇帝 ============
{
  const s = freshState();
  s.turn.charId = 'emperor';
  // 给玩家 1 设皇冠（模拟「我是皇帝，皇冠原本在对方」）
  s.players.forEach((p, i) => { p.hasCrown = (i === 1); });
  s.turn.pending = { kind: 'emperor_crown' };
  // 把皇冠交给玩家 2
  let r = CitEngine.applyAction(s, 'p0', { type: 'emperor_crown', target: 'p2' });
  check('皇帝把皇冠交给玩家 2', r.ok && s.players[2].hasCrown === true && s.players[1].hasCrown === false);
  check('pending 进入 emperor_take 并记录 _fromCrownIdx', s.turn.pending.kind === 'emperor_take' && s.turn.pending._fromCrownIdx === 1);
  const takeActions = (CitEngine.getAvailableActions(s, 'p0').actions || []);
  check('emperor_take 步骤列出 pending_back 按钮', takeActions.some(a => a.type === 'pending_back'));
  // 退回 crown 并把皇冠还给玩家 1
  r = CitEngine.applyAction(s, 'p0', { type: 'pending_back', to: 'emperor_crown' });
  check('皇帝 take → 回退到 crown', r.ok && s.turn.pending.kind === 'emperor_crown');
  check('回退后皇冠还给原持有者（玩家 1）', s.players[1].hasCrown === true && s.players[2].hasCrown === false);
}

// ============ 4. 不允许的退回（如回退到不存在的步骤）应被拒 ============
{
  const s = freshState();
  s.turn.pending = { kind: 'magician_choice' };
  let r = CitEngine.applyAction(s, 'p0', { type: 'pending_back', to: 'magician_choice' });
  check('顶层步骤尝试退回被拒', !r.ok && /不能退回|无需选择/.test(r.error || ''));
}

console.log('\n返回上一步按钮：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);