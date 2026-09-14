#include <iostream>

#include "neural_evaluator.hpp"

using namespace citadels::native;

int main() {
  BatchEvaluator backend(uniform_batch_backend());
  NativeNeuralBatchedEvaluator evaluator(backend, "large");
  NativeGameState state; state.active_player = 0;
  state.players.push_back({"p0", "architect", 2, {}, {}, false});
  std::vector<NativeSearchAction> actions = {{ActionType::TakeGold}, {ActionType::EndTurn}};
  const auto result = evaluator.evaluate_batch({state, state}, {0, 0}, {actions, actions});
  std::cout << result.size() << ',' << result[0].priors.size() << ',' << result[1].priors[1];
}
