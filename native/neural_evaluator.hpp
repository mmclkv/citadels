#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "batch_evaluator.hpp"
#include "game_adapter.hpp"
#include "state_features.hpp"

namespace citadels::native {

inline std::vector<float> encode_network_state(const NativeGameState& state, int player = -1) {
  auto features = encode_features(state, player);
  features.resize(192, 0.0f);
  return features;
}

inline void add_action_hash(std::vector<float>& vector, const std::string& text, uint32_t salt) {
  uint32_t hash = 2166136261u;
  for (unsigned char character : text) {
    hash ^= character;
    hash *= 16777619u;
  }
  const size_t index = 32u + ((hash ^ (salt * 2654435761u)) % 32u);
  vector[index] += (hash & 0x80000000u) ? -1.0f : 1.0f;
}

inline void normalize_action_vector(std::vector<float>& vector) {
  float norm = 0.0f;
  for (float value : vector) norm += value * value;
  norm = std::sqrt(norm);
  if (norm > 1.0f) for (float& value : vector) value /= norm;
}

inline std::vector<float> encode_network_action(const NativeSearchAction& action) {
  std::vector<float> result(64, 0.0f);
  result[0] = static_cast<float>(kActionEncodingVersion);
  result[1 + static_cast<size_t>(action.type)] = 1.0f;
  const std::array<std::pair<const char*, const std::string*>, 5> fields = {{
    {"uid", &action.uid}, {"target", &action.target}, {"name", &action.name},
    {"effect", &action.effect}, {"secondaryUid", &action.secondary_uid}
  }};
  for (size_t i = 0; i < fields.size(); ++i)
    if (!fields[i].second->empty()) add_action_hash(result, std::string(fields[i].first) + "=" + *fields[i].second, static_cast<uint32_t>(i));
  for (size_t i = 0; i < action.selected_uids.size(); ++i)
    add_action_hash(result, "uids[" + std::to_string(i) + "]=" + action.selected_uids[i], static_cast<uint32_t>(i + 16));
  normalize_action_vector(result);
  return result;
}

class NativeNeuralBatchedEvaluator final
    : public BatchedEvaluator<NativeGameState, NativeSearchAction> {
 public:
  NativeNeuralBatchedEvaluator(BatchEvaluator& backend, std::string profile)
      : backend_(backend), profile_(std::move(profile)) {}

  Evaluation evaluate(const NativeGameState& state, int player,
                      const std::vector<NativeSearchAction>& actions) override {
    const auto result = evaluate_batch({state}, {player}, {actions});
    if (result.empty()) return {};
    return result.front();
  }

  std::vector<Evaluation> evaluate_batch(
      const std::vector<NativeGameState>& states, const std::vector<int>& players,
      const std::vector<std::vector<NativeSearchAction>>& actions) override {
    std::vector<std::vector<float>> state_vectors;
    std::vector<std::vector<std::vector<float>>> action_vectors;
    state_vectors.reserve(states.size()); action_vectors.reserve(actions.size());
    for (size_t i = 0; i < states.size(); ++i)
      state_vectors.push_back(encode_network_state(states[i], i < players.size() ? players[i] : -1));
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
    for (size_t i = 0; i < states.size(); ++i) {
      Evaluation evaluation;
      evaluation.priors = result.policies[i];
      if (result.value_vectors.size() == states.size()) {
        evaluation.value_vector = result.value_vectors[i];
        evaluation.value = evaluation.value_vector[0];
        evaluation.has_value_vector = true;
      } else if (result.values.size() == states.size()) {
        evaluation.value = result.values[i];
        evaluation.value_vector[0] = evaluation.value;
      }
      output.push_back(std::move(evaluation));
    }
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
