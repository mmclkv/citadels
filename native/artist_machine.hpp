#pragma once

#include <algorithm>
#include <string>
#include <vector>

#include "game_state.hpp"

namespace citadels::native {

struct ArtistState {
  int gold = 0;
  std::vector<NativeDistrict> city;
  std::vector<std::string> selected;
};

inline bool artist_select(ArtistState& state, const std::string& uid) {
  if (state.selected.size() >= 2 || uid.empty() || state.gold <= static_cast<int>(state.selected.size()))
    return false;
  if (std::find(state.selected.begin(), state.selected.end(), uid) != state.selected.end()) return false;
  auto it = std::find_if(state.city.begin(), state.city.end(), [&](const NativeDistrict& d) {
    return d.card.uid == uid;
  });
  if (it == state.city.end() || it->card.cost < 0) return false;
  state.selected.push_back(uid);
  return true;
}

inline bool artist_done(ArtistState& state) {
  if (state.selected.size() > 2 || state.gold < static_cast<int>(state.selected.size())) return false;
  for (const auto& uid : state.selected) {
    auto it = std::find_if(state.city.begin(), state.city.end(), [&](const NativeDistrict& d) {
      return d.card.uid == uid;
    });
    if (it == state.city.end() || it->effect == "beautified") return false;
  }
  for (const auto& uid : state.selected) {
    auto it = std::find_if(state.city.begin(), state.city.end(), [&](const NativeDistrict& d) {
      return d.card.uid == uid;
    });
    it->effect = "beautified";
    --state.gold;
  }
  state.selected.clear();
  return true;
}

}  // namespace citadels::native
