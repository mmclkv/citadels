#include <iostream>
#include "scholar_machine.hpp"

int main() {
  using namespace citadels::native;
  std::vector<DistrictCard> deck;
  for (int i = 0; i < 10; ++i) deck.push_back({"d" + std::to_string(i), "", 1});
  DeckMachine machine(std::move(deck));
  JsRng rng(13);
  std::vector<DistrictCard> hand{{"h", "", 1}};
  auto drawn = machine.draw(7, rng);
  const bool ok = scholar_choose(hand, std::move(drawn), 3, machine, rng);
  std::cout << ok << ',' << hand.size() << ',' << machine.deck_count() << ','
            << machine.discard_count() << '\n';
}
