#pragma once

#include <string_view>

namespace citadels::native {

struct TurnState {
  std::string_view role_id;
  bool witch_resume = false;
  int gold = 0;
  int spent_on_build = 0;
  int call_index = 0;
  int played_count = 0;
  bool pending = false;
};

inline bool end_turn(TurnState& turn) {
  if (turn.pending) return false;
  if (turn.role_id == "alchemist" && turn.spent_on_build > 0) {
    turn.gold += turn.spent_on_build;
  }
  ++turn.played_count;
  ++turn.call_index;
  turn.spent_on_build = 0;
  return true;
}

}  // namespace citadels::native
