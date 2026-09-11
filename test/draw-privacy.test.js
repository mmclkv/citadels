/* 回归测试：抽牌/选牌结果属于隐藏信息，不得在战报与下发状态中泄露。
 *
 * 规则依据：Citadels 中手牌是隐藏信息。「抽 2 张保留 1 张，其余放回牌库底」
 * 与「学者抽 N 选 1，其余洗回牌堆」都是暗抽，其他玩家只能知道你拿了牌，
 * 不能知道拿了什么 —— 否则等同于公开手牌。
 *
 * 修复前：
 *   1. draw_keep 完成时 log 写入了保留牌的牌名（『教堂』等），战报直接泄密；
 *   2. scholar_pick 同样写入了选中牌名；
 *   3. sanitize 的 pendingPublic 对**所有**玩家下发了 pending.cards，
 *      联机模式下对手可从 state 里直接读到别人抽到的牌。
 */
'use strict';
const Engine = require('../src/engine.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

function mkState() {
  const seats = [];
  for (let i = 0; i < 3; i++) {
    seats.push({ id: 'p' + i, name: '玩家' + (i + 1), isBot: true, botLevel: 'normal' });
  }
  const st = Engine.createGame({
    roomId: 't', endDistricts: 8, charSetMode: 'dark', seed: 7, seats: seats
  });
  Engine.startGame(st);
  st.phase = 'action';
  st.reaction = null;
  st.roundConfirm = null;
  return st;
}

function mkTurn(playerIdx) {
  return {
    charId: 'merchant', num: 6, playerIdx: playerIdx, phase: 'main',
    takenResources: false, incomeTaken: false, abilityUsed: false,
    builds: 0, spentOnBuild: 0,
    usedLab: false, usedSmithy: false, usedMuseum: false,
    pending: null, bonusDone: false
  };
}

function lastLogs(st, n) {
  return st.log.slice(-n).map(l => l.text || '').join(' | ');
}

console.log('\n[场景1] 抽 2 留 1：战报不得出现保留牌的牌名');
{
  const st = mkState();
  st.turn = mkTurn(0);
  const before = st.players[0].hand.length;

  const r1 = Engine.applyAction(st, 'p0', { type: 'take_cards' });
  check('take_cards 执行成功', r1.ok === true, r1.error);

  const pd = st.turn.pending;
  check('进入 draw_keep 待选状态', !!pd && pd.kind === 'draw_keep');
  const drawnNames = (pd.cards || []).map(c => c.name);
  check('确实抽到了 2 张牌', drawnNames.length === 2, JSON.stringify(drawnNames));

  const r2 = Engine.applyAction(st, 'p0', { type: 'draw_keep', uid: pd.cards[0].uid });
  check('draw_keep 执行成功', r2.ok === true, r2.error);

  const keptName = drawnNames[0];
  const tail = lastLogs(st, 4);
  check('战报未泄露保留的牌名「' + keptName + '」', tail.indexOf(keptName) < 0, tail);
  check('战报仍记录抽牌动作（保留了 1 张）', /保留了 1 张/.test(tail), tail);
  check('战报说明其余牌放回牌库底', /牌库底/.test(tail), tail);

  const hand = st.players[0].hand.map(c => c.name);
  check('选择的牌确实进了自己手牌', hand.indexOf(keptName) >= 0);
  check('手牌只多了 1 张', st.players[0].hand.length === before + 1,
    before + ' → ' + st.players[0].hand.length);
}

console.log('\n[场景2] 抽牌待选时：只有行动者本人能拿到具体牌面');
{
  const st = mkState();
  st.turn = mkTurn(0);
  Engine.applyAction(st, 'p0', { type: 'take_cards' });

  const mine = Engine.sanitize(st, 'p0');
  const other = Engine.sanitize(st, 'p1');
  const spectator = Engine.sanitize(st, 'nobody');

  check('本人可见待选牌面', mine.turn.pending.cards.length === 2,
    'cards=' + mine.turn.pending.cards.length);
  check('其他玩家拿不到牌面', other.turn.pending.cards.length === 0,
    'cards=' + other.turn.pending.cards.length);
  check('旁观者拿不到牌面', spectator.turn.pending.cards.length === 0,
    'cards=' + spectator.turn.pending.cards.length);
  check('他人仍知道正在选牌（kind 保留）', other.turn.pending.kind === 'draw_keep');
  check('他人可知抽了几张（count）', other.turn.pending.count === 2,
    'count=' + other.turn.pending.count);
}

console.log('\n[场景3] 学者选牌：战报与下发同样保密');
{
  const st = mkState();
  st.turn = mkTurn(0);
  const picked = [
    { uid: 's1', name: '学者塔', en: 'school', color: 'purple', cost: 6, desc: '' },
    { uid: 's2', name: '教堂', en: 'church', color: 'blue', cost: 2, desc: '' },
    { uid: 's3', name: '酒馆', en: 'tavern', color: 'green', cost: 1, desc: '' }
  ];
  st.turn.pending = { kind: 'scholar_pick', cards: picked };

  const otherBefore = Engine.sanitize(st, 'p1');
  check('学者待选时他人看不到牌面', otherBefore.turn.pending.cards.length === 0);
  const mineBefore = Engine.sanitize(st, 'p0');
  check('学者待选时本人可见 3 张牌面', mineBefore.turn.pending.cards.length === 3);

  const r = Engine.applyAction(st, 'p0', { type: 'scholar_pick', uid: 's1' });
  check('scholar_pick 执行成功', r.ok === true, r.error);

  const tail = lastLogs(st, 3);
  check('战报未泄露学者选中的牌名', tail.indexOf('学者塔') < 0, tail);
  check('战报仍说明「从 3 张中选择了 1 张」', /从 3 张建筑牌中选择了 1 张/.test(tail), tail);
  check('选中的牌进入手牌', st.players[0].hand.some(c => c.uid === 's1'));
}

console.log('\n[场景4] 回归：公开信息仍然正常公开（建造必须写进战报）');
{
  const st = mkState();
  st.turn = mkTurn(0);
  const built = { uid: 'b1', name: '集市', en: 'market', color: 'green', cost: 2, desc: '' };
  st.players[0].hand.push(built);
  st.players[0].gold = 10;
  const r = Engine.applyAction(st, 'p0', { type: 'build', uid: 'b1' });
  check('建造成功', r.ok === true, r.error);
  const tail = lastLogs(st, 2);
  check('建造的牌名照常公开在战报', /建造了『集市』/.test(tail), tail);
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
