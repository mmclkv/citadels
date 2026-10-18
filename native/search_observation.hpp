#pragma once

#include "game_state.hpp"
#include "mcts_core.hpp"

namespace citadels::native {

// Team play may be supplied by a separate rules change. This fix must also
// compile against rule states which do not yet have that optional mode.
template <typename State>
auto search_public_team_mode(const State& state, int) -> decltype(state.team_mode, bool()) {
  return state.team_mode;
}
template <typename State>
bool search_public_team_mode(const State&, ...) { return false; }

// Exact identities where visible, shared public work once per transition.
// Do not hash the RNG, deck order, hidden discard identities, uncalled queue,
// another player's hand/roles, or the order of private signed declarations.
inline std::vector<InformationSetKey> native_search_observations(const NativeGameState& s) {
  InformationSetKeyBuilder pub;
  const auto strings = [](auto& b, const auto& values) {
    b.u64(values.size()); for (const auto& v : values) b.string(v);
  };
  const auto ints = [](auto& b, const auto& values) {
    b.u64(values.size()); for (auto v : values) b.i32(v);
  };
  const auto card = [](auto& b, const auto& c) {
    b.string(c.uid); b.string(c.name); b.string(c.color); b.i32(c.cost);
  };
  pub.i32(static_cast<int>(s.phase)); pub.i32(s.active_player); pub.boolean(s.has_turn);
  pub.string(s.turn_phase); pub.i32(s.round); pub.i32(s.turns_completed);
  pub.i32(s.call_index); pub.i32(s.end_districts); pub.boolean(search_public_team_mode(s, 0));
  pub.i32(s.first_to_finish); ints(pub, s.first_finishers); strings(pub, s.enabled_bell_towers);
  pub.i32(s.builds); pub.i32(s.spent_on_build); pub.boolean(s.resources_taken);
  pub.boolean(s.income_taken); pub.boolean(s.ability_used); pub.boolean(s.bonus_done);
  pub.boolean(s.monk_extra_taken); pub.boolean(s.used_lab); pub.boolean(s.used_smithy); pub.boolean(s.used_museum);
  pub.u64(s.deck.deck_count()); pub.u64(s.deck.discard_count());
  pub.i32(s.draft_step); pub.i32(s.draft_current_player); pub.string(s.draft_sub);
  pub.i32(s.draft_total_steps); strings(pub, s.draft_face_up);
  auto roster = s.char_deck; std::sort(roster.begin(), roster.end()); strings(pub, roster);
  pub.i32(s.round_confirm_count); for (bool v : s.round_confirmed) pub.boolean(v);
  pub.string(s.reaction_kind); pub.i32(s.reaction_player);
  pub.i32(s.reaction_target); pub.i32(s.reaction_num); pub.boolean(s.reaction_build);
  // The announced construction is public during a Magistrate reaction.
  if (s.reaction_kind == "magistrate") pub.string(s.reaction_uid);
  pub.i32(s.assassinated); pub.i32(s.thief_target); pub.i32(s.thief_player);
  pub.i32(s.bewitched); pub.i32(s.witch_player); pub.i32(s.tax_collector_gold);
  pub.i32(s.magistrate_player); pub.boolean(s.magistrate_claimed);
  auto warrants = s.magistrate_nums; std::sort(warrants.begin(), warrants.end()); ints(pub, warrants);
  pub.i32(s.blackmailer_player);
  auto threats = s.blackmailer_nums; std::sort(threats.begin(), threats.end()); ints(pub, threats);
  ints(pub, s.blackmailer_done); ints(pub, s.blackmailer_revealed_real);
  pub.u64(s.players.size());
  for (size_t i = 0; i < s.players.size(); ++i) {
    const auto& p = s.players[i];
    pub.string(p.id); pub.i32(p.gold); pub.boolean(p.has_crown);
    pub.u64(p.hand.size()); pub.u64(p.role_ids.size()); strings(pub, p.played);
    if (s.has_turn && static_cast<int>(i) == s.active_player && s.turn_phase != "setup") pub.string(p.role_id);
    pub.u64(p.city.size());
    for (const auto& d : p.city) {
      card(pub, d.card); pub.string(d.effect); pub.boolean(d.beautified);
      pub.i32(d.built_round); pub.u64(d.museum_cards.size());
    }
  }
  const auto common = pub.finish();
  std::vector<InformationSetKey> result;
  for (size_t viewer = 0; viewer < s.players.size(); ++viewer) {
    InformationSetKeyBuilder b; b.u64(common.lo); b.u64(common.hi); b.i32(static_cast<int>(viewer));
    const auto& own = s.players[viewer];
    b.string(own.role_id); strings(b, own.role_ids);
    for (const auto& c : own.hand) card(b, c);
    for (const auto& d : own.city) for (const auto& c : d.museum_cards) card(b, c);
    if (s.magistrate_player == static_cast<int>(viewer)) b.i32(s.magistrate_signed);
    if (s.blackmailer_player == static_cast<int>(viewer)) b.i32(s.blackmailer_signed);
    if (s.phase == NativePhase::Draft && s.draft_current_player == static_cast<int>(viewer) &&
        s.draft_step >= 0 && s.draft_step < static_cast<int>(s.draft_steps.size()) &&
        !(s.draft_steps[s.draft_step].from_face_down && s.draft_sub == "pick")) strings(b, s.draft_pool);
    const int owner = s.pending_kind == "lighthouse" ? s.pending_target : s.active_player;
    if (owner == static_cast<int>(viewer) && !s.pending_kind.empty()) {
      b.string(s.pending_kind); b.i32(s.pending_target); b.i32(s.pending_amount);
      b.i32(s.pending_signed); ints(b, s.pending_nums);
      b.string(s.pending_uid); b.i32(s.pending_cursor); strings(b, s.pending_selected);
      for (const auto& c : s.pending_cards) card(b, c);
    }
    if (s.active_player == static_cast<int>(viewer)) {
      b.string(s.building_mode); b.string(s.building_source); strings(b, s.building_cards);
    }
    if (s.active_player == static_cast<int>(viewer) &&
        (s.pending_kind == "wizard_card" || s.pending_kind == "wizard_choice") &&
        s.pending_target >= 0 && s.pending_target < static_cast<int>(s.players.size()))
      for (const auto& c : s.players[s.pending_target].hand) card(b, c);
    result.push_back(b.finish());
  }
  return result;
}

}  // namespace citadels::native
