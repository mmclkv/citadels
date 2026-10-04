// Standalone regression tests; no game rules or LibTorch installation needed.
#include <iostream>
#include <stdexcept>
#include "mcts_core.hpp"

using namespace citadels::native;

struct ToyState {
  std::vector<int> players{0, 1};
  int action = -1;
  int depth = 0;
};

struct ToyGame : GameAdapter<ToyState, int> {
  float shift;
  int terminal_depth;
  ToyGame(float offset, int depth) : shift(offset), terminal_depth(depth) {}
  float value(const ToyState& state) const { return (state.action == 0 ? -0.2f : -0.8f) + shift; }
  std::vector<int> legal_actions(const ToyState& state, int) const override {
    if (terminal(state)) return {};
    return state.depth == 0 ? std::vector<int>{0, 1} : std::vector<int>{0};
  }
  bool apply(ToyState& state, int, const int& action) const override {
    if (state.depth == 0) state.action = action;
    ++state.depth;
    return true;
  }
  int next_player(const ToyState&) const override { return 0; }
  bool terminal(const ToyState& state) const override { return state.depth >= terminal_depth; }
  float terminal_value(const ToyState& state, int) const override { return value(state); }
  std::array<float, kValueSlots> terminal_value_vector(const ToyState& state, int) const override {
    std::array<float, kValueSlots> result{};
    result[0] = value(state); result[1] = -result[0];
    return result;
  }
  InformationSetKey information_set_hash(const ToyState& state, int) const override {
    return {static_cast<uint64_t>(state.action + 1), static_cast<uint64_t>(state.depth)};
  }
};

struct ToyEvaluator : BatchedEvaluator<ToyState, int> {
  const ToyGame& game;
  int batch_calls = 0;
  explicit ToyEvaluator(const ToyGame& g) : game(g) {}
  Evaluation evaluate(const ToyState& state, int, const std::vector<int>& actions) override {
    Evaluation result;
    result.priors.assign(actions.size(), 1.0f / std::max<size_t>(1, actions.size()));
    result.has_value_vector = true;
    if (state.depth) result.value_vector = game.terminal_value_vector(state, 0);
    return result;
  }
  std::vector<Evaluation> evaluate_batch(const std::vector<ToyState>& states,
      const std::vector<int>& players, const std::vector<std::vector<int>>& actions) override {
    ++batch_calls;
    return BatchedEvaluator::evaluate_batch(states, players, actions);
  }
};

auto run(float shift, int depth, int batch, int simulations = 500) {
  ToyGame game(shift, depth);
  ToyEvaluator evaluator(game);
  Mcts<ToyState, int>::Config config;
  config.simulations = simulations;
  config.max_depth = 8;
  config.dirichlet_epsilon = 0;
  const auto result = BatchedMcts<ToyState, int>(game, evaluator, config).search(ToyState{}, 0, batch);
  if (result.visits != simulations) throw std::runtime_error("Lost or duplicated backups");
  if (depth == 1 && evaluator.batch_calls != 0)
    throw std::runtime_error("Terminal paths should not require leaf evaluation");
  return result;
}

int main() {
  const auto serial = run(0, 1, 1);
  for (int batch : {8, 32, 128}) {
    const auto terminal = run(0, 1, batch);
    if (terminal.policy != serial.policy)
      throw std::runtime_error("Terminal results were delayed within a batch");
    const auto negative = run(0, 2, batch, 512);
    const auto positive = run(1, 2, batch, 512);
    if (negative.policy != positive.policy)
      throw std::runtime_error("Pending visits changed observed Q depending on its sign");
    if (negative.policy[0] <= 0.8f)
      throw std::runtime_error("Search failed to favor the better action");
  }
  std::cout << "Batched MCTS regression tests passed\n";
}
