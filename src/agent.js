/* 富饶之城 — 目标导向电脑玩家
 *
 * Agent 模式和普通 NPC 共用同一套规则引擎，但会先建立一个短期目标，
 * 再把目标交给启发式决策器执行。这样可以在不依赖外部模型/API 的情况下，
 * 提供可复现、可托管、不会因网络问题卡住的 AI Agent 玩家。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./ai.js'), require('./cards.js'));
  } else {
    root.CitAgent = factory(root.CitAI, root.CitCards);
  }
})(typeof self !== 'undefined' ? self : this, function (AI, Cards) {
  'use strict';

  function goalFor(state, player) {
    const left = Math.max(0, state.config.endDistricts - player.city.length);
    if (left <= 2 && player.gold >= 3) return 'finish_city';
    if (player.hand.length <= 1) return 'refill_hand';
    if (player.gold <= 1) return 'build_reserve';
    return player.city.length < 3 ? 'develop_city' : 'protect_lead';
  }

  function decide(state, playerId) {
    const player = state.players.find(p => p.id === playerId);
    if (!player) return null;
    // 目标写入只读的决策上下文，不污染引擎状态，方便日志和调试工具复用。
    const context = { goal: goalFor(state, player), playerId, round: state.round };
    let action = AI.decide(state, playerId);
    if (!action) return null;

    // Agent 的第一原则是完成当前目标；以下轻量修正只在普通 AI 给出明显
    // 不利动作时生效，所有最终动作仍由 Engine 做合法性校验。
    if (context.goal === 'refill_hand' && action.type === 'take_gold' && player.gold >= 3) {
      action = { type: 'take_cards' };
    }
    if (context.goal === 'finish_city' && action.type === 'take_cards' && player.gold >= 2) {
      action = { type: 'take_gold' };
    }
    return action;
  }

  return { decide, goalFor };
});
