/* 回归测试：外交官在自己没有任何建筑时，UI 不能卡死，且回合必须能正常结束。
 *
 * 这是早期「点击发动 → 游戏卡死」bug 的回归网。后来方案从「进 pending + 兜底按钮」
 * 升级为「前置拦截」：没有建筑时能力按钮直接 disabled，硬发 action 也会被引擎拒绝。
 * 所以本测试锁住的现行为是：
 *   A 组（无建筑）：按钮 disabled、硬发被拒、pending 不进、面板照常给出 income/end_turn
 *                      且回合能正常领收入、结束。
 *   B 组（有建筑，正向对照）：按钮可点、能正常进入 diplomat_mine，防止过度拦截。
 *   C 组（有建筑但对手都没建筑）：真正还生效的兜底 —— 选完自己建筑后进入 diplomat_theirs，
 *                      面板给 ability_skip，点它能正常收尾（这是「卡死」防线在现方案下
 *                      唯一仍可达的路径）。 */
'use strict';
const CitEngine = require('../src/engine.js');

function freshState(cs) {
  const seats = [];
  for (let i = 0; i < 4; i++) seats.push({ id: 'p' + i, name: '玩家' + (i + 1), isBot: true, botLevel: 'normal' });
  const s = CitEngine.createGame({ roomId: 't', endDistricts: 8, charSetMode: cs, seed: 7, seats });
  CitEngine.startGame(s);
  s.phase = 'action'; s.roundConfirm = null; s.reaction = null;
  s.players[0].chars = ['diplomat'];
  s.turn = {
    charId: 'diplomat', num: 8, playerIdx: 0, phase: 'main',
    takenResources: true, incomeTaken: false, abilityUsed: false,
    builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: null, bonusDone: false
  };
  return s;
}

function myBuilding() { return { uid: 'mine1', name: '小屋', cost: 1, color: 'red', en: 'hovel' }; }

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// ============ A 组：没有任何建筑时 ============
['base', 'dark', 'mixed'].forEach(cs => {
  const s = freshState(cs);
  s.players[0].city = [];                       // 关键：没有任何建筑

  const avail0 = CitEngine.getAvailableActions(s, 'p0');
  const abilityBtn = avail0.actions.find(a => a.type === 'ability');
  check('[' + cs + '] 面板含能力按钮且被置灰(disabled)', abilityBtn && abilityBtn.disabled === true);

  // 硬发能力（绕过 UI），引擎应直接拒绝，且不应进 pending
  const r1 = CitEngine.applyAction(s, 'p0', { type: 'ability' });
  check('[' + cs + '] 硬发能力被引擎拒绝(ok:false)', r1.ok === false);
  check('[' + cs + '] 被拒后 pending 仍为 null', s.turn.pending === null);

  // 面板不应为空：正常给出 income / end_turn，且没有凭空冒出的 ability_skip
  const avail1 = CitEngine.getAvailableActions(s, 'p0');
  check('[' + cs + '] 面板非空（有收入/结束可用）', avail1.actions && avail1.actions.length > 0);
  check('[' + cs + '] 面板含 income 与 end_turn',
    avail1.actions.some(a => a.type === 'income') && avail1.actions.some(a => a.type === 'end_turn'));
  check('[' + cs + '] 面板不含 ability_skip（从未进 pending）',
    !avail1.actions.some(a => a.type === 'ability_skip'));

  // 回合能正常推进：领收入 -> 结束
  const ri = CitEngine.applyAction(s, 'p0', { type: 'income' });
  check('[' + cs + '] 领取收入成功（回合未卡死）', ri.ok === true);
  const re = CitEngine.applyAction(s, 'p0', { type: 'end_turn' });
  check('[' + cs + '] 结束回合成功', re.ok === true);
});

// ============ B 组：有建筑时，正向对照（防止过度拦截） ============
['base', 'dark', 'mixed'].forEach(cs => {
  const s = freshState(cs);
  s.players[0].city = [myBuilding()];            // 有 1 栋建筑

  const avail0 = CitEngine.getAvailableActions(s, 'p0');
  const abilityBtn = avail0.actions.find(a => a.type === 'ability');
  check('[' + cs + '] 有建筑时能力按钮可点(disabled 不为 true)', abilityBtn && abilityBtn.disabled !== true);

  const r1 = CitEngine.applyAction(s, 'p0', { type: 'ability' });
  check('[' + cs + '] 有建筑时发动能力成功', r1.ok === true);
  check('[' + cs + '] 进入 diplomat_mine pending', s.turn.pending && s.turn.pending.kind === 'diplomat_mine');
  const avail1 = CitEngine.getAvailableActions(s, 'p0');
  check('[' + cs + '] 面板非空', avail1.actions && avail1.actions.length > 0);
});

// ============ C 组：有建筑但对手都没建筑 —— 兜底按钮仍生效 ============
['base', 'dark', 'mixed'].forEach(cs => {
  const s = freshState(cs);
  s.players[0].city = [myBuilding()];           // 自己有建筑
  // 其余玩家 city 保持为空（startGame 后本就为空）：没有可交换的目标

  CitEngine.applyAction(s, 'p0', { type: 'ability' });          // 进入 diplomat_mine
  check('[' + cs + '] 已进 diplomat_mine', s.turn.pending && s.turn.pending.kind === 'diplomat_mine');
  const rSel = CitEngine.applyAction(s, 'p0', { type: 'choose_district', uid: 'mine1' });
  check('[' + cs + '] 选自己建筑成功', rSel.ok === true);
  check('[' + cs + '] 进入 diplomat_theirs', s.turn.pending && s.turn.pending.kind === 'diplomat_theirs');

  const avail = CitEngine.getAvailableActions(s, 'p0');
  const skip = avail.actions.find(a => a.type === 'ability_skip');
  check('[' + cs + '] 对手无建筑→面板给出 ability_skip 兜底', !!skip);

  const r2 = CitEngine.applyAction(s, 'p0', { type: 'ability_skip' });
  check('[' + cs + '] 点击兜底正常收尾', r2.ok === true);
  check('[' + cs + '] pending 已清除', s.turn.pending === null);
  check('[' + cs + '] abilityUsed 已置位', s.turn.abilityUsed === true);
});

console.log('\n外交官无建筑回归测试：通过 ' + pass + '，失败 ' + fail);
process.exit(fail > 0 ? 1 : 0);
