#include <iostream>
#include "district_deck.hpp"

int main(int argc, char** argv) {
  const uint32_t seed = argc > 1 ? static_cast<uint32_t>(std::stoul(argv[1])) : 1u;
  const auto deck = citadels::native::build_base_district_deck(seed);
  for (size_t i = 0; i < deck.size(); ++i) {
    if (i) std::cout << ',';
    std::cout << deck[i].uid;
  }
  std::cout << '\n';
}
