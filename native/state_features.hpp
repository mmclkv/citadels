#pragma once

#include <algorithm>
#include <array>
#include <string>
#include <vector>

#include "game_state.hpp"

namespace citadels::native {

constexpr int kStateEncodingVersion = 15;
constexpr int kLegacyCityCardFeatureSize = 30;
constexpr int kCityCardFeatureSize = 54;
constexpr int kCityCardEmbeddingSize = 8;
constexpr int kEntityV6CitySlots = 16;
constexpr int kEntityV6CitySlotSize = 8;
constexpr int kEntityV6PlayerFeatureSize = 56 + kEntityV6CitySlots * kEntityV6CitySlotSize;
constexpr int kEntityV6PlayerEmbedFeatureSize = 56 + kEntityV6CitySlots * (7 + kCityCardEmbeddingSize);
constexpr int kEntityV6BaseFeatureSize = 32 + 8 * kEntityV6PlayerFeatureSize + kCityCardFeatureSize;
constexpr int kEntityV6PublicContextSize = 496;
constexpr int kEntityV6StateFeatureSize = kEntityV6BaseFeatureSize + kEntityV6PublicContextSize;
constexpr int kActionEncodingVersion = 11;
constexpr int kActionFeatureSize = 448;
inline int state_version_for_action(int version) { return version >= 11 ? 15 : 14; }
inline int state_feature_size(int version) { return version >= 15 ? kEntityV6StateFeatureSize : 1790; }
inline int action_feature_size(int version) { return version >= 11 ? kActionFeatureSize : 256; }
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
    "School of Magic", "Dragon Gate", "University", "Great Wall", "Quarry",
    "Armory", "Basilica", "Capitol", "Factory", "Framework", "Gold Mine",
    "Imperial Treasury", "Ivory Tower", "Map Room", "Monument", "Necropolis", "Park",
    "Poor House", "Secret Vault", "Stables", "Statue", "Theater", "Thieves’ Den",
    "Wishing Well", "Lighthouse", "Bell Tower", "Ballroom", "Hospital", "Throne Room"
  };
  for (size_t i = 0; i < names.size(); ++i)
    if ((!card.en.empty() && card.en == names[i]) || (!card.name.empty() && card.name == names[i])) return static_cast<int>(i);
  // UID order depends on the scenario's deck. Never infer a named unknown
  // card's identity from its instance number.
  if (card.en.empty() && card.name.empty() && card.purple_effect.empty() && card.uid.size() > 1 && card.uid[0] == 'd') {
    try {
      const int uid = std::stoi(card.uid.substr(1));
      static constexpr std::array<int, kLegacyCityCardFeatureSize> ends = {
        5, 9, 12, 15, 18, 21, 23, 28, 32, 35, 38, 41, 43, 46, 49, 52, 54,
        55, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68
      };
      for (size_t i = 0; i < ends.size(); ++i) if (uid < ends[i]) return static_cast<int>(i);
    } catch (...) {}
  }
  return -1;
}

