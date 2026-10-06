#include <iostream>
#include <stdexcept>
#define main citadels_game_worker_main
#include "game_engine_worker.cpp"
#undef main
#include "neural_evaluator.hpp"

using namespace citadels::native;

static void require(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(message);
}

static NativeGameState prepared() {
  NativeGameState state;
  state.phase = NativePhase::Action;
  state.has_turn = true;
  state.active_player = 0;
  state.turn_phase = "main";
  state.resources_taken = true;
  state.pending_kind = "emperor_crown";
  state.players = {{"emperor", "emperor", 2}, {"recipient", "merchant", 3}};
  state.players[0].has_crown = true;
  state.players[1].hand = {{"card", "green", 1, "Market"}};
  NativeGameAdapter game;
  auto crown = decode_action(parse_json(R"({"type":"emperor_crown","target":"recipient"})"));
  require(game.apply(state, 0, crown), "crown transfer failed");
  require(state.pending_target == 1 && state.players[1].has_crown, "wrong crown recipient");
  return state;
}

int main() {
  NativeGameAdapter game;
  for (const char* wire : {R"({"type":"emperor_take","mode":"gold"})",
                            R"({"type":"emperor_take","name":"gold"})"}) {
    auto state = prepared();
    auto action = decode_action(parse_json(wire));
    auto legal = game.legal_actions(state, 0);
    require(std::any_of(legal.begin(), legal.end(), [&](const auto& a) { return matches(a, action); }), "wire gold action rejected");
    require(game.apply(state, 0, action), "wire gold apply failed");
    require(state.players[0].gold == 3 && state.players[1].gold == 2, "gold not transferred");
    require(state.pending_kind.empty() && state.ability_used, "ability not completed");
  }
  auto state = prepared();
  const auto canonical = game.legal_actions(state, 0);
  for (const auto& current : canonical) {
    require(current.name == current.mode, "name/mode are not aligned");
    auto legacy = current;
    legacy.mode.clear();
    require(encode_network_action(current, &state, 0) == encode_network_action(legacy, &state, 0),
            "network action encoding changed");
  }
  NativeSearchAction action;
  action.type = ActionType::EmperorTake;
  action.mode = "gold";
  require(game.apply(state, 0, action), "native mode gold apply failed");
  require(state.players[0].gold == 3 && state.players[1].gold == 2, "native mode gold not transferred");
  require(!game.apply(state, 0, action), "emperor collected twice");
  for (const char* wire : {R"({"type":"emperor_take","mode":"card"})",
                            R"({"type":"emperor_take","name":"card"})"}) {
    auto card_state = prepared();
    require(game.apply(card_state, 0, decode_action(parse_json(wire))), "card take failed");
    require(card_state.players[0].hand.size() == 1 && card_state.players[1].hand.empty(), "card not transferred");
    require(card_state.players[0].gold == 2 && card_state.players[1].gold == 3, "card take changed gold");
  }
  auto empty = prepared();
  empty.players[1].gold = 0;
  require(game.apply(empty, 0, action), "empty target gold choice blocked the turn");
  require(empty.players[0].gold == 2 && empty.players[1].gold == 0 && empty.pending_kind.empty(), "empty gold target result wrong");
  auto wrong_actor = prepared();
  require(!game.apply(wrong_actor, 1, action), "wrong actor could take emperor resources");
  std::cout << "emperor take regressions passed\n";
}
