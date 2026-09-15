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
  for (size_t i = 0; i < state.players.size(); ++i) {
    if (i) std::cout << ',';
    std::cout << native_terminal_reward(state, static_cast<int>(i));
  }
  std::cout << '\n';
  return 0;
}
