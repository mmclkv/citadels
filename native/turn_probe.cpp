#include <iostream>
#include "turn_machine.hpp"

int main() {
  using namespace citadels::native;
  TurnState normal{"assassin", false, 5, 3, 2, 0, false};
  TurnState alchemist{"alchemist", false, 5, 3, 2, 0, false};
  TurnState witchAlchemist{"alchemist", true, 5, 3, 2, 0, false};
  TurnState pending{"assassin", false, 5, 0, 2, 0, true};
  std::cout << end_turn(normal) << ',' << normal.gold << ',' << normal.call_index << ','
            << end_turn(alchemist) << ',' << alchemist.gold << ','
            << end_turn(witchAlchemist) << ',' << witchAlchemist.gold << ','
            << end_turn(pending) << '\n';
}
