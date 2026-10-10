#include <iostream>
#include "seat_policy_evaluator.hpp"
using namespace citadels::native;
struct State { std::vector<int> players{0,1,2}; int depth=0, action=0; };
struct Game : GameAdapter<State,int> {
  mutable int counts[2]{};
  std::vector<int> legal_actions(const State& s,int) const override {
    return s.depth==0 ? std::vector<int>{0} : s.depth==1 ? std::vector<int>{0,1} : std::vector<int>{};
  }
  bool apply(State& s,int,const int& a) const override {
    if(s.depth==1){++counts[a];s.action=a;} ++s.depth;return true;
  }
  int next_player(const State&) const override{return 1;}
  bool terminal(const State& s) const override{return s.depth==2;}
  float terminal_value(const State& s,int p) const override{return p==0 ? float(s.action==0) : float(s.action==1);}
  InformationSetKey information_set_hash(const State& s,int) const override{return {uint64_t(s.depth),uint64_t(s.action)};}
};
struct Model : BatchedEvaluator<State,int> {
  float first; int batches=0, rows=0;
  explicit Model(float p):first(p){}
  Evaluation evaluate(const State&,int,const std::vector<int>& a) override {
    Evaluation e;e.priors=a.size()==2?std::vector<float>{first,1-first}:std::vector<float>{1};
    e.has_value_vector=true;e.value_vector[0]=first;return e;
  }
  std::vector<Evaluation> evaluate_batch(const std::vector<State>& s,const std::vector<int>& p,
      const std::vector<std::vector<int>>& a) override {
    ++batches;rows+=int(s.size());return BatchedEvaluator::evaluate_batch(s,p,a);
  }
};
void require(bool b,const char* msg){if(!b)throw std::runtime_error(msg);}
int main(){
  Model root(.99f),history(.2f);
  SeatPolicyEvaluator<State,int> routing(root,{{1,&history},{2,&history}});
  const auto values=routing.evaluate_batch({State{},State{},State{}},{0,1,2},{{0,1},{0,1},{0,1}});
  require(history.batches==1 && history.rows==2,"Shared opponent model was not batched");
  require(values[0].priors[0]==.99f && values[1].priors[0]==.2f && values[2].priors[0]==.2f,"Wrong seat model");
  require(values[1].value_vector[0]==.99f,"Historical model replaced learner value");
  SeatPolicyEvaluator<State,int> same(root,{{1,&root}});
  const int before=root.batches;
  same.evaluate_batch({State{}},{1},{{0,1}});
  require(root.batches==before+1,"Current opponent duplicated model inference");
  Game game;Mcts<State,int>::Config config;config.simulations=5000;config.seed=27;config.max_depth=4;
  const int history_before=history.rows;
  auto run=[&]{return BatchedMcts<State,int>(game,routing,config,{},[&](int p){return routing.has_policy(p);}).search(State{},0,32);};
  auto result=run();
  require(result.visits==5000,"Lost simulation credits");
  require(game.counts[0]>800 && game.counts[0]<1200 && game.counts[1]>3700,"Opponent was optimized instead of sampled");
  require(history.rows-history_before==1,"Repeated opponent information set was not cached");
  const int first=game.counts[0];game.counts[0]=game.counts[1]=0;
  run();require(game.counts[0]==first,"Same search seed not reproducible");
  std::cout<<"Seat policies: routing, shared batching, learner values, sampling, caching, seeded replay passed\n";
}
