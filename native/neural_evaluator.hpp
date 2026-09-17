#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <string>
#include <vector>

#include "batch_evaluator.hpp"
#include "game_adapter.hpp"
#include "state_features.hpp"

namespace citadels::native {

inline std::vector<float> encode_network_state(const NativeGameState& state, int player = -1) {
  auto features = encode_features(state, player);
  features.resize(kStateFeatureSize, 0.0f);
  return features;
}

inline void normalize_action_vector(std::vector<float>& vector) {
  float norm = 0.0f;
  for (float value : vector) norm += value * value;
  norm = std::sqrt(norm);
  if (norm > 1.0f) for (float& value : vector) value /= norm;
}

inline float uid_reference(const std::string& uid) {
  size_t end = uid.size();
  while (end > 0 && uid[end - 1] >= '0' && uid[end - 1] <= '9') --end;
  if (end == uid.size()) return 0.0f;
  int number = 0;
  for (size_t i = end; i < uid.size(); ++i) number = std::min(64, number * 10 + uid[i] - '0');
  return static_cast<float>(number) / 64.0f;
}

inline int role_number_for_action(const std::string& id) {
  const int numeric = id.empty() ? 0 : std::atoi(id.c_str());
  return numeric > 0 ? numeric : role_number(id);
}

inline int action_type_feature_index(ActionType type) {
  // Must match ACTION_TYPES in training/train.js exactly. Enum declaration order
  // is intentionally independent from the model feature order.
  static constexpr std::array<ActionType, 43> types = {
    ActionType::AbilitySkip, ActionType::Ability, ActionType::AbbotResource, ActionType::ArtistDone,
    ActionType::BlackmailerBribe, ActionType::BlackmailerRefuse, ActionType::BlackmailerSigned, ActionType::BlackmailerChar,
    ActionType::Build, ActionType::ChooseCards, ActionType::ChooseChar, ActionType::ChooseDistrict,
    ActionType::ChoosePlayer, ActionType::ConfirmRound, ActionType::DraftDiscard, ActionType::DraftPick,
    ActionType::DrawKeep, ActionType::EmperorCrown, ActionType::EmperorTake, ActionType::EndTurn,
    ActionType::Income, ActionType::Lab, ActionType::MagicianMode, ActionType::MagistrateSigned, ActionType::MagistrateChar,
    ActionType::MonkResource, ActionType::MonkTake, ActionType::Museum, ActionType::NavigatorBonus,
    ActionType::PendingBack, ActionType::ProphetGive, ActionType::Reaction, ActionType::ScholarPick,
    ActionType::Smithy, ActionType::SpyColor, ActionType::SpyTarget, ActionType::TakeCards,
    ActionType::TakeGold, ActionType::TaxCollect, ActionType::WizardBuild, ActionType::WizardCard,
    ActionType::WizardTake, ActionType::WizardTarget
  };
  for (size_t i = 0; i < types.size(); ++i) if (type == types[i]) return static_cast<int>(i);
  return -1;
}

inline std::vector<float> encode_network_action(const NativeSearchAction& action,
                                                const NativeGameState* state = nullptr,
                                                int perspective_player = -1) {
  std::vector<float> result(256, 0.0f);
  result[0] = static_cast<float>(kActionEncodingVersion);
  const int type_index = action_type_feature_index(action.type);
  if (type_index >= 0) result[1 + static_cast<size_t>(type_index)] = 1.0f;
  if (state && perspective_player >= 0 && perspective_player < static_cast<int>(state->players.size())) {
    const int count = static_cast<int>(state->players.size());
    for (int i = 0; i < count; ++i) if (state->players[i].id == action.target) {
      const int relative = (i - perspective_player + count) % count;
      if (relative < 8) result[42 + relative] = 1.0f;
      break;
    }
  }
  const int role = action.has_num && action.num != 0 ? action.num : role_number_for_action(action.name);
  if (role >= 1 && role <= 9) result[50 + role - 1] = 1.0f;
  for (size_t i = 0; i < kRoleIds.size(); ++i)
    if (action.name == kRoleIds[i]) { result[68 + i] = 1.0f; break; }
  const std::string mode = !action.mode.empty() ? action.mode
    : (!action.name.empty() && (action.name == "gold" || action.name == "cards" || action.name == "card"
      || action.name == "swap" || action.name == "redraw" || action.name == "use" || action.name == "skip"
      || action.name == "take" || action.name == "destroy") ? action.name : action.effect);
  static const std::array<const char*, 9> modes = {"gold", "cards", "card", "swap", "redraw", "use", "skip", "take", "destroy"};
  for (size_t i = 0; i < modes.size(); ++i) if (mode == modes[i]) { result[59 + i] = 1.0f; break; }
  if (action.color == "yellow" || action.color == "blue" || action.color == "green" || action.color == "red" || action.color == "purple") {
    static const std::array<const char*, 5> colors = {"yellow", "blue", "green", "red", "purple"};
    for (size_t i = 0; i < colors.size(); ++i) if (action.color == colors[i]) result[95 + i] = 1.0f;
  }
  if (action.num >= 0) result[107] = std::min(1.0f, static_cast<float>(action.num) / 9.0f);
  if (action.gold >= 0) result[108] = std::min(1.0f, static_cast<float>(action.gold) / 20.0f);
  if (action.cards >= 0) result[109] = std::min(1.0f, static_cast<float>(action.cards) / 8.0f);
  result[110] = action.use ? 1.0f : 0.0f;
  result[111] = action.uid.empty() ? 0.0f : 1.0f;
  result[112] = action.secondary_uid.empty() ? 0.0f : 1.0f;
  result[113] = std::min(1.0f, static_cast<float>(action.selected_uids.size()) / 8.0f);
  result[114] = uid_reference(action.uid);
  result[115] = uid_reference(action.secondary_uid);
  for (size_t i = 0; i < action.selected_uids.size() && i < 8; ++i)
    result[116 + i] = uid_reference(action.selected_uids[i]);
  if (state && !action.uid.empty()) {
    const DistrictCard* card = nullptr;
    for (const auto& player : state->players) {
      for (const auto& held : player.hand) if (held.uid == action.uid) { card = &held; break; }
      if (!card) for (const auto& built : player.city) if (built.card.uid == action.uid) { card = &built.card; break; }
      if (card) break;
    }
    if (!card) for (const auto& pending : state->pending_cards) if (pending.uid == action.uid) { card = &pending; break; }
    if (card) {
      result[105] = std::min(1.0f, std::max(0.0f, static_cast<float>(card->cost) / 8.0f));
      result[106] = std::min(1.0f, std::max(0.0f, static_cast<float>(card->score_value > 0 ? card->score_value : card->cost) / 10.0f));
      static const std::array<const char*, 5> colors = {"yellow", "blue", "green", "red", "purple"};
      for (size_t i = 0; i < colors.size(); ++i) if (card->color == colors[i]) result[100 + i] = 1.0f;
    }
  }
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
      for (const auto& action : group)
        action_vectors.back().push_back(encode_network_action(action, &states[action_vectors.size() - 1],
                                                              action_vectors.size() - 1 < players.size() ? players[action_vectors.size() - 1] : -1));
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
