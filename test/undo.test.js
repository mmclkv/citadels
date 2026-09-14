'use strict';

/**
 * training/undo.js 的回归测试 — 增量落子 + 精确撤销（Recording Proxy）。
 *
 * 两个层面：
 *  1) 机制层（确定性，不依赖引擎/神经网络）：用假 Engine 触发各类写操作
 *     （对象赋值、新增键、嵌套改动、数组 push、splice/shift 截断、越界索引赋值导致
 *     length 隐式增长并留下稀疏空洞、delete 键、delete 数组元素造出空洞），
 *     验证 undo 后状态逐字节等价，且二次 apply 与首次完全一致（无交叉污染）。
 *  2) 集成层（真实引擎）：在 MCTS 实际使用的「掐掉 log/notices 的 working 状态」上，
 *     对真实对局在多个阶段的所有合法动作做 apply+undo，验证逐字节还原。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../src/engine.js');
const { applyRecorded } = require('../training/undo.js');
const { cloneTrimmed } = require('../training/search-state.js');

// 严格结构化序列化：区分「稀疏空洞」与「值为 undefined 的属性」，并忽略对象键顺序。
function stringify(v, seen) {
  seen = seen || new WeakSet();
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (seen.has(v)) return '"__CIRCLE__"';
  seen.add(v);
  if (Array.isArray(v)) {
    const parts = [];
    for (let i = 0; i < v.length; i++) {
      parts.push(i in v ? stringify(v[i], seen) : '"__HOLE__"');
    }
    // 数组上可能存在的非数字自有属性（罕见，但一并纳入）
    for (const k of Object.keys(v)) {
      if (/^\d+$/.test(k)) continue;
      parts.push(JSON.stringify(k) + ':' + stringify(v[k], seen));
    }
    return '[' + parts.join(',') + ',len=' + v.length + ']';
  }
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stringify(v[k], seen)).join(',') + '}';
}

// ---- 机制层：临时替换 Engine.applyAction 以触发受控写操作 ----
const realApplyAction = Engine.applyAction;
function withFakeApply(mutator, fn) {
  Engine.applyAction = function (t, pid, action) {
    mutator(t, action);
    return { ok: true };
  };
  try {
    fn();
  } finally {
    Engine.applyAction = realApplyAction;
  }
}

// 验证：apply+undo 后状态等于 before，且二次 apply 的中间态与前一次完全一致（无记录泄漏）。
function checkRestore(label, state, mutator, action) {
  const before = stringify(state);
  withFakeApply(mutator, () => {
    const { ok, undo } = applyRecorded(state, 'pX', action);
    assert.equal(ok, true, label + '：apply 应合法');
    undo();
  });
  assert.equal(stringify(state), before, label + '：undo 后状态逐字节还原');

  // 二次 apply 的中间态应一次不差（无记录泄漏 / 交叉污染）
  let mid1, mid2;
  withFakeApply(mutator, () => {
    const { undo } = applyRecorded(state, 'pX', action);
    mid1 = stringify(state);
    undo();
  });
  withFakeApply(mutator, () => {
    const { undo } = applyRecorded(state, 'pX', action);
    mid2 = stringify(state);
    undo();
  });
  assert.equal(mid1, mid2, label + '：二次 apply 与首次完全一致（无交叉污染）');
}

test('机制层：对象赋值 / 新增键 / 嵌套改动 可精确撤销', () => {
  const state = { a: 1, nested: { x: 10, y: 20 } };
  checkRestore('对象', state, (t) => {
    t.a = 99;
    t.b = 'new';                 // 新增键
    t.nested.x = -1;
    t.nested.z = { deep: true }; // 嵌套新增
  }, { type: 'obj' });
});

test('机制层：数组 push（length 隐式增长）可精确撤销', () => {
  const state = { list: [1, 2, 3] };
  checkRestore('push', state, (t) => {
    t.list.push(4);
    t.list.push(5, 6);
  }, { type: 'push' });
});

test('机制层：数组 splice/shift（length 缩小、尾部被丢弃）可精确撤销', () => {
  const state = { list: [10, 20, 30, 40, 50] };
  checkRestore('splice', state, (t) => {
    t.list.splice(1, 2, 99);     // [10,99,40,50]，丢弃了 20/30
  }, { type: 'splice' });
  const state2 = { list: [1, 2, 3] };
  checkRestore('shift', state2, (t) => {
    t.list.shift();              // [2,3]
  }, { type: 'shift' });
});

test('机制层：越界索引赋值（length 隐式增长、留下稀疏空洞）可精确撤销', () => {
  const state = { list: [1, 2] };   // length 2
  // 原状态无空洞；越界赋值会留下 [2..4] 的空洞，但其后 undo 必须还原回 [1,2]
  checkRestore('越界赋值', state, (t) => {
    t.list[5] = 9;              // length → 6，索引 2..4 为稀疏空洞
  }, { type: 'oob' });
  assert.equal(stringify(state), '{"list":[1,2,len=2]}');
});

test('机制层：delete 对象键 / delete 数组元素（造出空洞）可精确撤销', () => {
  const state = { a: 1, keep: 2, list: [1, 2, 3] };
  checkRestore('delete键', state, (t) => {
    delete t.a;                 // 删对象键
    delete t.list[1];           // 造出稀疏空洞（不是设成 undefined）
  }, { type: 'del' });
  // 原 list 是 [1,2,3]，删除索引1后 [1,,3] 是「中间态」；undo 必须还原回 [1,2,3]
  assert.equal(stringify(state), '{"a":1,"keep":2,"list":[1,2,3,len=3]}');
});

test('机制层：原状态含稀疏空洞，填充空洞后撤销应重建空洞（不是 undefined）', () => {
  const state = { list: [1, , 3] };   // 索引 1 是稀疏空洞
  checkRestore('填充空洞', state, (t) => {
    t.list[1] = 9;             // 把空洞填成 9
  }, { type: 'fill' });
  // undo 之后索引 1 必须恢复成空洞（而非值为 9，也非 own-undefined 属性）
  assert.ok(!(1 in state.list), 'undo 后索引1应为稀疏空洞');
  assert.equal(stringify(state), '{"list":[1,"__HOLE__",3,len=3]}');
});

test('机制层：原状态含稀疏空洞，push 后撤销应保持空洞形态', () => {
  const state = { list: [1, , 3] };
  checkRestore('带空洞push', state, (t) => {
    t.list.push(4);
  }, { type: 'push' });
  assert.ok(!(1 in state.list), 'undo 后空洞仍在索引1');
  assert.equal(stringify(state), '{"list":[1,"__HOLE__",3,len=3]}');
});

// ---- 集成层：真实对局 + 真实引擎，工作在被掐掉 log/notices 的 working 状态上 ----
function currentPlayerId(state) {
  if (state.phase === 'draft') {
    const step = state.draft && state.draft.steps[state.draft.stepIdx];
    return step ? state.players[step.player].id : null;
  }
  if (state.phase === 'action') {
    if (state.reaction) return state.players[state.reaction.playerIdx].id;
    if (state.roundConfirm) {
      const i = state.roundConfirm.confirmed.findIndex(c => !c);
      return i >= 0 ? state.players[i].id : null;
    }
    return state.players[state.turn.playerIdx].id;
  }
  return null;
}

test('集成层：真实对局各阶段 apply+undo 后 working 状态逐字节还原', () => {
  const seats = [1, 2, 3, 4].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true }));
  const full = Engine.createGame({ seats, seed: 20260913 });
  Engine.startGame(full);

  let step = 0;
  let totalChecks = 0;
  let failures = 0;
  while (step < 400 && full.phase !== 'gameover') {
    const pid = currentPlayerId(full);
    if (!pid) break;
    const { actions } = Engine.getAvailableActions(full, pid);
    if (!actions || !actions.length) break;

    // MCTS 实际使用的 working 状态：掐掉只写不读的 UI 字段
    const working = cloneTrimmed(full);
    const before = stringify(working);
    for (const a of actions) {
      const { ok, undo } = applyRecorded(working, pid, a);
      undo();
      totalChecks++;
      if (stringify(working) !== before) {
        failures++;
        if (failures <= 3) {
          assert.fail(`steps=${step} action=${a && a.type}：undo 后状态不一致`);
        }
      }
    }
    // 真正推进一步，进入下一阶段继续验证
    const a = actions[step % actions.length];
    const r = Engine.applyAction(full, pid, a);
    if (!r || !r.ok) break;
    step++;
  }
  assert.equal(failures, 0,
    `真实对局共 ${totalChecks} 次 apply+undo 必须全部逐字节还原（失败 ${failures} 次）`);
  console.log(`  集成层：真实对局 ${step} 步、${totalChecks} 次 apply+undo 全部逐字节还原 ✓`);
});

test('集成层：二次 apply 与首次一致（working 状态无交叉污染）', () => {
  const seats = [1, 2, 3, 4].map(i => ({ id: 'p' + i, name: 'P' + i, isBot: true }));
  const full = Engine.createGame({ seats, seed: 555 });
  Engine.startGame(full);
  const pid = currentPlayerId(full);
  const { actions } = Engine.getAvailableActions(full, pid);
  const a = actions[0];

  const working = cloneTrimmed(full);
  const { ok, undo } = applyRecorded(working, pid, a);
  assert.equal(ok, true);
  const mid1 = stringify(working);
  undo();

  const { undo: undo2 } = applyRecorded(working, pid, a);
  const mid2 = stringify(working);
  undo2();

  assert.equal(mid1, mid2, 'working 状态二次 apply 应与首次完全一致');
});
