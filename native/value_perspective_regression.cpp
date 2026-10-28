// Diagnostic characterization: actor-conditioned critics can forget root facts.
// This test documents current behavior; it does not change search semantics.
#include <iostream>
#include <stdexcept>
#include "neural_evaluator.hpp"
using namespace citadels::native;
static void check(bool ok, const char* why) { if (!ok) throw std::runtime_error(why); }

static int encoding_checks() {
  int pairs = 0;
  const auto deck = build_base_district_deck(123);
  for (int n : {4, 6, 8}) for (int version : {14, 15, 16}) {
    NativeGameState s; s.players.resize(n); s.active_player = 1;
    s.has_turn = true; s.phase = NativePhase::Action; s.turn_phase = "main";
    for (int p = 0; p < n; ++p) {
      s.players[p].id = "p" + std::to_string(p);
      s.players[p].hand = {deck[p]};
    }
    s.deck = DeckMachine(std::vector<DistrictCard>(deck.begin()+n,deck.end()));
    const auto root = encode_network_state(s, 0, version);
    const auto actor = encode_network_state(s, 1, version);
    int tested = 0;
    for (const auto& card : deck) {
      auto changed = s; changed.players[0].hand = {card};
      // Exchange with an unobserved draw pile: public counts stay fixed.
      for (auto& drawn : changed.deck.deck_cards())
        if (drawn.uid == card.uid) { drawn=s.players[0].hand[0]; break; }
      if (encode_network_state(changed, 0, version) == root) continue;
      check(encode_network_state(changed, 1, version) == actor,
            "Opponent encoding unexpectedly exposes root's private hand");
      ++tested; ++pairs;
      if (tested == 10) break;
    }
    check(tested == 10, "Not enough distinct root-hand counterfactuals");
  }
  NativeGameState s; s.players.resize(4); s.active_player = 1;
  s.has_turn = true; s.phase = NativePhase::Action; s.turn_phase = "main";
  for (int p = 0; p < 4; ++p) s.players[p].id = "p" + std::to_string(p);
  s.players[2].hand = {deck[0]}; s.known_hand_cards.push_back({0,2,deck[0].uid});
  auto changed = s;
  for (const auto& card : deck) if (district_identity_index(card) != district_identity_index(deck[0])) {
    changed.players[2].hand = {card}; changed.known_hand_cards[0].uid = card.uid; break;
  }
  check(encode_network_state(s,0,16) != encode_network_state(changed,0,16),
        "Root's legitimately observed opponent card must be distinguishable");
  check(encode_network_state(s,1,16) == encode_network_state(changed,1,16),
        "Another actor must not inherit root's private observation");
  return pairs;
}

struct ViewState { std::vector<int> players{0,1,2}; int step=0, secret=0; };
struct ViewGame : GameAdapter<ViewState,int> {
  std::vector<int> legal_actions(const ViewState& s,int) const override {
    return terminal(s) ? std::vector<int>{} : s.step==0 ? std::vector<int>{0,1} : std::vector<int>{0};
  }
  bool apply(ViewState& s,int,const int&) const override { ++s.step; return true; }
  int next_player(const ViewState& s) const override { return s.step % 3; }
  bool terminal(const ViewState& s) const override { return s.step >= 2; }
  float terminal_value(const ViewState& s,int p) const override {
    return p==0 ? (s.secret ? .8f : -.8f) : p==1 ? .3f : -.3f;
  }
  std::array<float,kValueSlots> terminal_value_vector(const ViewState& s,int p) const override {
    std::array<float,kValueSlots> v{};
    for(int r=0;r<3;++r) v[r]=terminal_value(s,(p+r)%3);
    return v;
  }
};
// Exact conditional expectation for this toy, with a 50:50 secret prior for B.
// A knows its secret; B knows neither alternative. No learned error is involved.
struct ConditionalCritic : Evaluator<ViewState,int>, BatchedEvaluator<ViewState,int> {
  std::vector<int> actors;
  Evaluation evaluate(const ViewState& s,int p,const std::vector<int>& actions) override {
    actors.push_back(p); Evaluation e; e.has_value_vector=true;
    e.priors.assign(actions.size(),1.f/actions.size());
    const float absolute[] = {p==0 ? (s.secret ? .8f : -.8f) : 0.f,.3f,-.3f};
    for(int r=0;r<3;++r) e.value_vector[r]=absolute[(p+r)%3];
    return e;
  }
};
static void search_checks(bool batched,int batch) {
  ViewGame game;
  for(int secret : {0,1}) for(int depth : {1,2}) {
    ConditionalCritic critic; ViewState s; s.secret=secret;
    Mcts<ViewState,int>::Config c; c.simulations=1; c.max_depth=depth;
    auto r = batched ? BatchedMcts<ViewState,int>(game,critic,c).search(s,0,batch)
                    : Mcts<ViewState,int>(game,critic,c).search(s,0);
    check(r.visits==1,"Incorrect visit count");
    const float expected=depth==1 ? 0.f : secret ? .8f : -.8f;
    check(std::abs(r.value_vector[0]-expected)<1e-6f,"Unexpected root value");
    check(std::abs(r.value_vector[1]-.3f)<1e-6f && std::abs(r.value_vector[2]+.3f)<1e-6f,
          "Seat rotation is incorrect");
    check(critic.actors==(depth==1 ? std::vector<int>({0,1}) : std::vector<int>({0})),"Unexpected evaluator viewpoint");
  }
}
int main() try {
  const int pairs=encoding_checks(); search_checks(false,1);
  for(int batch : {1,8,32}) search_checks(true,batch);
  std::cout << "Value-perspective regression tests passed: " << pairs
    << " real-encoder pairs; v14/v15/v16; 4/6/8 players; known-hand privacy; "
       "16 serial/batched search cases. Actor-leaf root value=0 for both secrets; "
       "terminal root values=-0.8/+0.8; seat rotation correct.\n";
}
catch (const std::exception& e) { std::cerr << e.what() << std::endl; return 1; }
