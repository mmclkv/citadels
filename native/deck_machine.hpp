#pragma once

#include <utility>
#include <vector>

#include "district_deck.hpp"

namespace citadels::native {

class DeckMachine {
 public:
  explicit DeckMachine(std::vector<DistrictCard> deck) : deck_(std::move(deck)) {}

  void discard(std::vector<DistrictCard> cards) {
    discard_.insert(discard_.end(),
                    std::make_move_iterator(cards.begin()),
                    std::make_move_iterator(cards.end()));
  }

  void put_bottom(std::vector<DistrictCard> cards) {
    deck_.insert(deck_.end(),
                 std::make_move_iterator(cards.begin()),
                 std::make_move_iterator(cards.end()));
  }

  void return_and_shuffle(std::vector<DistrictCard> cards, JsRng& rng) {
    deck_.insert(deck_.end(),
                 std::make_move_iterator(cards.begin()),
                 std::make_move_iterator(cards.end()));
    for (size_t i = deck_.size() - 1; i > 0; --i) {
      const size_t j = static_cast<size_t>(rng.next() * static_cast<double>(i + 1));
      std::swap(deck_[i], deck_[j]);
    }
  }

  std::vector<DistrictCard> draw(int count, JsRng& rng) {
    std::vector<DistrictCard> result;
    for (int i = 0; i < count; ++i) {
      if (deck_.empty()) recycle(rng);
      if (deck_.empty()) break;
      result.push_back(std::move(deck_.front()));
      deck_.erase(deck_.begin());
    }
    return result;
  }

  size_t deck_count() const { return deck_.size(); }
  size_t discard_count() const { return discard_.size(); }

 private:
  void recycle(JsRng& rng) {
    if (discard_.empty()) return;
    deck_ = std::move(discard_);
    discard_.clear();
    for (size_t i = deck_.size() - 1; i > 0; --i) {
      const size_t j = static_cast<size_t>(rng.next() * static_cast<double>(i + 1));
      std::swap(deck_[i], deck_[j]);
    }
  }

  std::vector<DistrictCard> deck_;
  std::vector<DistrictCard> discard_;
};

}  // namespace citadels::native
