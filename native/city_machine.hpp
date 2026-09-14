#pragma once

#include "build_rules.hpp"

namespace citadels::native {

struct CityState {
  int gold = 0;
  int hand_count = 0;
  int city_count = 0;
  int builds = 0;
  int spent_on_build = 0;
  int end_districts = 8;
  bool first_to_finish = false;
};

inline bool apply_build(CityState& city, const BuildCard& card,
                        const BuildContext& context) {
  if (!can_build(card, context) || city.hand_count <= 0) return false;
  city.gold -= card.cost;
  --city.hand_count;
  ++city.city_count;
  ++city.builds;
  city.spent_on_build += card.cost;
  if (city.city_count >= city.end_districts) city.first_to_finish = true;
  return true;
}

}  // namespace citadels::native
