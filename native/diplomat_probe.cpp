#include <iostream>
#include "diplomat_machine.hpp"

int main() {
  using namespace citadels::native;
  DiplomatPlayer mine{5, {{"城堡", 4, false}}};
  DiplomatPlayer target{0, {{"港口", 4, false}}};
  const bool ok = diplomat_swap(mine, target, 0, 0, 8);
  DiplomatPlayer blocked{5, {{"堡垒", 3, true}}};
  DiplomatPlayer other{0, {{"城堡", 4, false}}};
  const bool fortress = diplomat_swap(blocked, other, 0, 0, 8);
  std::cout << ok << ',' << mine.gold << ',' << target.gold << ','
            << mine.city[0].name << ',' << target.city[0].name << ',' << fortress << '\n';
}
