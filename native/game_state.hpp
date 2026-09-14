#pragma once

#include <algorithm>
#include <string>
#include <vector>

#include "action_codec.hpp"
#include "build_rules.hpp"
#include "city_machine.hpp"
#include "deck_machine.hpp"
#include "resource_rules.hpp"
#include "special_buildings.hpp"
#include "turn_machine.hpp"

namespace citadels::native {

struct NativeDistrict {
  DistrictCard card;
  std::string name;
  std::string effect;
  std::vector<DistrictCard> museum_cards;
};

struct NativePlayer {
  std::string id;
  std::string role_id;
  int gold = 2;
  std::vector<DistrictCard> hand;
  std::vector<NativeDistrict> city;
  bool has_crown = false;
};

struct NativeGameState {
  std::vector<NativePlayer> players;
  DeckMachine* deck = nullptr;
  JsRng* rng = nullptr;
  int active_player = -1;
  int end_districts = 8;
  int builds = 0;
  int spent_on_build = 0;
  bool resources_taken = false;
  bool turn_ended = false;
  bool used_lab = false;
  bool used_smithy = false;
  bool used_museum = false;

  NativePlayer* active() {
    if (active_player < 0 || active_player >= static_cast<int>(players.size())) return nullptr;
    return &players[active_player];
  }

  bool take_gold() {
    auto* p = active();
    if (!p || resources_taken) return false;
    p->gold += plan_take_gold(p->role_id, ResourcePhase::Main).gold;
    resources_taken = true;
    return true;
  }

  bool take_cards(DistrictDrawEffect effect = DistrictDrawEffect::None) {
    auto* p = active();
    if (!p || resources_taken || !deck || !rng) return false;
    const auto plan = plan_take_cards(p->role_id, ResourcePhase::Main, effect);
    auto cards = deck->draw(plan.drawn, *rng);
    p->hand.insert(p->hand.end(), std::make_move_iterator(cards.begin()),
                   std::make_move_iterator(cards.end()));
    p->gold += plan.gold;
    resources_taken = true;
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
    int same = 0, quarry = 0;
    for (const auto& d : p->city) {
      if (d.name == name) ++same;
      if (d.effect == "quarry") ++quarry;
    }
    BuildCard card{name, it->color, it->cost};
    BuildContext context{p->role_id, false, p->gold, builds, 1, same, quarry};
    if (!can_build(card, context)) return false;
    p->gold -= it->cost;
    spent_on_build += it->cost;
    p->city.push_back({*it, name, effect, {}});
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
    if (!p || !deck || !rng || !std::any_of(p->city.begin(), p->city.end(), [&](const NativeDistrict& d) {
      return d.card.uid == building_uid && d.effect == "smithy";
    })) return false;
    SpecialBuildingState s;
    s.gold = p->gold; s.hand = std::move(p->hand); s.has_smithy = true; s.used_smithy = used_smithy;
    const bool ok = citadels::native::use_smithy(s, *deck, *rng);
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
    if (!active() || turn_ended) return false;
    TurnState turn{active()->role_id, false, active()->gold, spent_on_build,
                   0, 0, false};
    if (!citadels::native::end_turn(turn)) return false;
    active()->gold = turn.gold;
    turn_ended = true;
    return true;
  }
};

}  // namespace citadels::native
