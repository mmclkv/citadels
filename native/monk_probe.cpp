#include <iostream>
#include "monk_machine.hpp"

int main() {
  using namespace citadels::native;
  MonkPlayer monk{2, 0, 3};
  std::vector<MonkPlayer> players{{2, 0, 0}, monk, {5, 0, 0}};
  const bool resource = monk_resource(players[1], 1, 2);
  const bool taken = monk_take(players[1], players, 1);
  const bool invalid = monk_resource(players[1], 2, 2);
  std::cout << resource << ',' << taken << ',' << invalid << ',' << players[1].gold
            << ',' << players[1].hand_count << ',' << players[2].gold << '\n';
}
