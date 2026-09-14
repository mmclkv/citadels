#include <iostream>

#include "special_buildings.hpp"

using namespace citadels::native;

int main() {
  SpecialBuildingState lab;
  lab.has_lab = true;
  lab.hand = {{"h1", "green", 3}, {"h2", "red", 2}};
  const bool a = use_lab(lab, "h1");
  const bool b = use_lab(lab, "h2");

  SpecialBuildingState museum;
  museum.has_museum = true;
  museum.hand = {{"m1", "blue", 2}};
  const bool c = use_museum(museum, "m1");
  const bool d = use_museum(museum, "m1");

  DeckMachine deck({{"d1", "yellow", 3}, {"d2", "blue", 2}, {"d3", "red", 1}});
  JsRng rng(9);
  SpecialBuildingState smithy;
  smithy.has_smithy = true;
  smithy.gold = 2;
  const bool e = use_smithy(smithy, deck, rng);
  const bool f = use_smithy(smithy, deck, rng);
  std::cout << a << ',' << b << ',' << lab.gold << ',' << lab.hand.size() << ','
            << lab.discard.size() << ',' << c << ',' << d << ','
            << museum.hand.size() << ',' << museum_score_bonus(museum) << ','
            << e << ',' << f << ',' << smithy.gold << ',' << smithy.hand.size();
  return 0;
}
