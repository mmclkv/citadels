#include <iostream>

#include "game_state.hpp"

using namespace citadels::native;

int main() {
  auto deck_data = build_base_district_deck(11);
  NativeGameState state;
  state.deck = DeckMachine(std::move(deck_data)); state.rng = JsRng(11); state.active_player = 0;
  state.players.push_back({"p0", "architect", 2, {{"h1", "green", 1}}, {}, false});
  const bool a = state.take_gold();
  const bool b = state.take_gold();
  const bool c = state.end_turn();
  std::cout << a << ',' << b << ',' << c << ',' << state.players[0].gold;
  return 0;
}
