#include <iostream>
#include "build_rules.hpp"

int main() {
  using namespace citadels::native;
  const BuildCard green{"酒馆", "green", 1};
  const BuildCard yellow{"城堡", "yellow", 4};
  BuildContext normal{"assassin", false, 4, 0, 1, 0, 0};
  BuildContext overLimit{"assassin", false, 4, 1, 1, 0, 0};
  BuildContext businessman{"businessman", false, 4, 3, 1, 0, 0};
  BuildContext duplicate{"assassin", false, 5, 0, 1, 1, 0};
  BuildContext quarry{"assassin", false, 5, 0, 1, 1, 1};
  BuildContext navigator{"navigator", false, 5, 0, 1, 0, 0};
  std::cout << can_build(yellow, normal) << ',' << can_build(yellow, overLimit)
            << ',' << can_build(green, businessman) << ','
            << can_build(green, duplicate) << ',' << can_build(green, quarry)
            << ',' << can_build(green, navigator) << '\n';
}
