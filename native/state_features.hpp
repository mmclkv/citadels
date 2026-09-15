#pragma once

#include <algorithm>
#include <array>
#include <string>
#include <vector>

#include "game_state.hpp"

namespace citadels::native {

constexpr int kStateEncodingVersion = 2;
constexpr int kStateFeatureSize = 192;
constexpr int kActionEncodingVersion = 2;

inline int state_phase_code(NativePhase phase) {
  switch (phase) {
    case NativePhase::Lobby: return 0;
    case NativePhase::Draft: return 1;
    case NativePhase::Action: return 2;
    case NativePhase::Reaction: return 3;
    case NativePhase::RoundConfirm: return 4;
    case NativePhase::GameOver: return 5;
    default: return 6;
  }
}

inline int role_number(const std::string& id) {
  if (id == "assassin" || id == "witch") return 1;
  if (id == "thief") return 2;
  if (id == "magician" || id == "prophet") return 3;
  if (id == "king" || id == "emperor" || id == "noble") return 4;
  if (id == "bishop" || id == "monk") return 5;
  if (id == "merchant" || id == "alchemist" || id == "businessman") return 6;
  if (id == "architect" || id == "navigator" || id == "scholar") return 7;
  if (id == "warlord" || id == "diplomat" || id == "marshal") return 8;
  if (id == "queen" || id == "artist") return 9;
  return 0;
}

inline int pending_kind_code(const std::string& kind) {
  static const std::array<const char*, 18> names = {
    "assassin", "thief", "witch_target", "magician_choice", "magician_swap",
    "magician_redraw", "warlord_destroy", "marshal_seize", "artist",
    "navigator_bonus", "monk_declare", "emperor_crown", "emperor_take",
    "prophet_give", "draw_keep", "scholar_pick", "diplomat_mine", "diplomat_theirs"
  };
  for (size_t i = 0; i < names.size(); ++i) if (kind == names[i]) return static_cast<int>(i + 1);
  return 0;
}

inline int turn_phase_code(const std::string& phase) {
  if (phase == "main" || phase.empty()) return 0;
  if (phase == "witch_resume") return 1;
  if (phase == "draw_keep") return 2;
  if (phase == "scholar_pick") return 3;
  return 4;
}

inline int active_player_index(const NativeGameState& state) {
  if (state.has_turn && state.active_player >= 0 && state.active_player < static_cast<int>(state.players.size())) return state.active_player;
  if (state.reaction_player >= 0 && state.reaction_player < static_cast<int>(state.players.size())) return state.reaction_player;
  if (state.draft_current_player >= 0 && state.draft_current_player < static_cast<int>(state.players.size())) return state.draft_current_player;
  return -1;
}

inline std::vector<float> encode_features(const NativeGameState& state,
                                          int perspective_player = -1,
                                          int max_players = 8) {
  (void)max_players;
  std::vector<float> features(kStateFeatureSize, 0.0f);
  const int player_count = static_cast<int>(state.players.size());
  if (player_count <= 0) return features;
  const int me = perspective_player >= 0 && perspective_player < player_count ? perspective_player : 0;
  const int active = active_player_index(state);
  const auto rel = [&](int absolute) -> int {
    if (absolute < 0 || absolute >= player_count) return -1;
    return (absolute - me + player_count) % player_count;
  };
  const int active_rel = rel(active);
  features[0] = static_cast<float>(kStateEncodingVersion);
  features[1] = static_cast<float>(player_count) / 8.0f;
  features[2] = static_cast<float>(state_phase_code(state.phase)) / 6.0f;
  features[3] = static_cast<float>(state.round) / 100.0f;
  features[4] = active_rel < 0 ? 0.0f : static_cast<float>(active_rel) / 8.0f;
  features[5] = static_cast<float>(state.end_districts) / 12.0f;
  features[6] = state.first_to_finish < 0 ? 0.0f : static_cast<float>(rel(state.first_to_finish) + 1) / 9.0f;
  features[7] = static_cast<float>(state.deck.deck_count()) / 100.0f;
  features[8] = static_cast<float>(state.deck.discard_count()) / 100.0f;
  features[9] = static_cast<float>(state.char_deck.size()) / 8.0f;
  features[10] = static_cast<float>(state.call_index) / 16.0f;
  features[11] = state.phase == NativePhase::Draft ? static_cast<float>(std::max(0, state.draft_step)) / 32.0f : 0.0f;
  features[12] = state.phase == NativePhase::Draft ? static_cast<float>(state.draft_total_steps) / 32.0f : 0.0f;
  features[13] = state.phase == NativePhase::Draft && state.draft_current_player >= 0
    ? static_cast<float>(rel(state.draft_current_player) + 1) / 9.0f : 0.0f;
  features[14] = state.reaction_player < 0 ? 0.0f : static_cast<float>(rel(state.reaction_player) + 1) / 9.0f;
  features[15] = static_cast<float>(state.round_confirm_count) / 8.0f;
  features[16] = state.pending_target < 0 ? 0.0f : static_cast<float>(rel(state.pending_target) + 1) / 9.0f;
  features[17] = state.pending_from_crown < 0 ? 0.0f : static_cast<float>(rel(state.pending_from_crown) + 1) / 9.0f;
  features[18] = static_cast<float>(pending_kind_code(state.pending_kind)) / 32.0f;
  features[19] = static_cast<float>(state.has_turn ? turn_phase_code(state.turn_phase) : 4) / 4.0f;
  features[20] = static_cast<float>(state.turns_completed) / 100.0f;
  features[21] = state.resources_taken ? 1.0f : 0.0f;
  features[22] = state.income_taken ? 1.0f : 0.0f;
  features[23] = state.monk_extra_taken ? 1.0f : 0.0f;
  features[24] = state.ability_used ? 1.0f : 0.0f;
  features[25] = state.used_lab ? 1.0f : 0.0f;
  features[26] = state.used_smithy ? 1.0f : 0.0f;
  features[27] = state.used_museum ? 1.0f : 0.0f;
  features[28] = state.bonus_done ? 1.0f : 0.0f;
  features[29] = static_cast<float>(state.pending_cards.size()) / 8.0f;
  features[30] = static_cast<float>(state.builds) / 4.0f;
  features[31] = static_cast<float>(state.spent_on_build) / 20.0f;
  constexpr std::array<const char*, 5> colors = {"yellow", "blue", "green", "red", "purple"};
  for (int r = 0; r < 8 && r < player_count; ++r) {
    const int absolute = (me + r) % player_count;
    const auto& p = state.players[absolute];
    const size_t base = static_cast<size_t>(32 + r * 20);
    int city_score = 0, city_cost = 0, purple = 0, museum = 0, beautified = 0;
    std::array<bool, 5> have{};
    for (const auto& district : p.city) {
      city_score += district.card.score_value > 0 ? district.card.score_value : district.card.cost;
      city_cost += district.card.cost;
      for (size_t c = 0; c < colors.size(); ++c) if (district.card.color == colors[c]) have[c] = true;
      if (!district.effect.empty() || !district.card.purple_effect.empty()) ++purple;
      museum += static_cast<int>(district.museum_cards.size());
      if (district.beautified) ++beautified;
    }
    const int revealed = absolute == me && !p.role_ids.empty() ? role_number(p.role_ids.front())
      : absolute == (state.has_turn ? state.active_player : -1) ? role_number(p.role_id)
      : (!p.played.empty() ? role_number(p.played.front()) : 0);
    const size_t visible_chars = absolute == me ? p.role_ids.size() : p.played.size();
    // JS intentionally exposes only the boolean choice status, not opponent
    // role identities, so these two flags use raw chars while the length and
    // revealed-number slots remain perspective-masked.
    const bool chosen = !p.role_ids.empty();
    const bool draft_complete = state.phase != NativePhase::Draft || static_cast<int>(p.role_ids.size()) >= (player_count <= 3 ? 2 : 1);
    features[base] = static_cast<float>(p.gold) / 20.0f;
    features[base + 1] = static_cast<float>(p.hand_count) / 20.0f;
    features[base + 2] = static_cast<float>(p.city.size()) / std::max(1, state.end_districts);
    features[base + 3] = p.has_crown ? 1.0f : 0.0f;
    features[base + 4] = absolute == active ? 1.0f : 0.0f;
    features[base + 5] = chosen ? 1.0f : 0.0f;
    features[base + 6] = draft_complete ? 1.0f : 0.0f;
    features[base + 7] = revealed == 0 ? 0.0f : static_cast<float>(revealed + 1) / 21.0f;
    features[base + 8] = static_cast<float>(p.played.size()) / 3.0f;
    features[base + 9] = static_cast<float>(city_score) / 100.0f;
    features[base + 10] = static_cast<float>(city_cost) / 100.0f;
    features[base + 11] = static_cast<float>(std::count(have.begin(), have.end(), true)) / 5.0f;
    features[base + 12] = static_cast<float>(purple) / 10.0f;
    features[base + 13] = static_cast<float>(museum) / 10.0f;
    features[base + 14] = static_cast<float>(beautified) / 10.0f;
    features[base + 15] = static_cast<float>(visible_chars) / 3.0f;
    features[base + 16] = p.connected ? 1.0f : 0.0f;
    features[base + 17] = p.is_bot ? 1.0f : 0.0f;
    features[base + 18] = static_cast<float>(p.seat) / 8.0f;
    features[base + 19] = absolute == active ? static_cast<float>(state.pending_cards.size()) / 8.0f : 0.0f;
  }
  return features;
}

}  // namespace citadels::native
