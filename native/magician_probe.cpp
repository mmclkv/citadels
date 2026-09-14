#include <iostream>
#include "magician_machine.hpp"

int main() {
  using namespace citadels::native;
  MagicianHands hands{{{"a", "", 1}}, {{"b", "", 2}, {"c", "", 3}}};
  magician_swap(hands);
  std::vector<DistrictCard> deck{{"d", "", 1}, {"e", "", 2}};
  DeckMachine machine(std::move(deck));
  std::vector<DistrictCard> mine{{"x", "", 1}, {"y", "", 2}};
  JsRng rng(7);
  const bool ok = magician_redraw(mine, {"x"}, machine, rng);
  std::cout << hands.mine.size() << ',' << hands.target.size() << ',' << ok << ','
            << mine.size() << ',' << mine[0].uid << ',' << machine.discard_count() << '\n';
}
