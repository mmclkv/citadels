#pragma once

#include <algorithm>
#include <string>
#include <vector>

#include "action_codec.hpp"
#include "build_rules.hpp"
#include "city_machine.hpp"
#include "deck_machine.hpp"
#include "emperor_machine.hpp"
#include "military_machine.hpp"
#include "resource_rules.hpp"
#include "special_buildings.hpp"
#include "turn_machine.hpp"

namespace citadels::native {

enum class NativePhase { Lobby, Draft, Action, Reaction, RoundConfirm, GameOver, Unknown };

struct NativeDistrict {
  DistrictCard card;
  std::string name;
  std::string effect;
  std::vector<DistrictCard> museum_cards;
  bool fortress = false;
  bool beautified = false;
};

struct NativePlayer {
  std::string id;
  std::string role_id;
  int gold = 2;
  std::vector<DistrictCard> hand;
  std::vector<NativeDistrict> city;
  bool has_crown = false;
  std::vector<std::string> role_ids;
};

struct NativeDraftStep {
  int player = -1;
  int keep = 1;
  int discard = 0;
  bool from_face_down = false;
};

struct NativeGameState {
  NativePhase phase = NativePhase::Unknown;
  std::vector<NativePlayer> players;
  DeckMachine deck;
  JsRng rng;
  int active_player = -1;
  int round = 1;
  int turns_completed = 0;
  int end_districts = 8;
  int builds = 0;
  int spent_on_build = 0;
  bool resources_taken = false;
  bool income_taken = false;
  bool monk_extra_taken = false;
  bool ability_used = false;
  bool used_lab = false;
  bool used_smithy = false;
  bool used_museum = false;
  bool bonus_done = false;
  int draft_step = -1;
  int draft_total_steps = 0;
  int draft_current_player = -1;
  std::string draft_sub;
  std::vector<std::string> draft_pool;
  std::vector<std::string> draft_face_up;
  std::vector<std::string> draft_face_down;
  std::vector<NativeDraftStep> draft_steps;
  int reaction_player = -1;
  std::string reaction_kind;
  std::vector<int> reaction_queue;
  DistrictCard reaction_card;
  bool has_reaction_card = false;
  int round_confirm_count = 0;
  std::vector<bool> round_confirmed;
  std::string pending_kind;
  std::vector<std::string> char_deck;
  int assassinated = -1;
  int thief_target = -1;
  int bewitched = -1;
  int witch_player = -1;
  int pending_target = -1;
  int pending_from_crown = -1;
  std::string pending_uid;
  std::vector<DistrictCard> pending_cards;
  std::vector<std::string> pending_selected;
  std::vector<int> pending_queue;

  bool draft_remove(const std::string& id) {
    auto remove = [&](std::vector<std::string>& values) {
      const auto it = std::find(values.begin(), values.end(), id);
      if (it == values.end()) return false;
      values.erase(it); return true;
    };
    return remove(draft_pool) || remove(draft_face_down);
  }

  bool advance_draft() {
    if (draft_step < 0 || draft_step >= static_cast<int>(draft_steps.size())) return false;
    const auto& step = draft_steps[draft_step];
    if (step.discard > 0 && draft_sub == "pick") { draft_sub = "discard"; return true; }
    ++draft_step; draft_sub = "pick";
    if (draft_step >= static_cast<int>(draft_steps.size())) {
      phase = NativePhase::Action;
      active_player = 0;
    } else draft_current_player = draft_steps[draft_step].player;
    return true;
  }

  NativePlayer* active() {
    if (active_player < 0 || active_player >= static_cast<int>(players.size())) return nullptr;
    return &players[active_player];
  }

  bool transfer_crown(int target) {
    if (!active() || target < 0 || target >= static_cast<int>(players.size()) || target == active_player) return false;
    for (auto& player : players) player.has_crown = false;
    players[target].has_crown = true;
    pending_target = target;
    pending_from_crown = active_player;
    return true;
  }

