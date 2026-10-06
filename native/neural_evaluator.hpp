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
  return encode_features(state, player, 8);
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

inline std::array<float, 2> uid_bytes(const std::string& uid) {
  size_t end = uid.size();
  while (end > 0 && uid[end - 1] >= '0' && uid[end - 1] <= '9') --end;
  if (end == uid.size()) return {};
  uint32_t number = 0;
    for (size_t i = end; i < uid.size(); ++i)
      number = number > 6553 || (number == 6553 && uid[i] > '5')
        ? 65535 : number * 10 + static_cast<uint32_t>(uid[i] - '0');
  return {static_cast<float>(number & 255u) / 255.0f, static_cast<float>((number >> 8) & 255u) / 255.0f};
}

inline int action_type_feature_index(ActionType type) {
  // Historical model action feature order. Enum declaration order is
  // intentionally independent from the model feature order.
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
                                                int perspective_player = -1,
                                                int action_encoding_version = kActionEncodingVersion) {
  std::vector<float> result(256, 0.0f);
  // v10 extends the unused suffix; preserve v9's normalized prefix exactly
  // so zero-initialized new columns provide a lossless weight warm start.
  result[0] = static_cast<float>(std::min(action_encoding_version, 9));
  const int type_index = action_type_feature_index(action.type);
  if (type_index >= 0) result[1 + static_cast<size_t>(type_index)] = 1.0f;
  if (state && perspective_player >= 0 && perspective_player < static_cast<int>(state->players.size())) {
    const int count = static_cast<int>(state->players.size());
    for (int i = 0; i < count; ++i) if (state->players[i].id == action.target) {
      const int relative = (i - perspective_player + count) % count;
      if (relative < 8) result[(action_encoding_version >= 7 ? 124 : 42) + relative] = 1.0f;
      break;
    }
  }
  // Only explicit numeric role selections belong in this feature. Some actions
  // (notably MonkResource) use `name` for a numeric amount, not a character.
  const bool draft_action = action.type == ActionType::DraftPick || action.type == ActionType::DraftDiscard;
  const int role = draft_action ? role_number_for_action(action.name)
    : action.has_num && action.num != 0 ? action.num
    : (action.type == ActionType::ChooseChar || action.type == ActionType::MagistrateSigned ||
       action.type == ActionType::MagistrateChar || action.type == ActionType::BlackmailerChar ||
       action.type == ActionType::BlackmailerSigned ? role_number_for_action(action.name) : 0);
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
  result[110] = (action.use || (action.type == ActionType::Reaction && action.name == "use")) ? 1.0f : 0.0f;
  result[111] = action.uid.empty() ? 0.0f : 1.0f;
  result[112] = action.secondary_uid.empty() ? 0.0f : 1.0f;
  result[113] = std::min(1.0f, static_cast<float>(action.selected_uids.size()) / 8.0f);
  if (action_encoding_version >= 9) {
    const auto primary = uid_bytes(action.uid), secondary = uid_bytes(action.secondary_uid);
    result[162] = primary[0]; result[163] = primary[1];
    result[164] = secondary[0]; result[165] = secondary[1];
    for (size_t i = 0; i < action.selected_uids.size() && i < 8; ++i) {
      const auto selected = uid_bytes(action.selected_uids[i]);
      result[166 + i * 2] = selected[0]; result[167 + i * 2] = selected[1];
    }
  } else {
    result[114] = uid_reference(action.uid);
    result[115] = uid_reference(action.secondary_uid);
    for (size_t i = 0; i < action.selected_uids.size() && i < 8; ++i)
      result[116 + i] = uid_reference(action.selected_uids[i]);
  }
  if (state && !action.uid.empty()) {
    const DistrictCard* card = nullptr;
    for (const auto& player : state->players) {
      for (const auto& held : player.hand) if (held.uid == action.uid) { card = &held; break; }
      if (!card) for (const auto& built : player.city) if (built.card.uid == action.uid) { card = &built.card; break; }
      if (card) break;
    }
    if (!card) for (const auto& pending : state->pending_cards) if (pending.uid == action.uid) { card = &pending; break; }
    if (card) {
      const int identity = district_identity_index(*card);
      if (action_encoding_version >= 8 && identity >= 0) result[132 + static_cast<size_t>(identity)] = 1.0f;
      result[105] = std::min(1.0f, std::max(0.0f, static_cast<float>(card->cost) / 8.0f));
      result[106] = std::min(1.0f, std::max(0.0f, static_cast<float>(card->score_value > 0 ? card->score_value : card->cost) / 10.0f));
      static const std::array<const char*, 5> colors = {"yellow", "blue", "green", "red", "purple"};
      for (size_t i = 0; i < colors.size(); ++i) if (card->color == colors[i]) result[100 + i] = 1.0f;
    }
  }
  normalize_action_vector(result);
  if (action_encoding_version >= 10 && state) {
    // Two 31-wide district references: primary [182,213), secondary [213,244).
    // Instance attributes and explicit owner/slot links distinguish identical
    // card types with different beautification, museum contents or costs.
    const auto reference = [&](const std::string& uid, size_t offset) {
      if (uid.empty()) return;
      for (size_t owner = 0; owner < state->players.size(); ++owner) {
        const auto& city = state->players[owner].city;
        for (size_t slot = 0; slot < city.size(); ++slot) {
          const auto& d = city[slot];
          if (d.card.uid != uid) continue;
          result[offset] = 1;
          result[offset + 1] = d.beautified ? 1 : 0;
          result[offset + 2] = std::min(1.0f, static_cast<float>(d.museum_cards.size()) / 8);
          result[offset + 3] = std::min(1.0f, static_cast<float>(d.built_round) / 100);
          result[offset + 4] = d.fortress ? 1 : 0;
          const int score = d.card.score_as > 0 ? d.card.score_as
            : d.card.score_value > 0 ? d.card.score_value : d.card.cost;
          result[offset + 5] = (score + d.museum_cards.size() + int(d.beautified)) / 20.0f;
          const bool wall = std::any_of(city.begin(), city.end(), [&](const NativeDistrict& other) {
            return other.card.uid != uid && other.effect == "wallCost";
          });
          result[offset + 6] = destroy_cost(MilitaryCard{d.name, d.card.cost, d.fortress, d.beautified}, wall) / 20.0f;
          if (perspective_player >= 0 && perspective_player < static_cast<int>(state->players.size())) {
            const size_t relative = (owner + state->players.size() - perspective_player) % state->players.size();
            if (relative < 8) result[offset + 7 + relative] = 1;
          }
          if (slot < kEntityV6CitySlots) result[offset + 15 + slot] = 1;
          return;
        }
      }
    };
    reference(action.uid, 182);
    reference(!action.secondary_uid.empty() ? action.secondary_uid
      : state->pending_kind == "diplomat_theirs" ? state->pending_uid : std::string{}, 213);
  }
  return result;
}

class NativeNeuralBatchedEvaluator final
    : public BatchedEvaluator<NativeGameState, NativeSearchAction> {
 public:
  NativeNeuralBatchedEvaluator(BatchEvaluator& backend, std::string profile,
                               int action_encoding_version = kActionEncodingVersion)
      : backend_(backend), profile_(std::move(profile)), action_encoding_version_(action_encoding_version) {}

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
          action_vectors.size() - 1 < players.size() ? players[action_vectors.size() - 1] : -1,
          action_encoding_version_));
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
  int action_encoding_version_;
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
