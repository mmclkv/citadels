'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Search } = require('../training/mcts.js');

// 只验证 backup 的视角换算，不需要真实模型 / 引擎：用原型造一个空壳即可
function makeSearch(rootPlayerId) {
  const s = Object.create(Search.prototype);
  s.rootPlayerId = rootPlayerId;
  return s;
}

function makePath(ids) {
  return ids.map(playerId => ({ playerId, W: 0, N: 0 }));
}

function backup(rootId, ids, value) {
  const search = makeSearch(rootId);
  const path = makePath(ids);
  search.backup(path, value);
  return path;
}

test('同一次回传中，路径上每个节点的 N 都恰好 +1', () => {
  const path = backup('A', ['A', 'B', 'B', 'A'], 0.7);
  for (const node of path) assert.equal(node.N, 1, '每个节点访问数 +1');
});

test('两人局退化为经典取反：根 = −V，对手 = +V', () => {
  const [root, opp] = backup('A', ['A', 'B'], 0.5);
  assert.ok(Math.abs(root.W - -0.5) < 1e-9, '根（我）拿到 −V，实际 ' + root.W);
  assert.ok(Math.abs(opp.W - 0.5) < 1e-9, '对手拿到 +V，实际 ' + opp.W);
});

test('同一玩家回合内连续决策不取反', () => {
  // 一个回合 = 领金币 → 建造 → 结束回合，行动方始终是 A
  const path = backup('A', ['A', 'A', 'A'], 1);
  for (const node of path) {
    assert.ok(Math.abs(node.W - 1) < 1e-9, '全程保持 +V，实际 ' + node.W);
  }
});

test('两个不同对手之间不取反（paranoid：其余玩家视为同一阵营）', () => {
  const [root, b, c] = backup('A', ['A', 'B', 'C'], 1);
  assert.ok(Math.abs(root.W - -1) < 1e-9, '根（我）拿到 −V，实际 ' + root.W);
  assert.ok(Math.abs(b.W - 1) < 1e-9, '对手 B 拿到 +V，实际 ' + b.W);
  assert.ok(Math.abs(c.W - 1) < 1e-9, '对手 C 拿到 +V，实际 ' + c.W);
});

test('三人局绕回同一玩家时符号自洽：叶与根都是「我」，根拿到 +V', () => {
  // 旧的「每上一层取反」实现会在这里给出 −V
  const [root, b, c, leaf] = backup('A', ['A', 'B', 'C', 'A'], 1);
  assert.ok(Math.abs(leaf.W - 1) < 1e-9, '叶（我）拿到 +V，实际 ' + leaf.W);
  assert.ok(Math.abs(root.W - 1) < 1e-9, '根（我）拿到 +V，实际 ' + root.W);
  assert.ok(Math.abs(b.W - -1) < 1e-9, '对手 B 拿到 −V，实际 ' + b.W);
  assert.ok(Math.abs(c.W - -1) < 1e-9, '对手 C 拿到 −V，实际 ' + c.W);
});

test('我方 / 对手方交替时逐段取反', () => {
  const [root, b, meAgain] = backup('A', ['A', 'B', 'A'], 1);
  assert.ok(Math.abs(root.W - 1) < 1e-9, '根拿到 +V，实际 ' + root.W);
  assert.ok(Math.abs(b.W - -1) < 1e-9, '对手拿到 −V，实际 ' + b.W);
  assert.ok(Math.abs(meAgain.W - 1) < 1e-9, '再次轮到我方拿到 +V，实际 ' + meAgain.W);
});

test('终局回传 0 时各节点 W 增量为 0，但 N 仍然累加', () => {
  const [root, b] = backup('A', ['A', 'B'], 0);
  assert.equal(root.W, 0, '根 W 增量为 0');
  assert.equal(b.W, 0, '对手 W 增量为 0');
  assert.equal(root.N, 1, '根仍然计数');
  assert.equal(b.N, 1, '对手仍然计数');
});

/* ---------------- 终局分支：用真实胜负回传，而不是 0 ---------------- */

