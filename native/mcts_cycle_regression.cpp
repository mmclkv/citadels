#include <iostream>
#include <stdexcept>
#include "game_adapter.hpp"
#include "neural_evaluator.hpp"
#include "heuristic_search.hpp"
#define main citadels_game_worker_main
#include "game_engine_worker.cpp"
#undef main

using namespace citadels::native;
static void require(bool ok, const char* text) { if (!ok) throw std::runtime_error(text); }

struct LoopState { std::vector<int> players{0, 1}; int stage = 0; int progress = 0; };
struct LoopGame : GameAdapter<LoopState, int> {
  bool exit_available = true;
  bool nested_exit = false;
  bool real_progress = false;
  std::vector<int> legal_actions(const LoopState& s, int) const override {
    if (terminal(s)) return {};
    return (s.stage == 0 && exit_available) || (s.stage == 1 && nested_exit)
        ? std::vector<int>{0, 1} : std::vector<int>{0};
  }
  bool apply(LoopState& s, int, const int& a) const override {
    s.stage = a == 1 ? 2 : 1 - s.stage;
    if (real_progress) ++s.progress;
    return true;
  }
  int next_player(const LoopState&) const override { return 0; }
  bool terminal(const LoopState& s) const override { return s.stage == 2 || s.progress >= 4; }
  float terminal_value(const LoopState&, int) const override { return .5f; }
  InformationSetKey information_set_hash(const LoopState&, int) const override { return {1, 1}; }
  InformationSetKey no_progress_key(const LoopState& s, int) const override {
    return {static_cast<uint64_t>(s.stage + 1), static_cast<uint64_t>(s.progress)};
  }
};
struct LoopEvaluator : Evaluator<LoopState, int>, BatchedEvaluator<LoopState, int> {
  int calls = 0;
  Evaluation evaluate(const LoopState&, int, const std::vector<int>& actions) override {
    ++calls;
    Evaluation e; e.priors.assign(actions.size(), 1);
    if (actions.size() == 2) e.priors = {.999f, .001f};
    e.has_value_vector = true; e.value_vector[0] = 1;
    return e;
  }
};

struct WizardEvaluator : Evaluator<NativeGameState, NativeSearchAction>,
                         BatchedEvaluator<NativeGameState, NativeSearchAction> {
  Evaluation evaluate(const NativeGameState&, int, const std::vector<NativeSearchAction>& actions) override {
    for (const auto& action : actions)
      require(action.type != ActionType::PendingBack, "network evaluated an AI navigation action");
    Evaluation e; e.priors.assign(actions.size(), actions.empty() ? 0 : 1.0f / actions.size());
    return e;
  }
};

static void test_search(bool batched) {
  LoopGame game;
  LoopEvaluator evaluator;
  Mcts<LoopState, int>::Config config;
  config.simulations = 500; config.max_depth = 700;
  const auto search = [&] {
    if (batched) return BatchedMcts<LoopState, int>(game, evaluator, config).search(LoopState{}, 0, 32);
    return Mcts<LoopState, int>(game, evaluator, config).search(LoopState{}, 0);
  };
  auto result = search();
  require(result.policy.size() == 2 && result.policy[0] == 0 && result.policy[1] == 1,
          "search still prefers the no-progress loop");
  require(result.visits == 499, "cycle detection fabricated a visit/value backup");
  require(evaluator.calls == 2, "loop created an unbounded chain of leaf evaluations");
  game.nested_exit = true;
  result = search();
  require(result.visits == 499 && result.policy[0] > 0,
          "pruning Back also removed the branch's forward exit");
  game.nested_exit = false;
  game.exit_available = false;
  bool rejected = false;
  try { search(); } catch (const std::runtime_error&) { rejected = true; }
  require(rejected, "all-cyclic search silently returned a cyclic policy");
  game.real_progress = true;
  result = search();
  require(result.visits == 500 && result.policy[0] == 1,
          "observational aliases with real progress were incorrectly pruned");
}

