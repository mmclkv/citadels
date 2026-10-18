#include <cmath>
#include <iostream>
#include <stdexcept>
#include "game_adapter.hpp"

using namespace citadels::native;
static void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }

struct HiddenState {
  std::vector<int> players{0, 1};
  int phase = 0, hidden = 0, guess = -1, signal = 0;
  bool safe = false;
};
struct HiddenGame : GameAdapter<HiddenState, int> {
  bool guessing(const HiddenState& s) const { return s.phase == (s.signal == 2 ? 3 : 2); }
  std::vector<int> legal_actions(const HiddenState& s, int) const override {
    if (terminal(s)) return {};
    if (s.phase == 0 && s.safe) return {2, 3};
    return guessing(s) ? std::vector<int>{0, 1} : std::vector<int>{2};
  }
  bool apply(HiddenState& s, int, const int& action) const override {
    if (s.phase == 0 && action == 3) { s.guess = 3; s.phase = 4; return true; }
    if (guessing(s)) { s.guess = action; s.phase = 4; } else ++s.phase;
    return true;
  }
  int next_player(const HiddenState& s) const override {
    return s.phase == 1 || (s.phase == 2 && s.signal == 2) ? 1 : 0;
  }
  bool terminal(const HiddenState& s) const override { return s.phase == 4; }
  float terminal_value(const HiddenState& s, int player) const override {
    const float reward = s.guess == 3 ? .75f : s.guess == s.hidden ? 1.f : 0.f;
    return player == 0 ? reward : 1-reward;
  }
  std::array<float, kValueSlots> terminal_value_vector(const HiddenState& s, int player) const override {
    std::array<float, kValueSlots> result{};
    result[0] = terminal_value(s, player); result[1] = 1-result[0]; return result;
  }
  InformationSetKey information_set_hash(const HiddenState& s, int player) const override {
    InformationSetKeyBuilder b; b.i32(player); b.i32(s.phase); b.i32(s.signal);
    if (player == 1 || (s.signal && s.phase == 2)) b.i32(s.hidden);
    return b.finish();
  }
};
struct NeutralEvaluator : Evaluator<HiddenState, int>, BatchedEvaluator<HiddenState, int> {
  Evaluation evaluate(const HiddenState&, int, const std::vector<int>& actions) override {
    Evaluation result; result.priors.assign(actions.size(), 1.f/std::max<size_t>(1, actions.size()));
    result.value = .5f; result.has_value_vector = true;
    result.value_vector[0] = result.value_vector[1] = .5f; return result;
  }
};

static void test_search(bool batched, int batch) {
  HiddenGame game; NeutralEvaluator evaluator;
  Mcts<HiddenState, int>::Config config;
  config.simulations = 20000; config.max_depth = 10; config.seed = 123; config.dirichlet_epsilon = 0;
  std::vector<HiddenState> worlds(2); worlds[1].hidden = 1;
  const auto search = [&](const std::vector<float>& weights = std::vector<float>{}) {
    if (batched) return BatchedMcts<HiddenState, int>(game, evaluator, config).search(worlds, 0, batch, weights);
    return Mcts<HiddenState, int>(game, evaluator, config).search(worlds, 0, weights);
  };
  const auto blind = search();
  require(std::abs(blind.value-.5f) < .025f, "Private opponent branch leaked into future own decision");
  require(blind.visits == config.simulations, "Information sharing lost or duplicated completed visits");
  config.share_information_history = false;
  require(search().value > .97f, "History-off ablation must reproduce private-branch strategy fusion");
  config.share_information_history = true;
  const auto weighted = search({4,1});
  require(std::abs(weighted.value-.8f) < .025f, "Shared decision did not optimize the weighted distribution");
  for (auto& world : worlds) world.safe = true;
  const auto safe = search();
  require(safe.policy[1] > .95f && std::abs(safe.value-.75f) < .025f,
          "Search preferred an impossible clairvoyant plan over a better safe action");
  for (auto& world : worlds) { world.safe = false; world.signal = 1; }
  require(search().value > .95f, "Legitimately observed information was incorrectly merged");
  for (auto& world : worlds) world.signal = 2;
  auto a = worlds[0], b = worlds[1]; a.phase = b.phase = 3;
  require(game.information_set_hash(a, 0) == game.information_set_hash(b, 0), "Memory test must alias current observations");
  require(search().value > .95f, "Past private observations were forgotten after the signal disappeared");
}

static void test_native_visibility() {
  NativeGameAdapter game; NativeGameState state;
  state.phase = NativePhase::Action; state.active_player = 1; state.has_turn = true; state.turn_phase = "main";
  state.players = {{"p0", "", 2}, {"p1", "merchant", 2}, {"p2", "", 2}};
  state.players[0].hand = {{"a", "green", 1, "Market"}};
  state.players[1].hand = {{"b", "blue", 2, "Church"}};
  state.players[2].hand = {{"c", "red", 3, "Prison"}};
  state.players[1].role_ids = {"merchant"}; state.magistrate_player = 1;
  state.magistrate_nums = {4,2,6}; state.magistrate_signed = 4;
  const auto original = game.observation_hashes(state);
  auto changed = state; changed.players[1].hand[0].uid = "secret-other";
  changed.players[1].role_ids = {"bishop"}; changed.magistrate_signed = 6;
  std::reverse(changed.magistrate_nums.begin(), changed.magistrate_nums.end()); changed.rng = JsRng(1234);
  const auto hidden = game.observation_hashes(changed);
  require(original[0] == hidden[0] && original[2] == hidden[2], "Hidden hand/role/commitment/order/RNG changed another viewer's observation");
  require(!(original[1] == hidden[1]), "Owner's private information was lost");
  state.active_player = 0; state.pending_kind = "wizard_card"; state.pending_target = 1;
  changed = state; changed.players[1].hand[0].uid = "seen-other";
  const auto seen_a = game.observation_hashes(state), seen_b = game.observation_hashes(changed);
  require(!(seen_a[0] == seen_b[0]) && seen_a[2] == seen_b[2], "Wizard visibility was not viewer-specific");
  NativeSearchAction action; action.type = ActionType::MagistrateSigned; action.num = 2;
  auto other = action; other.num = 6;
  require(game.visible_action_hash(state, 1, 0, action) == game.visible_action_hash(state, 1, 0, other),
          "Private action argument leaked through the event history");
  require(!(game.visible_action_hash(state, 1, 1, action) == game.visible_action_hash(state, 1, 1, other)),
          "Actor must remember their own private choice");
}

int main() {
  test_search(false, 1);
  for (int batch : {1, 8, 32, 128}) test_search(true, batch);
  test_native_visibility();
  std::cout << "Information-set regression tests passed\n";
}
