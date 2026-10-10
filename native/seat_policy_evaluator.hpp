#pragma once
#include <unordered_map>
#include "mcts_core.hpp"

namespace citadels::native {

// Keep the learner's value estimates; only the behavior prior comes from the
// frozen opponent. Group seats sharing a model into a single inference batch.
template <typename State, typename Action>
class SeatPolicyEvaluator : public BatchedEvaluator<State, Action> {
 public:
  using Backend = BatchedEvaluator<State, Action>;
  SeatPolicyEvaluator(Backend& learner, std::unordered_map<int, Backend*> policies)
      : learner_(learner), policies_(std::move(policies)) {}
  Evaluation evaluate(const State& state, int player, const std::vector<Action>& actions) override {
    return evaluate_batch({state}, {player}, {actions}).front();
  }
  std::vector<Evaluation> evaluate_batch(const std::vector<State>& states,
      const std::vector<int>& players, const std::vector<std::vector<Action>>& actions) override {
    auto result = learner_.evaluate_batch(states, players, actions);
    if (result.size() != states.size()) throw std::runtime_error("Incomplete learner evaluation batch");
    std::unordered_map<Backend*, std::vector<size_t>> groups;
    for (size_t i = 0; i < states.size(); ++i) {
      const auto found = policies_.find(players.at(i));
      if (found == policies_.end()) continue;
      ++policy_evaluations;
      if (found->second != &learner_) groups[found->second].push_back(i);
    }
    for (const auto& [backend, indices] : groups) {
      std::vector<State> sub_states;
      std::vector<int> sub_players;
      std::vector<std::vector<Action>> sub_actions;
      for (size_t index : indices) {
        sub_states.push_back(states[index]); sub_players.push_back(players[index]);
        sub_actions.push_back(actions[index]);
      }
      auto evaluated = backend->evaluate_batch(sub_states, sub_players, sub_actions);
      if (evaluated.size() != indices.size()) throw std::runtime_error("Incomplete opponent policy batch");
      for (size_t i = 0; i < indices.size(); ++i) {
        if (evaluated[i].priors.size() != sub_actions[i].size())
          throw std::runtime_error("Opponent policy action count mismatch");
        result[indices[i]].priors = std::move(evaluated[i].priors);
      }
    }
    return result;
  }
  bool has_policy(int player) const { return policies_.count(player) != 0; }
  int policy_evaluations = 0;
 private:
  Backend& learner_;
  std::unordered_map<int, Backend*> policies_;
};
} // namespace citadels::native
