#pragma once

#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include "game_adapter.hpp"
#include "cfr_digest.hpp"

namespace citadels::native {

// Independent of neural features and MCTS determinization. Length framing
// makes keys unambiguous even for localized names containing punctuation.
struct CfrKey {
  std::string value;
  void text(const std::string& s) { value += std::to_string(s.size()) + ":" + s; }
  void number(int n) { text(std::to_string(n)); }
  void list(std::vector<std::string> items, bool ordered = false) {
    if (!ordered) std::sort(items.begin(), items.end());
    number(static_cast<int>(items.size()));
    for (const auto& s : items) text(s);
  }
};

inline std::string cfr_card_key(const DistrictCard& c) {
  CfrKey k;
  k.text(c.en.empty() ? c.name : c.en); k.text(c.color);
  k.number(c.cost); k.number(c.score_value); k.number(c.score_as);
  k.text(c.purple_effect);
  return k.value;
}
inline std::vector<std::string> cfr_cards(const std::vector<DistrictCard>& cards) {
  std::vector<std::string> result;
  for (const auto& c : cards) result.push_back(cfr_card_key(c));
  return result;
}
inline std::string cfr_district_key(const NativeDistrict& d) {
  CfrKey k; k.text(cfr_card_key(d.card)); k.text(d.name); k.text(d.effect);
  k.number(d.beautified); k.number(d.fortress); k.number(d.built_round);
  // Museum contents are face down: only their number is public.
  k.number(static_cast<int>(d.museum_cards.size()));
  return k.value;
}
inline int cfr_relative(const NativeGameState& s, int me, int seat) {
  return seat < 0 ? -1 : (seat - me + static_cast<int>(s.players.size())) %
      static_cast<int>(s.players.size());
}
inline std::string cfr_role_number(const NativeGameState& s, int number) {
  for (const auto& id : s.char_deck) if (role_number(id) == number) return id;
  return "number:" + std::to_string(number);
}
inline std::vector<std::string> cfr_numbers(const NativeGameState& s,
                                          const std::vector<int>& numbers) {
  std::vector<std::string> result;
  for (int n : numbers) result.push_back(cfr_role_number(s, n));
  return result;
}

// Resolve only observable card references. Never search arbitrary opponents'
// hands to encode an action. UID is transport identity, not strategy identity.
inline std::string cfr_card_reference(const NativeGameState& s, int me,
                                      const std::string& uid) {
  if (uid.empty()) return {};
  CfrKey key;
  for (const auto& c : s.players.at(me).hand) if (c.uid == uid) {
    key.text("hand"); key.text(cfr_card_key(c)); return key.value;
  }
  for (size_t i = 0; i < s.players.size(); ++i)
    for (const auto& d : s.players[i].city) if (d.card.uid == uid) {
      key.text("city"); key.number(cfr_relative(s, me, static_cast<int>(i)));
      key.text(cfr_district_key(d)); return key.value;
    }
  if (me == s.active_player) {
    for (const auto& c : s.pending_cards) if (c.uid == uid) {
      key.text("pending"); key.text(cfr_card_key(c)); return key.value;
    }
  }
  if (s.has_reaction_card && s.reaction_card.uid == uid && me == s.reaction_player) {
    key.text("reaction"); key.text(cfr_card_key(s.reaction_card)); return key.value;
  }
  throw std::runtime_error("CFR action refers to an unobservable card");
}

inline std::string cfr_action_key(const NativeGameState& s, int me,
                                  const NativeSearchAction& a) {
  CfrKey k; k.text(std::string(action_type_name(a.type)));
  k.text(cfr_card_reference(s, me, a.uid));
  k.text(cfr_card_reference(s, me, a.secondary_uid));
  std::vector<std::string> selected;
  for (const auto& uid : a.selected_uids) selected.push_back(cfr_card_reference(s, me, uid));
  k.list(std::move(selected));
  if (!a.target.empty()) {
    const int target = s.find_player(a.target);
    if (target < 0) throw std::runtime_error("CFR action has an unknown target");
    k.number(cfr_relative(s, me, target));
  } else k.number(-1);
  const bool role = a.type == ActionType::ChooseChar || a.type == ActionType::MagistrateSigned ||
      a.type == ActionType::MagistrateChar || a.type == ActionType::BlackmailerSigned ||
      a.type == ActionType::BlackmailerChar;
  k.text(role && a.has_num ? cfr_role_number(s, a.num) : a.name);
  k.text(a.effect); k.text(a.mode); k.text(a.color);
  k.number(role ? -1 : a.num); k.number(a.gold); k.number(a.cards);
  k.number(a.use); k.number(a.has_num);
  return k.value;
}

struct CfrActionSet {
  std::vector<std::string> keys;
  std::vector<std::vector<size_t>> indices;
};
inline CfrActionSet cfr_action_set(const NativeGameState& s, int me,
                                  const std::vector<NativeSearchAction>& actions) {
  std::map<std::string, std::vector<size_t>> groups;
  for (size_t i = 0; i < actions.size(); ++i) groups[cfr_action_key(s, me, actions[i])].push_back(i);
  CfrActionSet result;
  for (auto& [key, indices] : groups) {
    result.keys.push_back(key); result.indices.push_back(std::move(indices));
  }
  return result;
}

inline std::string cfr_observation(const NativeGameState& s, int me) {
  if (me < 0 || me >= static_cast<int>(s.players.size()))
    throw std::runtime_error("Invalid CFR observer");
  CfrKey k; k.text("cfr-observation-v1"); k.number(static_cast<int>(s.players.size()));
  k.number(static_cast<int>(s.phase)); k.number(s.round); k.number(s.end_districts);
  k.number(cfr_relative(s, me, s.first_to_finish));
  k.number(cfr_relative(s, me, s.active_player)); k.number(s.has_turn);
  k.number(static_cast<int>(s.deck.deck_count())); k.number(static_cast<int>(s.deck.discard_count()));
  k.list(s.char_deck); k.list(s.draft_face_up);
  k.number(s.draft_step); k.number(s.draft_total_steps);
  k.number(cfr_relative(s, me, s.draft_current_player));
  k.text(s.turn_phase); k.number(s.turns_completed); k.number(s.builds); k.number(s.spent_on_build);
  for (bool b : {s.resources_taken, s.income_taken, s.monk_extra_taken, s.ability_used,
                s.used_lab, s.used_smithy, s.used_museum, s.bonus_done}) k.number(b);
  k.number(s.assassinated); k.number(s.thief_target); k.number(cfr_relative(s, me, s.thief_player));
  k.number(s.bewitched); k.number(cfr_relative(s, me, s.witch_player));
  k.number(s.tax_collector_gold); k.number(s.round_confirm_count);
  for (size_t rel = 0; rel < s.players.size(); ++rel) {
    const auto absolute = (me + rel) % s.players.size(); const auto& p = s.players[absolute];
    k.number(p.gold); k.number(static_cast<int>(p.hand.size())); k.number(p.has_crown);
    k.number(!p.role_ids.empty()); k.list(p.played);
    // A role is public only when called, never merely because role_id is set.
    k.text(s.has_turn && s.phase != NativePhase::Draft &&
           static_cast<int>(absolute) == s.active_player ? p.role_id : "");
    std::vector<std::string> city;
    for (const auto& d : p.city) city.push_back(cfr_district_key(d));
    k.list(std::move(city), true);
    const bool confirmed = absolute < s.round_confirmed.size() && s.round_confirmed[absolute];
    k.number(s.phase == NativePhase::RoundConfirm && confirmed);
  }
  k.list(cfr_cards(s.players[me].hand)); k.list(s.players[me].role_ids, true);
  k.list(cfr_numbers(s, s.magistrate_nums)); k.number(s.magistrate_claimed);
  k.list(cfr_numbers(s, s.blackmailer_nums)); k.list(cfr_numbers(s, s.blackmailer_done));
  k.list(cfr_numbers(s, s.blackmailer_revealed_real));
  k.number(cfr_relative(s, me, s.magistrate_player));
  k.number(cfr_relative(s, me, s.blackmailer_player));
  k.number(s.magistrate_player == me ? s.magistrate_signed : -1);
  k.number(s.blackmailer_player == me ? s.blackmailer_signed : -1);
  if (s.phase == NativePhase::Draft && me == s.draft_current_player) {
    k.text(s.draft_sub); k.list(s.draft_pool);
    if (s.draft_step >= 0 && s.draft_step < static_cast<int>(s.draft_steps.size()) &&
        s.draft_steps[s.draft_step].from_face_down && s.draft_sub == "pick") k.list(s.draft_face_down);
  }
  k.text(s.reaction_kind); k.number(cfr_relative(s, me, s.reaction_player));
  k.number(cfr_relative(s, me, s.reaction_target)); k.number(s.reaction_num); k.number(s.reaction_build);
  if (s.has_reaction_card) k.text(cfr_card_key(s.reaction_card));
  if (me == s.active_player) {
    k.text(s.pending_kind); k.number(cfr_relative(s, me, s.pending_target));
    k.number(s.pending_amount); k.number(cfr_relative(s, me, s.pending_from_crown));
    k.number(s.pending_first);
    // During blackmail pending_signed is a hidden flag, not the victim's knowledge.
    const bool declares_warrants = s.pending_kind == "magistrate_declare" ||
        s.pending_kind == "magistrate_second" || s.pending_kind == "magistrate_third";
    k.number(declares_warrants ? s.pending_signed : -1);
    k.list(cfr_numbers(s, s.pending_nums));
    k.list(cfr_cards(s.pending_cards)); k.number(s.pending_cursor);
    std::vector<std::string> selected;
    for (const auto& uid : s.pending_selected) selected.push_back(cfr_card_reference(s, me, uid));
    k.list(std::move(selected));
    k.text(cfr_card_reference(s, me, s.pending_uid));
    for (int player : s.pending_queue) k.number(cfr_relative(s, me, player));
    if (s.pending_kind == "magician_redraw") k.list(cfr_cards(s.players[me].hand), true);
  }
  return k.value;
}

// Full recall ledger represented by chained SHA-256 fingerprints (not a
// truncated recent-history window). Previously seen private observations
// continue to distinguish information sets after the effect has completed.
class CfrHistory {
 public:
  explicit CfrHistory(const NativeGameState& initial) : memories_(initial.players.size()), last_(initial.players.size()) {
    observe(initial);
  }
  void transition(const NativeGameState& before, int actor, const NativeSearchAction& action,
                  const NativeGameState& after) {
    CfrKey event; event.text("own-action"); event.text(cfr_action_key(before, actor, action));
    remember(actor, event.value);
    // Spy observes the target's hand BEFORE its cards/gold are resolved.
    if (action.type == ActionType::SpyColor && before.pending_target >= 0) {
      CfrKey seen; seen.text("spy-hand"); seen.number(before.round);
      seen.number(cfr_relative(before, actor, before.pending_target));
      seen.list(cfr_cards(before.players.at(before.pending_target).hand));
      remember(actor, seen.value);
    }
    observe(after);
  }
  std::string information(const NativeGameState& s, int me) const {
    CfrKey k; k.text("cfr-info-v1-recall"); k.text(memories_.at(me));
    k.text(cfr_observation(s, me)); return k.value;
  }
 private:
  void observe(const NativeGameState& s) {
    if (s.players.size() != memories_.size()) throw std::runtime_error("CFR seat count changed");
    for (size_t p = 0; p < s.players.size(); ++p) {
      auto observation = cfr_observation(s, static_cast<int>(p));
      if (observation != last_[p]) { remember(p, observation); last_[p] = std::move(observation); }
    }
  }
  void remember(size_t player, const std::string& event) {
    CfrKey k; k.text(memories_.at(player)); k.text(event); memories_[player] = cfr_digest(k.value);
  }
  std::vector<std::string> memories_;
  std::vector<std::string> last_;
};

}  // namespace citadels::native
