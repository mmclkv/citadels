#include <iostream>
#include "military_machine.hpp"

int main() {
  using namespace citadels::native;
  MilitaryPlayer lord{5, {{"城堡", 4, false, false}, {"战场", 3, false, true}}};
  MilitaryPlayer victim{0, {{"神庙", 1, false, false}}};
  const bool destroyed = warlord_destroy(lord, victim, 0, 8, false, false);
  MilitaryPlayer marshal{4, {}};
  MilitaryPlayer target{2, {{"酒馆", 1, false, false}, {"堡垒", 3, true, false}}};
  const bool seized = marshal_seize(marshal, target, 0, 8, false);
  std::cout << destroyed << ',' << lord.gold << ',' << victim.city.size() << ','
            << seized << ',' << marshal.gold << ',' << target.gold << ','
            << marshal.city.size() << ',' << target.city.size() << '\n';
}
