#pragma once

#include <string_view>
#include <vector>

#include "js_rng.hpp"
#include "district_deck.hpp"

namespace citadels::native {

struct CrownState {
  int holder = -1;
};

inline bool transfer_crown(CrownState& crown, int from_player, int target_player) {
  if (target_player < 0 || target_player == from_player) return false;
  crown.holder = target_player;
  return true;
}

inline int emperor_take_gold(int& emperor_gold, int& target_gold) {
  const int amount = target_gold > 0 ? 1 : 0;
  target_gold -= amount;
  emperor_gold += amount;
  return amount;
}

inline bool emperor_take_card(std::vector<DistrictCard>& emperor_hand,
                              std::vector<DistrictCard>& target_hand, JsRng& rng) {
  if (target_hand.empty()) return false;
  const size_t index = static_cast<size_t>(rng.next() * target_hand.size());
  emperor_hand.push_back(std::move(target_hand[index]));
  target_hand.erase(target_hand.begin() + static_cast<std::ptrdiff_t>(index));
  return true;
}

}  // namespace citadels::native
