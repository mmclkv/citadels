#include <iostream>
#include <string>

#include "draft_machine.hpp"

int main(int argc, char** argv) {
  if (argc < 3) return 2;
  citadels::native::DraftMachine machine(std::stoi(argv[1]), std::stoi(argv[2]));
  for (int i = 3; i < argc; ++i) {
    const auto type = citadels::native::action_type_from_string(argv[i]);
    if (!type || !machine.apply(*type)) return 3;
    if (i > 3) std::cout << ',';
    std::cout << machine.current_player();
  }
  std::cout << '\n';
}
