#pragma once

#include <algorithm>

namespace citadels::native {

enum class ResourcePending { None, KeepCard };

struct ResourceState {
  int gold = 0;
  int hand_count = 0;
  bool resources_taken = false;
  ResourcePending pending = ResourcePending::None;
  int drawn_count = 0;
};

// 行动阶段的通用资源转移，不包含角色/建筑例外。
// 例外由规则适配器计算 amount/drawn 后调用，避免把特殊能力硬编码到搜索核心。
inline bool take_gold(ResourceState& state, int amount) {
  if (state.resources_taken || amount < 0) return false;
  state.gold += amount;
  state.resources_taken = true;
  return true;
}

inline bool take_cards(ResourceState& state, int drawn_count, bool keep_all = false) {
  if (state.resources_taken || drawn_count < 0) return false;
  state.resources_taken = true;
  state.drawn_count = drawn_count;
  if (keep_all) {
    state.hand_count += drawn_count;
    state.drawn_count = 0;
    return true;
  }
  if (drawn_count == 0) return true;
  state.pending = ResourcePending::KeepCard;
  return true;
}

inline bool keep_drawn_card(ResourceState& state) {
  if (state.pending != ResourcePending::KeepCard || state.drawn_count <= 0) return false;
  ++state.hand_count;
  state.drawn_count = 0;
  state.pending = ResourcePending::None;
  return true;
}

inline bool can_end_turn(const ResourceState& state) {
  return state.pending == ResourcePending::None;
}

}  // namespace citadels::native
