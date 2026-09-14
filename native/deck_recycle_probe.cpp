#include <iostream>
#include <vector>

#include "deck_machine.hpp"

int main() {
  std::vector<citadels::native::DistrictCard> deck;
  deck.push_back({"a", "", 0});
  deck.push_back({"b", "", 0});
  citadels::native::DeckMachine machine(std::move(deck));
  machine.discard({{"c", "", 0}, {"d", "", 0}, {"e", "", 0}});
  citadels::native::JsRng rng(17);
  machine.draw(2, rng);
  const auto cards = machine.draw(3, rng);
  for (size_t i = 0; i < cards.size(); ++i) {
    if (i) std::cout << ',';
    std::cout << cards[i].uid;
  }
  std::cout << '\n';
}