  bool emperor_take_gold() {
    if (!active() || pending_target < 0 || pending_target >= static_cast<int>(players.size())) return false;
    return ::citadels::native::emperor_take_gold(active()->gold, players[pending_target].gold) > 0;
  }

  bool emperor_take_card() {
    if (!active() || pending_target < 0 || pending_target >= static_cast<int>(players.size())) return false;
    return ::citadels::native::emperor_take_card(active()->hand, players[pending_target].hand, rng);
  }

  bool diplomat_swap(const std::string& target_id, const std::string& target_uid) {
    if (!active() || pending_uid.empty()) return false;
    int target = -1;
    for (size_t i = 0; i < players.size(); ++i)
      if (players[i].id == target_id) target = static_cast<int>(i);
    if (target < 0 || target == active_player || players[target].city.size() >= static_cast<size_t>(end_districts)) return false;
    auto own_it = std::find_if(active()->city.begin(), active()->city.end(), [&](const NativeDistrict& d) { return d.card.uid == pending_uid; });
    auto their_it = std::find_if(players[target].city.begin(), players[target].city.end(), [&](const NativeDistrict& d) { return d.card.uid == target_uid; });
    if (own_it == active()->city.end() || their_it == players[target].city.end() || own_it->fortress || their_it->fortress) return false;
    if (std::any_of(active()->city.begin(), active()->city.end(), [&](const NativeDistrict& d) {
      return d.name == their_it->name && d.card.uid != pending_uid;
    })) return false;
    const int difference = std::max(0, their_it->card.cost - own_it->card.cost);
    if (difference > active()->gold) return false;
    active()->gold -= difference; players[target].gold += difference;
    NativeDistrict own = std::move(*own_it);
    NativeDistrict theirs = std::move(*their_it);
    active()->city.erase(own_it);
    players[target].city.erase(their_it);
    active()->city.push_back(std::move(theirs));
    players[target].city.push_back(std::move(own));
    pending_uid.clear(); pending_target = -1; pending_kind.clear();
    return true;
  }

  int find_player(const std::string& id) const {
    for (size_t i = 0; i < players.size(); ++i) if (players[i].id == id) return static_cast<int>(i);
    return -1;
  }

  bool warlord_destroy(const std::string& target_id, const std::string& uid) {
    if (!active()) return false;
    const int target = find_player(target_id);
    if (target < 0 || players[target].city.size() >= static_cast<size_t>(end_districts) ||
        (target != active_player && players[target].role_id == "bishop")) return false;
    auto it = std::find_if(players[target].city.begin(), players[target].city.end(),
      [&](const NativeDistrict& d) { return d.card.uid == uid; });
    if (it == players[target].city.end() || it->fortress) return false;
    MilitaryCard card{it->name, it->card.cost, it->fortress, it->beautified};
    const int cost = destroy_cost(card, false);
    if (active()->gold < cost) return false;
    active()->gold -= cost;
    DistrictCard destroyed = it->card;
    players[target].city.erase(it);
    reaction_card = destroyed; has_reaction_card = true;
    reaction_queue.clear();
    for (size_t i = 0; i < players.size(); ++i)
      if (static_cast<int>(i) != active_player && players[i].gold >= 1 &&
          std::any_of(players[i].city.begin(), players[i].city.end(), [](const NativeDistrict& d) { return d.effect == "graveyard"; }))
        reaction_queue.push_back(static_cast<int>(i));
    if (reaction_queue.empty()) { deck.discard({destroyed}); has_reaction_card = false; }
    else { reaction_player = reaction_queue.front(); reaction_kind = "graveyard"; }
    pending_kind.clear();
    return true;
  }

