#pragma once

#include <stdexcept>

#include "action_codec.hpp"

namespace citadels::native {

enum class DraftSub { Pick, Discard, Complete };

// 选角阶段的纯状态机。牌池内容由上层处理；这里只负责阶段、步序和行动者，
// 便于先与 JS 回放逐动作对齐，再接入角色牌合法性过滤。
class DraftMachine {
 public:
  DraftMachine(int player_count, int crown_seat)
      : player_count_(player_count), crown_seat_(crown_seat), step_(0), sub_(DraftSub::Pick) {
    if (player_count < 2 || player_count > 8) throw std::invalid_argument("player count");
    total_steps_ = player_count == 2 ? 4 : player_count == 3 ? 6 : player_count;
  }

  int current_player() const {
    if (complete()) return -1;
    return (crown_seat_ + step_) % player_count_;
  }

  DraftSub sub() const { return sub_; }
  int step() const { return step_; }
  bool complete() const { return step_ >= total_steps_; }

  bool apply(ActionType action) {
    if (complete()) return false;
    if (sub_ == DraftSub::Pick && action != ActionType::DraftPick) return false;
    if (sub_ == DraftSub::Discard && action != ActionType::DraftDiscard) return false;
    if (sub_ == DraftSub::Pick && requires_discard()) {
      sub_ = DraftSub::Discard;
      return true;
    }
    ++step_;
    sub_ = complete() ? DraftSub::Complete : DraftSub::Pick;
    return true;
  }

 private:
  bool requires_discard() const {
    return player_count_ == 2 && (step_ == 1 || step_ == 2);
  }

  int player_count_;
  int crown_seat_;
  int step_;
  int total_steps_;
  DraftSub sub_;
};

}  // namespace citadels::native