// runOne（增量重放版）需要 cloneState 与 Engine 才能跑：
//   - cloneState：复制根节点状态作为 working 起点
//   - Engine.applyAction：沿路径重放走到子节点的动作
// 这里用一个纯桩，让 applyAction 在遇到「标记结束的动作」时把 working.phase 翻成
// gameover，从而无需真实引擎就能造出「重放一步后到达终局」的叶子。
function makeTerminalSearch(rootPlayerId, rewardFn) {
  const s = Object.create(Search.prototype);
  s.rootPlayerId = rootPlayerId;
  s.maxDepth = 10;
  s.rewardFn = rewardFn || null;
  s.rng = () => 0.5;
  s.cPuct = 1.0;
  s.expansions = 0;
  s.evaluator = {
    calls: 0,
    async evaluate() { this.calls++; }
  };
  // 根节点状态克隆：working 必须是一份独立副本（终局后逻辑不依赖其内容）
  s.cloneState = (state) => JSON.parse(JSON.stringify(state));
  // 桩引擎：只负责在重放「结束动作」时把 working 标成 gameover，让 runOne 命中终局分支
  s.Engine = {
    applyAction(working, playerId, action) {
      if (action && action.__endGame) working.phase = 'gameover';
      return { ok: true };
    }
  };
  return s;
}

test('终局节点回传真实胜负，而不是 0', async () => {
  const s = makeTerminalSearch('A', () => new Map([['A', 1.5], ['B', -0.5]]));
  const root = { playerId: 'A', W: 0, N: 0, expanded: true, state: { phase: 'gameover' } };
  await s.runOne(root);
  assert.ok(Math.abs(root.W - 1.5) < 1e-9, '根（我）拿到自己的真实奖励 1.5，实际 ' + root.W);
  assert.equal(root.N, 1, '访问数 +1');
});

test('终局节点按视角换算：对手的真实得分对我是相反的符号', async () => {
  const s = makeTerminalSearch('A', () => new Map([['A', 1.5], ['B', -0.5]]));
  // 根在 play 阶段，已预置一个 gameover 叶子（走一步结束动作抵达）。runOne 会：
  //   root → 重放 incomingAction(结束动作) → working 变 gameover → backup(叶子视角)
  const root = {
    playerId: 'A', W: 0, N: 0, expanded: true, state: { phase: 'play' },
    legalActions: [{ __endGame: true }], P: new Float32Array([1]), children: new Map()
  };
  const leaf = {
    playerId: 'B', W: 0, N: 0, expanded: true,
    incomingAction: { __endGame: true }, parent: root
  };
  root.children.set(0, leaf);
  await s.runOne(root);
  assert.ok(Math.abs(leaf.W - -0.5) < 1e-9, '叶子（对手）拿到自己的真实奖励 −0.5，实际 ' + leaf.W);
  assert.ok(Math.abs(root.W - 0.5) < 1e-9, '根（我）换算成 +0.5，实际 ' + root.W);
});

test('终局判定优先于扩展：不再浪费一次网络评估', async () => {
  const s = makeTerminalSearch('A', () => new Map([['A', 2], ['B', 2]]));
  // expanded = false，但已经是终局：应当直接回传真实奖励，不触发评估
  const root = { playerId: 'A', W: 0, N: 0, expanded: false, state: { phase: 'gameover' } };
  await s.runOne(root);
  assert.equal(s.evaluator.calls, 0, '终局节点不应触发网络评估');
  assert.equal(s.expansions, 0, '终局节点不应计入扩展次数');
  assert.ok(Math.abs(root.W - 2) < 1e-9, '回传的是真实奖励 2，实际 ' + root.W);
});

test('未提供 rewardFn 时终局仍回传 0，保持向后兼容', async () => {
  const s = makeTerminalSearch('A', null);
  const root = { playerId: 'A', W: 0, N: 0, expanded: true, state: { phase: 'gameover' } };
  await s.runOne(root);
  assert.equal(root.W, 0, '无 rewardFn 时回传 0');
  assert.equal(root.N, 1, '访问数仍然累加');
});

test('terminalValue 对缺失 / 异常的 rewardFn 安全降级为 0', () => {
  const s = makeTerminalSearch('A', null);
  assert.equal(s.terminalValue({ phase: 'gameover' }, 'A'), 0, '无 rewardFn → 0');
  s.rewardFn = () => null;
  assert.equal(s.terminalValue({ phase: 'gameover' }, 'A'), 0, '返回 null → 0');
  s.rewardFn = () => { throw new Error('boom'); };
  assert.equal(s.terminalValue({ phase: 'gameover' }, 'A'), 0, '抛异常 → 0');
  s.rewardFn = () => new Map([['A', 0.75]]);
  assert.equal(s.terminalValue({ phase: 'gameover' }, 'B'), 0, '查不到该玩家 → 0');
});