  bool marshal_seize(const std::string& target_id, const std::string& uid) {
    if (!active()) return false;
    const int target = find_player(target_id);
    if (target < 0 || target == active_player || players[target].city.size() >= static_cast<size_t>(end_districts)) return false;
    auto it = std::find_if(players[target].city.begin(), players[target].city.end(),
      [&](const NativeDistrict& d) { return d.card.uid == uid; });
    if (it == players[target].city.end() || it->fortress || it->card.cost > 3 || active()->gold < it->card.cost) return false;
    if (std::count_if(active()->city.begin(), active()->city.end(), [&](const NativeDistrict& d) { return d.name == it->name; }) > 0) return false;
    const int cost = it->card.cost;
    active()->gold -= cost; players[target].gold += cost;
    NativeDistrict seized = std::move(*it);
    players[target].city.erase(it); active()->city.push_back(std::move(seized));
    pending_kind.clear();
    return true;
  }

  bool reaction(bool use) {
    if (reaction_kind != "graveyard" || !has_reaction_card || reaction_player < 0 || reaction_player >= static_cast<int>(players.size())) return false;
    auto& responder = players[reaction_player];
    if (use) {
      if (responder.gold < 1) return false;
      --responder.gold; responder.hand.push_back(reaction_card);
      reaction_queue.clear(); reaction_kind.clear(); reaction_player = -1; has_reaction_card = false;
      return true;
    }
    if (!reaction_queue.empty() && reaction_queue.front() == reaction_player) reaction_queue.erase(reaction_queue.begin());
    if (!reaction_queue.empty()) { reaction_player = reaction_queue.front(); return true; }
    deck.discard({reaction_card});
    reaction_kind.clear(); reaction_player = -1; has_reaction_card = false;
    return true;
  }

  bool navigator_bonus(const std::string& mode) {
    if (!active() || bonus_done || (mode != "gold" && mode != "cards")) return false;
    if (mode == "gold") active()->gold += 4;
    else {
      auto cards = deck.draw(4, rng);
      active()->hand.insert(active()->hand.end(), std::make_move_iterator(cards.begin()), std::make_move_iterator(cards.end()));
    }
    bonus_done = true; pending_kind.clear(); return true;
  }

  bool monk_resource(int gold, int cards) {
    if (!active() || gold < 0 || cards < 0 || gold + cards != static_cast<int>(
      std::count_if(active()->city.begin(), active()->city.end(), [](const NativeDistrict& d) { return d.card.color == "blue"; }))) return false;
    active()->gold += gold;
    auto drawn = deck.draw(cards, rng);
    active()->hand.insert(active()->hand.end(), std::make_move_iterator(drawn.begin()), std::make_move_iterator(drawn.end()));
    pending_kind.clear(); return true;
  }

  bool keep_pending_card(const std::string& uid) {
    if (!active() || pending_cards.empty()) return false;
    auto it = std::find_if(pending_cards.begin(), pending_cards.end(), [&](const DistrictCard& card) { return card.uid == uid; });
    if (it == pending_cards.end()) return false;
    DistrictCard chosen = *it;
    std::vector<DistrictCard> rest;
    for (const auto& card : pending_cards) if (card.uid != uid) rest.push_back(card);
    active()->hand.push_back(std::move(chosen));
    const bool draw_keep = pending_kind == "draw_keep";
    if (draw_keep) deck.put_bottom(std::move(rest));
    else deck.return_and_shuffle(std::move(rest), rng);
    if (active()->role_id == "architect" && !bonus_done) {
      auto bonus = deck.draw(2, rng);
      active()->hand.insert(active()->hand.end(), std::make_move_iterator(bonus.begin()), std::make_move_iterator(bonus.end()));
      bonus_done = true;
    }
    pending_cards.clear(); pending_kind.clear();
    if (!draw_keep) ability_used = true;
    after_resources();
    return true;
  }

