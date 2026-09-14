#include <cstdlib>
#include <iomanip>
#include <iostream>

#include "js_rng.hpp"

int main(int argc, char** argv) {
  const uint32_t seed = argc > 1 ? static_cast<uint32_t>(std::strtoul(argv[1], nullptr, 10)) : 1u;
  const int count = argc > 2 ? std::atoi(argv[2]) : 8;
  citadels::native::JsRng rng(seed);
  std::cout << std::setprecision(17);
  for (int i = 0; i < count; ++i) {
    if (i) std::cout << ',';
    std::cout << rng.next();
  }
  std::cout << '\n';
}
