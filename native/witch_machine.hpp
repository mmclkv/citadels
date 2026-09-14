#pragma once

namespace citadels::native {

struct WitchResumeTurn {
  int player_index = -1;
  int role_character_id = -1;
  bool witch_resume = false;
  bool resources_taken = false;
  bool bonus_done = false;
  bool ability_used = false;
  int builds = 0;
  int spent_on_build = 0;
};

inline bool begin_witch_resume(WitchResumeTurn& turn, int witch_player,
                               int role_character_id) {
  if (witch_player < 0 || role_character_id < 0) return false;
  turn.player_index = witch_player;
  turn.role_character_id = role_character_id;
  turn.witch_resume = true;
  turn.resources_taken = true;
  // 被施咒者已经领取资源，角色额外奖励不在接管阶段重复触发。
  turn.bonus_done = true;
  turn.ability_used = false;
  turn.builds = 0;
  turn.spent_on_build = 0;
  return true;
}

}  // namespace citadels::native
