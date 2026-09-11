/* 回归测试：「本轮出局角色」widget 跨轮次多显示一张角色卡。
 *
 * 根因：清理旧节点时用了
 *     Array.prototype.forEach.call(container.children, ch => { ...removeChild(ch) })
 * `children` 是 **live** HTMLCollection。Array.prototype.forEach 会在开始时
 * 缓存 length，并在每次迭代用 HasProperty 检查索引是否仍存在；removeChild 让
 * 集合实时缩短后，紧随其后的索引就「不存在」了，于是被**静默跳过**，永远删不掉。
 * 结果：跨轮次时 faceUp 全部更换（需删除 2 个旧节点），只删掉第 1 个，
 * 第 2 个残留 → widget 里多显示一张上一轮的角色。
 *
 * 本测试用严格模拟 live HTMLCollection 语义（动态 length + 动态索引 + has trap）
 * 的假 DOM，验证修复后的快照遍历能正确清干净，并验证修复前的写法确实会漏删。
 */
'use strict';

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

/* ---------- 严格模拟 live HTMLCollection 的假 DOM ---------- */
class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this._children = [];
    this.dataset = {};
    this.parentNode = null;
  }
  get children() {
    const node = this;
    const target = { node: node };
    return new Proxy(target, {
      get(t, p) {
        if (p === 'length') return node._children.length;
        if (typeof p === 'string' && /^\d+$/.test(p)) return node._children[Number(p)];
        return t[p];
      },
      has(t, p) {
        if (typeof p === 'string' && /^\d+$/.test(p)) return Number(p) < node._children.length;
        return p in t;
      }
    });
  }
  appendChild(child) {
    if (child && child.tag === 'frag') {
      child._children.slice().forEach(k => this.appendChild(k));
      child._children = [];
      return child;
    }
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this._children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this._children.indexOf(child);
    if (i >= 0) this._children.splice(i, 1);
    if (child.parentNode === this) child.parentNode = null;
    return child;
  }
  uids() { return this._children.map(c => c.dataset.uid); }
}

function fakeDocument() {
  return { createDocumentFragment: () => new FakeNode('frag') };
}

/* ---------- 与 app.js 一致的两种清理写法 ---------- */
// 修复前：live 集合直接遍历（会漏删）
function removeStaleLive(container, keep) {
  Array.prototype.forEach.call(container.children, ch => {
    const k = ch.dataset && ch.dataset.uid;
    if (k && !keep[k] && ch.parentNode) ch.parentNode.removeChild(ch);
  });
}
// 修复后：静态快照遍历
function childrenSnapshot(container) {
  return Array.prototype.slice.call(container.children);
}
function removeStaleSnapshotted(container, keep) {
  childrenSnapshot(container).forEach(ch => {
    const k = ch.dataset && ch.dataset.uid;
    if (k && !keep[k] && ch.parentNode) ch.parentNode.removeChild(ch);
  });
}

/* ---------- 与 app.js renderRemoved 一致的按 id 复用渲染 ---------- */
function renderRemoved(container, faceUpIds, removeStale) {
  const doc = fakeDocument();
  const existing = {};
  Array.prototype.forEach.call(container.children, ch => {
    const k = ch.dataset && ch.dataset.uid;
    if (k) existing[k] = ch;
  });
  const keep = {};
  const frag = doc.createDocumentFragment();
  faceUpIds.forEach(id => {
    let node = existing[id];
    if (!node) { node = new FakeNode('div'); node.dataset.uid = id; }
    keep[id] = node;
    frag.appendChild(node);
  });
  removeStale(container, keep);
  container.appendChild(frag);
}

console.log('\n[场景1] 跨轮次 faceUp 全部更换 → 修复前会漏删（复现 bug）');
{
  const c = new FakeNode('div');
  renderRemoved(c, ['assassin', 'thief'], removeStaleLive);          // 第 1 轮
  check('第 1 轮 DOM 正确', c.uids().join(',') === 'assassin,thief', c.uids().join(','));
  renderRemoved(c, ['wizard', 'king'], removeStaleLive);             // 第 2 轮全换
  check('【修复前】确实漏删 → DOM 残留 3 个（即多显示一张）',
    c.uids().length === 3, 'DOM=' + c.uids().join(','));
  check('【修复前】残留的是上一轮第 2 张',
    c.uids().indexOf('thief') >= 0, 'DOM=' + c.uids().join(','));
}

console.log('\n[场景2] 同样的序列走修复后的快照遍历');
{
  const c = new FakeNode('div');
  renderRemoved(c, ['assassin', 'thief'], removeStaleSnapshotted);
  check('第 1 轮 DOM 正确', c.uids().join(',') === 'assassin,thief', c.uids().join(','));
  renderRemoved(c, ['wizard', 'king'], removeStaleSnapshotted);
  check('跨轮全换后只剩新角色（不再多显示）',
    c.uids().join(',') === 'wizard,king', 'DOM=' + c.uids().join(','));
}

console.log('\n[场景3] 部分保留：同 id 节点必须复用（不能重建，否则霓虹立绘会闪）');
{
  const c = new FakeNode('div');
  renderRemoved(c, ['assassin', 'thief'], removeStaleSnapshotted);
  const keepNode = c._children[0];
  renderRemoved(c, ['assassin', 'wizard'], removeStaleSnapshotted);
  check('保留项节点引用不变（复用成功）', c._children[0] === keepNode);
  check('被移除项已删除、新项已加入',
    c.uids().join(',') === 'assassin,wizard', 'DOM=' + c.uids().join(','));
  check('总数仍为 2', c.uids().length === 2);
}

console.log('\n[场景4] 多轮连续更替（模拟一局走很多轮）');
{
  const c = new FakeNode('div');
  const rounds = [
    ['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h'], ['i', 'j'],
    ['k', 'a'], ['b', 'c'], ['a', 'b'], ['d', 'e'], ['f', 'g']
  ];
  rounds.forEach(r => renderRemoved(c, r, removeStaleSnapshotted));
  check('10 轮之后 DOM 恰好等于最后一轮的 2 张',
    c.uids().join(',') === 'f,g', 'DOM=' + c.uids().join(','));
  check('无幽灵节点累积', c.uids().length === 2, 'count=' + c.uids().length);
}

console.log('\n[场景5] 清空（faceUp 为空）');
{
  const c = new FakeNode('div');
  renderRemoved(c, ['a', 'b', 'c'], removeStaleSnapshotted);
  renderRemoved(c, [], removeStaleSnapshotted);
  check('全部清空', c.uids().length === 0, 'DOM=' + c.uids().join(','));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
