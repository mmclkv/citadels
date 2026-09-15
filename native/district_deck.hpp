#pragma once

#include <string>
#include <vector>

#include "js_rng.hpp"

namespace citadels::native {

struct DistrictCard {
  std::string uid;
  std::string color;
  int cost = 0;
  // Loaded game snapshots carry the localized card name.  Keeping it after
  // the existing fields preserves aggregate initialization of the built-in deck.
  std::string name;
};

inline std::vector<DistrictCard> build_base_district_deck(uint32_t seed) {
  // 顺序与 src/cards.js DISTRICTS 完全一致；UID 先分配再洗牌。
  struct Definition { const char* color; int cost; int count; };
  static constexpr Definition definitions[] = {
    {"yellow", 3, 5}, {"yellow", 4, 4}, {"yellow", 5, 3},
    {"blue", 1, 3}, {"blue", 2, 3}, {"blue", 3, 3}, {"blue", 5, 2},
    {"green", 1, 5}, {"green", 2, 4}, {"green", 3, 3}, {"green", 4, 3},
    {"green", 4, 3}, {"green", 5, 2},
    {"red", 1, 3}, {"red", 2, 3}, {"red", 3, 3}, {"red", 5, 2},
    {"purple", 2, 1}, {"purple", 3, 2}, {"purple", 4, 1}, {"purple", 5, 1},
    {"purple", 5, 1}, {"purple", 5, 1}, {"purple", 5, 1}, {"purple", 6, 1},
    {"purple", 6, 1}, {"purple", 6, 1}, {"purple", 6, 1},
    {"purple", 6, 1}, {"purple", 5, 1}
  };
  std::vector<DistrictCard> deck;
  int uid = 0;
  for (const auto& definition : definitions) {
    for (int i = 0; i < definition.count; ++i) {
      deck.push_back({"d" + std::to_string(uid++), definition.color, definition.cost});
    }
  }
  JsRng rng(seed);
  for (size_t i = deck.size() - 1; i > 0; --i) {
    const size_t j = static_cast<size_t>(rng.next() * static_cast<double>(i + 1));
    std::swap(deck[i], deck[j]);
  }
  return deck;
}

}  // namespace citadels::native
