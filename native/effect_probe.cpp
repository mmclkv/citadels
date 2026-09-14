#include <iostream>
#include "effect_resolution.hpp"

int main() {
  using namespace citadels::native;
  CallPlayer players[3]{{2}, {5}, {0}};
  CallEffects effects;
  effects.assassinated = 1;
  std::cout << static_cast<int>(resolve_call(effects, 1, 0, players, 3)) << ',';
  effects.thief_target = 2; effects.thief_player = 0;
  std::cout << static_cast<int>(resolve_call(effects, 2, 1, players, 3)) << ','
            << players[0].gold << ',' << players[1].gold << ',' << effects.thief_target << ',';
  std::cout << declare_bewitched(effects, 3, 2) << ',' << effects.bewitched << ','
            << effects.witch_player << ','
            << static_cast<int>(resolve_call(effects, 3, 2, players, 3)) << '\n';
}
