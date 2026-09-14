#include <iostream>
#include "call_queue.hpp"

int main() {
  using namespace citadels::native;
  CallPlayer players[3]{{1}, {4}, {6}};
  CallEffects effects;
  effects.assassinated = 1;
  effects.thief_target = 2;
  effects.thief_player = 0;
  CallQueue queue({{3, 1}, {1, 0}, {2, 2}});
  auto first = queue.next(effects, players, 3);
  auto second = queue.next(effects, players, 3);
  auto third = queue.next(effects, players, 3);
  std::cout << first->entry.character_number << ',' << static_cast<int>(first->outcome)
            << ',' << second->entry.character_number << ',' << static_cast<int>(second->outcome)
            << ',' << players[0].gold << ',' << players[2].gold << ',' << (third.has_value() ? 1 : 0)
            << '\n';
}
