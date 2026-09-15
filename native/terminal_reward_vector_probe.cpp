#include <iostream>
#include <iomanip>
#include <string>

#include "game_adapter.hpp"
#include "state_loader.hpp"

using namespace citadels::native;

int main() {
  std::string line;
  if (!std::getline(std::cin, line)) return 2;
  const NativeGameState state = load_native_state(parse_json(line));
  std::cout << std::setprecision(9);
  for (size_t perspective = 0; perspective < state.players.size(); ++perspective) {
    if (perspective) std::cout << ';';
    const auto values = native_terminal_reward_vector(state, static_cast<int>(perspective));
    for (size_t slot = 0; slot < kValueSlots; ++slot) {
      if (slot) std::cout << ',';
      std::cout << values[slot];
    }
  }
  std::cout << '\n';
  return 0;
}
