'use strict';

/**
 * 搜索用的状态快照工具。
 *
 * 背景（实测数据）：MCTS 每个新节点都要 clone 一份完整游戏状态，代价几乎是自对弈
 * CPU 账单里最大的一块。而 state 里塞了大量只有 UI 用得着、且随对局单调增长的东西：
 *
 *   5 人局第 0 步   → 合计 9.4 KB，其中 log 0.2 KB
 *   5 人局第 350 步 → 合计 31.8 KB，其中 log 18.4 KB（58%）、notices 3.1 KB（10%）
 *
 * 引擎侧已经确认这两项**只写不读**：
 *   - src/engine.js:29  log()      只 push（并用 length 做 400 条上限）
 *   - src/engine.js:44  notify()   只 push（并用 length 做 24 条上限）
 *   - src/engine.js:1801 sanitize() 唯一的读处，给 UI 切片
 * 而且 training/train.js 的 encodeState 本来就把 log / notices 列在 IGNORE_KEYS 里，
 * 它们从不参与特征编码。
 *
 * 所以在搜索树内部把这两项置空，对游戏语义与网络输入都是等价的，只省时间和内存。
 */

const DROPPED_KEYS = ['log', 'notices'];

/**
 * 深拷贝一份状态，跳过 DROPPED_KEYS。
 *
 * 做法是拷贝前临时把这几个键摘掉再 JSON.stringify —— 而不是先全量拷贝再删，
 * 否则光是序列化那 18 KB 战报就已经把钱花掉了。
 *
 * @param {object} state 源状态，函数保证不修改它
 * @returns {object} 新状态，log / notices 为空数组
 */
function cloneTrimmed(state) {
  if (!state || typeof state !== 'object') return state;
  const stash = DROPPED_KEYS.map(key => ({
    key, value: state[key], present: Object.prototype.hasOwnProperty.call(state, key)
  }));
  // 每次新建空数组：宁可多一次分配，也不让源头状态与快照共享同一个数组引用
  for (const entry of stash) state[entry.key] = [];
  let copy;
  try {
    copy = JSON.parse(JSON.stringify(state));
  } finally {
    // 无论中途是否抛错，都必须把源状态还原成原样
    for (const entry of stash) {
      if (entry.present) state[entry.key] = entry.value;
      else delete state[entry.key];
    }
  }
  return copy;
}

/**
 * 就地清空一份状态的 log / notices（用于已经确定是快照、不对外共享的对象）。
 */
function trimInPlace(state) {
  if (state && typeof state === 'object') for (const key of DROPPED_KEYS) state[key] = [];
  return state;
}

module.exports = { cloneTrimmed, trimInPlace, DROPPED_KEYS };
