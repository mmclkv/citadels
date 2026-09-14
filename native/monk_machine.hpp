#pragma once

#include <vector>

namespace citadels::native {

struct MonkPlayer {
  int gold = 0;
  int hand_count = 0;
  int blue_buildings = 0;
};

inline bool monk_resource(MonkPlayer& monk, int gold, int cards) {
  if (gold < 0 || cards < 0 || gold + cards != monk.blue_buildings) return false;
  monk.gold += gold;
  monk.hand_count += cards;
  return true;
}

inline int richest_other(const std::vector<MonkPlayer>& players, size_t monk_index) {
  int best = -1;
  int best_gold = -1;
  for (size_t i = 0; i < players.size(); ++i) {
    if (i != monk_index && players[i].gold > best_gold) {
      best = static_cast<int>(i);
      best_gold = players[i].gold;
    }
  }
  return best;
}

inline bool monk_take(MonkPlayer& monk, std::vector<MonkPlayer>& players,
                      size_t monk_index) {
  const int richest = richest_other(players, monk_index);
  if (richest < 0 || players[richest].gold <= monk.gold) return false;
  --players[richest].gold;
  ++monk.gold;
  return true;
}

}  // namespace citadels::native
