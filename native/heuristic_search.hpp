#pragma once

#include <chrono>
#include <cerrno>
#include <cstdlib>
#include "npc_policy.hpp"
#include "determinize.hpp"

namespace citadels::native {

class NativeHeuristicEvaluator final : public Evaluator<NativeGameState,NativeSearchAction> {
 public:
  Evaluation evaluate(const NativeGameState& s,int player,
                      const std::vector<NativeSearchAction>& actions) override {
    Evaluation result;
    if(player<0 || player>=static_cast<int>(s.players.size()))return result;
    std::vector<double> utilities;
    double mean=0;
    for(const auto& a:actions) {const double v=NativeNpcPolicy::search_utility(s,player,a);utilities.push_back(v);mean+=v;}
    if(!utilities.empty())mean/=utilities.size();
    double variance=0;
    for(double v:utilities)variance+=(v-mean)*(v-mean);
    const double scale=std::max(1.0,std::sqrt(variance/std::max<size_t>(1,utilities.size())));
    double total=0;
    for(double v:utilities){result.priors.push_back(static_cast<float>(std::exp(std::clamp((v-mean)/scale,-3.0,3.0))));total+=result.priors.back();}
    // No root noise in real games. A probability floor prevents heuristics
    // from excluding initially unattractive actions such as ending the turn.
    for(float& p:result.priors)p=static_cast<float>(0.85*p/total+0.15/actions.size());
    result.has_value_vector=true;
    if(s.phase==NativePhase::GameOver)result.value_vector=native_terminal_reward_vector(s,player);
    else {
      std::vector<double> strength;
      for(size_t i=0;i<s.players.size();++i)strength.push_back(NativeNpcPolicy::search_strength(s,static_cast<int>(i),player));
      for(size_t r=0;r<s.players.size() && r<kValueSlots;++r) {
        const size_t own=(player+r)%s.players.size();double expected_rank=0;
        for(size_t other=0;other<s.players.size();++other)if(other!=own)
          expected_rank+=1/(1+std::exp(std::clamp((strength[own]-strength[other])/6.0,-20.0,20.0)));
        result.value_vector[r]=s.players.size()==1?1:static_cast<float>(1-2*expected_rank/(s.players.size()-1));
      }
    }
    result.value=result.value_vector[0];return result;
  }
};

struct HeuristicSearchConfig {
  int simulations=128;
  int particles=8;
  int max_depth=32;
  int time_budget_ms=200;
  int critical_time_budget_ms=400;
  float c_puct=1.4f;
  bool enabled=true;
};
inline HeuristicSearchConfig heuristic_search_defaults() {
  HeuristicSearchConfig config;
  const auto read=[](const char* name,int fallback,int minimum) {
    const char* raw=std::getenv(name);if(!raw)return fallback;
    char* end=nullptr;errno=0;const long value=std::strtol(raw,&end,10);
    return errno==0 && end!=raw && *end=='\0' && value>=minimum && value<=std::numeric_limits<int>::max()
      ? static_cast<int>(value):fallback;
  };
  config.simulations=read("CITADELS_HEURISTIC_MCTS_SIMULATIONS",config.simulations,1);
  config.particles=read("CITADELS_HEURISTIC_MCTS_PARTICLES",config.particles,1);
  config.max_depth=read("CITADELS_HEURISTIC_MCTS_MAX_DEPTH",config.max_depth,1);
  config.time_budget_ms=read("CITADELS_HEURISTIC_MCTS_TIME_MS",config.time_budget_ms,0);
  config.critical_time_budget_ms=read("CITADELS_HEURISTIC_MCTS_CRITICAL_TIME_MS",config.critical_time_budget_ms,0);
  const char* enabled=std::getenv("CITADELS_HEURISTIC_MCTS_ENABLED");
  config.enabled=!enabled || std::string(enabled)!="0";
  return config;
}
struct HeuristicDecision {
  int selected=-1;
  int visits=0;
  int expansions=0;
  int particles=0;
  double elapsed_ms=0;
  bool searched=false;
  bool fallback=false;
  std::string fallback_reason;
};

inline bool heuristic_actions_equal(const NativeSearchAction& a,const NativeSearchAction& b) {
  return a.type==b.type && a.uid==b.uid && a.name==b.name && a.effect==b.effect &&
    a.target==b.target && a.selected_uids==b.selected_uids && a.secondary_uid==b.secondary_uid &&
    a.mode==b.mode && a.color==b.color && a.num==b.num && a.gold==b.gold && a.cards==b.cards &&
    a.use==b.use && a.has_num==b.has_num;
}

// One entry point for real games and training NPC advancement. The neural
// worker keeps its inexpensive NativeNpcPolicy simulation policy: no nested MCTS.
inline HeuristicDecision choose_native_npc(const NativeGameState& state,int player,
    const std::vector<NativeSearchAction>& actions,uint32_t seed=1,
    HeuristicSearchConfig options=heuristic_search_defaults()) {
  HeuristicDecision decision;
  if(actions.empty() || player<0 || player>=static_cast<int>(state.players.size()))return decision;
  if(actions.size()==1){decision.selected=0;return decision;}
  if(!options.enabled || state.players[player].bot_level!="hard" || actions.front().type==ActionType::ConfirmRound) {
    decision.selected=NativeNpcPolicy::choose(state,player,actions,seed);return decision;
  }
  const auto start=std::chrono::steady_clock::now();
  try {
    NativeGameAdapter rules;
    std::vector<NativeGameState> particles;
    for(int i=0;i<std::max(1,options.particles);++i) {
      auto world=determinize_native_state(state,player,seed+static_cast<uint32_t>(i)*0x9e3779b9u,true);
      const auto legal=rules.legal_actions(world,player);
      if(legal.size()!=actions.size())continue;
      bool aligned=true;
      for(size_t j=0;j<legal.size();++j)if(!heuristic_actions_equal(legal[j],actions[j])){aligned=false;break;}
      if(aligned)particles.push_back(std::move(world));
    }
    if(particles.empty())throw std::runtime_error("No legal information-set particles");
    Mcts<NativeGameState,NativeSearchAction>::Config config;
    config.simulations=std::max(1,options.simulations);config.max_depth=std::max(1,options.max_depth);
    config.seed=seed;config.c_puct=options.c_puct;config.dirichlet_epsilon=0;
    bool critical=state.phase==NativePhase::Draft;
    for(const auto& p:state.players)if(p.city.size()+2>=static_cast<size_t>(state.end_districts))critical=true;
    config.time_budget_ms=critical?options.critical_time_budget_ms:options.time_budget_ms;
    NativeHeuristicEvaluator evaluator;
    const auto result=Mcts<NativeGameState,NativeSearchAction>(rules,evaluator,config).search(particles,player);
    if(result.policy.size()!=actions.size() || result.visits<=0)throw std::runtime_error("No completed heuristic simulations");
    decision.selected=static_cast<int>(std::max_element(result.policy.begin(),result.policy.end())-result.policy.begin());
    decision.visits=result.visits;decision.expansions=result.expansions;
    decision.particles=static_cast<int>(particles.size());decision.searched=true;
  } catch(const std::exception& error) {
    decision.selected=NativeNpcPolicy::choose(state,player,actions,seed);decision.fallback=true;
    decision.fallback_reason=error.what();
  }
  decision.elapsed_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
  return decision;
}

} // namespace citadels::native
