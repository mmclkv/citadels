#include <iostream>

#include "game_adapter.hpp"

using namespace citadels::native;

class CountingEvaluator final : public BatchedEvaluator<NativeGameState, NativeSearchAction> {
 public:
  int batch_calls = 0;
  Evaluation evaluate(const NativeGameState&, int,
                      const std::vector<NativeSearchAction>& actions) override {
    Evaluation e; e.priors.assign(actions.size(), 1.0f / std::max<size_t>(1, actions.size())); return e;
  }
  std::vector<Evaluation> evaluate_batch(const std::vector<NativeGameState>& states,
      const std::vector<int>&, const std::vector<std::vector<NativeSearchAction>>& actions) override {
    ++batch_calls; std::vector<Evaluation> result;
    for (const auto& group : actions) result.push_back(evaluate(states.front(), 0, group));
    return result;
  }
};

int main() {
  NativeGameState state; state.deck = DeckMachine(build_base_district_deck(5));
  state.rng = JsRng(5); state.active_player = 0; state.resources_taken = true;
  state.players.push_back({"p0", "architect", 4, {{"h1", "green", 1}, {"h2", "blue", 1}}, {}, false});
  NativeGameAdapter game; CountingEvaluator evaluator;
  Mcts<NativeGameState, NativeSearchAction>::Config config; config.simulations = 12; config.max_depth = 16;
  BatchedMcts<NativeGameState, NativeSearchAction> search(game, evaluator, config);
  const auto result = search.search(state, 0, 4);
  std::cout << result.visits << ',' << evaluator.batch_calls << ',' << result.policy.size();
}
