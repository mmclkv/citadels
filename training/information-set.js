'use strict';

// 信息集 key 只描述某个玩家合法可观察到的内容。
// 它不能包含对手手牌、隐藏牌堆顺序或尚未公开的角色，否则会把偷看的信息
// 当成节点身份的一部分。
const OMIT_KEYS = new Set(['log', 'notices', 'rngState', 'stateHash']);

function canonical(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonical);
  const out = {};
  Object.keys(value).sort().forEach(key => {
    if (!OMIT_KEYS.has(key)) out[key] = canonical(value[key]);
  });
  return out;
}

function stableJson(value) {
  return JSON.stringify(canonical(value));
}

/** 生成一个观察者视角的信息集 key。sanitize 由规则引擎提供。 */
function informationSetKey(state, playerId, sanitize) {
  const view = typeof sanitize === 'function' ? sanitize(state, playerId) : state;
  return stableJson({ viewer: playerId, view });
}

module.exports = { canonical, stableJson, informationSetKey };
