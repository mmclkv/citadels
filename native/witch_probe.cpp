#include <iostream>
#include "witch_machine.hpp"

int main() {
  using namespace citadels::native;
  WitchResumeTurn turn;
  const bool ok = begin_witch_resume(turn, 2, 6);
  WitchResumeTurn invalid;
  const bool bad = begin_witch_resume(invalid, -1, 6);
  std::cout << ok << ',' << turn.player_index << ',' << turn.role_character_id << ','
            << turn.witch_resume << ',' << turn.resources_taken << ',' << turn.bonus_done
            << ',' << turn.ability_used << ',' << turn.builds << ',' << turn.spent_on_build
            << ',' << bad << '\n';
}