  bool magician_redraw(const std::vector<std::string>& uids) {
    if (!active() || pending_kind != "magician_redraw" || uids.size() > active()->hand.size()) return false;
    std::vector<DistrictCard> discarded;
    for (const auto& uid : uids) {
      auto it = std::find_if(active()->hand.begin(), active()->hand.end(), [&](const DistrictCard& card) { return card.uid == uid; });
      if (it == active()->hand.end()) return false;
      discarded.push_back(*it); active()->hand.erase(it);
    }
    deck.put_bottom(std::move(discarded));
    auto drawn = deck.draw(static_cast<int>(uids.size()), rng);
    active()->hand.insert(active()->hand.end(), std::make_move_iterator(drawn.begin()), std::make_move_iterator(drawn.end()));
    pending_kind.clear(); return drawn.size() == uids.size();
  }

  bool artist_select(const std::string& uid) {
    if (!active() || pending_kind != "artist" || pending_selected.size() >= 2 ||
        std::find(pending_selected.begin(), pending_selected.end(), uid) != pending_selected.end()) return false;
    auto it = std::find_if(active()->city.begin(), active()->city.end(), [&](const NativeDistrict& d) { return d.card.uid == uid && !d.beautified; });
    if (it == active()->city.end() || active()->gold <= static_cast<int>(pending_selected.size())) return false;
    pending_selected.push_back(uid); return true;
  }

  bool artist_done(const std::vector<std::string>& uids) {
    if (!active() || pending_kind != "artist" || uids.size() > 2 || uids != pending_selected || active()->gold < static_cast<int>(uids.size())) return false;
    for (const auto& uid : uids) {
      auto it = std::find_if(active()->city.begin(), active()->city.end(), [&](const NativeDistrict& d) { return d.card.uid == uid && !d.beautified; });
      if (it == active()->city.end()) return false;
    }
    for (const auto& uid : uids) for (auto& district : active()->city) if (district.card.uid == uid) { district.beautified = true; --active()->gold; }
    pending_selected.clear(); pending_kind.clear(); return true;
  }

  bool prophet_collect() {
    auto* p = active();
    if (!p) return false;
    pending_queue.clear();
    for (size_t i = 0; i < players.size(); ++i) {
      if (static_cast<int>(i) == active_player || players[i].hand.empty()) continue;
      const size_t index = static_cast<size_t>(rng.next() * players[i].hand.size());
      p->hand.push_back(std::move(players[i].hand[index]));
      players[i].hand.erase(players[i].hand.begin() + static_cast<std::ptrdiff_t>(index));
      pending_queue.push_back(static_cast<int>(i));
    }
    if (pending_queue.empty()) { pending_kind.clear(); return true; }
    pending_kind = "prophet_give";
    pending_target = pending_queue.front();
    return true;
  }

  bool prophet_give(const std::string& uid) {
    auto* p = active();
    if (!p || pending_kind != "prophet_give" || pending_queue.empty() ||
        pending_queue.front() != pending_target || pending_target < 0 ||
        pending_target >= static_cast<int>(players.size())) return false;
    auto it = std::find_if(p->hand.begin(), p->hand.end(),
      [&](const DistrictCard& card) { return card.uid == uid; });
    if (it == p->hand.end()) return false;
    players[pending_target].hand.push_back(std::move(*it));
    p->hand.erase(it);
    pending_queue.erase(pending_queue.begin());
    if (pending_queue.empty()) {
      pending_target = -1; pending_kind.clear(); ability_used = true;
    } else {
      pending_target = pending_queue.front();
    }
    return true;
  }
  const NativePlayer* active() const {
    if (active_player < 0 || active_player >= static_cast<int>(players.size())) return nullptr;
    return &players[active_player];
  }

  bool take_gold() {
    auto* p = active();
    if (!p || resources_taken) return false;
    p->gold += plan_take_gold(p->role_id, ResourcePhase::Main).gold;
    resources_taken = true;
    after_resources();
    return true;
  }

