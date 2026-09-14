#pragma once

#include <vector>

#include "deck_machine.hpp"

namespace citadels::native {

struct NavigatorState {
  int gold = 0;
  int hand_count = 0;
  bool bonus_done = false;
};

inline bool navigator_gold(NavigatorState& state) {
  if (state.bonus_done) return false;
  state.gold += 4;
  state.bonus_done = true;
  return true;
}

inline bool navigator_cards(NavigatorState& state, DeckMachine& deck, JsRng& rng) {
  if (state.bonus_done) return false;
  const auto cards = deck.draw(4, rng);
  state.hand_count += static_cast<int>(cards.size());
  state.bonus_done = true;
  return true;
}

}  // namespace citadels::native
