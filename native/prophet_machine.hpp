#pragma once

#include <cstddef>
#include <vector>

#include "district_deck.hpp"

namespace citadels::native {

struct ProphetState {
  std::vector<DistrictCard> hand;
  std::vector<std::vector<DistrictCard>> opponents;
  std::vector<size_t> return_queue;
};

inline bool prophet_collect(ProphetState& state, size_t prophet_index, JsRng& rng) {
  if (prophet_index >= state.opponents.size()) return false;
  state.return_queue.clear();
  for (size_t i = 0; i < state.opponents.size(); ++i) {
    if (i == prophet_index || state.opponents[i].empty()) continue;
    const size_t index = static_cast<size_t>(rng.next() * state.opponents[i].size());
    state.hand.push_back(std::move(state.opponents[i][index]));
    state.opponents[i].erase(state.opponents[i].begin() + static_cast<std::ptrdiff_t>(index));
    state.return_queue.push_back(i);
  }
  return true;
}

inline bool prophet_return(ProphetState& state, size_t target_index, size_t hand_index) {
  if (state.return_queue.empty() || state.return_queue.front() != target_index ||
      hand_index >= state.hand.size() || target_index >= state.opponents.size()) return false;
  state.opponents[target_index].push_back(std::move(state.hand[hand_index]));
  state.hand.erase(state.hand.begin() + static_cast<std::ptrdiff_t>(hand_index));
  state.return_queue.erase(state.return_queue.begin());
  return true;
}

}  // namespace citadels::native
