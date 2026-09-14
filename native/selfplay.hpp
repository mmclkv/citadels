#pragma once

#include <cstddef>
#include <vector>

#include "game_adapter.hpp"

namespace citadels::native {

struct SelfPlayResult {
  bool terminal = false;
  int turns = 0;
  int winner = -1;
  std::size_t search_expansions = 0;
};

// 单局原生自对弈驱动器。它只负责循环和统计，规则仍由 GameAdapter 提供，
// 因而后续接入神经网络 Evaluator 不需要改动对局控制层。
template <typename State, typename Action>
SelfPlayResult play_one(const GameAdapter<State, Action>& game,
                        Evaluator<State, Action>& evaluator, State state,
                        int root_player, typename Mcts<State, Action>::Config config) {
  Mcts<State, Action> search(game, evaluator, config);
  SelfPlayResult result;
  const int max_turns = config.max_depth * 4;
  while (!game.terminal(state) && result.turns < max_turns) {
    const int player = game.next_player(state);
    const auto actions = game.legal_actions(state, player);
    if (actions.empty()) break;
    const auto decision = search.search(state, player);
    ++result.turns;
    result.search_expansions += static_cast<std::size_t>(decision.expansions);
    std::size_t selected = 0;
    for (std::size_t i = 1; i < decision.policy.size(); ++i) {
      if (decision.policy[i] > decision.policy[selected]) selected = i;
    }
    if (selected >= actions.size() || !game.apply(state, player, actions[selected])) break;
  }
  result.terminal = game.terminal(state);
  if (result.terminal) {
    for (int i = 0; i < static_cast<int>(state.players.size()); ++i) {
      if (state.players[i].city.size() >= static_cast<size_t>(state.end_districts)) {
        result.winner = i;
        break;
      }
    }
  }
  return result;
}

}  // namespace citadels::native
