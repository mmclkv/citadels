#pragma once

#include <algorithm>
#include <string_view>
#include <vector>

#include "deck_machine.hpp"

namespace citadels::native {

struct MagicianHands {
  std::vector<DistrictCard> mine;
  std::vector<DistrictCard> target;
};

inline bool magician_swap(MagicianHands& hands) {
  hands.mine.swap(hands.target);
  return true;
}

inline bool magician_redraw(std::vector<DistrictCard>& hand,
                            const std::vector<std::string_view>& discard_uids,
                            DeckMachine& deck, JsRng& rng) {
  if (discard_uids.size() > hand.size()) return false;
  std::vector<DistrictCard> discarded;
  for (const auto uid : discard_uids) {
    const auto it = std::find_if(hand.begin(), hand.end(),
                                 [uid](const DistrictCard& card) { return card.uid == uid; });
    if (it == hand.end()) return false;
    discarded.push_back(std::move(*it));
    hand.erase(it);
  }
  const int count = static_cast<int>(discarded.size());
  deck.put_bottom(std::move(discarded));
  auto drawn = deck.draw(count, rng);
  if (static_cast<int>(drawn.size()) != count) return false;
  hand.insert(hand.end(), std::make_move_iterator(drawn.begin()),
              std::make_move_iterator(drawn.end()));
  return true;
}

}  // namespace citadels::native
