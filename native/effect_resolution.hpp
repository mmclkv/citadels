#pragma once

#include <string_view>

namespace citadels::native {

struct CallPlayer {
  int gold = 0;
};

struct CallEffects {
  int assassinated = 0;
  int thief_target = 0;
  int thief_player = -1;
  int bewitched = 0;
  int witch_player = -1;
};

enum class CallOutcome { Normal, SkippedAssassinated, Bewitched, ThiefResolved };

inline CallOutcome resolve_call(CallEffects& effects, int character_number,
                                int target_player, CallPlayer* players,
                                int player_count) {
  if (effects.assassinated == character_number) return CallOutcome::SkippedAssassinated;
  if (effects.bewitched == character_number) return CallOutcome::Bewitched;
  if (effects.thief_target == character_number && effects.thief_player >= 0 &&
      target_player >= 0 && target_player < player_count &&
      effects.thief_player < player_count) {
    players[effects.thief_player].gold += players[target_player].gold;
    players[target_player].gold = 0;
    effects.thief_target = 0;
    return CallOutcome::ThiefResolved;
  }
  return CallOutcome::Normal;
}

inline bool declare_bewitched(CallEffects& effects, int character_number, int witch_player) {
  if (character_number < 2 || character_number > 9 || witch_player < 0) return false;
  effects.bewitched = character_number;
  effects.witch_player = witch_player;
  return true;
}

}  // namespace citadels::native
