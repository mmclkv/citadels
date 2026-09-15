#pragma once

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#include "batch_evaluator.hpp"
#include "game_adapter.hpp"
#include "state_features.hpp"

namespace citadels::native {

inline std::vector<float> encode_network_state(const NativeGameState& state) {
  auto features = encode_features(state);
  features.resize(192, 0.0f);
  return features;
}

inline std::vector<float> encode_network_action(const NativeSearchAction& action) {
  std::vector<float> result(64, 0.0f);
  result[static_cast<size_t>(action.type) % result.size()] = 1.0f;
  result[63] = static_cast<float>(std::hash<std::string>{}(action.uid) % 997) / 997.0f;
  return result;
}

class NativeNeuralBatchedEvaluator final
    : public BatchedEvaluator<NativeGameState, NativeSearchAction> {
 public:
  NativeNeuralBatchedEvaluator(BatchEvaluator& backend, std::string profile)
      : backend_(backend), profile_(std::move(profile)) {}

  Evaluation evaluate(const NativeGameState& state, int,
                      const std::vector<NativeSearchAction>& actions) override {
    const auto result = evaluate_batch({state}, {0}, {actions});
    if (result.empty()) return {};
    return result.front();
  }

  std::vector<Evaluation> evaluate_batch(
      const std::vector<NativeGameState>& states, const std::vector<int>&,
      const std::vector<std::vector<NativeSearchAction>>& actions) override {
    std::vector<std::vector<float>> state_vectors;
    std::vector<std::vector<std::vector<float>>> action_vectors;
    state_vectors.reserve(states.size()); action_vectors.reserve(actions.size());
    for (const auto& state : states) state_vectors.push_back(encode_network_state(state));
    for (const auto& group : actions) {
      action_vectors.emplace_back();
      for (const auto& action : group) action_vectors.back().push_back(encode_network_action(action));
    }
    // 直接调用统一后端接口，避免把 GPU/CPU 设备逻辑复制到规则适配器。
    std::vector<BatchEvaluationRequest> requests;
    for (size_t i = 0; i < states.size(); ++i) requests.push_back({state_vectors[i], action_vectors[i]});
    const auto result = backend_.evaluate(requests);
    std::vector<Evaluation> output;
    if (result.policies.size() != states.size()) return output;
    for (size_t i = 0; i < states.size(); ++i)
      output.push_back({result.policies[i], result.values[i]});
    return output;
  }

 private:
  BatchEvaluator& backend_;
  std::string profile_;
};

class NativeNeuralEvaluator final : public Evaluator<NativeGameState, NativeSearchAction> {
 public:
  explicit NativeNeuralEvaluator(NativeNeuralBatchedEvaluator& backend) : backend_(backend) {}
  Evaluation evaluate(const NativeGameState& state, int player,
                      const std::vector<NativeSearchAction>& actions) override {
    return backend_.evaluate(state, player, actions);
  }
 private:
  NativeNeuralBatchedEvaluator& backend_;
};

}  // namespace citadels::native
