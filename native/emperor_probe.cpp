#include <iostream>
#include "emperor_machine.hpp"

int main() {
  using namespace citadels::native;
  CrownState crown{1};
  int emperor_gold = 2;
  int target_gold = 0;
  std::vector<DistrictCard> emperor{{"e", "", 1}};
  std::vector<DistrictCard> target{{"a", "", 1}, {"b", "", 2}};
  JsRng rng(9);
  std::cout << transfer_crown(crown, 1, 2) << ',' << crown.holder << ','
            << emperor_take_gold(emperor_gold, target_gold) << ',' << emperor_gold << ','
            << emperor_take_card(emperor, target, rng) << ',' << emperor.size() << ','
            << target.size() << '\n';
}
