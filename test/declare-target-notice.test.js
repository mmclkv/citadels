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

const confiscateStart = app.indexOf("case 'magistrate_confiscate':");
assert.ok(confiscateStart > 0, '前端应处理行政官没收建筑通知');
const confiscateBlock = app.slice(confiscateStart, app.indexOf('\n      case ', confiscateStart + 10));
assert.ok(/if \(isMe\)\s*\{[\s\S]*?queueEvent\(\{/.test(confiscateBlock),
  '建筑被行政官没收时应向受影响玩家弹出事件提示');
assert.ok(/你的建筑被行政官没收/.test(confiscateBlock) && /建造费用已退还/.test(confiscateBlock),
  '弹窗应说明建筑被没收并提示建造费用已退还');

// 行政官：三个逮捕令的去向对全场公开，三种身份（行政官本人 / 收到逮捕令的人 / 旁观者）都要弹窗
const magStart = app.indexOf("case 'magistrate_declare':");
assert.ok(magStart > 0, '前端应处理 magistrate_declare 公告');
const magBlock = app.slice(magStart, app.indexOf('\n      case ', magStart + 10));
assert.ok(!/if \(byMe\) return/.test(magBlock), '行政官宣告不得跳过任何玩家');
assert.ok((magBlock.match(/queueEvent\(\{/g) || []).length >= 3,
  '行政官宣告对「本人 / 收到逮捕令的人 / 旁观者」都要用弹窗（当前 ' +
  (magBlock.match(/queueEvent\(\{/g) || []).length + ' 处）');
assert.ok(!/signed/.test(magBlock), '弹窗不得泄露哪一张是真逮捕令');
assert.ok(/n\.targets/.test(magBlock), '弹窗应列出全部三个目标的角色名');

// 勒索者：目标拒绝赎回后被冻结，状态栏要说清在等谁；面板上要画威胁标记
assert.ok(/请等待勒索者翻开威胁标记/.test(app), '被威胁方应看到等待勒索者的提示');
assert.ok(/s\.reaction\.kind === 'blackmailer'[\s\S]{0,80}targetIdx === App\.myIdx/.test(app),
  '等待提示只在自己被威胁时出现');
assert.ok(/threatMarkHTML\(p\.threat\)/.test(app), '对手面板应画威胁标记');
assert.ok(/threatMarkHTML\(me\.threat\)/.test(app), '自己面板应画威胁标记');
assert.ok(/is-real/.test(app) && /is-fake/.test(app), '翻开后要区分刀子与玫瑰花');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
assert.ok(/\.threat-mark/.test(css), '威胁标记需要有样式');
// 行政官的逮捕令：卷轴图标同样画在金币左侧
assert.ok(/warrantMarkHTML\(p\.warrant\)/.test(app), '对手面板应画逮捕令卷轴');
assert.ok(/warrantMarkHTML\(me\.warrant\)/.test(app), '自己面板应画逮捕令卷轴');
assert.ok(/\.warrant-mark/.test(css), '逮捕令卷轴需要有样式');
assert.ok(/WARRANT_SVG[\s\S]{0,400}rect x="3\.4"/.test(app), '卷轴应画出上下卷杆');

// 面板标记（逮捕令卷轴 / 威胁标记）不该在别人每次行动时重播入场动画
const baseMarkRule = css.slice(css.indexOf('.threat-mark,'), css.indexOf('.threat-mark svg'));
assert.ok(baseMarkRule.length > 0, '应能取到标记的基础样式规则');
assert.ok(!/animation:/.test(baseMarkRule),
  '标记的基础样式不能带 animation —— 面板每次行动都会重建，挂上去就会跟着抖');
assert.ok(/\.threat-mark\.mark-in/.test(css) && /\.warrant-mark\.mark-in/.test(css),
  '入场动画应改由 .mark-in 触发');
assert.ok(/function markSignature\(/.test(app) && /function playMarkAnim\(/.test(app),
  '前端应按标记状态签名决定是否播放动画');
assert.ok(/playMarkAnim\(head, markSignature\(p\)/.test(app), '对手面板要做签名判断');
assert.ok(/playMarkAnim\(myGold, markSignature\(me\)/.test(app), '自己面板要做签名判断');

// 税务官：战场中央要有一个标记，并把已放置的金币数写在标记上
assert.ok(/function renderTaxPot\(wrap, s\)/.test(app), '前端应有税务官标记的渲染函数');
assert.ok(/renderTaxPot\(wrap, s\);/.test(app), 'renderOpponents 里要调用税务官标记渲染');
assert.ok(/c\.id === 'tax_collector'/.test(app), '只有本局有税务官时才显示标记');
assert.ok(/s\.effects && s\.effects\.taxCollectorGold/.test(app), '标记上的数字取税务官已放置的金币数');
assert.ok(/class="tax-pot-count"/.test(app), '标记上要有显示金币数的元素');
assert.ok(/TAX_POT_SVG/.test(app), '标记用内联 SVG 绘制，不依赖字体/emoji');
assert.ok(/\.tax-pot\{/.test(css), '税务官标记需要有样式');
assert.ok(/\.tax-pot-count\{/.test(css), '金币数徽章需要有样式');
assert.ok(/@keyframes tax-pot-bump/.test(css), '金币数增加时要有提示动画');
assert.ok(/html\[data-theme="neon"\] \.tax-pot /.test(
  fs.readFileSync(path.join(__dirname, '..', 'public', 'themes', 'neon', 'theme.css'), 'utf8')),
  '霓虹主题需要适配税务官标记');

console.log('刺客/盗贼宣告：全体弹窗、编号与角色名战报全部通过');
