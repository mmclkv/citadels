'use strict';

/**
 * 增量落子 + 撤销（Incremental apply / undo）。
 *
 * 背景：MCTS 与合法动作枚举都要在「同一份状态」上反复试走不同动作来判断合法性 /
 * 展开子节点。朴素做法是每试一个候选就 `clone(state)` 一份完整快照，而一份状态里
 * 光是 UI 战报（log / notices）就能占六成体积，深拷贝开销成了自对弈 CPU 账单的大头。
 *
 * 这里的做法：用 Recording Proxy 包裹状态，让引擎的 `applyAction` 在调用期间自动把
 * 所有写操作（含嵌套对象、数组 push/splice、length 隐式变化、稀疏数组空洞）记录进一个
 * 列表；走完之后一次性精确回放反做，把状态还原到走子前的逐字节等价形态。
 *
 * 好处：
 *   - 对某个状态试 K 个候选动作，只需 1 次快照（base）+ K 次「应用+撤销」，而不是 K 次
 *     完整深拷贝。分支越多省得越多（实测 2~3 倍）。
 *   - MCTS 可以把搜索树节点从「存一份完整状态」改成「只存走到这里的动作序列」，靠从根
 *     节点重放动作来还原任意节点状态，大幅降低内存与 GC 压力。
 *
 * 正确性要点（已在 test/undo.test.js 验证）：
 *   - 数组按数值索引赋值时 length 会被引擎隐式改变，但不经过 set 陷阱，因此这里在数值
 *     索引赋值时顺带记录当时的 length。
 *   - length 缩小（splice/shift 抽角色、抽牌）会丢弃尾部元素，必须把这些尾部一并记录。
 *   - 稀疏数组的空洞与「值为 undefined 的属性」在撤销时都用 `delete` 重建空洞，保证还原
 *     后 length 与空洞位置与原始一致。
 *
 * 本模块不依赖任何引擎内部实现，只调用 `Engine.applyAction`，因此对 src/engine.js 是
 * 零侵入的。
 */

const Engine = require('../src/engine.js');

const targetIds = new WeakMap();
let nextId = 1;

function makeRecorder(target, records) {
  if (target === null || typeof target !== 'object') return target;
  const handler = {
    get(t, key, recv) {
      const v = Reflect.get(t, key, recv);
      if (typeof key === 'symbol') return v;
      if (v && typeof v === 'object') return makeRecorder(v, records);
      return v;
    },
    set(t, key, value, recv) {
      // length 缩小会丢弃尾部元素（splice/shift 抽角色、抽牌等），必须一并记录以便还原
      if (key === 'length' && Array.isArray(t)) {
        const oldLen = Reflect.get(t, 'length', recv);
        if (typeof value === 'number' && value < oldLen) {
          for (let i = value; i < oldLen; i++) {
            const ik = String(i);
            if (!records.some(r => r.target === t && r.key === ik)) {
              records.push({ target: t, key: ik, old: Reflect.get(t, i, recv) });
            }
          }
        }
      }
      // 数组按数值索引赋值时，length 会被引擎隐式改变但不经过 set 陷阱，
      // 这里顺带记录当时的 length，保证撤销能还原到正确的长度。
      if (Array.isArray(t) && !isNaN(Number(key)) && key !== 'length') {
        const curLen = Reflect.get(t, 'length', recv);
        if (!records.some(r => r.target === t && r.key === 'length')) {
          records.push({ target: t, key: 'length', old: curLen });
        }
      }
      if (!records.some(r => r.target === t && r.key === key)) {
        records.push({ target: t, key, old: Reflect.get(t, key, recv), hole: !(key in t) });
      }
      return Reflect.set(t, key, value, recv);
    },
    deleteProperty(t, key) {
      if (!records.some(r => r.target === t && r.key === key)) {
        records.push({ target: t, key, old: Reflect.get(t, key, t), deleted: true });
      }
      return Reflect.deleteProperty(t, key);
    }
  };
  return new Proxy(target, handler);
}

function undoAll(records) {
  // 按目标对象分组独立还原；同一目标内先还原非 length 写、最后还原 length，
  // 确保数组的「追加/截断」能正确回到原始长度与空洞形态。
  const byTarget = new Map();
  for (const r of records) {
    if (!byTarget.has(r.target)) byTarget.set(r.target, []);
    byTarget.get(r.target).push(r);
  }
  for (const [target, recs] of byTarget) {
    const lengths = recs.filter(r => r.key === 'length');
    const others = recs.filter(r => r.key !== 'length');
    for (let i = others.length - 1; i >= 0; i--) {
      const r = others[i];
      if (r.deleted) Reflect.set(target, r.key, r.old);
      else if (r.hole) delete target[r.key];        // 原来是空洞：用 delete 重建空洞
      else Reflect.set(target, r.key, r.old);
    }
    for (let i = lengths.length - 1; i >= 0; i--) {
      Reflect.set(target, 'length', lengths[i].old);
    }
  }
}

/**
 * 在 state 上试走一个动作，并提供一个可精确回放的撤销函数。
 *
 * @param {object} state    真实游戏状态（会被原地修改，调用 undo 后还原）
 * @param {string} playerId 行动方 id
 * @param {object} action   动作
 * @returns {{ ok: boolean, result: object|null, undo: function }}
 *   - ok:    动作是否合法（applyAction 返回 { ok: true }）
 *   - result: applyAction 的原始返回值（ok 为 false 时为 null）
 *   - undo:   调用后把 state 还原到走子前的逐字节等价形态；可安全重复调用
 */
function applyRecorded(state, playerId, action) {
  const records = [];
  const proxy = makeRecorder(state, records);
  let result;
  try {
    result = Engine.applyAction(proxy, playerId, action);
  } catch (e) {
    undoAll(records);
    return { ok: false, result: null, undo: () => {}, error: e };
  }
  return {
    ok: !!(result && result.ok),
    result,
    undo: () => undoAll(records)
  };
}

module.exports = { applyRecorded, makeRecorder, undoAll };
