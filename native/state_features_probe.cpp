#include <cstdlib>
#include <iomanip>
#include <iostream>

#include "json_value.hpp"
#include "neural_evaluator.hpp"
#include "state_loader.hpp"

int main(int argc, char** argv) {
  const int perspective = argc > 1 ? std::atoi(argv[1]) : 0;
  std::string line;
  if (!std::getline(std::cin, line)) return 2;
  try {
    const auto state = citadels::native::load_native_state(citadels::native::parse_json(line));
    const auto vector = citadels::native::encode_network_state(state, perspective);
    std::cout << std::setprecision(9);
    for (size_t i = 0; i < vector.size(); ++i) {
      if (i) std::cout << ',';
      std::cout << vector[i];
    }
    std::cout << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
