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
    else {
      result.value_vector[0] = -0.5f + game.shift;
      result.value_vector[1] = -result.value_vector[0];
    }
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

struct WideGame : ToyGame {
  explicit WideGame(float shift) : ToyGame(shift, 1) {}
  std::vector<int> legal_actions(const ToyState& state, int) const override {
    std::vector<int> actions;
    if (!terminal(state)) for (int i = 0; i < 500; ++i) actions.push_back(i);
    return actions;
  }
};

struct WideEvaluator : ToyEvaluator {
  explicit WideEvaluator(const ToyGame& game) : ToyEvaluator(game) {}
  Evaluation evaluate(const ToyState& state, int player, const std::vector<int>& actions) override {
    auto result = ToyEvaluator::evaluate(state, player, actions);
    if (actions.size() > 1) {
      result.priors.assign(actions.size(), 0.1f / (actions.size() - 1));
      result.priors[0] = 0.9f;
    }
    return result;
  }
};

void test_fpu() {
  Mcts<ToyState, int>::Config config;
  config.simulations = 500;
  config.dirichlet_epsilon = 0;
  WideGame negative(0), positive(1);
  WideEvaluator negative_eval(negative), positive_eval(positive);
  const auto a = BatchedMcts<ToyState, int>(negative, negative_eval, config).search(ToyState{}, 0, 32);
  const auto b = BatchedMcts<ToyState, int>(positive, positive_eval, config).search(ToyState{}, 0, 32);
  if (a.policy != b.policy || a.policy[0] < 0.9f || a.visits != 500)
    throw std::runtime_error("FPU must use actor value, not optimistic zero");
  struct SerialEvaluator : Evaluator<ToyState, int> {
    WideEvaluator& evaluator;
    explicit SerialEvaluator(WideEvaluator& e) : evaluator(e) {}
    Evaluation evaluate(const ToyState& s, int p, const std::vector<int>& actions) override {
      return evaluator.evaluate(s, p, actions);
    }
  } serial_negative(negative_eval), serial_positive(positive_eval);
  const auto sa = Mcts<ToyState, int>(negative, serial_negative, config).search(ToyState{}, 0);
  const auto sb = Mcts<ToyState, int>(positive, serial_positive, config).search(ToyState{}, 0);
  if (sa.policy != sb.policy || sa.policy[0] < 0.9f)
    throw std::runtime_error("Serial search FPU must also be translation invariant");
}

void test_opponent_fpu() {
  struct OpponentGame : ToyGame {
    mutable int best = 0, other = 0;
    OpponentGame() : ToyGame(0, 2) {}
    int next_player(const ToyState&) const override { return 1; }
    std::vector<int> legal_actions(const ToyState& state, int) const override {
      if (terminal(state)) return {};
      if (state.depth == 0) return {0};
      std::vector<int> actions;
      for (int i = 0; i < 500; ++i) actions.push_back(i);
      return actions;
    }
    bool apply(ToyState& state, int player, const int& action) const override {
      if (state.depth == 1) {
        state.action = action;
        action == 0 ? ++best : ++other;
      }
      ++state.depth;
      return true;
    }
    std::array<float, kValueSlots> terminal_value_vector(const ToyState& state, int player) const override {
      auto result = ToyGame::terminal_value_vector(state, 0);
      if (player == 0) std::swap(result[0], result[1]);
      return result;
    }
  } game;
  struct OpponentEvaluator : BatchedEvaluator<ToyState, int> {
    Evaluation evaluate(const ToyState&, int player, const std::vector<int>& actions) override {
      Evaluation result;
      result.has_value_vector = true;
      result.value_vector[0] = player == 0 ? 0.5f : -0.5f;
      result.value_vector[1] = -result.value_vector[0];
      result.priors.assign(actions.size(), actions.size() > 1 ? 0.1f / (actions.size() - 1) : 1.0f);
      if (actions.size() > 1) result.priors[0] = 0.9f;
      return result;
    }
  } evaluator;
  Mcts<ToyState, int>::Config config;
  config.simulations = 500; config.dirichlet_epsilon = 0;
  const auto result = BatchedMcts<ToyState, int>(game, evaluator, config).search(ToyState{}, 0, 32);
  if (result.visits != 500 || game.best < 0.9f * (game.best + game.other) ||
      result.value_vector[0] < 0.19f || result.value_vector[0] > 0.3f ||
      std::abs(result.value_vector[0] + result.value_vector[1]) > 1e-5f)
    throw std::runtime_error("Opponent FPU or multi-player value rotation used root perspective");
}

int main() {
  test_fpu();
  test_opponent_fpu();
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