inline const DistrictCard* visible_district_card(const NativeGameState& state, int observer,
                                                 const std::string& uid) {
  if (uid.empty() || observer < 0 || observer >= static_cast<int>(state.players.size())) return nullptr;
  for (const auto& card : state.players[observer].hand) if (card.uid == uid) return &card;
  for (const auto& player : state.players) for (const auto& district : player.city)
    if (district.card.uid == uid) return &district.card;
  if (state.has_reaction_card && state.reaction_card.uid == uid) return &state.reaction_card;
  const int pending_owner = state.pending_kind == "lighthouse" ? state.pending_target : state.active_player;
  if (observer == pending_owner) for (const auto& card : state.pending_cards) if (card.uid == uid) return &card;
  if (observer == state.active_player && (state.pending_kind == "wizard_card" || state.pending_kind == "wizard_choice") &&
      state.pending_target >= 0 && state.pending_target < static_cast<int>(state.players.size()))
    for (const auto& card : state.players[state.pending_target].hand) if (card.uid == uid) return &card;
  return nullptr;
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
                                          int encoding_version = kStateEncodingVersion) {
  (void)max_players;
  constexpr int player_feature_size = kEntityV6PlayerFeatureSize;
  const bool expanded = encoding_version >= 15;
  const int card_count = expanded ? kCityCardFeatureSize : kLegacyCityCardFeatureSize;
  const int base_size = 32 + 8 * player_feature_size + card_count;
  std::vector<float> features(state_feature_size(encoding_version), 0.0f);
  const int player_count = static_cast<int>(state.players.size());
  if (player_count <= 0) return features;
  const int me = perspective_player >= 0 && perspective_player < player_count ? perspective_player : 0;
  const int active = active_player_index(state);
  const auto rel = [&](int absolute) -> int {
    if (absolute < 0 || absolute >= player_count) return -1;
    return (absolute - me + player_count) % player_count;
  };
  const int active_rel = rel(active);
  features[0] = static_cast<float>(encoding_version);
  features[1] = static_cast<float>(player_count) / 8.0f;
  features[2] = static_cast<float>(state_phase_code(state.phase)) / 6.0f;
  features[3] = static_cast<float>(state.round) / 100.0f;
  features[4] = active_rel < 0 ? 0.0f : static_cast<float>(active_rel) / 8.0f;
  features[5] = static_cast<float>(state.completion_limit()) / 12.0f;
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
  const bool private_bishop_payment = state.pending_kind == "bishop_payer" ||
      state.pending_kind == "bishop_repay";
  features[16] = pending_target < 0 || (private_bishop_payment && me != state.active_player)
      ? 0.0f : static_cast<float>(rel(pending_target) + 1) / 9.0f;
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
      ? (me == state.active_player ? state.pending_amount : 0)
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
    constexpr bool enhanced_context = true;
    const std::string revealed_id = enhanced_context && absolute == me && absolute == active && !p.role_id.empty() ? p.role_id
      : absolute == me && !p.role_ids.empty() ? p.role_ids.front()
      : state.has_turn && absolute == state.active_player && state.turn_phase != "setup" && !p.role_id.empty() ? p.role_id
      : !p.played.empty() ? p.played.front() : std::string{};
    const int revealed = role_number(revealed_id);
    const size_t visible_chars = absolute == me ? p.role_ids.size() : p.played.size();
    // JS intentionally exposes only the boolean choice status, not opponent
    // role identities, so these two flags use raw chars while the length and
    // revealed-number slots remain perspective-masked.
    const bool chosen = !p.role_ids.empty();
    const bool draft_complete = state.phase != NativePhase::Draft || static_cast<int>(p.role_ids.size()) >= (player_count <= 3 ? 2 : 1);
    features[base] = static_cast<float>(p.gold) / 20.0f;
    features[base + 1] = static_cast<float>(p.hand.size()) / 20.0f;
    features[base + 2] = static_cast<float>(state.city_count(absolute)) / std::max(1, state.completion_limit());
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
    // Preserve the feature slot but distinguish policy populations. Self-play
    // trains against neural and heuristic seats; value estimates need to know
    // which behavior generated the current perspective.
    features[base + 17] = enhanced_context
      ? (!p.is_bot ? 0.0f : p.bot_type == "neural" ? 1.0f : p.bot_type == "agent" ? 0.66f : 0.33f)
      : (p.is_bot ? 1.0f : 0.0f);
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
    for (size_t i = 0; i < p.city.size() && i < kEntityV6CitySlots; ++i) {
      const auto& card = p.city[i].card;
      constexpr size_t slot_width = kEntityV6CitySlotSize;
      const size_t slot = base + 56 + i * slot_width;
      features[slot] = std::min(1.0f, std::max(0.0f, static_cast<float>(card.cost) / 8.0f));
      int color = 0;
      for (size_t c = 0; c < city_colors.size(); ++c)
        if (card.color == city_colors[c]) { color = static_cast<int>(c) + 1; break; }
      features[slot + 1] = static_cast<float>(color) / 5.0f;
      const int score = card.score_value > 0 ? card.score_value : card.cost;
      features[slot + 2] = std::min(1.0f, std::max(0.0f, static_cast<float>(score) / 10.0f));
      const int identity = district_identity_index(card);
      if (identity >= 0 && identity < card_count) features[slot + 3] = static_cast<float>(identity + 1);
      {
        features[slot + 4] = p.city[i].beautified ? 1.0f : 0.0f;
        features[slot + 5] = std::min(1.0f, static_cast<float>(p.city[i].museum_cards.size()) / 8.0f);
        features[slot + 6] = std::min(1.0f, static_cast<float>(p.city[i].built_round) / 100.0f);
        features[slot + 7] = p.city[i].fortress ? 1.0f : 0.0f;
      }
    }
  }
  {
    static constexpr std::array<float, 30> maximum_copies = {
      5, 4, 3, 3, 3, 3, 2, 5, 4, 3, 3, 3, 2, 3, 3, 3, 2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1
    };
    for (const auto& card : state.players[me].hand) {
      const int identity = district_identity_index(card);
      if (identity >= 0 && identity < card_count)
        features[base_size - card_count + identity] += identity < 30 ? 1.0f / maximum_copies[identity] : 1.0f;
    }
  }
  {
    const size_t start = base_size;
    // Keep the old 30-wide context blocks intact. Append 24 new identities
    // for reaction, pending card, selected cards and visible pending cards.
    const auto identity_offset = [&](size_t offset, int identity) -> size_t {
      return identity < 30 ? offset + identity : 256 + ((offset - 94) / 30) * 24 + identity - 30;
    };
    const auto mark_roles = [&](const std::vector<std::string>& roles, size_t offset) {
      for (const auto& id : roles) for (size_t i = 0; i < kRoleIds.size(); ++i)
        if (id == kRoleIds[i]) features[start + offset + i] = 1.0f;
    };
    mark_roles(state.char_deck, 0);
    mark_roles(state.draft_face_up, 27);
    if (state.phase == NativePhase::Draft && me == state.draft_current_player &&
        state.draft_step >= 0 && state.draft_step < static_cast<int>(state.draft_steps.size())) {
      std::vector<std::string> selectable = state.draft_pool;
      const auto& step = state.draft_steps[static_cast<size_t>(state.draft_step)];
      if (step.from_face_down && state.draft_sub == "pick")
        selectable.insert(selectable.end(), state.draft_face_down.begin(), state.draft_face_down.end());
      if (state.draft_sub == "discard")
        selectable.erase(std::remove_if(selectable.begin(), selectable.end(), [](const std::string& id) {
          return role_number(id) == 4;
        }), selectable.end());
      mark_roles(selectable, 229);
    }
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
    {
      const auto mark_number = [&](int number, size_t offset) {
        if (number >= 1 && number <= 9) features[start + offset + static_cast<size_t>(number - 1)] = 1.0f;
      };
      if (state.magistrate_player == me) mark_number(state.magistrate_signed, 72);
      if (state.blackmailer_player == me) mark_number(state.blackmailer_signed, 81);
      if (state.reaction_kind == "graveyard") features[start + 90] = 1.0f;
      if (state.reaction_kind == "magistrate") features[start + 91] = 1.0f;
      if (state.reaction_kind == "blackmailer") features[start + 92] = 1.0f;
      features[start + 93] = state.reaction_build ? 1.0f : 0.0f;
      const auto mark_card = [&](const std::string& uid, size_t offset,
                                 bool active_player_knows_other_hands = false) {
        (void)active_player_knows_other_hands;
        const auto* card = visible_district_card(state, me, uid);
        const int identity = card ? district_identity_index(*card) : -1;
        if (identity >= 0 && identity < card_count) features[start + identity_offset(offset, identity)] = 1.0f;
      };
      mark_card(state.reaction_uid, 94);
      const bool wizard_knows_other_hands = state.pending_kind == "wizard_card" ||
          state.pending_kind == "wizard_choice";
      mark_card(state.pending_uid, 124, wizard_knows_other_hands);
      const auto add_identity_count = [&](const DistrictCard& card, size_t offset, float divisor) {
        const int identity = district_identity_index(card);
        if (identity >= 0 && identity < card_count) features[start + identity_offset(offset, identity)] += 1.0f / divisor;
      };
      const int pending_owner = state.pending_kind == "lighthouse" ? state.pending_target : state.active_player;
      const bool sees_pending_selection = me == pending_owner || state.pending_kind == "artist";
      if (sees_pending_selection) {
        for (const auto& uid : state.pending_selected) {
          bool found = false;
          if (me == state.active_player) {
            for (const auto& card : state.players[me].hand) if (card.uid == uid) {
              add_identity_count(card, 154, 5.0f); found = true; break;
            }
          }
          if (!found && state.pending_kind == "artist") {
            for (const auto& player : state.players) for (const auto& district : player.city) if (district.card.uid == uid) {
              add_identity_count(district.card, 154, 5.0f); found = true; break;
            }
          }
        }
        if (me == pending_owner)
          for (const auto& card : state.pending_cards) add_identity_count(card, 184, 5.0f);
      }
      if (me == state.active_player) {
        features[start + 214] = std::min(1.0f, static_cast<float>(state.pending_cursor) / 32.0f);
        features[start + 215] = std::min(1.0f, static_cast<float>(state.pending_selected.size()) / 16.0f);
        features[start + 216] = std::min(1.0f, static_cast<float>(state.pending_amount) / 20.0f);
        for (int number : state.pending_nums) mark_number(number, 217);
      } else if (state.pending_kind == "artist") {
        features[start + 215] = std::min(1.0f, static_cast<float>(state.pending_selected.size()) / 16.0f);
      }
      features[start + 226] = std::min(1.0f, static_cast<float>(state.pending_cards.size()) / 16.0f);
      features[start + 227] = state.pending_kind == "wizard_choice" ? 1.0f : 0.0f;
      features[start + 228] = state.magistrate_claimed ? 1.0f : 0.0f;
    }
    if (expanded) {
      // Private discard/payment identities are visible only to their owner.
      if (me == state.active_player) {
        for (const auto& card : state.players[me].hand) {
          const int identity = district_identity_index(card);
          if (identity < 0) continue;
          if (std::find(state.pending_selected.begin(), state.pending_selected.end(), card.uid) != state.pending_selected.end() ||
              std::find(state.building_cards.begin(), state.building_cards.end(), card.uid) != state.building_cards.end())
            features[start + 352 + identity] += 0.2f;
        }
      }
      static constexpr std::array<const char*, 6> kinds = {
        "lighthouse", "bell_tower", "theater_exchange", "ballroom", "thieves_den", "artist"};
      for (size_t i = 0; i < kinds.size(); ++i) if (state.pending_kind == kinds[i]) features[start + 406 + i] = 1;
      static constexpr std::array<const char*, 3> modes = {"framework", "necropolis", "thievesDen"};
      for (size_t i = 0; i < modes.size(); ++i) if (state.building_mode == modes[i]) features[start + 412 + i] = 1;
      for (int r = 0; r < player_count && r < 8; ++r) {
        const int owner = (me + r) % player_count;
        for (const auto& district : state.players[owner].city) {
          const int identity = district_identity_index(district.card);
          if (identity >= 0 && district.card.uid == state.building_source) features[start + 415 + identity] = 1;
          if (district.effect == "bellTower" && std::find(state.enabled_bell_towers.begin(), state.enabled_bell_towers.end(), district.card.uid) != state.enabled_bell_towers.end())
            features[start + 469 + r] = 1;
        }
        if (std::find(state.pending_queue.begin(), state.pending_queue.end(), owner) != state.pending_queue.end()) features[start + 477 + r] = 1;
        if (std::find(state.first_finishers.begin(), state.first_finishers.end(), owner) != state.first_finishers.end()) features[start + 485 + r] = 1;
      }
      features[start + 493] = state.turn_phase == "hospital" ? 1 : 0;
      features[start + 494] = state.building_mode == "wizard" ? 1 : 0;
      features[start + 495] = state.turn_phase == "bewitched" ? 1 : 0;
    }
  }
  return features;
}

}  // namespace citadels::native