  bool take_cards(DistrictDrawEffect effect = DistrictDrawEffect::None) {
    auto* p = active();
    if (!p || resources_taken) return false;
    const bool keep_both = std::any_of(p->city.begin(), p->city.end(),
      [](const NativeDistrict& d) { return d.effect == "keepBoth"; });
    const bool draw_three = !keep_both && std::any_of(p->city.begin(), p->city.end(),
      [](const NativeDistrict& d) { return d.effect == "draw3keep1"; });
    const auto plan = plan_take_cards(p->role_id, ResourcePhase::Main,
      draw_three ? DistrictDrawEffect::Observatory : (keep_both ? DistrictDrawEffect::Library : effect));
    auto cards = deck.draw(plan.drawn, rng);
    p->gold += plan.gold;
    resources_taken = true;
    if (plan.keep_all || cards.empty()) {
      p->hand.insert(p->hand.end(), std::make_move_iterator(cards.begin()),
                     std::make_move_iterator(cards.end()));
    } else {
      pending_cards = std::move(cards);
      pending_kind = "draw_keep";
    }
    if (pending_kind.empty()) after_resources();
    return true;
  }

  void after_resources() {
    auto* p = active();
    if (!p || ability_used || !pending_kind.empty()) return;
    if (p->role_id == "navigator") { pending_kind = "navigator_bonus"; return; }
    if (p->role_id == "scholar") {
      pending_cards = deck.draw(7, rng);
      if (pending_cards.empty()) ability_used = true;
      else pending_kind = "scholar_pick";
      return;
    }
    if (p->role_id == "witch") { pending_kind = "witch_target"; return; }
    if (p->role_id == "monk" && !income_taken) { pending_kind = "monk_declare"; return; }
    if (p->role_id == "prophet") { prophet_collect(); return; }
  }

  bool income() {
    auto* p = active();
    if (!p || income_taken) return false;
    std::string color;
    if (p->role_id == "king" || p->role_id == "noble") color = "yellow";
    else if (p->role_id == "bishop") color = "blue";
    else if (p->role_id == "merchant") color = "green";
    else if (p->role_id == "warlord" || p->role_id == "marshal") color = "red";
    else return false;
    const int amount = static_cast<int>(std::count_if(p->city.begin(), p->city.end(),
      [&](const NativeDistrict& d) { return d.card.color == color; }));
    p->gold += amount;
    income_taken = true;
    return true;
  }

  bool monk_take() {
    auto* p = active();
    if (!p || p->role_id != "monk" || !income_taken || monk_extra_taken) return false;
    int richest = -1;
    for (size_t i = 0; i < players.size(); ++i) {
      if (static_cast<int>(i) == active_player) continue;
      if (richest < 0 || players[i].gold > players[richest].gold) richest = static_cast<int>(i);
    }
    if (richest < 0 || players[richest].gold <= p->gold) return false;
    --players[richest].gold; ++p->gold; monk_extra_taken = true;
    return true;
  }

  bool start_ability() {
    auto* p = active();
    if (!p || ability_used || pending_kind.size()) return false;
    if (p->role_id == "assassin" || p->role_id == "thief") {
      pending_kind = p->role_id; return true;
    }
    if (p->role_id == "magician") { pending_kind = "magician_choice"; return true; }
    if (p->role_id == "emperor") { pending_kind = "emperor_crown"; return true; }
    if (p->role_id == "diplomat") {
      if (p->city.empty()) return false;
      pending_kind = "diplomat_mine"; return true;
    }
    if (p->role_id == "warlord") { pending_kind = "warlord_destroy"; return true; }
    if (p->role_id == "marshal") { pending_kind = "marshal_seize"; return true; }
    if (p->role_id == "artist") { pending_kind = "artist"; pending_selected.clear(); return true; }
    if (p->role_id == "navigator") { pending_kind = "navigator_bonus"; return true; }
    if (p->role_id == "scholar") {
      pending_cards = deck.draw(7, rng);
      if (pending_cards.empty()) { ability_used = true; return true; }
      pending_kind = "scholar_pick"; return true;
    }
    if (p->role_id == "prophet") return prophet_collect();
    return false;
  }

