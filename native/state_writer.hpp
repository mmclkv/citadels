#pragma once

#include <algorithm>
#include <array>
#include <ostream>
#include <string>
#include <string_view>

#include "game_adapter.hpp"

namespace citadels::native {

inline void write_json_string(std::ostream& out, std::string_view value) {
  out << '"';
  for (unsigned char ch : value) {
    switch (ch) {
      case '"': out << "\\\""; break;
      case '\\': out << "\\\\"; break;
      case '\b': out << "\\b"; break;
      case '\f': out << "\\f"; break;
      case '\n': out << "\\n"; break;
      case '\r': out << "\\r"; break;
      case '\t': out << "\\t"; break;
      default:
        if (ch < 0x20) out << "\\u00" << "0123456789abcdef"[ch >> 4] << "0123456789abcdef"[ch & 15];
        else out << static_cast<char>(ch);
    }
  }
  out << '"';
}

inline void write_json_strings(std::ostream& out, const std::vector<std::string>& values) {
  out << '[';
  for (size_t i = 0; i < values.size(); ++i) {
    if (i) out << ',';
    write_json_string(out, values[i]);
  }
  out << ']';
}

inline void write_native_card(std::ostream& out, const DistrictCard& card,
                              const NativeDistrict* district = nullptr) {
  out << "{\"uid\":"; write_json_string(out, card.uid);
  out << ",\"name\":"; write_json_string(out, district && !district->name.empty() ? district->name : card.name);
  out << ",\"en\":"; write_json_string(out, card.en);
  out << ",\"desc\":"; write_json_string(out, card.desc);
  out << ",\"color\":"; write_json_string(out, card.color);
  out << ",\"cost\":" << card.cost << ",\"scoreValue\":"
      << (card.score_as > 0 ? card.score_as : card.score_value);
  out << ",\"purpleEffect\":"; write_json_string(out, district && !district->effect.empty() ? district->effect : card.purple_effect);
  if (district) {
    out << ",\"purple\":{\"effect\":"; write_json_string(out, district->effect);
    out << ",\"scoreAs\":" << card.score_as << "},\"beautified\":"
        << (district->beautified ? "true" : "false") << ",\"fortress\":"
        << (district->fortress ? "true" : "false") << ",\"builtRound\":" << district->built_round
        << ",\"museum\":[";
    for (size_t i = 0; i < district->museum_cards.size(); ++i) {
      if (i) out << ',';
      write_native_card(out, district->museum_cards[i]);
    }
    out << ']';
  }
  out << '}';
}

inline const char* native_phase_name(NativePhase phase) {
  switch (phase) {
    case NativePhase::Lobby: return "lobby";
    case NativePhase::Draft: return "draft";
    case NativePhase::Action: return "action";
    case NativePhase::Reaction: return "reaction";
    case NativePhase::RoundConfirm: return "roundConfirm";
    case NativePhase::GameOver: return "gameover";
    default: return "unknown";
  }
}

inline void write_native_action(std::ostream& out, const NativeSearchAction& action) {
  out << "{\"type\":"; write_json_string(out, action_type_name(action.type));
  if (!action.uid.empty()) { out << ",\"uid\":"; write_json_string(out, action.uid); }
  if (!action.name.empty()) {
    if (action.type == ActionType::DraftPick || action.type == ActionType::DraftDiscard) {
      out << ",\"charId\":"; write_json_string(out, action.name);
    } else if (action.type == ActionType::MagicianMode) {
      out << ",\"mode\":"; write_json_string(out, action.mode.empty() ? action.name : action.mode);
    } else if (action.type == ActionType::Reaction) {
      out << ",\"use\":" << (action.name == "use" ? "true" : "false");
    } else {
      out << ",\"name\":"; write_json_string(out, action.name);
    }
  }
  if (!action.effect.empty()) { out << ",\"effect\":"; write_json_string(out, action.effect); }
  if (!action.target.empty()) { out << ",\"target\":"; write_json_string(out, action.target); }
  if (!action.secondary_uid.empty()) {
    out << (action.type == ActionType::Lab ? ",\"discardUid\":" : ",\"cardUid\":");
    write_json_string(out, action.secondary_uid);
  }
  if (!action.selected_uids.empty()) { out << ",\"uids\":"; write_json_strings(out, action.selected_uids); }
  if (!action.mode.empty() && action.type != ActionType::MagicianMode) { out << ",\"mode\":"; write_json_string(out, action.mode); }
  if (!action.color.empty()) { out << ",\"color\":"; write_json_string(out, action.color); }
  if (action.has_num) out << ",\"num\":" << action.num;
  if (action.gold >= 0) out << ",\"gold\":" << action.gold;
  if (action.cards >= 0) out << ",\"cards\":" << action.cards;
  out << '}';
}

inline void write_native_state(std::ostream& out, const NativeGameState& state) {
  out << "{\"phase\":\"" << native_phase_name(state.phase) << "\",\"round\":" << state.round
      << ",\"rngState\":" << state.rng.state() << ",\"firstToFinish\":" << state.first_to_finish
      << ",\"config\":{\"endDistricts\":" << state.end_districts << '}'
      << ",\"pendingQueen\":";
  if (state.pending_queen < 0) out << "null";
  else out << "{\"playerIdx\":" << state.pending_queen << '}';
  out << ",\"turnsCompleted\":" << state.turns_completed << ",\"callIdx\":" << state.call_index
      << ",\"players\":[";
  for (size_t i = 0; i < state.players.size(); ++i) {
    if (i) out << ',';
    const auto& player = state.players[i];
    out << "{\"id\":"; write_json_string(out, player.id);
    out << ",\"name\":"; write_json_string(out, player.name);
    out << ",\"seat\":" << player.seat << ",\"isBot\":" << (player.is_bot ? "true" : "false")
        << ",\"botType\":"; write_json_string(out, player.bot_type);
    out << ",\"botLevel\":"; write_json_string(out, player.bot_level);
    out << ",\"gold\":" << player.gold << ",\"handCount\":" << player.hand.size()
        << ",\"hasCrown\":" << (player.has_crown ? "true" : "false")
        << ",\"connected\":" << (player.connected ? "true" : "false") << ",\"played\":";
    write_json_strings(out, player.played);
    out << ",\"chars\":"; write_json_strings(out, player.role_ids);
    out << ",\"hand\":[";
    for (size_t j = 0; j < player.hand.size(); ++j) { if (j) out << ','; write_native_card(out, player.hand[j]); }
    out << "],\"city\":[";
    for (size_t j = 0; j < player.city.size(); ++j) {
      if (j) out << ',';
      write_native_card(out, player.city[j].card, &player.city[j]);
    }
    out << "]}";
  }
  out << "],\"deck\":[";
  const auto& deck = state.deck.deck_cards();
  const auto& discard = state.deck.discard_cards();
  for (size_t i = 0; i < deck.size(); ++i) { if (i) out << ','; write_native_card(out, deck[i]); }
  out << "],\"discard\":[";
  for (size_t i = 0; i < discard.size(); ++i) { if (i) out << ','; write_native_card(out, discard[i]); }
  out << "],\"charDeck\":"; write_json_strings(out, state.char_deck);
  out << ",\"callQueue\":[";
  for (size_t i = 0; i < state.call_queue.size(); ++i) {
    if (i) out << ',';
    const auto& entry = state.call_queue[i];
    out << "{\"charId\":"; write_json_string(out, entry.char_id);
    out << ",\"num\":" << entry.number << ",\"playerIdx\":" << entry.player << '}';
  }
  out << "],\"observations\":[";
  for (size_t i = 0; i < state.observations.size(); ++i) {
    if (i) out << ',';
    const auto& observation = state.observations[i];
    if (!observation.valid) { out << "null"; continue; }
    out << "{\"round\":" << observation.round << ",\"gold\":" << observation.gold
        << ",\"handSize\":" << observation.hand_size << ",\"freeColors\":";
    write_json_strings(out, observation.free_colors); out << '}';
  }
  out << "],\"draft\":";
  if (state.phase != NativePhase::Draft) out << "null";
  else {
    out << "{\"stepIdx\":" << state.draft_step << ",\"totalSteps\":" << state.draft_total_steps
        << ",\"currentPlayer\":";
    if (state.draft_current_player >= 0 && state.draft_current_player < static_cast<int>(state.players.size()))
      write_json_string(out, state.players[state.draft_current_player].id);
    else out << "null";
    out << ",\"sub\":"; write_json_string(out, state.draft_sub);
    out << ",\"pool\":"; write_json_strings(out, state.draft_pool);
    out << ",\"faceUp\":"; write_json_strings(out, state.draft_face_up);
    out << ",\"faceDown\":"; write_json_strings(out, state.draft_face_down);
    out << ",\"steps\":[";
    for (size_t i = 0; i < state.draft_steps.size(); ++i) {
      if (i) out << ',';
      const auto& step = state.draft_steps[i];
      out << "{\"player\":" << step.player << ",\"keep\":" << step.keep
          << ",\"discard\":" << step.discard << ",\"fromFaceDown\":"
          << (step.from_face_down ? "true" : "false") << '}';
    }
    out << "]}";
  }
  // Face-up removals remain public and affect later role-target choices
  // (e.g. the Magistrate), even after the draft UI is no longer active.
  out << ",\"draftPublic\":{\"faceUp\":";
  write_json_strings(out, state.draft_face_up);
  out << '}';
  out << ",\"turn\":";
  if (!state.has_turn || state.active_player < 0 || state.active_player >= static_cast<int>(state.players.size())) out << "null";
  else {
    const auto& player = state.players[state.active_player];
    const int number = role_number(player.role_id);
    out << "{\"charId\":"; write_json_string(out, player.role_id);
    out << ",\"num\":" << number << ",\"playerIdx\":" << state.active_player
        << ",\"phase\":"; write_json_string(out, state.turn_phase);
    out << ",\"takenResources\":" << (state.resources_taken ? "true" : "false")
        << ",\"incomeTaken\":" << (state.income_taken ? "true" : "false")
        << ",\"monkExtraTaken\":" << (state.monk_extra_taken ? "true" : "false")
        << ",\"abilityUsed\":" << (state.ability_used ? "true" : "false")
        << ",\"buildLimit\":"
        << (state.turn_phase == "witch_resume" ? 1 :
            player.role_id == "architect" ? 3 :
            (player.role_id == "prophet" || player.role_id == "scholar") ? 2 :
            player.role_id == "navigator" ? 0 : 1)
        << ",\"builds\":" << state.builds << ",\"spentOnBuild\":" << state.spent_on_build
        << ",\"usedLab\":" << (state.used_lab ? "true" : "false")
        << ",\"usedSmithy\":" << (state.used_smithy ? "true" : "false")
        << ",\"usedMuseum\":" << (state.used_museum ? "true" : "false")
        << ",\"bonusDone\":" << (state.bonus_done ? "true" : "false") << ",\"pending\":";
    if (state.pending_kind.empty()) out << "null";
    else {
      out << "{\"kind\":"; write_json_string(out, state.pending_kind);
      if (state.pending_target >= 0) out << ",\"targetIdx\":" << state.pending_target;
      if (state.pending_amount) out << ",\"amount\":" << state.pending_amount;
      if (state.pending_from_crown >= 0) out << ",\"_fromCrownIdx\":" << state.pending_from_crown;
      if (!state.pending_uid.empty()) out << ",\"uid\":" , write_json_string(out, state.pending_uid);
      if (state.pending_first >= 0) out << ",\"first\":" << state.pending_first;
      if (state.pending_signed >= 0) out << ",\"signed\":" << state.pending_signed;
      if (!state.pending_nums.empty()) {
        out << ",\"nums\":[";
        for (size_t i = 0; i < state.pending_nums.size(); ++i) { if (i) out << ','; out << state.pending_nums[i]; }
        out << ']';
      }
      if (!state.pending_selected.empty()) { out << ",\"selected\":"; write_json_strings(out, state.pending_selected); }
      if (state.pending_cursor) out << ",\"cursor\":" << state.pending_cursor;
      if (!state.pending_queue.empty()) {
        out << ",\"queue\":[";
        for (size_t i = 0; i < state.pending_queue.size(); ++i) { if (i) out << ','; out << state.pending_queue[i]; }
        out << ']';
      }
      if (state.pending_kind == "wizard_choice" && state.pending_target >= 0 &&
          state.pending_target < static_cast<int>(state.players.size())) {
        const auto& hand = state.players[state.pending_target].hand;
        const auto chosen = std::find_if(hand.begin(), hand.end(),
          [&](const DistrictCard& card) { return card.uid == state.pending_uid; });
        if (chosen != hand.end()) { out << ",\"card\":"; write_native_card(out, *chosen); }
      } else if (!state.pending_cards.empty()) {
        out << ",\"cards\":[";
        for (size_t i = 0; i < state.pending_cards.size(); ++i) { if (i) out << ','; write_native_card(out, state.pending_cards[i]); }
        out << ']';
      }
      out << '}';
    }
    out << '}';
  }
  out << ",\"reaction\":";
  if (state.reaction_kind.empty()) out << "null";
  else {
    out << "{\"kind\":"; write_json_string(out, state.reaction_kind);
    out << ",\"playerIdx\":" << state.reaction_player << ",\"targetIdx\":" << state.reaction_target
        << ",\"num\":" << state.reaction_num << ",\"prompt\":";
    write_json_string(out, state.reaction_kind == "graveyard" ? "是否支付 1 金将建筑收入手牌？" : "请选择是否发动响应效果");
    out << ",\"queue\":[";
    for (size_t i = 0; i < state.reaction_queue.size(); ++i) { if (i) out << ','; out << state.reaction_queue[i]; }
    out << ']';
    if (state.has_reaction_card) { out << ",\"card\":"; write_native_card(out, state.reaction_card); }
    out << '}';
  }
  out << ",\"pendingDestroy\":";
  if (state.has_reaction_card && state.reaction_kind == "graveyard") { out << "{\"card\":"; write_native_card(out, state.reaction_card); out << '}'; }
  else out << "null";
  out << ",\"roundConfirm\":";
  if (state.phase != NativePhase::RoundConfirm) out << "null";
  else {
    out << "{\"round\":" << state.round << ",\"confirmed\":[";
    for (size_t i = 0; i < state.round_confirmed.size(); ++i) { if (i) out << ','; out << (state.round_confirmed[i] ? "true" : "false"); }
    out << "]}";
  }
  out << ",\"effects\":{\"assassinated\":";
  if (state.assassinated < 0) out << "null"; else out << state.assassinated;
  out << ",\"thief\":"; if (state.thief_target < 0) out << "null"; else out << state.thief_target;
  out << ",\"thiefBy\":"; if (state.thief_player < 0) out << "null"; else out << state.thief_player;
  out << ",\"bewitched\":"; if (state.bewitched < 0) out << "null"; else out << state.bewitched;
  out << ",\"witchBy\":"; if (state.witch_player < 0) out << "null"; else out << state.witch_player;
  out << ",\"taxCollectorGold\":" << state.tax_collector_gold << ",\"magistrate\":";
  if (state.magistrate_player < 0) out << "null";
  else {
    out << "{\"nums\":[";
    for (size_t i = 0; i < state.magistrate_nums.size(); ++i) { if (i) out << ','; out << state.magistrate_nums[i]; }
    out << "],\"signed\":" << state.magistrate_signed << ",\"playerIdx\":" << state.magistrate_player
        << ",\"claimed\":" << (state.magistrate_claimed ? "true" : "false") << '}';
  }
  out << ",\"blackmailer\":";
  if (state.blackmailer_player < 0) out << "null";
  else {
    out << "{\"nums\":[";
    for (size_t i = 0; i < state.blackmailer_nums.size(); ++i) { if (i) out << ','; out << state.blackmailer_nums[i]; }
    out << "],\"signed\":" << state.blackmailer_signed << ",\"playerIdx\":" << state.blackmailer_player
        << ",\"done\":[";
    for (size_t i = 0; i < state.blackmailer_done.size(); ++i) { if (i) out << ','; out << state.blackmailer_done[i]; }
    out << "],\"revealed\":[";
    for (size_t i = 0; i < state.blackmailer_revealed_real.size(); ++i) {
      if (i) out << ',';
      out << "{\"num\":" << state.blackmailer_revealed_real[i] << ",\"isReal\":true}";
    }
    out << "]}";
  }
  out << "},\"scores\":[";
  std::vector<int> totals(state.players.size(), 0);
  for (size_t player = 0; player < state.players.size(); ++player) {
    const auto& value = state.players[player];
    int base = 0, museum = 0, beautified = 0, ghosts = 0;
    std::array<bool, 5> colors{};
    for (const auto& district : value.city) {
      base += district.card.score_as > 0 ? district.card.score_as :
        district.card.score_value > 0 ? district.card.score_value : district.card.cost;
      if (district.card.color == "yellow") colors[0] = true;
      else if (district.card.color == "blue") colors[1] = true;
      else if (district.card.color == "green") colors[2] = true;
      else if (district.card.color == "red") colors[3] = true;
      else if (district.card.color == "purple") colors[4] = true;
      museum += static_cast<int>(district.museum_cards.size());
      beautified += district.beautified ? 1 : 0;
      ghosts += district.effect == "anyColorScore" && district.built_round != state.round ? 1 : 0;
    }
    int bonus = museum + beautified;
    const int missing = static_cast<int>(std::count(colors.begin(), colors.end(), false));
    if (missing == 0 || (missing > 0 && missing <= ghosts)) bonus += 3;
    if (state.first_to_finish == static_cast<int>(player)) bonus += 4;
    else if (value.city.size() >= static_cast<size_t>(state.end_districts)) bonus += 2;
    totals[player] = base + bonus;
    if (player) out << ',';
    out << "{\"playerIdx\":" << player << ",\"name\":"; write_json_string(out, value.name);
    out << ",\"base\":" << base << ",\"bonus\":" << bonus << ",\"total\":" << totals[player]
        << ",\"cityCount\":" << value.city.size() << ",\"detail\":[{\"label\":\"建筑总分\",\"value\":" << base << '}';
    if (museum) out << ", {\"label\":\"博物馆\",\"value\":" << museum << '}';
    if (beautified) out << ", {\"label\":\"美化\",\"value\":" << beautified << '}';
    if (missing == 0 || (missing > 0 && missing <= ghosts))
      out << ", {\"label\":\"五色齐全\",\"value\":3}";
    if (state.first_to_finish == static_cast<int>(player))
      out << ", {\"label\":\"率先建成 " << state.end_districts << " 栋\",\"value\":4}";
    else if (value.city.size() >= static_cast<size_t>(state.end_districts))
      out << ", {\"label\":\"建成 " << state.end_districts << " 栋\",\"value\":2}";
    out << "]}";
  }
  out << "],\"winner\":";
  if (totals.empty()) out << "null";
  else {
    const int best = *std::max_element(totals.begin(), totals.end());
    const auto winners = std::count(totals.begin(), totals.end(), best);
    if (winners != 1) out << "null";
    else out << std::distance(totals.begin(), std::find(totals.begin(), totals.end(), best));
  }
  out << '}';
}

}  // namespace citadels::native
