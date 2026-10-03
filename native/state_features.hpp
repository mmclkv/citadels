#pragma once

#include <algorithm>
#include <array>
#include <string>
#include <vector>

#include "game_state.hpp"

namespace citadels::native {

constexpr int kStateEncodingVersion = 12;
constexpr int kLegacyStateEncodingVersion = 8;
constexpr int kStateFeatureSize = 672;
constexpr int kEntityV3StateFeatureSize = 702;
constexpr int kCityCardFeatureSize = 30;
constexpr int kCityCardEmbeddingSize = 8;
constexpr int kCityIdSlotSize = 4;
constexpr int kEntityV4PlayerFeatureSize = 56 + 8 * kCityIdSlotSize;
constexpr int kEntityV4PlayerEmbedFeatureSize = 56 + 8 * (3 + kCityCardEmbeddingSize);
constexpr int kEntityV4StateFeatureSize = 32 + 8 * kEntityV4PlayerFeatureSize + kCityCardFeatureSize;
constexpr int kPublicContextFeatureSize = 72;
constexpr int kEntityV5StateFeatureSize = kEntityV4StateFeatureSize + kPublicContextFeatureSize;
constexpr int kEntityV6CitySlots = 16;
constexpr int kEntityV6CitySlotSize = 8;
constexpr int kEntityV6PlayerFeatureSize = 56 + kEntityV6CitySlots * kEntityV6CitySlotSize;
constexpr int kEntityV6PlayerEmbedFeatureSize = 56 + kEntityV6CitySlots * (7 + kCityCardEmbeddingSize);
constexpr int kEntityV6BaseFeatureSize = 32 + 8 * kEntityV6PlayerFeatureSize + kCityCardFeatureSize;
constexpr int kEntityV6PublicContextSize = 256;
constexpr int kEntityV6StateFeatureSize = kEntityV6BaseFeatureSize + kEntityV6PublicContextSize;
constexpr int kActionEncodingVersion = 9;
constexpr std::array<const char*, 27> kRoleIds = {"assassin", "witch", "thief", "magician", "prophet",
  "king", "emperor", "noble", "bishop", "monk", "merchant", "alchemist", "businessman",
  "architect", "navigator", "scholar", "warlord", "diplomat", "marshal", "queen", "artist",
  "magistrate", "spy", "blackmailer", "wizard", "abbot", "tax_collector"};

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
  if (id == "magistrate") return 1;
  if (id == "thief") return 2;
  if (id == "spy" || id == "blackmailer") return 2;
  if (id == "magician" || id == "prophet") return 3;
  if (id == "wizard") return 3;
  if (id == "king" || id == "emperor" || id == "noble") return 4;
  if (id == "bishop" || id == "monk") return 5;
  if (id == "abbot") return 5;
  if (id == "merchant" || id == "alchemist" || id == "businessman") return 6;
  if (id == "architect" || id == "navigator" || id == "scholar") return 7;
  if (id == "warlord" || id == "diplomat" || id == "marshal") return 8;
  if (id == "queen" || id == "artist") return 9;
  if (id == "tax_collector") return 9;
  return 0;
}

