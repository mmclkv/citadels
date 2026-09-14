#include <iostream>
#include "state_loader.hpp"

using namespace citadels::native;

int main() {
  try {
    const auto state = load_native_state_line(
      R"({"state":{"round":3,"rngState":17,"config":{"endDistricts":8},"players":[{"id":"p0","gold":4,"chars":["king"],"hasCrown":true,"hand":[{"uid":"h1","color":"blue","cost":2}],"city":[{"uid":"c1","name":"墓地","color":"purple","cost":5,"purple":{"effect":"graveyard"}}]}],"deck":[{"uid":"d1","color":"red","cost":3}],"discard":[],"turn":{"playerIdx":0,"takenResources":true,"builds":1}}})");
    std::cout << state.players.size() << ',' << state.players[0].hand.size() << ','
            << state.players[0].city[0].effect << ',' << state.deck.deck_count() << ','
            << state.active_player << ',' << state.builds;
  } catch (const std::exception& error) {
    std::cerr << error.what();
    return 1;
  }
}
