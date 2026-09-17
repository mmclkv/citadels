'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Cards = require('../src/cards.js');
const Engine = require('../src/engine.js');

function stateWith(charId) {
  const state = Engine.createGame({ seed: 22, charSetMode: 'dark', seats: [
    { id: 'p0', name: '甲', isBot: true }, { id: 'p1', name: '乙', isBot: true },
    { id: 'p2', name: '丙', isBot: true }, { id: 'p3', name: '丁', isBot: true }
  ] });
  Engine.startGame(state);
  state.phase = 'action';
  state.players.forEach(p => { p.chars = []; p.played = []; });
  state.players[0].chars = [charId];
  state.players[0].gold = 2;
  state.turn = { charId, num: Cards.CHAR_MAP[charId].num, playerIdx: 0, phase: 'main',
    takenResources: true, incomeTaken: false, abilityUsed: false, builds: 0,
    spentOnBuild: 0, usedLab: false, usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
  return state;
}

test('dark 6 个角色已注册，dark 角色组可选用新增角色', () => {
  for (const id of ['magistrate', 'spy', 'blackmailer', 'wizard', 'abbot', 'tax_collector']) {
    assert.ok(Cards.CHAR_MAP[id], id + ' 应有角色定义');
  }
  const ids = Cards.pickCharacterSet(6, 'dark', () => 0).map(c => c.id);
  assert.deepEqual(ids, ['witch', 'blackmailer', 'wizard', 'emperor', 'abbot', 'alchemist', 'navigator', 'diplomat', 'tax_collector']);
});

test('住持按蓝色建筑数量领取金币，不再发动资源组合技能', () => {
  const state = stateWith('abbot');
  state.players[0].city = [{ uid: 'b1', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  const actions = Engine.getAvailableActions(state, 'p0').actions;
  assert.ok(actions.some(a => a.type === 'income'), '住持应能领取宗教收入');
  assert.ok(!actions.some(a => a.type === 'ability'), '住持没有旧版主动技能');
  assert.equal(Engine.applyAction(state, 'p0', { type: 'income' }).ok, true);
  assert.equal(state.players[0].gold, 3);
  assert.equal(state.turn.incomeTaken, true);
});

test('税务官建造后会累积建筑税，并可在自己的回合收取', () => {
  const state = stateWith('tax_collector');
  state.players[1].hand = [{ uid: 'd1', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  state.players[1].gold = 3;
  state.turn.playerIdx = 1; state.turn.charId = 'tax_collector'; state.turn.num = 9;
  state.players[1].chars = ['king'];
  state.players[0].chars = ['tax_collector'];
  assert.equal(Engine.applyAction(state, 'p1', { type: 'build', uid: 'd1' }).ok, true);
  assert.equal(state.effects.taxCollectorGold, 1);
  state.turn.playerIdx = 0; state.turn.charId = 'tax_collector'; state.turn.num = 9;
  state.players[0].chars = ['tax_collector'];
  const collect = Engine.getAvailableActions(state, 'p0').actions.find(a => a.type === 'ability');
  assert.ok(collect, '税务官应有收税能力');
  assert.equal(Engine.applyAction(state, 'p0', collect).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'tax_collect' }).ok, true);
  assert.equal(state.effects.taxCollectorGold, 0);
});

test('间谍可以调查玩家手牌并按建筑类型抽牌', () => {
  const state = stateWith('spy');
  state.players[1].hand = [{ uid: 'x1', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  state.players[1].gold = 2;
  assert.equal(Engine.applyAction(state, 'p0', { type: 'ability' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'spy_target', target: 'p1' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'spy_color', color: 'blue' }).ok, true);
  assert.equal(state.players[0].hand.length, 5);
  assert.equal(state.players[1].gold, 1);
});

test('法师可以查看并立即建造目标手牌且不增加正常建造次数', () => {
  const state = stateWith('wizard');
  state.players[0].gold = 5;
  state.players[1].hand = [{ uid: 'x2', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  assert.equal(Engine.applyAction(state, 'p0', { type: 'ability' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'wizard_target', target: 'p1' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'wizard_card', uid: 'x2' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'wizard_build' }).ok, true);
  assert.equal(state.players[0].city[0].uid, 'x2');
  assert.equal(state.turn.builds, 0);
});

test('行政官先选真逮捕令，再依次选择两个假逮捕令', () => {
  const state = stateWith('magistrate');
  state.players[0].chars = ['magistrate'];
  assert.equal(Engine.applyAction(state, 'p0', { type: 'ability' }).ok, true);
  const available = Engine.getAvailableActions(state, 'p0');
  assert.match(available.prompt, /先选择真逮捕令/);
  assert.ok(available.actions.length > 0 && available.actions.every(a => a.type === 'magistrate_signed'),
    '第一步只提供真逮捕令目标');
  const signedNum = available.actions[0].num;
  assert.equal(Engine.applyAction(state, 'p0', { type: 'magistrate_signed', num: signedNum }).ok, true);
  assert.equal(state.turn.pending.kind, 'magistrate_second');
  assert.match(Engine.getAvailableActions(state, 'p0').prompt, /第 1 个假逮捕令/);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'magistrate_char', num: signedNum }).ok, false,
    '假逮捕令不能与真逮捕令目标重复');
  let falseChoices = Engine.getAvailableActions(state, 'p0').actions;
  assert.ok(falseChoices.every(a => a.type === 'magistrate_char' && a.num !== signedNum));
  const falseNum1 = falseChoices[0].num;
  assert.equal(Engine.applyAction(state, 'p0', { type: 'magistrate_char', num: falseNum1 }).ok, true);
  assert.equal(state.turn.pending.kind, 'magistrate_third');
  assert.match(Engine.getAvailableActions(state, 'p0').prompt, /第 2 个假逮捕令/);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'magistrate_char', num: falseNum1 }).ok, false,
    '两个假逮捕令也不能重复');
  assert.equal(state.effects.magistrate, null, '三个目标选齐之前逮捕令不生效');
  falseChoices = Engine.getAvailableActions(state, 'p0').actions;
  const falseNum2 = falseChoices[0].num;
  assert.equal(Engine.applyAction(state, 'p0', { type: 'magistrate_char', num: falseNum2 }).ok, true);
  assert.equal(state.effects.magistrate.signed, signedNum);
  assert.deepEqual(state.effects.magistrate.nums, [signedNum, falseNum1, falseNum2]);
  assert.equal(state.turn.pending, null);
  // 三个逮捕令的去向要写进战报，但不泄露哪一张是真的
  const line = state.log.map(l => l.text || l).join('\n').split('\n').filter(t => t.includes('逮捕令发给了')).pop();
  assert.ok(line, '战报应宣告逮捕令发给了谁');
  for (const num of [signedNum, falseNum1, falseNum2]) assert.ok(line.includes(num + ' 号·'), '战报应列出 ' + num + ' 号角色');
  assert.ok(!/真逮捕令是|真的那张/.test(line), '战报不应泄露哪张是真的');
  // 同时下发一条公告，供前端给所有玩家弹窗
  const notice = (state.notices || []).filter(n => n.kind === 'magistrate_declare').pop();
  assert.ok(notice, '应下发 magistrate_declare 公告');
  assert.deepEqual(notice.nums, [signedNum, falseNum1, falseNum2]);
  assert.equal(notice.targets.length, 3);
  assert.deepEqual(notice.targets.map(t => t.num), [signedNum, falseNum1, falseNum2]);
  assert.ok(notice.targets.every(t => t.name && t.name !== '未知角色'), '公告应带上角色名');
  assert.ok(!('signed' in notice), '公告不应泄露真逮捕令');
});

test('真逮捕令命中时会冻结建造方，等行政官决定是否发动', () => {
  const state = stateWith('magistrate');
  state.players[0].chars = ['magistrate'];
  state.players[1].hand = [{ uid: 'x3', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  state.players[1].gold = 3;
  state.effects.magistrate = { nums: [3, 5, 6], signed: 3, playerIdx: 0, claimed: false };
  state.turn = { charId: 'wizard', num: 3, playerIdx: 1, phase: 'main', takenResources: true,
    incomeTaken: true, abilityUsed: true, builds: 0, spentOnBuild: 0, usedLab: false,
    usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
  assert.equal(Engine.applyAction(state, 'p1', { type: 'build', uid: 'x3' }).ok, true);
  // 建筑尚未落地：既没扣钱也没进城市，等待行政官
  assert.ok(state.reaction, '应挂起行政官的响应');
  assert.equal(state.reaction.kind, 'magistrate');
  assert.equal(state.reaction.playerIdx, 0);
  assert.equal(state.players[1].city.length, 0);
  assert.equal(state.players[1].gold, 3);
  assert.equal(state.players[1].hand.length, 1);
  // 冻结：目标玩家拿不到任何行动，行政官拿到「发动/不发动」
  const forTarget = Engine.getAvailableActions(state, 'p1');
  assert.deepEqual(forTarget.actions, [], '建造方在行政官决定前被冻结');
  const forMagistrate = Engine.getAvailableActions(state, 'p0');
  assert.equal(forMagistrate.actions.length, 2);
  assert.equal(forMagistrate.actions[0].use, true);
});

test('行政官发动逮捕令后没收建筑，目标方拿回建造费', () => {
  const state = stateWith('magistrate');
  state.players[0].chars = ['magistrate'];
  state.players[1].hand = [{ uid: 'x3', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 }];
  state.players[1].gold = 3;
  state.effects.magistrate = { nums: [3, 5, 6], signed: 3, playerIdx: 0, claimed: false };
  state.turn = { charId: 'wizard', num: 3, playerIdx: 1, phase: 'main', takenResources: true,
    incomeTaken: true, abilityUsed: true, builds: 0, spentOnBuild: 0, usedLab: false,
    usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
  Engine.applyAction(state, 'p1', { type: 'build', uid: 'x3' });
  assert.equal(Engine.applyAction(state, 'p0', { type: 'reaction', use: true }).ok, true);
  assert.equal(state.reaction, null, '响应后解冻');
  assert.equal(state.players[0].city[0].uid, 'x3');
  assert.equal(state.players[1].city.length, 0);
  assert.equal(state.players[1].gold, 3, '建造费已返还');
  assert.equal(state.players[1].hand.length, 0, '建筑已出手牌');
  assert.equal(state.effects.magistrate.claimed, true);
  const notice = state.notices.filter(n => n.kind === 'magistrate_confiscate').pop();
  assert.ok(notice, '没收时应发送专属通知');
  assert.equal(notice.playerId, 'p1', '通知应能定位被没收建筑的玩家');
  assert.equal(notice.card.name, '神庙', '通知应包含被没收建筑名');
});

test('行政官放弃发动时建筑归建造方，且同一轮不再触发', () => {
  const state = stateWith('magistrate');
  state.players[0].chars = ['magistrate'];
  state.players[1].hand = [
    { uid: 'x3', name: '神庙', color: 'blue', cost: 1, scoreValue: 1 },
    { uid: 'x4', name: '酒馆', color: 'green', cost: 1, scoreValue: 1 }
  ];
  state.players[1].gold = 5;
  // 黑暗角色组默认含税务官，建造会被抽 1 金建筑税；这里剔除以单独验证逮捕令
  state.charDeck = state.charDeck.filter(id => id !== 'tax_collector');
  // 用建筑师（每回合可建 3 栋）才能验证「同回合第二次建造不再触发」
  state.effects.magistrate = { nums: [7, 5, 6], signed: 7, playerIdx: 0, claimed: false };
  state.turn = { charId: 'architect', num: 7, playerIdx: 1, phase: 'main', takenResources: true,
    incomeTaken: true, abilityUsed: true, builds: 0, spentOnBuild: 0, usedLab: false,
    usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
  Engine.applyAction(state, 'p1', { type: 'build', uid: 'x3' });
  assert.equal(Engine.applyAction(state, 'p0', { type: 'reaction', use: false }).ok, true);
  assert.equal(state.players[1].city[0].uid, 'x3');
  assert.equal(state.players[1].gold, 4, '放弃发动则正常付费');
  assert.equal(state.players[0].city.length, 0);
  // 签名逮捕令只针对第一次付费建造
  assert.equal(Engine.applyAction(state, 'p1', { type: 'build', uid: 'x4' }).ok, true);
  assert.equal(state.reaction, null, '第二次建造不再冻结');
  assert.equal(state.players[1].city.length, 2);
});

function charIdWithNum(state, num) {
  return (state.charDeck || []).find(id => Engine.charOf(id).num === num);
}

function threatState(signedNum, targetNum) {
  const state = stateWith('blackmailer');
  state.players[0].chars = ['blackmailer'];
  state.players[0].gold = 0;            // 勒索者起始 0 金，便于断言翻开后拿走了多少
  state.players[1].gold = 6;
  state.players[1].chars = [charIdWithNum(state, targetNum)];
  state.effects.blackmailer = { nums: [targetNum], signed: signedNum, playerIdx: 0, done: [], revealed: [] };
  state.turn = { charId: charIdWithNum(state, targetNum), num: targetNum, playerIdx: 1, phase: 'main',
    takenResources: false, incomeTaken: false, abilityUsed: false, builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false, bonusDone: false,
    pending: { kind: 'blackmailer_threat', targetIdx: 1, signed: signedNum === targetNum } };
  return state;
}

test('勒索者能分配两个威胁目标，并在战报中公开去向', () => {
  const state = stateWith('blackmailer');
  assert.equal(Engine.applyAction(state, 'p0', { type: 'ability' }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'blackmailer_char', num: 3 }).ok, true);
  assert.equal(Engine.applyAction(state, 'p0', { type: 'blackmailer_char', num: 5 }).ok, true);
  // 两个目标选完后，还要由勒索者指定哪一个是真威胁标记（不再随机）
  assert.equal(state.turn.pending.kind, 'blackmailer_signed', '应先问勒索者真标记给谁');
  assert.equal(state.effects.blackmailer, null, '指定真标记前不应落地');
  const signedActs = Engine.getAvailableActions(state, 'p0').actions
    .filter(a => a.type === 'blackmailer_signed').map(a => a.num).sort((a, b) => a - b);
  assert.deepEqual(signedActs, [3, 5], '只能在两个已选目标里挑');
  assert.equal(Engine.applyAction(state, 'p0', { type: 'blackmailer_signed', num: 9 }).ok, false,
    '不在两个目标里的编号应被拒绝');
  assert.equal(Engine.applyAction(state, 'p0', { type: 'blackmailer_signed', num: 5 }).ok, true);
  assert.deepEqual(state.effects.blackmailer.nums, [3, 5]);
  assert.deepEqual(state.effects.blackmailer.done, []);
  assert.deepEqual(state.effects.blackmailer.revealed, []);
  assert.equal(state.effects.blackmailer.signed, 5, '真标记应落在勒索者指定的 5 号身上');
  // 战报公开两个目标，但不泄露哪一个是真的
  const line = state.log.map(l => l.text).filter(t => t.includes('威胁标记发给了')).pop();
  assert.ok(line, '战报应宣告威胁标记发给了谁');
  for (const num of [3, 5]) assert.ok(line.includes(num + ' 号·'), '战报应列出 ' + num + ' 号角色');
  assert.ok(!/真威胁|签名威胁/.test(line), '战报不应泄露哪个是真的');
  const notice = state.notices.filter(n => n.kind === 'blackmailer_declare').pop();
  assert.ok(notice, '应下发 blackmailer_declare 公告');
  assert.deepEqual(notice.nums, [3, 5]);
  assert.deepEqual(notice.targets.map(t => t.num), [3, 5]);
  assert.ok(notice.targets.every(t => t.name && t.name !== '未知角色'), '公告应带上角色名');
  assert.ok(!('signed' in notice), '公告不应泄露真威胁标记');
});

test('逮捕令目标翻开角色牌后，面板金币左侧出现卷轴标记', () => {
  const state = stateWith('magistrate');
  state.players[0].chars = ['magistrate'];
  assert.equal(Engine.applyAction(state, 'p0', { type: 'ability' }).ok, true);
  const available = Engine.getAvailableActions(state, 'p0').actions;
  const targetNum = available[0].num;
  const targetIdx = 1;
  state.players[targetIdx].chars = [charIdWithNum(state, targetNum)];
  state.callQueue = [{ num: targetNum, playerIdx: targetIdx }];
  assert.equal(Engine.applyAction(state, 'p0', { type: 'magistrate_signed', num: targetNum }).ok, true);
  let fake = Engine.getAvailableActions(state, 'p0').actions;
  const falseNum1 = fake[0].num;
  assert.equal(Engine.applyAction(state, 'p0', { type: 'magistrate_char', num: falseNum1 }).ok, true);
  fake = Engine.getAvailableActions(state, 'p0').actions;
  const falseNum2 = fake[0].num;
  assert.equal(Engine.applyAction(state, 'p0', { type: 'magistrate_char', num: falseNum2 }).ok, true);
  // 角色牌还盖着的时候，旁观者看不到任何人头上的逮捕令
  const targetId = state.players[targetIdx].id;
  assert.equal(Engine.sanitize(state, 'p2').players[targetIdx].warrant, null);
  // 当事人自己知道自己的角色，所以看得见
  assert.deepEqual(Engine.sanitize(state, targetId).players[targetIdx].warrant, { num: targetNum });
  // 叫到他、角色牌翻开后，全场都能看到卷轴
  state.turn = { charId: charIdWithNum(state, targetNum), num: targetNum, playerIdx: targetIdx, phase: 'main',
    takenResources: false, incomeTaken: false, abilityUsed: false, builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false, bonusDone: false, pending: null };
  assert.deepEqual(Engine.sanitize(state, 'p2').players[targetIdx].warrant, { num: targetNum });
  // 只公开「发给了哪三个角色」，不泄露哪一张是真的
  const mg = Engine.sanitize(state, 'p2').effects.magistrate;
  assert.deepEqual(mg.nums, [targetNum, falseNum1, falseNum2]);
  assert.ok(!('signed' in mg), '下发的逮捕令状态不得带 signed');
});

test('拒绝赎回后目标被冻结，等勒索者决定是否翻开威胁标记', () => {
  const state = threatState(3, 3);
  assert.equal(Engine.applyAction(state, 'p1', { type: 'blackmailer_refuse' }).ok, true);
  assert.equal(state.reaction.kind, 'blackmailer');
  assert.equal(state.reaction.playerIdx, 0, '由勒索者决断');
  assert.equal(state.reaction.targetIdx, 1);
  // 目标被冻结：没有任何可行动作，状态栏提示在等勒索者
  const forTarget = Engine.getAvailableActions(state, 'p1');
  assert.deepEqual(forTarget.actions, []);
  assert.match(forTarget.prompt, /^请等待勒索者翻开威胁标记/);
  // 勒索者这边给出「是 / 否」
  const forOwner = Engine.getAvailableActions(state, 'p0');
  assert.match(forOwner.prompt, /是否翻开/);
  assert.deepEqual(forOwner.actions.map(a => a.use), [true, false]);
  // 选「否」：直接跳过，金币分文不动，目标解冻
  assert.equal(Engine.applyAction(state, 'p0', { type: 'reaction', use: false }).ok, true);
  assert.equal(state.reaction, null);
  assert.equal(state.players[1].gold, 6, '不翻开则金币不变');
  assert.equal(state.turn.pending, null, '解冻后回到正常回合');
  assert.ok(Engine.getAvailableActions(state, 'p1').actions.some(a => a.type === 'take_gold'),
    '解冻后可以正常领资源');
});

test('翻开真威胁标记拿走全部金币（刀），假的分文不失（玫瑰）', () => {
  const real = threatState(3, 3);
  assert.equal(Engine.applyAction(real, 'p1', { type: 'blackmailer_refuse' }).ok, true);
  assert.equal(Engine.applyAction(real, 'p0', { type: 'reaction', use: true }).ok, true);
  assert.equal(real.players[1].gold, 0, '真威胁标记拿走全部金币');
  assert.equal(real.players[0].gold, 6);
  assert.deepEqual(real.effects.blackmailer.revealed, [{ num: 3, isReal: true }]);
  assert.ok(real.log.map(l => l.text).some(t => t.includes('带血的刀')), '战报说明翻出的是刀');

  const fake = threatState(9, 3);
  assert.equal(Engine.applyAction(fake, 'p1', { type: 'blackmailer_refuse' }).ok, true);
  assert.equal(Engine.applyAction(fake, 'p0', { type: 'reaction', use: true }).ok, true);
  assert.equal(fake.players[1].gold, 6, '假威胁标记分文不失');
  assert.deepEqual(fake.effects.blackmailer.revealed, [{ num: 3, isReal: false }]);
  assert.ok(fake.log.map(l => l.text).some(t => t.includes('玫瑰花')), '战报说明翻出的是玫瑰');

  // 面板标记：翻开前是盖牌，翻开后带 isReal
  const view1 = Engine.sanitize(real, 'p1');
  assert.deepEqual(view1.players[1].threat, { num: 3, revealed: true, isReal: true });
  const view0 = Engine.sanitize(fake, 'p1');
  assert.deepEqual(view0.players[1].threat, { num: 3, revealed: true, isReal: false });
  // 还没翻开的那一轮：面板上是盖牌（isReal 为 null）
  const pending = threatState(9, 3);
  assert.deepEqual(Engine.sanitize(pending, 'p1').players[1].threat,
    { num: 3, revealed: false, isReal: null });
});

test('支付赎金后威胁标记消失，不再触发冻结', () => {
  const state = threatState(3, 3);
  assert.equal(Engine.applyAction(state, 'p1', { type: 'blackmailer_bribe' }).ok, true);
  assert.equal(state.players[1].gold, 3, '支付一半金币');
  assert.equal(state.players[0].gold, 0, '赎金不给勒索者（沿用既定规则：只是销毁）');
  assert.deepEqual(state.effects.blackmailer.nums, []);
  assert.equal(state.reaction, null);
  assert.equal(Engine.sanitize(state, 'p1').players[1].threat, null);
});

test('威胁标记不能给 1 号角色、被刺杀者、被施咒者、已有逮捕令者', () => {
  const state = stateWith('blackmailer');
  // 本局角色为 1~9，其中 5/8/9 明置移除，勒索者自己占 2 号
  state.effects.assassinated = 3;
  state.effects.bewitched = 4;
  state.effects.magistrate = { nums: [5, 8, 9], signed: 5, playerIdx: 1 };
  const blocked = [1, 3, 4, 5, 8, 9];

  assert.deepEqual(Engine.blackmailerBlockedNums(state).sort((a, b) => a - b), blocked);

  assert.equal(Engine.applyAction(state, 'p0', { type: 'ability' }).ok, true);
  assert.equal(state.turn.pending.kind, 'blackmailer_declare');
  const offered = Engine.getAvailableActions(state, 'p0').actions
    .filter(a => a.type === 'blackmailer_char').map(a => a.num).sort((a, b) => a - b);
  assert.deepEqual(offered, [6, 7], '只剩 6、7 可选：1 号、被刺杀的 3 号、被施咒的 4 号、有逮捕令的 5 号都要排除');

  // 绕过 UI 直接提交被禁用的编号，引擎也必须拒绝
  for (const n of [1, 3, 4, 5]) {
    assert.equal(Engine.applyAction(state, 'p0', { type: 'blackmailer_char', num: n }).ok, false,
      n + ' 号不该被接受');
  }
});

test('威胁标记目标不足两个时只放一个，一个都没有则能力作废', () => {
  // 只剩 7 号一个合法目标：直接落地唯一的真标记，不再走两步选择
  const one = stateWith('blackmailer');
  one.effects.assassinated = 3;
  one.effects.bewitched = 4;
  one.effects.magistrate = { nums: [6, 8, 9], signed: 6, playerIdx: 1 };
  assert.equal(Engine.applyAction(one, 'p0', { type: 'ability' }).ok, true);
  assert.equal(one.turn.pending, null, '不需要再让玩家选');
  assert.deepEqual(one.effects.blackmailer.nums, [7]);
  assert.equal(one.effects.blackmailer.signed, 7, '只有一个标记时它就是真标记');

  // 一个合法目标都不剩：能力直接作废
  const none = stateWith('blackmailer');
  none.effects.assassinated = 3;
  none.effects.bewitched = 4;
  none.effects.magistrate = { nums: [6, 7, 8], signed: 6, playerIdx: 1 };
  assert.equal(Engine.applyAction(none, 'p0', { type: 'ability' }).ok, true);
  assert.equal(none.effects.blackmailer, null);
  assert.equal(none.turn.abilityUsed, true);
});
