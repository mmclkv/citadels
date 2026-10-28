// Standalone forced-action traversal regression; no LibTorch dependency.
#include <iostream>
#include <stdexcept>
#include <thread>
#include "mcts_core.hpp"
using namespace citadels::native;

static void require(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(message);
}
struct ChainState {
  std::vector<int> players{0, 1, 2};
  int step = 0, choice = -1, chance = 0;
};
struct ChainGame : GameAdapter<ChainState, int> {
  int end = 24, branch = -1, fail = -1, delay_ms = 0;
  bool singleton_root = false, random_outcome = false;
  mutable int applications = 0, draws = 0, maximum_step = 0;
  std::vector<int> legal_actions(const ChainState& s, int) const override {
    if (terminal(s)) return {};
    return (s.step == 0 && !singleton_root) || s.step == branch
        ? std::vector<int>{0, 1} : std::vector<int>{0};
  }
  bool apply(ChainState& s, int, const int& a) const override {
    if (s.step == fail) return false;
    if (delay_ms) std::this_thread::sleep_for(std::chrono::milliseconds(delay_ms));
    if (s.step == 0) s.choice = a;
    if (random_outcome && s.step == 6) s.chance = draws++ % 2;
    ++s.step; ++applications; maximum_step = std::max(maximum_step, s.step);
    return true;
  }
  int next_player(const ChainState& s) const override { return s.step % 3; }
  bool terminal(const ChainState& s) const override { return s.step >= end; }
  float terminal_value(const ChainState& s, int p) const override {
    const int choice = random_outcome ? s.chance : s.choice;
    return p == 0 ? (choice == 0 ? .8f : -.6f) : p == 1 ? -.3f : -.5f;
  }
  std::array<float, kValueSlots> terminal_value_vector(const ChainState& s, int p) const override {
    std::array<float, kValueSlots> v{};
    for (int r = 0; r < 3; ++r) v[r] = terminal_value(s, (p + r) % 3);
    return v;
  }
  InformationSetKey information_set_hash(const ChainState& s, int p) const override {
    InformationSetKeyBuilder b;
    b.i32(s.step); b.i32(s.choice); b.i32(s.chance); b.i32(p);
    return b.finish();
  }
};
struct ChainEvaluator : Evaluator<ChainState, int>, BatchedEvaluator<ChainState, int> {
  std::vector<int> steps, actors;
  Evaluation evaluate(const ChainState& s, int p, const std::vector<int>& actions) override {
    steps.push_back(s.step); actors.push_back(p);
    Evaluation e; e.priors.assign(actions.size(), 1.f / std::max<size_t>(1, actions.size()));
    const float absolute[] = {.25f, .5f, -.75f};
    e.has_value_vector = true;
    for (int r = 0; r < 3; ++r) e.value_vector[r] = absolute[(p + r) % 3];
    return e;
  }
};
static auto search(ChainGame& g, ChainEvaluator& e, bool batched, int batch,
                   Mcts<ChainState, int>::Config config) {
  if (batched) return BatchedMcts<ChainState, int>(g, e, config).search(ChainState{}, 0, batch);
  return Mcts<ChainState, int>(g, e, config).search(ChainState{}, 0);
}
static void run(bool batched, int batch, bool history) {
  Mcts<ChainState, int>::Config c;
  c.simulations = 64; c.max_depth = 40; c.share_information_history = history;
  {
    ChainGame g; ChainEvaluator e;
    const auto r = search(g, e, batched, batch, c);
    require(r.visits == 64, "Forced chain lost or duplicated visits");
    require(e.steps == std::vector<int>{0}, "Forced chain still stopped for a network estimate");
    require(g.applications == 64 * g.end, "Forced chain was not applied once per complete simulation");
    const float expected = r.policy[0] * .8f + r.policy[1] * -.6f;
    require(std::abs(r.value_vector[0] - expected) < 1e-5f &&
            std::abs(r.value_vector[1] + .3f) < 1e-5f &&
            std::abs(r.value_vector[2] + .5f) < 1e-5f,
            "Terminal values lost their actor perspective through forced actions");
  }
  {
    ChainGame g; ChainEvaluator e; g.branch = 13;
    auto one = c; one.simulations = 1;
    const auto r = search(g, e, batched, batch, one);
    require(e.steps == std::vector<int>({0, 13}) && e.actors.back() == 1,
            "Search failed to stop at the first genuine decision");
    require(r.visits == 1 && std::abs(r.value_vector[0] - .25f) < 1e-5f &&
            std::abs(r.value_vector[2] + .75f) < 1e-5f,
            "Decision leaf value was not rotated back to root");
    ChainEvaluator baseline; one.fast_forward_single_actions = false;
    search(g, baseline, batched, batch, one);
    require(baseline.steps == std::vector<int>({0, 1}), "Legacy traversal ablation changed");
  }
  {
    ChainGame g; ChainEvaluator e; auto shallow = c; shallow.max_depth = 7;
    const auto r = search(g, e, batched, batch, shallow);
    require(r.visits == 64 && g.maximum_step == 7, "Forced chain exceeded the action depth limit");
    require(e.steps.size() == 3 && e.steps[1] == 7 && e.steps[2] == 7,
            "Depth cutoff must estimate each forced leaf once");
    require(std::abs(r.value_vector[0] - .25f) < 1e-5f,
            "Depth cutoff backed up a forced node's unevaluated zero");
  }
  {
    ChainGame g; ChainEvaluator e; g.fail = 3;
    const auto r = search(g, e, batched, batch, c);
    require(r.visits == 64 && g.maximum_step == 3 && e.steps.size() == 3,
            "Failed forced action must fall back to a real leaf estimate");
    require(std::abs(r.value_vector[0] - .25f) < 1e-5f,
            "Failed forced action fabricated a zero-valued result");
  }
  {
    ChainGame g; ChainEvaluator e;
    g.singleton_root = true; g.random_outcome = true;
    const auto r = search(g, e, batched, batch, c);
    require(g.draws == 64 && e.steps == std::vector<int>{0} && r.visits == 64,
            "Forced traversal cached a random transition instead of applying it");
    require(std::abs(r.value_vector[0] - .1f) < 1e-5f,
            "Random outcomes were not backed up with their actual frequencies");
  }
}
static void test_deadline(bool batched) {
  ChainGame g; ChainEvaluator e;
  g.singleton_root = true; g.end = 100000; g.delay_ms = 3;
  Mcts<ChainState, int>::Config c;
  c.simulations = 1000; c.max_depth = 100000; c.time_budget_ms = 10;
  const auto r = search(g, e, batched, 32, c);
  require(r.visits == 0 && e.steps == std::vector<int>{0} && g.maximum_step < g.end,
          "Timed-out forced path consumed a visit or triggered a new leaf evaluation");
}
int main() {
  for (bool history : {false, true}) {
    run(false, 1, history);
    for (int batch : {1, 8, 32, 128}) run(true, batch, history);
  }
  test_deadline(false); test_deadline(true);
  std::cout << "Forced-action MCTS regression tests passed\n";
}
