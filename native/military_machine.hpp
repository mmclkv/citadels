#pragma once

#include <cstddef>
#include <string_view>
#include <vector>

namespace citadels::native {

struct MilitaryCard {
  std::string_view name;
  int cost = 0;
  bool immune = false;
  bool beautified = false;
};

struct MilitaryPlayer {
  int gold = 0;
  std::vector<MilitaryCard> city;
};

inline int destroy_cost(const MilitaryCard& card, bool target_has_other_wall) {
  int cost = card.cost - 1 + (card.beautified ? 1 : 0);
  if (target_has_other_wall) ++cost;
  return cost < 0 ? 0 : cost;
}

inline bool warlord_destroy(MilitaryPlayer& attacker, MilitaryPlayer& target,
                            size_t target_index, int end_districts,
                            bool bishop_protected, bool target_has_other_wall) {
  if (target_index >= target.city.size() ||
      target.city.size() >= static_cast<size_t>(end_districts) ||
      bishop_protected || target.city[target_index].immune) return false;
  const int cost = destroy_cost(target.city[target_index], target_has_other_wall);
  if (cost > attacker.gold) return false;
  attacker.gold -= cost;
  target.city.erase(target.city.begin() + static_cast<std::ptrdiff_t>(target_index));
  return true;
}

inline bool marshal_seize(MilitaryPlayer& attacker, MilitaryPlayer& target,
                          size_t target_index, int end_districts,
                          bool duplicate_name) {
  if (target_index >= target.city.size() || target.city[target_index].cost > 3 ||
      target.city.size() >= static_cast<size_t>(end_districts) ||
      target.city[target_index].immune || duplicate_name) return false;
  const int cost = target.city[target_index].cost;
  if (cost > attacker.gold) return false;
  attacker.gold -= cost;
  target.gold += cost;
  attacker.city.push_back(target.city[target_index]);
  target.city.erase(target.city.begin() + static_cast<std::ptrdiff_t>(target_index));
  return true;
}

}  // namespace citadels::native
