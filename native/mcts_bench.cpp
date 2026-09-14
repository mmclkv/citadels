#include <chrono>
#include <cstdlib>
#include <iostream>

#include "game_adapter.hpp"

using namespace citadels::native;

int main(int argc, char** argv) {
  const int searches = argc > 1 ? std::atoi(argv[1]) : 1000;
  const int simulations = argc > 2 ? std::atoi(argv[2]) : 50;
  NativeGameState state;
  state.deck = DeckMachine(build_base_district_deck(20260915));
  state.rng = JsRng(20260915);
  state.active_player = 0;
  state.players.push_back({"p0", "architect", 4,
                           {{"h1", "green", 1}, {"h2", "blue", 2}}, {}, false});
  state.players.push_back({"p1", "merchant", 4,
                           {{"h3", "red", 1}, {"h4", "yellow", 3}}, {}, false});
  state.resources_taken = true;
  NativeGameAdapter game;
  UniformNativeEvaluator evaluator;
  Mcts<NativeGameState, NativeSearchAction>::Config config;
  config.simulations = simulations;
  config.max_depth = 64;
  config.c_puct = 1.0f;
  config.seed = 20260915;
  Mcts<NativeGameState, NativeSearchAction> mcts(game, evaluator, config);
  long long visits = 0;
  long long expansions = 0;
  const auto begin = std::chrono::steady_clock::now();
  for (int i = 0; i < searches; ++i) {
    const auto result = mcts.search(state, 0);
    visits += result.visits;
    expansions += result.expansions;
  }
  const auto elapsed = std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - begin).count();
  std::cout << "engine=cpp searches=" << searches << " sims=" << simulations
            << " total_ms=" << elapsed << " avg_search_ms=" << elapsed / searches
            << " searches_per_sec=" << (searches * 1000.0 / elapsed)
            << " visits=" << visits << " expansions=" << expansions << '\n';
}