  static int role_number(const std::string& id) {
    static const std::vector<std::string> ids = {
      "assassin", "thief", "magician", "king", "bishop", "merchant", "architect", "warlord",
      "witch", "emperor", "navigator", "scholar", "prophet", "artist", "marshal", "noble", "alchemist"
    };
    const auto it = std::find(ids.begin(), ids.end(), id);
    return it == ids.end() ? -1 : static_cast<int>(it - ids.begin()) + 1;
  }

  bool begin_next_round() {
    if (players.size() < 2 || char_deck.empty()) return false;
    ++round;
    for (auto& player : players) { player.role_ids.clear(); player.role_id.clear(); }
    pending_kind.clear(); pending_queue.clear(); pending_cards.clear(); pending_selected.clear();
    reaction_kind.clear(); reaction_queue.clear(); has_reaction_card = false; reaction_player = -1;
    std::vector<std::string> pool = char_deck;
    for (size_t i = pool.size(); i > 1; --i) {
      const size_t j = static_cast<size_t>(rng.next() * static_cast<double>(i));
      std::swap(pool[i - 1], pool[j]);
    }
    draft_pool.clear(); draft_face_up.clear(); draft_face_down.clear(); draft_steps.clear();
    const int n = static_cast<int>(players.size());
    int crown = 0;
    for (size_t i = 0; i < players.size(); ++i) if (players[i].has_crown) crown = static_cast<int>(i);
    std::vector<int> order;
    for (int k = 0; k < n; ++k) order.push_back((crown + k) % n);
    if (n == 2) {
      if (!pool.empty()) { draft_face_down.push_back(pool.front()); pool.erase(pool.begin()); }
      draft_steps = {{order[0], 1, 0, false}, {order[1], 1, 1, false},
                     {order[0], 1, 1, false}, {order[1], 1, 0, false}};
    } else if (n == 3) {
      if (!pool.empty()) { draft_face_down.push_back(pool.front()); pool.erase(pool.begin()); }
      for (int k = 0; k < 6; ++k) draft_steps.push_back({order[k % 3], 1, 0, false});
    } else {
      const int up = std::max(0, static_cast<int>(pool.size()) - n - 2);
      for (int k = 0; k < up && !pool.empty(); ++k) {
        int picked = -1;
        for (int tries = 0; tries < 50; ++tries) {
          const int candidate = static_cast<int>(rng.next() * pool.size());
          if (role_number(pool[candidate]) != 4) { picked = candidate; break; }
        }
        if (picked < 0) picked = static_cast<int>(rng.next() * pool.size());
        draft_face_up.push_back(pool[picked]);
        pool.erase(pool.begin() + picked);
      }
      if (!pool.empty()) {
        const size_t picked = static_cast<size_t>(rng.next() * pool.size());
        draft_face_down.push_back(pool[picked]); pool.erase(pool.begin() + picked);
      }
      for (int k = 0; k < n; ++k) draft_steps.push_back({order[k], 1, 0, false});
      if (n >= 7 && !draft_steps.empty()) draft_steps.back().from_face_down = true;
    }
    draft_pool = std::move(pool); draft_step = 0; draft_total_steps = static_cast<int>(draft_steps.size());
    draft_current_player = draft_steps.empty() ? -1 : draft_steps.front().player;
    draft_sub = "pick"; phase = NativePhase::Draft; active_player = -1;
    round_confirm_count = 0; round_confirmed.assign(players.size(), false);
    return true;
  }

  bool confirm_round(int player) {
    if (phase != NativePhase::RoundConfirm || player < 0 || player >= static_cast<int>(players.size())) return false;
    if (round_confirmed.size() != players.size()) round_confirmed.assign(players.size(), false);
    if (round_confirmed[player]) return false;
    round_confirmed[player] = true;
    round_confirm_count = static_cast<int>(std::count(round_confirmed.begin(), round_confirmed.end(), true));
    if (round_confirm_count == static_cast<int>(players.size())) return begin_next_round();
    return true;
  }

