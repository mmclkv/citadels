#include <iostream>
#include "city_machine.hpp"

int main() {
  using namespace citadels::native;
  CityState city{6, 2, 7, 0, 0, 8, false};
  BuildCard card{"城堡", "yellow", 4};
  BuildContext context{"assassin", false, 6, 0, 1, 0, 0};
  std::cout << apply_build(city, card, context) << ',' << city.gold << ','
            << city.hand_count << ',' << city.city_count << ',' << city.builds
            << ',' << city.spent_on_build << ',' << city.first_to_finish << '\n';
}
