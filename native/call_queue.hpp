#pragma once

#include <algorithm>
#include <optional>
#include <utility>
#include <vector>

#include "effect_resolution.hpp"

namespace citadels::native {

struct CallEntry {
  int character_number = 0;
  int player_index = -1;
};

struct CalledTurn {
  CallEntry entry;
  CallOutcome outcome = CallOutcome::Normal;
};

class CallQueue {
 public:
  explicit CallQueue(std::vector<CallEntry> entries) : entries_(std::move(entries)) {
    std::stable_sort(entries_.begin(), entries_.end(),
                     [](const CallEntry& left, const CallEntry& right) {
                       return left.character_number < right.character_number;
                     });
  }

  std::optional<CalledTurn> next(CallEffects& effects, CallPlayer* players,
                                 int player_count) {
    while (index_ < entries_.size()) {
      const CallEntry entry = entries_[index_++];
      const auto outcome = resolve_call(effects, entry.character_number,
                                        entry.player_index, players, player_count);
      if (outcome == CallOutcome::SkippedAssassinated) continue;
      return CalledTurn{entry, outcome};
    }
    return std::nullopt;
  }

  size_t index() const { return index_; }
  size_t size() const { return entries_.size(); }

 private:
  std::vector<CallEntry> entries_;
  size_t index_ = 0;
};

}  // namespace citadels::native
