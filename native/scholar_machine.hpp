#pragma once

#include <cstddef>
#include <vector>

#include "deck_machine.hpp"

namespace citadels::native {

inline bool scholar_choose(std::vector<DistrictCard>& hand,
                           std::vector<DistrictCard> drawn, size_t chosen_index,
                           DeckMachine& deck, JsRng& rng) {
  if (drawn.empty() || chosen_index >= drawn.size()) return false;
  hand.push_back(std::move(drawn[chosen_index]));
  drawn.erase(drawn.begin() + static_cast<std::ptrdiff_t>(chosen_index));
  deck.return_and_shuffle(std::move(drawn), rng);
  return true;
}

}  // namespace citadels::native
