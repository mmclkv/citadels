#include <iostream>
#include "navigator_machine.hpp"

int main() {
  using namespace citadels::native;
  NavigatorState gold{1, 2, false};
  NavigatorState cards{1, 2, false};
  NavigatorState repeat{1, 2, false};
  std::vector<DistrictCard> deck;
  for (int i = 0; i < 5; ++i) deck.push_back({"d" + std::to_string(i), "", 1});
  DeckMachine machine(std::move(deck));
  JsRng rng(29);
  const bool a = navigator_gold(gold);
  const bool b = navigator_cards(cards, machine, rng);
  const bool c = navigator_gold(gold);
  std::cout << a << ',' << gold.gold << ',' << gold.bonus_done << ',' << b << ','
            << cards.hand_count << ',' << cards.bonus_done << ',' << c << '\n';
}
