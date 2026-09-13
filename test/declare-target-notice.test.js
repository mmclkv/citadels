'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Engine = require('../src/engine.js');

function stateFor(charId, pendingKind) {
  const state = Engine.createGame({
    roomId: 'declare-target-test', charSetMode: 'base', endDistricts: 8, seed: 91,
    seats: [
      { id: 'actor', name: '宣告者', isBot: false },
      { id: 'other', name: '旁观者', isBot: false }
    ]
  });
  state.phase = 'action';
  state.turn = {
    charId, num: charId === 'assassin' ? 1 : 2, playerIdx: 0, playerId: 'actor', phase: 'main',
    takenResources: true, incomeTaken: false, abilityUsed: false, builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false, pending: { kind: pendingKind }, bonusDone: false
  };
  return state;
}

function verify(charId, pendingKind, targetNum, targetName, noticeKind, verb) {
  const state = stateFor(charId, pendingKind);
  const result = Engine.applyAction(state, 'actor', { type: 'choose_char', num: targetNum });
  assert.equal(result.ok, true);
  const notice = state.notices.at(-1);
  assert.equal(notice.kind, noticeKind);
  assert.equal(notice.num, targetNum);
  assert.equal(notice.charName, targetName, '公开通知携带本局编号对应的角色名');
  assert.match(state.log.at(-1).text, new RegExp(verb + ' ' + targetNum + ' 号角色『' + targetName + '』'));
}

verify('assassin', 'assassin', 6, '商人', 'assassin_declare', '宣布刺杀');
verify('thief', 'thief', 5, '主教', 'thief_declare', '宣布偷窃');

const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
for (const kind of ['assassin_declare', 'thief_declare']) {
  const start = app.indexOf("case '" + kind + "':");
  const end = app.indexOf('\n      case ', start + 10);
  const block = app.slice(start, end);
  assert.ok(!/if \(byMe\) return/.test(block), kind + ' 不得跳过宣告者自己的全体弹窗');
  assert.ok(/else \{[\s\S]*queueEvent\(\{/.test(block), kind + ' 对非目标玩家也使用事件弹窗');
  assert.ok(/n\.charName/.test(block), kind + ' 弹窗同时显示角色名');
}

console.log('刺客/盗贼宣告：全体弹窗、编号与角色名战报全部通过');