  bool build(const std::string& uid, const std::string& name,
             const std::string& effect = {}) {
    auto* p = active();
    if (!p) return false;
    auto it = std::find_if(p->hand.begin(), p->hand.end(), [&](const DistrictCard& c) {
      return c.uid == uid;
    });
    if (it == p->hand.end()) return false;
    const std::string resolved_name = name.empty() ? it->name : name;
    if (resolved_name.empty()) return false;
    int same = 0, quarry = 0;
    for (const auto& d : p->city) {
      if (d.name == resolved_name) ++same;
      if (d.effect == "quarry") ++quarry;
    }
    BuildCard card{resolved_name, it->color, it->cost};
    BuildContext context{p->role_id, false, p->gold, builds, 1, same, quarry};
    if (!can_build(card, context)) return false;
    p->gold -= it->cost;
    spent_on_build += it->cost;
    p->city.push_back({*it, resolved_name, effect, {}});
    p->hand.erase(it);
    ++builds;
    return true;
  }

  bool use_lab(const std::string& building_uid, const std::string& discard_uid) {
    auto* p = active();
    if (!p || !std::any_of(p->city.begin(), p->city.end(), [&](const NativeDistrict& d) {
      return d.card.uid == building_uid && d.effect == "lab";
    })) return false;
    SpecialBuildingState s;
    s.gold = p->gold; s.hand = std::move(p->hand); s.has_lab = true; s.used_lab = used_lab;
    const bool ok = citadels::native::use_lab(s, discard_uid);
    p->gold = s.gold; p->hand = std::move(s.hand);
    used_lab = s.used_lab;
    return ok;
  }

  bool use_smithy(const std::string& building_uid) {
    auto* p = active();
    if (!p || !std::any_of(p->city.begin(), p->city.end(), [&](const NativeDistrict& d) {
      return d.card.uid == building_uid && d.effect == "smithy";
    })) return false;
    SpecialBuildingState s;
    s.gold = p->gold; s.hand = std::move(p->hand); s.has_smithy = true; s.used_smithy = used_smithy;
    const bool ok = citadels::native::use_smithy(s, deck, rng);
    p->gold = s.gold; p->hand = std::move(s.hand);
    used_smithy = s.used_smithy;
    return ok;
  }

  bool use_museum(const std::string& building_uid, const std::string& card_uid) {
    auto* p = active();
    auto it = std::find_if(p ? p->city.begin() : std::vector<NativeDistrict>::iterator{},
                           p ? p->city.end() : std::vector<NativeDistrict>::iterator{},
                           [&](const NativeDistrict& d) {
                             return d.card.uid == building_uid && d.effect == "museum";
                           });
    if (!p || it == p->city.end()) return false;
    SpecialBuildingState s;
    s.hand = std::move(p->hand); s.has_museum = true; s.used_museum = used_museum;
    s.museum_cards = std::move(it->museum_cards);
    const bool ok = citadels::native::use_museum(s, card_uid);
    p->hand = std::move(s.hand); it->museum_cards = std::move(s.museum_cards);
    used_museum = s.used_museum;
    return ok;
  }

  bool end_turn() {
    if (!active()) return false;
    TurnState turn{active()->role_id, false, active()->gold, spent_on_build,
                   0, 0, false};
    if (!citadels::native::end_turn(turn)) return false;
    active()->gold = turn.gold;
    ++turns_completed;
    active_player = (active_player + 1) % static_cast<int>(players.size());
    if (active_player == 0) ++round;
    builds = 0;
    spent_on_build = 0;
    resources_taken = false;
    income_taken = false;
    monk_extra_taken = false;
    ability_used = false;
    used_lab = false;
    used_smithy = false;
    used_museum = false;
    return true;
  }
};

}  // namespace citadels::native
