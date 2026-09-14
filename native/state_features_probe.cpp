#include <iostream>

#include "state_features.hpp"

using namespace citadels::native;

int main() {
  NativeGameState state;
  state.deck = DeckMachine(build_base_district_deck(31));
  state.active_player = 1;
  state.round = 3;
  state.players.push_back({"p0", "merchant", 5, {}, {}, false});
  state.players.push_back({"p1", "architect", 2, {{"h1", "blue", 1}}, {}, true});
  const auto features = encode_features(state);
  std::cout << features.size() << ',' << features[0] << ',' << features[4]
            << ',' << features[16];
  return 0;
}
