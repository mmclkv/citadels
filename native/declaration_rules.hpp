#pragma once

#include <array>

namespace citadels::native {

enum class DeclarationKind { Assassin, Thief, Witch };

struct DeclarationState {
  DeclarationKind kind;
  std::array<bool, 10> active_numbers{};
  int declared_number = 0;
  bool ability_used = false;
};

inline bool declare_target(DeclarationState& state, int number) {
  if (number < 1 || number > 9 || number == 1 || !state.active_numbers[number]) return false;
  state.declared_number = number;
  state.ability_used = true;
  return true;
}

}  // namespace citadels::native
