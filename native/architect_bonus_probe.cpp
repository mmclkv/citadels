#include <iostream>
#include <stdexcept>

#include "game_state.hpp"

using namespace citadels::native;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

NativeGameState architect_state(uint32_t seed) {
  NativeGameState state;
  state.deck = DeckMachine(build_base_district_deck(seed));
  state.rng = JsRng(seed);
  state.phase = NativePhase::Action;
  state.active_player = 0;
  state.players.push_back({"p0", "architect", 2, {{"held", "blue", 2}}, {}, false});
  return state;
}

int main() {
  auto takes_gold = architect_state(17);
  require(takes_gold.take_gold(), "architect could not take gold");
  require(takes_gold.players[0].gold == 4, "architect gold resource is incorrect");
  require(takes_gold.players[0].hand.size() == 3,
          "architect did not receive two bonus cards after taking gold");
  takes_gold.after_resources();
  require(takes_gold.players[0].hand.size() == 3,
          "architect bonus cards were granted more than once");

  auto takes_cards = architect_state(23);
  require(takes_cards.take_cards(), "architect could not take cards");
  require(takes_cards.pending_kind == "draw_keep" && takes_cards.pending_cards.size() == 2,
          "architect card-resource choice must offer the normal two-card draw");
  const auto keep_uid = takes_cards.pending_cards.front().uid;
  require(takes_cards.keep_pending_card(keep_uid), "architect could not keep a drawn card");
  require(takes_cards.players[0].hand.size() == 4,
          "architect card resource plus two bonus cards has incorrect hand size");
  require(takes_cards.bonus_done, "architect card bonus was not marked as granted");

  auto next_role = architect_state(31);
  next_role.players.push_back({"p1", "", 2, {}, {}, false});
  next_role.players[0].role_id = "navigator";
  next_role.players[0].gold = 0;
  next_role.players[0].played = {"navigator"};
  next_role.players[1].role_id = "architect";
  next_role.active_player = 0;
  next_role.resources_taken = true;
  next_role.ability_used = true;
  next_role.bonus_done = true;
  next_role.call_queue = {{"navigator", 7, 0}, {"architect", 7, 1}};
  next_role.call_index = 0;
  require(next_role.end_turn(), "navigator turn did not advance to architect");
  require(next_role.active_player == 1 && !next_role.bonus_done && !next_role.ability_used,
          "per-turn ability flags were not reset for the next called character");
  require(next_role.take_gold() && next_role.players[1].hand.size() == 2,
          "architect bonus was blocked by a previous character's per-turn flag");

  std::cout << "architect bonus checks passed\n";
}
