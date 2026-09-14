#include <iostream>
#include "prophet_machine.hpp"

int main() {
  using namespace citadels::native;
  ProphetState state;
  state.hand = {{"p", "", 1}};
  state.opponents = {{{"a", "", 1}}, std::vector<DistrictCard>{},
                     {{"b", "", 2}, {"c", "", 3}}};
  JsRng rng(23);
  const bool collect = prophet_collect(state, 0, rng);
  const size_t collected = state.hand.size();
  const bool first = prophet_return(state, 2, 0);
  const bool second = prophet_return(state, 2, 0);
  std::cout << collect << ',' << collected << ',' << first << ',' << second << ','
            << state.hand.size() << ',' << state.opponents[0].size() << ','
            << state.opponents[2].size() << ',' << state.return_queue.size() << '\n';
}