static void test_wizard() {
  NativeGameAdapter game;
  NativeGameState state;
  state.phase = NativePhase::Action; state.active_player = 0; state.has_turn = true;
  state.turn_phase = "main"; state.resources_taken = true;
  state.players = {{"wizard", "wizard", 5}, {"target", "merchant", 2}};
  state.players[1].hand = {{"test-card", "green", 1, "Market"}};
  state.pending_kind = "wizard_card"; state.pending_target = 1;
  state.pending_cards = state.players[1].hand;
  const auto original_key = game.no_progress_key(state, 0);
  const auto selection = game.ai_actions(state, 0);
  require(selection.size() == 1 && game.apply(state, 0, selection[0]), "wizard card selection failed");
  const auto features_before = encode_features(state, 0, 8);
  const auto human = game.legal_actions(state, 0);
  const auto ai = game.ai_actions(state, 0);
  require(human.size() == 3 && ai.size() == 2, "human Back or AI take/build options were lost");
  WizardEvaluator wizard_evaluator;
  Mcts<NativeGameState, NativeSearchAction>::Config wizard_config;
  wizard_config.simulations = 16; wizard_config.max_depth = 4;
  const auto serial = Mcts<NativeGameState, NativeSearchAction>(game, wizard_evaluator, wizard_config).search(state, 0);
  const auto batched = BatchedMcts<NativeGameState, NativeSearchAction>(game, wizard_evaluator, wizard_config).search(state, 0, 8);
  require(serial.policy.size() == 2 && batched.policy.size() == 2,
          "native search root actions differ from the live/training action list");
  // Exercise the real IPC dispatch, not just the adapter. No production process
  // is started or changed: the worker owns this fixture in this test process.
  const auto ipc = [&](const std::string& mode, bool bot) {
    auto fixture = state; fixture.players[0].is_bot = bot;
    games["cycle-fixture"] = fixture;
    std::istringstream input("{\"id\":\"test\",\"mode\":\"" + mode +
        "\",\"gameId\":\"cycle-fixture\",\"playerId\":\"wizard\","
        "\"action\":{\"type\":\"pending_back\"}}\n");
    std::ostringstream output;
    auto* old_input = std::cin.rdbuf(input.rdbuf());
    auto* old_output = std::cout.rdbuf(output.rdbuf());
    std::cin.clear();
    citadels_game_worker_main();
    std::cin.rdbuf(old_input); std::cout.rdbuf(old_output); std::cin.clear();
    return parse_json(output.str());
  };
  const auto human_ipc = ipc("actions", false);
  const auto bot_ipc = ipc("actions", true);
  const auto training_ipc = ipc("decision", true);
  require(human_ipc.get("actions") && human_ipc.get("actions")->as_array().size() == 3,
          "human IPC lost Back");
  require(bot_ipc.get("actions") && bot_ipc.get("actions")->as_array().size() == 2,
          "live AI IPC still exposes Back");
  require(training_ipc.get("actions") && training_ipc.get("actions")->as_array().size() == 2,
          "training IPC action count disagrees with live AI");
  const auto npc_ipc = ipc("npc", true);
  require(npc_ipc.get("action") && string_field(*npc_ipc.get("action"), "type") != "pending_back",
          "NPC selected navigation instead of completing the ability");
  require(string_field(ipc("apply", true), "t") == "error", "AI apply accepts navigation Back");
  require(string_field(ipc("apply", false), "t") == "game_result", "human apply cannot navigate Back");
  for (size_t i = 0; i < ai.size(); ++i) {
    require(ai[i].type != ActionType::PendingBack, "AI can still navigate Back");
    require(encode_network_action(ai[i], &state, 0) == encode_network_action(human[i], &state, 0),
            "existing action encoding changed");
  }
  require(encode_features(state, 0, 8) == features_before, "state input changed");
  NativeHeuristicAdapter heuristic;
  require(heuristic.legal_actions(state, 0).size() == ai.size(), "heuristic search uses a different action set");
  auto take_state = state;
  require(game.apply(take_state, 0, ai[0]) && take_state.pending_kind.empty() &&
          take_state.players[0].hand.size() == 1 && take_state.players[1].hand.empty(),
          "AI cannot complete wizard take");
  require(game.apply(state, 0, human.back()), "human Back is no longer usable");
  require(game.no_progress_key(state, 0) == original_key, "reversible navigation identity is inconsistent");
  ++state.players[0].gold;
  require(!(game.no_progress_key(state, 0) == original_key), "resource progress looks like a cycle");
  state.pending_kind.clear();
  require(game.no_progress_key(state, 0) == InformationSetKey{}, "cycle pruning leaked into ordinary gameplay");
}

int main() {
  test_search(false); test_search(true); test_wizard();
  std::cout << "MCTS cycle regression tests passed\n";
}
