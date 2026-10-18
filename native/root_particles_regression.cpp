#include "mcts_core.hpp"
#include <iostream>
#include <thread>

using namespace citadels::native;
static void check(bool value,const char* message) { if(!value) throw std::runtime_error(message); }
struct World { std::vector<int> players{0}; int hidden=0,action=-1; };
struct Game : GameAdapter<World,int> {
  std::vector<int> legal_actions(const World& s,int) const override { return s.action<0?std::vector<int>{0,1}:std::vector<int>{}; }
  bool apply(World& s,int,const int& a) const override { s.action=a;return true; }
  int next_player(const World&) const override { return 0; }
  bool terminal(const World& s) const override { return s.action>=0; }
  float terminal_value(const World& s,int) const override { return s.action==1?.85f:(s.hidden?0.f:1.f); }
  InformationSetKey information_set_hash(const World& s,int) const override {
    InformationSetKeyBuilder b;b.i32(s.action);return b.finish();
  }
};
struct Eval : Evaluator<World,int>,BatchedEvaluator<World,int> {
  Evaluation evaluate(const World&,int,const std::vector<int>& a) override {
    Evaluation e;e.priors.assign(a.size(),1.f/std::max<size_t>(1,a.size()));e.value=.5;return e;
  }
};
static void test_search(bool batched,int batch) {
  Game game;Eval eval;Mcts<World,int>::Config config;
  config.simulations=12000;config.max_depth=3;config.seed=456;
  std::vector<World> initial(4);
  const auto old=batched?BatchedMcts<World,int>(game,eval,config).search(initial,0,batch):Mcts<World,int>(game,eval,config).search(initial,0);
  check(old.policy[0]>.9,"Fixed sample must miss the danger in this fixture");
  ProgressiveRootParticles<World> source;
  source.identity=[](const World& w){return std::to_string(w.hidden);};
  source.add({{World{},0},{World{},0},{World{},0},{World{},0}});
  size_t serial=0;
  source.generate=[&](size_t count) {
    std::vector<ProgressiveRootParticles<World>::Sample> samples;
    for(size_t i=0;i<count;++i) {World w;w.hidden=(++serial%5==0);samples.push_back({w,0});}
    return samples;
  };
  const auto result=batched?BatchedMcts<World,int>(game,eval,config).search(initial,0,batch,{},&source):Mcts<World,int>(game,eval,config).search(initial,0,{},nullptr,&source);
  check(source.proposals==1024 && source.states.size()==2,"Growing pool failed its proposal cap or deduplication");
  check(result.visits==config.simulations,"Adding worlds lost or duplicated search visits");
  check(result.policy[1]>.90 && std::abs(result.value-.85f)<.02,"New worlds did not correct the missed-risk decision");
}
int main() {
  try {
    ProgressiveRootParticles<int> p;p.identity=[](int i){return std::to_string(i);};p.prior_mixture=.2;
    p.add({{1,1000},{1,1000}});p.add({{2,1000+std::log(4.)}});
    check(p.states.size()==2 && p.proposals==3 && p.duplicates==1,"Duplicate mass/count lost");
    check(std::abs(p.weights[0]-.4)<1e-10 && std::abs(p.weights[1]-.6)<1e-10,"Batch scales or mixture multiplicity incorrect");
    check(std::abs(p.effective_samples()-1./(.2*.2+.2*.2+.6*.6))<1e-9,"Wrong importance ESS");
    ProgressiveRootParticles<int> zero;zero.add({{0,-INFINITY},{1,0}});
    check(zero.weights[0]==0 && zero.weights[1]==1,"Zero probability world acquired mass");
    ProgressiveRootParticles<int> all_zero;all_zero.add({{0,-INFINITY},{1,-INFINITY}});
    check(all_zero.weights[0]==.5 && all_zero.weights[1]==.5,"All-zero fallback is invalid");
    size_t calls=0;p.generate=[&](size_t){++calls;return std::vector<ProgressiveRootParticles<int>::Sample>{{3,1000}};};
    p.refresh(32,[]{return true;});check(calls==0,"Expired search generated new roots");
    p.refresh(31,[]{return false;});check(calls==0,"Roots grew before scheduled simulation count");
    p.refresh(32,[]{return false;});check(calls==1,"Scheduled refresh missing");
    test_search(false,1);for(int batch:{1,8,32,128})test_search(true,batch);
    // An absolute deadline also applies to batched initialization/search.
    Game game;Eval eval;Mcts<World,int>::Config c;c.simulations=10000;c.time_budget_ms=10000;
    c.deadline=std::chrono::steady_clock::now()-std::chrono::milliseconds(1);
    check(BatchedMcts<World,int>(game,eval,c).search(std::vector<World>(4),0,32).visits==0,"Batched search reset an expired absolute deadline");
    std::cout<<"Progressive root particle regression tests passed\n";
  } catch(const std::exception& e) {std::cerr<<e.what()<<'\n';return 1;}
}
