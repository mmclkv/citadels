#pragma once

#include <string_view>
#include <utility>
#include <vector>

namespace citadels::native {

struct DiplomatCard {
  std::string_view name;
  int cost = 0;
  bool fortress = false;
};

struct DiplomatPlayer {
  int gold = 0;
  std::vector<DiplomatCard> city;
};

inline bool diplomat_swap(DiplomatPlayer& mine, DiplomatPlayer& target,
                          size_t mine_index, size_t target_index,
                          int target_end_districts) {
  if (mine_index >= mine.city.size() || target_index >= target.city.size()) return false;
  if (target.city.size() >= static_cast<size_t>(target_end_districts)) return false;
  const auto& own = mine.city[mine_index];
  const auto& theirs = target.city[target_index];
  if (theirs.fortress || own.fortress) return false;
  const auto same_name = [&mine](std::string_view name) {
    size_t count = 0;
    for (const auto& card : mine.city) if (card.name == name) ++count;
    return count;
  };
  if (same_name(theirs.name) > 0) return false;
  const int difference = theirs.cost > own.cost ? theirs.cost - own.cost : 0;
  if (difference > mine.gold) return false;
  mine.gold -= difference;
  target.gold += difference;
  std::swap(mine.city[mine_index], target.city[target_index]);
  return true;
}

}  // namespace citadels::native