inline int pending_kind_code(const std::string& kind) {
  static const std::array<const char*, 34> names = {
    "assassin", "thief", "witch_target", "magician_choice", "magician_swap",
    "magician_redraw", "warlord_destroy", "marshal_seize", "artist",
    "navigator_bonus", "monk_declare", "emperor_crown", "emperor_take",
    "prophet_give", "draw_keep", "scholar_pick", "diplomat_mine", "diplomat_theirs",
    "magistrate_declare", "magistrate_second", "magistrate_third", "blackmailer_declare",
    "blackmailer_second", "blackmailer_signed", "blackmailer_threat", "spy_target", "spy_color",
    "wizard_target", "wizard_card", "wizard_choice", "abbot_declare", "tax_collect", "bishop_payer", "bishop_repay"
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

inline int district_identity_index(const DistrictCard& card) {
  static constexpr std::array<const char*, kCityCardFeatureSize> names = {
    "Manor", "Castle", "Palace", "Temple", "Church", "Monastery", "Cathedral",
    "Tavern", "Market", "Trading Post", "Docks", "Harbor", "Town Hall",
    "Watchtower", "Prison", "Battlefield", "Fortress", "Ghost Town", "Keep",
    "Museum", "Graveyard", "Laboratory", "Smithy", "Observatory", "Library",
    "School of Magic", "Dragon Gate", "University", "Great Wall", "Quarry"
  };
  for (size_t i = 0; i < names.size(); ++i)
    if ((!card.en.empty() && card.en == names[i]) || (!card.name.empty() && card.name == names[i])) return static_cast<int>(i);
  if (card.uid.size() > 1 && card.uid[0] == 'd') {
    try {
      const int uid = std::stoi(card.uid.substr(1));
      static constexpr std::array<int, kCityCardFeatureSize> ends = {
        5, 9, 12, 15, 18, 21, 23, 28, 32, 35, 38, 41, 43, 46, 49, 52, 54,
        55, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68
      };
      for (size_t i = 0; i < ends.size(); ++i) if (uid < ends[i]) return static_cast<int>(i);
    } catch (...) {}
  }
  return -1;
}

inline int active_player_index(const NativeGameState& state) {
  if (state.has_turn && state.active_player >= 0 && state.active_player < static_cast<int>(state.players.size())) return state.active_player;
  if (state.reaction_player >= 0 && state.reaction_player < static_cast<int>(state.players.size())) return state.reaction_player;
  if (state.draft_current_player >= 0 && state.draft_current_player < static_cast<int>(state.players.size())) return state.draft_current_player;
  return -1;
}

inline std::vector<float> encode_features(const NativeGameState& state,
                                          int perspective_player = -1,
                                          int max_players = 8,
                                          bool include_own_hand = false,
                                          bool include_city_identity = false,
                                          bool include_public_context = false,
                                          bool include_v6_features = false) {
  (void)max_players;
  const int player_feature_size = include_v6_features ? kEntityV6PlayerFeatureSize : include_city_identity ? kEntityV4PlayerFeatureSize : 80;
  const int state_feature_size = include_v6_features ? kEntityV6StateFeatureSize : include_public_context ? kEntityV5StateFeatureSize : include_city_identity ? kEntityV4StateFeatureSize
    : include_own_hand ? kEntityV3StateFeatureSize : kStateFeatureSize;
  std::vector<float> features(state_feature_size, 0.0f);
  const int player_count = static_cast<int>(state.players.size());
  if (player_count <= 0) return features;
  const int me = perspective_player >= 0 && perspective_player < player_count ? perspective_player : 0;
  const int active = active_player_index(state);
  const auto rel = [&](int absolute) -> int {
    if (absolute < 0 || absolute >= player_count) return -1;
    return (absolute - me + player_count) % player_count;
  };
  const int active_rel = rel(active);
  features[0] = static_cast<float>(include_v6_features ? kStateEncodingVersion : include_public_context ? kStateEncodingVersion - 1
    : include_city_identity ? kStateEncodingVersion - 2 : include_own_hand ? 9 : kLegacyStateEncodingVersion);
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
  const int pending_target = state.pending_target;
  features[16] = pending_target < 0 ? 0.0f : static_cast<float>(rel(pending_target) + 1) / 9.0f;
  features[17] = state.pending_from_crown < 0 ? 0.0f : static_cast<float>(rel(state.pending_from_crown) + 1) / 9.0f;
  features[18] = static_cast<float>(pending_kind_code(state.pending_kind)) / 34.0f;
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
  const int pending_count_or_amount = state.pending_kind == "bishop_repay" || state.pending_kind == "bishop_payer"
      ? state.pending_amount
      : (state.pending_kind == "draw_keep" || state.pending_kind == "scholar_pick" ||
         state.pending_kind == "wizard_card" ? static_cast<int>(state.pending_cards.size()) : 0);
  features[29] = static_cast<float>(pending_count_or_amount) / 8.0f;
  features[30] = static_cast<float>(state.builds) / 4.0f;
  features[31] = static_cast<float>(state.spent_on_build) / 20.0f;
  constexpr std::array<const char*, 5> colors = {"yellow", "blue", "green", "red", "purple"};
  constexpr std::array<const char*, 5> city_colors = {"yellow", "blue", "green", "red", "purple"};
  for (int r = 0; r < 8 && r < player_count; ++r) {
    const int absolute = (me + r) % player_count;
    const auto& p = state.players[absolute];
    const size_t base = static_cast<size_t>(32 + r * player_feature_size);
    int city_score = 0, city_cost = 0, purple = 0, museum = 0, beautified = 0;
    std::array<bool, 5> have{};
    for (const auto& district : p.city) {
      city_score += district.card.score_as > 0 ? district.card.score_as
        : district.card.score_value > 0 ? district.card.score_value : district.card.cost;
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
    const std::string revealed_id = absolute == me && !p.role_ids.empty() ? p.role_ids.front()
      : state.has_turn && absolute == state.active_player && !p.role_id.empty() ? p.role_id
      : !p.played.empty() ? p.played.front() : std::string{};
    // JS intentionally exposes only the boolean choice status, not opponent
    // role identities, so these two flags use raw chars while the length and
    // revealed-number slots remain perspective-masked.
    const bool chosen = !p.role_ids.empty();
    const bool draft_complete = state.phase != NativePhase::Draft || static_cast<int>(p.role_ids.size()) >= (player_count <= 3 ? 2 : 1);
    features[base] = static_cast<float>(p.gold) / 20.0f;
    features[base + 1] = static_cast<float>(p.hand.size()) / 20.0f;
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
    // 与 JS 编码保持一致：绝对座位号会让固定座位训练产生位置捷径，
    // 这里保留槽位但不再写入绝对 seat。
    features[base + 18] = 0.0f;
    const bool pending_exposes_count = state.pending_kind == "draw_keep" ||
        state.pending_kind == "scholar_pick" || state.pending_kind == "wizard_card";
    features[base + 19] = absolute == active && pending_exposes_count
        ? static_cast<float>(state.pending_cards.size()) / 8.0f : 0.0f;
    if (revealed >= 1 && revealed <= 9) features[base + 19 + static_cast<size_t>(revealed)] = 1.0f;
    for (size_t role = 0; role < kRoleIds.size(); ++role)
      if (revealed_id == kRoleIds[role]) { features[base + 29 + role] = 1.0f; break; }
    const size_t max_city_slots = include_v6_features ? kEntityV6CitySlots : 8;
    for (size_t i = 0; i < p.city.size() && i < max_city_slots; ++i) {
      const auto& card = p.city[i].card;
      const size_t slot_width = include_v6_features ? kEntityV6CitySlotSize : include_city_identity ? kCityIdSlotSize : 3;
      const size_t slot = base + 56 + i * slot_width;
      features[slot] = std::min(1.0f, std::max(0.0f, static_cast<float>(card.cost) / 8.0f));
      int color = 0;
      for (size_t c = 0; c < city_colors.size(); ++c)
        if (card.color == city_colors[c]) { color = static_cast<int>(c) + 1; break; }
      features[slot + 1] = static_cast<float>(color) / 5.0f;
      const int score = card.score_value > 0 ? card.score_value : card.cost;
      features[slot + 2] = std::min(1.0f, std::max(0.0f, static_cast<float>(score) / 10.0f));
      if (include_city_identity || include_v6_features) {
        const int identity = district_identity_index(card);
        if (identity >= 0) features[slot + 3] = static_cast<float>(identity + 1);
      }
      if (include_v6_features) {
        features[slot + 4] = p.city[i].beautified ? 1.0f : 0.0f;
        features[slot + 5] = std::min(1.0f, static_cast<float>(p.city[i].museum_cards.size()) / 8.0f);
        features[slot + 6] = std::min(1.0f, static_cast<float>(p.city[i].built_round) / 100.0f);
        features[slot + 7] = p.city[i].fortress ? 1.0f : 0.0f;
      }
    }
  }
  if (include_own_hand) {
    static constexpr std::array<const char*, 30> hand_cards = {
      "Manor", "Castle", "Palace", "Temple", "Church", "Monastery", "Cathedral",
      "Tavern", "Market", "Trading Post", "Docks", "Harbor", "Town Hall",
      "Watchtower", "Prison", "Battlefield", "Fortress", "Ghost Town", "Keep",
      "Museum", "Graveyard", "Laboratory", "Smithy", "Observatory", "Library",
      "School of Magic", "Dragon Gate", "University", "Great Wall", "Quarry"
    };
    static constexpr std::array<float, 30> maximum_copies = {
      5, 4, 3, 3, 3, 3, 2, 5, 4, 3, 3, 3, 2, 3, 3, 3, 2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
    };
    for (const auto& card : state.players[me].hand) {
      for (size_t i = 0; i < hand_cards.size(); ++i) {
        if (card.en == hand_cards[i] || (card.en.empty() && card.name == hand_cards[i])) {
          features[(include_v6_features ? kEntityV6BaseFeatureSize - kCityCardFeatureSize : include_city_identity ? 32 + 8 * kEntityV4PlayerFeatureSize : kStateFeatureSize) + i] += 1.0f / maximum_copies[i];
          break;
        }
      }
    }
  }
  if (include_public_context) {
    const size_t start = include_v6_features ? kEntityV6BaseFeatureSize : kEntityV4StateFeatureSize;
    const auto mark_roles = [&](const std::vector<std::string>& roles, size_t offset) {
      for (const auto& id : roles) for (size_t i = 0; i < kRoleIds.size(); ++i)
        if (id == kRoleIds[i]) features[start + offset + i] = 1.0f;
    };
    mark_roles(state.char_deck, 0);
    mark_roles(state.draft_face_up, 27);
    if (state.assassinated >= 1 && state.assassinated <= 9) features[start + 54] = state.assassinated / 9.0f;
    if (state.thief_target >= 1 && state.thief_target <= 9) features[start + 55] = state.thief_target / 9.0f;
    if (state.bewitched >= 1 && state.bewitched <= 9) features[start + 56] = state.bewitched / 9.0f;
    features[start + 57] = state.tax_collector_gold / 20.0f;
    if (state.players[me].role_ids.size() >= 2) for (size_t i = 0; i < kRoleIds.size(); ++i)
      if (state.players[me].role_ids[1] == kRoleIds[i]) features[start + 58] = static_cast<float>(i + 1) / kRoleIds.size();
    const auto number_mask = [](const std::vector<int>& nums) {
      int mask = 0;
      for (int num : nums) if (num >= 1 && num <= 9) mask |= 1 << (num - 1);
      return mask / 512.0f;
    };
    features[start + 59] = number_mask(state.magistrate_nums);
    features[start + 60] = number_mask(state.blackmailer_nums);
    features[start + 61] = number_mask(state.blackmailer_done);
    features[start + 63] = number_mask(state.blackmailer_revealed_real);
    if (state.pending_kind == "magician_redraw" && me == state.active_player) {
      features[start + 64] = state.pending_cursor / 20.0f;
      features[start + 65] = state.pending_selected.size() / 20.0f;
      int low = 0, high = 0;
      for (const auto& uid : state.pending_selected) for (const auto& card : state.players[me].hand)
        if (card.uid == uid) {
          const int identity = district_identity_index(card);
          if (identity >= 0 && identity < 15) low |= 1 << identity;
          else if (identity >= 15 && identity < 30) high |= 1 << (identity - 15);
          break;
        }
      features[start + 66] = low / 32768.0f;
      features[start + 67] = high / 32768.0f;
    }
    if (include_v6_features) {
      const auto mark_number = [&](int number, size_t offset) {
        if (number >= 1 && number <= 9) features[start + offset + static_cast<size_t>(number - 1)] = 1.0f;
      };
      if (state.magistrate_player == me) mark_number(state.magistrate_signed, 72);
      if (state.blackmailer_player == me) mark_number(state.blackmailer_signed, 81);
      if (state.reaction_kind == "graveyard") features[start + 90] = 1.0f;
      if (state.reaction_kind == "magistrate") features[start + 91] = 1.0f;
      if (state.reaction_kind == "blackmailer") features[start + 92] = 1.0f;
      features[start + 93] = state.reaction_build ? 1.0f : 0.0f;
      const auto mark_card = [&](const std::string& uid, size_t offset) {
        const auto mark = [&](const DistrictCard& card) {
          const int identity = district_identity_index(card);
          if (identity >= 0) features[start + offset + static_cast<size_t>(identity)] = 1.0f;
        };
        for (const auto& player : state.players) {
          for (const auto& card : player.hand) if (card.uid == uid) { mark(card); return; }
          for (const auto& district : player.city) if (district.card.uid == uid) { mark(district.card); return; }
        }
        for (const auto& card : state.pending_cards) if (card.uid == uid) { mark(card); return; }
      };
      mark_card(state.reaction_uid, 94);
      mark_card(state.pending_uid, 124);
      const auto add_identity_count = [&](const DistrictCard& card, size_t offset, float divisor) {
        const int identity = district_identity_index(card);
        if (identity >= 0) features[start + offset + static_cast<size_t>(identity)] += 1.0f / divisor;
      };
      if (me == state.active_player) {
        for (const auto& uid : state.pending_selected) {
          for (const auto& card : state.players[me].hand) if (card.uid == uid) { add_identity_count(card, 154, 5.0f); break; }
        }
        for (const auto& card : state.pending_cards) add_identity_count(card, 184, 5.0f);
      }
      features[start + 214] = std::min(1.0f, static_cast<float>(state.pending_cursor) / 32.0f);
      features[start + 215] = std::min(1.0f, static_cast<float>(state.pending_selected.size()) / 16.0f);
      features[start + 216] = std::min(1.0f, static_cast<float>(state.pending_amount) / 20.0f);
      for (int number : state.pending_nums) mark_number(number, 217);
      features[start + 226] = std::min(1.0f, static_cast<float>(state.pending_cards.size()) / 16.0f);
      features[start + 227] = state.pending_kind == "wizard_choice" ? 1.0f : 0.0f;
      features[start + 228] = state.magistrate_claimed ? 1.0f : 0.0f;
    }
  }
  return features;
}

}  // namespace citadels::native
