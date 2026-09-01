/* 客户端 UI 冒烟测试：用极简 DOM 桩加载 app.js，驱动一整局本地游戏，
   检验 render() 全流程不抛异常 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ----------------------------- 极简 DOM ----------------------------- */
class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this._cls = ''; this.children = []; this.dataset = {};
    this._html = ''; this._text = ''; this.hidden = false;
    this.style = {}; this.value = ''; this.title = '';
    this.scrollTop = 0; this.scrollHeight = 100;
    this.classList = {
      add: c => { const s = new Set(this._cls.split(' ').filter(Boolean)); s.add(c); this._cls = [...s].join(' '); },
      remove: c => { const s = new Set(this._cls.split(' ').filter(Boolean)); s.delete(c); this._cls = [...s].join(' '); },
      contains: c => this._cls.split(' ').includes(c),
      toggle: c => { this.classList.contains(c) ? this.classList.remove(c) : this.classList.add(c); }
    };
  }
  get className() { return this._cls; }
  set className(v) { this._cls = v || ''; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener() {}
}
const registry = {};
const getEl = sel => (registry[sel] || (registry[sel] = new El('div')));

const document = {
  createElement: t => new El(t),
  querySelector: getEl,
  querySelectorAll: sel => {
    if (sel === '.screen') return ['home', 'setup', 'lobby', 'game', 'over'].map(s => getEl('#screen-' + s));
    return [];
  },
  addEventListener: () => {}
};

const sandbox = {
  document, console, setTimeout, clearTimeout, Math, JSON, Date, String, Number, Array, Object, Set,
  WebSocket: function () { this.readyState = 0; this.send = () => {}; this.close = () => {}; },
  location: { protocol: 'http:', host: 'localhost:8787' },
  confirm: () => true, alert: () => {}
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const errors = [];
['src/cards.js', 'src/engine.js', 'src/ai.js', 'public/app.js'].forEach(f => {
  const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  vm.runInContext(code, sandbox, { filename: f });
});

const App = sandbox.__CitadelsApp;
if (!App) { console.error('✗ app.js 未导出 App'); process.exit(1); }

console.log('=== 客户端 UI 冒烟测试 ===');

// 单人模式配置（可用命令行覆盖：node dom-smoke.js 2 base 8）
const ARG_N = process.argv[2] || '4';
const ARG_CS = process.argv[3] || 'mixed';
const ARG_END = process.argv[4] || '7';

getEl('#cfg-players').value = ARG_N;
getEl('#cfg-level').value = 'normal';
getEl('#cfg-end').value = ARG_END;
getEl('#cfg-chars').value = ARG_CS;
getEl('#cfg-name').value = '测试玩家';
try {
  getEl('#btn-start-single').onclick();
} catch (e) { errors.push('开始游戏：' + e.message); }
console.log('✓ 点击开始游戏（' + ARG_N + ' 人 / ' + ARG_CS + ' / ' + ARG_END + ' 栋）→ phase=' +
  App.state.phase + '，玩家 ' + App.state.players.length + ' 位');

// 打开角色一览 / 规则
try { getEl('#btn-chars').onclick(); getEl('#btn-rules').onclick(); getEl('#modal-close').onclick(); }
catch (e) { errors.push('参考弹层：' + e.message); }
console.log('✓ 角色一览 / 规则速查 弹层正常');

const drive = App.__local;
let guard = 0, mine = 0, renders = 0;
while (App.state.phase !== 'gameover' && guard < 20000) {
  guard++; renders++;
  const s = App.state;
  const av = s.available;
  if (s.reaction) {
    if (s.reaction.playerId === App.myId && av && av.actions.length) drive.send(av.actions[0]);
    else drive.step();
    continue;
  }
  if (av && av.actions && av.actions.length) {
    mine++;
    const build = av.actions.find(a => a.type === 'build');
    const main = build || av.actions.find(a => a.type === 'income') ||
                 av.actions.find(a => a.type === 'take_gold') ||
                 av.actions.find(a => a.type === 'take_cards') ||
                 av.actions.find(a => a.type === 'end_turn') || av.actions[0];
    drive.send(main);
    // 让电脑连续行动直到再次轮到我
    let inner = 0;
    while (App.state.phase !== 'gameover' && inner < 80) {
      const a2 = App.state.available;
      if (a2 && a2.actions && a2.actions.length) break;
      if (!App.state.turn || App.state.turn.playerId === App.myId) break;
      drive.step(); inner++;
    }
  } else {
    drive.step();
  }
}

console.log('✓ 渲染 ' + renders + ' 次 / 本人行动 ' + mine + ' 次 / 主循环 ' + guard + ' 步');
console.log(App.state.phase === 'gameover'
  ? '✓ 本地对局正常结束（第 ' + App.state.round + ' 轮）'
  : '✗ 对局未结束，phase=' + App.state.phase);
if (App.state.scores) App.state.scores.forEach(r => console.log('    ' + r.name + '：' + r.total + ' 分'));

// 再来一局
try { getEl('#btn-again').onclick(); }
catch (e) { errors.push('再来一局：' + e.message); }
console.log('✓ 再来一局 → phase=' + App.state.phase + ' 轮次=' + App.state.round);

if (errors.length) {
  console.log('\n⚠ 捕获到 ' + errors.length + ' 个异常：');
  [...new Set(errors)].slice(0, 10).forEach(e => console.log('   - ' + e));
  process.exit(1);
} else {
  console.log('\n✓ 全程无 JS 异常');
  process.exit(0);
}
