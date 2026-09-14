#include <iostream>

#include "artist_machine.hpp"

using namespace citadels::native;

int main() {
  ArtistState state;
  state.gold = 2;
  state.city = {{{"c1", "yellow", 3}, "庄园", {}, {}},
                {{"c2", "blue", 2}, "教堂", {}, {}}};
  const bool a = artist_select(state, "c1");
  const bool b = artist_select(state, "c2");
  const bool c = artist_done(state);
  const bool d = artist_select(state, "c1");
  std::cout << a << ',' << b << ',' << c << ',' << d << ',' << state.gold << ','
            << state.city[0].effect << ',' << state.city[1].effect;
  return 0;
}
