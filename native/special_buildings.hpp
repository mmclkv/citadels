#pragma once

#include <algorithm>
#include <string>
#include <vector>

#include "deck_machine.hpp"

namespace citadels::native {

// 可由 GameAdapter 映射到真实 Player/Turn 的紫色建筑能力状态。
struct SpecialBuildingState {
  int gold = 0;
  std::vector<DistrictCard> hand;
  std::vector<DistrictCard> discard;
  std::vector<DistrictCard> museum_cards;
  bool has_lab = false;
  bool has_smithy = false;
  bool has_museum = false;
  bool used_lab = false;
  bool used_smithy = false;
  bool used_museum = false;
};

inline bool use_lab(SpecialBuildingState& state, const std::string& discard_uid) {
  if (!state.has_lab || state.used_lab || discard_uid.empty()) return false;
  auto it = std::find_if(state.hand.begin(), state.hand.end(), [&](const DistrictCard& c) {
    return c.uid == discard_uid;
  });
  if (it == state.hand.end()) return false;
  state.discard.push_back(std::move(*it));
  state.hand.erase(it);
  ++state.gold;
  state.used_lab = true;
  return true;
}

inline bool use_smithy(SpecialBuildingState& state, DeckMachine& deck, JsRng& rng) {
  if (!state.has_smithy || state.used_smithy || state.gold < 2) return false;
  state.gold -= 2;
  auto cards = deck.draw(3, rng);
  state.hand.insert(state.hand.end(), std::make_move_iterator(cards.begin()),
                    std::make_move_iterator(cards.end()));
  state.used_smithy = true;
  return true;
}

inline bool use_museum(SpecialBuildingState& state, const std::string& card_uid) {
  if (!state.has_museum || state.used_museum || card_uid.empty()) return false;
  auto it = std::find_if(state.hand.begin(), state.hand.end(), [&](const DistrictCard& c) {
    return c.uid == card_uid;
  });
  if (it == state.hand.end()) return false;
  state.museum_cards.push_back(std::move(*it));
  state.hand.erase(it);
  state.used_museum = true;
  return true;
}

inline int museum_score_bonus(const SpecialBuildingState& state) {
  return static_cast<int>(state.museum_cards.size());
}

}  // namespace citadels::native
