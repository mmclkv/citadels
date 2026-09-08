/* 回归测试：外交官在自己没有任何建筑时发动「交换建筑」能力，UI 不应卡死。
 * 复现人类玩家路径：applyAction({type:'ability'}) -> getAvailableActions 必须返回
 * 一个「放弃使用能力」的兜底按钮，且点击它能正常清除 pending、结束能力。 */
'use strict';
const CitEngine = require('../src/engine.js');

function makeDiplomatTurn(state, idx) {
  state.phase = 'action';
  state.roundConfirm = null;
  state.reaction = null;
  state.players[idx].city = [];            // 关键：没有任何建筑
  state.players[idx].chars = ['diplomat'];
  state.turn = {
    charId: 'diplomat', num: 8, playerIdx: idx, phase: 'main',
    takenResources: true, incomeTaken: false, abilityUsed: false,
    builds: 0, spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: null, bonusDone: false
  };
}

let pass = 0, fail = 0;
function check(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

// 用几个不同配置各跑一遍
['base', 'dark', 'mixed'].forEach(cs => {
  const seats = [];
  for (let i = 0; i < 4; i++) seats.push({ id: 'p' + i, name: '玩家' + (i + 1), isBot: true, botLevel: 'normal' });
  const state = CitEngine.createGame({ roomId: 't', endDistricts: 8, charSetMode: cs, seed: 7, seats: seats });
  CitEngine.startGame(state);

  const idx = 0;
  makeDiplomatTurn(state, idx);

  // 1) 玩家点击「发动外交官能力」
  const r1 = CitEngine.applyAction(state, 'p' + idx, { type: 'ability' });
  check('[' + cs + '] 发动能力成功', r1.ok === true);
  check('[' + cs + '] pending 进入 diplomat_mine', state.turn.pending && state.turn.pending.kind === 'diplomat_mine');

  // 2) 关键：UI 取到的行动面板必须非空，且包含放弃按钮
  const avail = CitEngine.getAvailableActions(state, 'p' + idx);
  check('[' + cs + '] 行动面板非空（修复前这里为空→卡死）', avail.actions && avail.actions.length > 0);
  const hasSkip = avail.actions.some(a => a.type === 'ability_skip');
  check('[' + cs + '] 面板含「放弃使用能力」兜底按钮', hasSkip === true);

  // 3) 点击放弃按钮应能正常推进
  const r2 = CitEngine.applyAction(state, 'p' + idx, { type: 'ability_skip' });
  check('[' + cs + '] 放弃能力成功', r2.ok === true);
  check('[' + cs + '] pending 已清除', state.turn.pending === null);
  check('[' + cs + '] abilityUsed 已置位', state.turn.abilityUsed === true);
});

console.log('\n外交官无建筑回归测试：通过 ' + pass + '，失败 ' + fail);
process.exit(fail > 0 ? 1 : 0);
