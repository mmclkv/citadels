#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace citadels::native {

enum class Phase { Lobby, Draft, Action, WitchResume, GameOver, Unknown };

struct PlayerSummary {
  std::string id;
  int seat = -1;
  int gold = 0;
  int hand_count = 0;
  int city_count = 0;
  std::vector<int> character_ids;
  bool has_crown = false;
  bool connected = true;
};

// C++ 规则适配器使用的稳定元状态。state_hash 对应完整 JS 状态（去除日志），
// 使局部迁移期间仍能用回放精确定位第一个分歧动作。
struct SearchState {
  int version = 1;
  std::string state_hash;
  Phase phase = Phase::Unknown;
  int round = 0;
  uint32_t rng_state = 0;
  int player_count = 0;
  int end_districts = 8;
  std::string char_set_mode;
  std::string actor_id;
  std::vector<PlayerSummary> players;
  int draft_step = -1;
  int draft_current_player = -1;
  int draft_pool_count = 0;
  int draft_face_down_count = 0;
  int turn_player = -1;
  int turn_character_id = -1;
  int call_index = 0;
};

}  // namespace citadels::native
