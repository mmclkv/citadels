#include <iostream>

#include "selfplay.hpp"

using namespace citadels::native;

int main() {
  NativeGameState state;
  state.deck = DeckMachine(build_base_district_deck(23));
  state.rng = JsRng(23);
  state.active_player = 0;
  state.end_districts = 1;
  state.players.push_back({"p0", "architect", 2, {{"h0", "green", 1}}, {}, false});
  state.players.push_back({"p1", "merchant", 2, {{"h1", "blue", 1}}, {}, false});
  NativeGameAdapter game;
  UniformNativeEvaluator evaluator;
  Mcts<NativeGameState, NativeSearchAction>::Config config;
  config.simulations = 4; config.max_depth = 16; config.seed = 23;
  const auto result = play_one(game, evaluator, state, 0, config);
  std::cout << result.terminal << ',' << result.turns << ',' << result.winner << ','
            << result.search_expansions;
  return 0;
}
