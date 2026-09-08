/* 验证 keyed-reconciliation 算法（与 public/app.js 的 syncCards 等价实现）：
 * 同一 uid 的卡片节点必须被复用（不重建 <img>），顺序与增删必须正确。
 * 这是根治「每行动一次整盘重绘→霓虹卡图闪烁」的核心不变量。
 * 用最小 DOM 模拟，避免引入 jsdom/Playwright 重依赖。 */
class FakeNode {
  constructor(tag) { this.tag = tag; this._children = []; this.dataset = {}; this.className = ''; this.parentNode = null; this._title = ''; }
  // 快照：模拟浏览器 live HTMLCollection 在 forEach 迭代期间被移除节点时的安全语义
  get children() { return this._children.slice(); }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    // 真实 DOM 语义：appendChild(fragment) 会把 fragment 的所有子节点移入自己
    if (child.tag === 'frag') {
      const kids = child.children.slice();
      kids.forEach(k => this.appendChild(k));
      child._children = [];
      return child;
    }
    child.parentNode = this;
    this._children.push(child);
    return child;
  }
  removeChild(child) { const i = this._children.indexOf(child); if (i >= 0) this._children.splice(i, 1); if (child.parentNode === this) child.parentNode = null; return child; }
  get title() { return this._title; }
  set title(v) { this._title = v; }
}
function createDocumentFragment() { return new FakeNode('frag'); }
function createElement(t) { return new FakeNode(t); }

// ---- 与 app.js 一致的精简实现 ----
function cardNode(c, opts) { const d = createElement('div'); d.dataset.uid = c.uid; d.className = 'card c-' + c.color; return d; }
function refreshCardNode(node, c, opts) { node.className = 'card c-' + c.color; node.dataset.uid = c.uid; }
function syncCards(container, cards, optsFor, onNode) {
  if (!container) return;
  const existing = {};
  Array.prototype.forEach.call(container.children, ch => { const k = ch.dataset && ch.dataset.uid; if (k) existing[k] = ch; });
  const keep = {};
  const frag = createDocumentFragment();
  cards.forEach(c => {
    let node = existing[c.uid];
    if (node) refreshCardNode(node, c, optsFor(c));
    else node = cardNode(c, optsFor(c));
    keep[c.uid] = node;
    if (onNode) onNode(node, c, optsFor(c));
    frag.appendChild(node);
  });
  Array.prototype.forEach.call(container.children, ch => {
    const k = ch.dataset && ch.dataset.uid;
    if (k && !keep[k] && ch.parentNode) ch.parentNode.removeChild(ch);
  });
  container.appendChild(frag);
}

let passed = 0, failed = 0;
function assert(cond, msg) { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.error('  ✗ ' + msg); } }

const cards = id => ({ uid: id, color: 'yellow' });
const container = new FakeNode('div');

// 1) 首次渲染：创建节点
syncCards(container, [cards('a'), cards('b')], c => ({}));
let na = container.children[0], nb = container.children[1];
assert(container.children.length === 2, '首次渲染产生 2 个节点');
assert(na.dataset.uid === 'a' && nb.dataset.uid === 'b', '顺序为 a, b');

// 2) 二次渲染（顺序反转）：节点必须复用，而非重建
syncCards(container, [cards('b'), cards('a')], c => ({}));
assert(container.children.length === 2, '顺序变化后仍是 2 个节点');
assert(container.children[0] === nb && container.children[1] === na, '同 uid 节点被复用（引用不变 → img 不重建 → 不闪）');

// 3) 增删：去掉 a，新增 c
syncCards(container, [cards('b'), cards('c')], c => ({}));
assert(container.children.length === 2, '增删后仍是 2 个节点');
assert(container.children[0] === nb, 'b 仍被复用');
assert(container.children[1].dataset.uid === 'c', 'c 为新创建');
assert(container.children.every(ch => ch.dataset.uid !== 'a'), 'a 已被移除');

// 4) 空列表：移除所有节点
syncCards(container, [], c => ({}));
assert(container.children.length === 0, '空列表时所有卡片节点被移除');

console.log('\nResults: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
