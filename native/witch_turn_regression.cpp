#include <algorithm>
#include <iostream>
#include <stdexcept>

#include "game_adapter.hpp"

using namespace citadels::native;

static void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

static bool has_type(const std::vector<NativeSearchAction>& actions,
                     ActionType type) {
  return std::any_of(actions.begin(), actions.end(),
                     [&](const auto& action) { return action.type == type; });
}

int main() {
  NativeGameState state;
  state.phase = NativePhase::Action;
  state.active_player = 0;
  state.has_turn = true;
  state.turn_phase = "main";
  state.resources_taken = true;
  state.pending_kind = "witch_target";
  state.char_deck = {"witch", "navigator"};
  state.players.push_back(NativePlayer{"witch-player", "witch", 3});
  state.players.push_back(NativePlayer{"navigator-player", "navigator", 3});
  state.players[0].role_ids = {"witch"};
  state.players[1].role_ids = {"navigator"};
  state.call_queue = {{"witch", 1, 0}, {"navigator", 7, 1}};
  state.deck = DeckMachine({{"build-card", "yellow", 1, "Market"}});
  state.rng = JsRng(123);

  NativeGameAdapter game;
  NativeSearchAction declare_target;
  declare_target.type = ActionType::ChooseChar;
  declare_target.name = "7";
  require(game.apply(state, 0, declare_target), "Witch target declaration failed");
  require(state.call_index == 1 && state.active_player == 1,
          "Witch kept acting after declaring the target");
  require(state.turn_phase == "bewitched" && state.pending_kind.empty(),
          "Witch declaration did not advance to the next role");

  require(state.take_gold(), "Bewitched Navigator could not take resources");
  require(state.active_player == 0 && state.turn_phase == "witch_resume" &&
              state.players[0].role_id == "navigator",
          "Witch did not resume as the selected Navigator");
  require(has_type(game.legal_actions(state, 0), ActionType::Ability),
          "Witch should retain the Navigator bonus");
  require(!has_type(game.legal_actions(state, 0), ActionType::Build),
          "Witch-resumed Navigator incorrectly has a build action");

  NativeSearchAction use_bonus;
  use_bonus.type = ActionType::Ability;
  require(game.apply(state, 0, use_bonus), "Navigator bonus could not be started");
  NativeSearchAction take_bonus;
  take_bonus.type = ActionType::NavigatorBonus;
  take_bonus.name = "gold";
  require(game.apply(state, 0, take_bonus), "Navigator bonus could not be claimed");
  require(!has_type(game.legal_actions(state, 0), ActionType::Build),
          "Navigator could build after claiming the bonus");
  require(!state.build("build-card", "Market"),
          "Engine accepted a build by a Witch-resumed Navigator");

  std::cout << "witch turn regressions passed\n";
  return 0;
}
