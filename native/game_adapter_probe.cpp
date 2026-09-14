#include <iostream>

#include "game_adapter.hpp"

using namespace citadels::native;

int main() {
  NativeGameState state;
  state.deck = DeckMachine(build_base_district_deck(17));
  state.rng = JsRng(17);
  state.active_player = 0;
  state.players.push_back({"p0", "architect", 2, {{"h1", "green", 1}}, {}, false});
  NativeGameAdapter game;
  UniformNativeEvaluator evaluator;
  Mcts<NativeGameState, NativeSearchAction>::Config config;
  config.simulations = 8; config.max_depth = 8; config.seed = 17;
  Mcts<NativeGameState, NativeSearchAction> mcts(game, evaluator, config);
  const auto result = mcts.search(state, 0);
  std::cout << result.visits << ',' << result.expansions << ',' << result.policy.size();
  return 0;
}
