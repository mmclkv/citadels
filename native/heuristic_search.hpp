#pragma once

#include <chrono>
#include <cerrno>
#include <cstdlib>
#include "npc_policy.hpp"
#include "determinize.hpp"

namespace citadels::native {

// Reuse needs exact identity beyond the fixed-size neural feature slots.
// Never include opponents' hidden card/role identities or deck order.
class NativeHeuristicAdapter final : public GameAdapter<NativeGameState,NativeSearchAction> {
 public:
  std::vector<NativeSearchAction> legal_actions(const NativeGameState& s,int p) const override {return rules_.ai_actions(s,p);}
  InformationSetKey no_progress_key(const NativeGameState& s,int p) const override {return rules_.no_progress_key(s,p);}
  bool apply(NativeGameState& s,int p,const NativeSearchAction& a) const override {return rules_.apply(s,p,a);}
  int next_player(const NativeGameState& s) const override {return rules_.next_player(s);}
  bool terminal(const NativeGameState& s) const override {return rules_.terminal(s);}
  float terminal_value(const NativeGameState& s,int p) const override {return rules_.terminal_value(s,p);}
  std::array<float,kValueSlots> terminal_value_vector(const NativeGameState& s,int p) const override {return rules_.terminal_value_vector(s,p);}
  InformationSetKey information_set_hash(const NativeGameState& s,int player) const override {
    InformationSetKeyBuilder b;const auto base=rules_.information_set_hash(s,player);
    b.u64(base.lo);b.u64(base.hi);b.i32(s.round);b.i32(s.end_districts);
    b.u64(s.deck.deck_count());b.u64(s.deck.discard_count());
    for(const auto& p:s.players){b.string(p.id);b.i32(p.gold);b.u64(p.hand.size());b.u64(p.city.size());
      for(const auto& d:p.city){b.string(d.card.uid);b.boolean(d.beautified);b.u64(d.museum_cards.size());}}
    if(player>=0 && player<static_cast<int>(s.players.size())){
      const auto& own=s.players[player];b.string(own.role_id);b.u64(own.role_ids.size());
      for(const auto& role:own.role_ids)b.string(role);
      for(const auto& c:own.hand)b.string(c.uid);
      if(s.active_player==player)for(const auto& c:s.pending_cards)b.string(c.uid);
      if(s.magistrate_player==player)b.i32(s.magistrate_signed);
      if(s.blackmailer_player==player)b.i32(s.blackmailer_signed);
    }
    return b.finish();
  }
 private:
  NativeGameAdapter rules_;
};

class NativeHeuristicEvaluator final : public Evaluator<NativeGameState,NativeSearchAction> {
 public:
  NativeHeuristicEvaluator(int rollout_steps=0,int rollouts=1,uint32_t seed=1,int time_ms=0,
      std::chrono::steady_clock::time_point deadline={})
      : rollout_steps_(rollout_steps),rollouts_(std::max(1,rollouts)),rng_(seed),time_ms_(time_ms),
        deadline_(deadline != std::chrono::steady_clock::time_point{} ? deadline :
          std::chrono::steady_clock::now()+std::chrono::milliseconds(std::max(0,time_ms))) {}
  int rollout_actions=0,completed_rollouts=0;
  Evaluation evaluate(const NativeGameState& s,int player,
                      const std::vector<NativeSearchAction>& actions) override {
    Evaluation result;
    if(player<0 || player>=static_cast<int>(s.players.size()))return result;
    std::vector<double> utilities(actions.size(),0);
    double mean=0;
    for(size_t i=0;i<actions.size();++i) {
      if(expired())break;
      utilities[i]=NativeNpcPolicy::search_utility(s,player,actions[i]);mean+=utilities[i];
    }
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
    result.value_vector=static_value(s,player);
    if(s.phase!=NativePhase::GameOver && rollout_steps_>0 && !expired()) {
      std::array<float,kValueSlots> accumulated{};
      NativeGameAdapter rules;
      int trials=0;
      for(int trial=0;trial<rollouts_ && !expired();++trial){
        auto world=s;
        for(int step=0;step<rollout_steps_ && !rules.terminal(world);++step){
          if(expired())break;
          const int actor=rules.next_player(world);const auto legal=rules.ai_actions(world,actor);
          if(actor<0 || legal.empty())break;
          if(expired())break;
          const int selected=NativeNpcPolicy::choose_rollout(world,actor,legal,rng_());
          if(expired())break;
          if(selected<0 || !rules.apply(world,actor,legal.at(selected)))
            throw std::runtime_error("Heuristic rollout rejected a legal action");
          ++rollout_actions;
        }
        // Keep the leaf perspective even if the actor changed during rollout.
        const auto tail=static_value(world,player);
        for(size_t i=0;i<kValueSlots;++i)accumulated[i]+=tail[i];
        ++completed_rollouts;
        ++trials;
      }
      if(trials)for(size_t i=0;i<kValueSlots;++i)
        result.value_vector[i]=0.4f*result.value_vector[i]+0.6f*accumulated[i]/trials;
    }
    result.value=result.value_vector[0];return result;
  }

  static std::array<float,kValueSlots> static_value(const NativeGameState& s,int player) {
    if(s.phase==NativePhase::GameOver)return native_terminal_reward_vector(s,player);
    std::array<float,kValueSlots> values{};
    if(player<0 || player>=static_cast<int>(s.players.size()))return values;
    std::vector<double> strength;
    for(size_t i=0;i<s.players.size();++i)strength.push_back(NativeNpcPolicy::search_strength(s,static_cast<int>(i),player));
    for(size_t r=0;r<s.players.size() && r<kValueSlots;++r) {
      const size_t own=(player+r)%s.players.size();double expected_rank=0;
      for(size_t other=0;other<s.players.size();++other)if(other!=own)
        expected_rank+=1/(1+std::exp(std::clamp((strength[own]-strength[other])/6.0,-20.0,20.0)));
      values[r]=s.players.size()==1?1:static_cast<float>(1-2*expected_rank/(s.players.size()-1));
    }
    return values;
  }
 private:
  bool expired() const {return time_ms_>0 && std::chrono::steady_clock::now()>=deadline_;}
  int rollout_steps_,rollouts_;std::mt19937 rng_;int time_ms_;
  std::chrono::steady_clock::time_point deadline_;
};

struct HeuristicSearchConfig {
  int simulations=std::numeric_limits<int>::max();
  int particles=8;
  int max_depth=700;
  int time_budget_ms=10000;
  float c_puct=1.0f;
  bool enabled=true;
  int rollout_steps=8;
  int rollouts=1;
  bool reuse_tree=true;
  int max_tree_nodes=8192;
};
// Runtime has one resource knob. Simulations run until the deadline rather
// than a hardware-dependent estimated count; other sizes are budget tiers.
inline HeuristicSearchConfig heuristic_search_for_budget(int milliseconds) {
  HeuristicSearchConfig config;
  config.time_budget_ms=std::max(1,milliseconds);
  config.simulations=std::numeric_limits<int>::max();
  config.particles=milliseconds<1000?2:milliseconds<5000?4:milliseconds<30000?8:16;
  config.max_depth=static_cast<int>(std::clamp<int64_t>(static_cast<int64_t>(milliseconds)*7/100,64,700));
  config.rollout_steps=milliseconds<1000?4:8;
  config.max_tree_nodes=static_cast<int>(std::clamp<int64_t>(static_cast<int64_t>(milliseconds)*8192/10000,4096,32768));
  return config;
}
inline HeuristicSearchConfig heuristic_search_defaults() {
  const auto read=[](const char* name,int fallback,int minimum) {
    const char* raw=std::getenv(name);if(!raw)return fallback;
    char* end=nullptr;errno=0;const long value=std::strtol(raw,&end,10);
    return errno==0 && end!=raw && *end=='\0' && value>=minimum && value<=std::numeric_limits<int>::max()
      ? static_cast<int>(value):fallback;
  };
  auto config=heuristic_search_for_budget(read("CITADELS_HEURISTIC_MCTS_TIME_MS",10000,1));
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
  int new_visits=0,reused_visits=0,rollout_actions=0,rollouts=0;
  size_t retained_nodes=0;
};

inline bool heuristic_actions_equal(const NativeSearchAction& a,const NativeSearchAction& b) {
  return a.type==b.type && a.uid==b.uid && a.name==b.name && a.effect==b.effect &&
    a.target==b.target && a.selected_uids==b.selected_uids && a.secondary_uid==b.secondary_uid &&
    a.mode==b.mode && a.color==b.color && a.num==b.num && a.gold==b.gold && a.cards==b.cards &&
    a.use==b.use && a.has_num==b.has_num;
}

class HeuristicSearchSession {
 public:
  using Search=Mcts<NativeGameState,NativeSearchAction>;
  Search::Tree tree;
  void clear(){tree.clear();player_=-1;}
  void prepare(const NativeGameState& s,int player,const HeuristicSearchConfig& c){
    if(player_!=player || round_!=s.round || phase_!=s.phase || owner_!=s.players[player].id ||
       role_!=s.players[player].role_id || options_.rollout_steps!=c.rollout_steps ||
       options_.rollouts!=c.rollouts || options_.particles!=c.particles ||
       options_.simulations!=c.simulations || options_.max_depth!=c.max_depth ||
       options_.c_puct!=c.c_puct || options_.time_budget_ms!=c.time_budget_ms ||
       options_.reuse_tree!=c.reuse_tree || options_.max_tree_nodes!=c.max_tree_nodes ||
       tree.nodes()>static_cast<size_t>(c.max_tree_nodes))tree.clear();
    player_=player;round_=s.round;phase_=s.phase;owner_=s.players[player].id;
    role_=s.players[player].role_id;options_=c;
  }
  void advance(const NativeGameState& before,int actor,const NativeSearchAction& action,
               const NativeGameState& after){
    NativeHeuristicAdapter rules;
    if(player_<0)return;
    if(actor!=player_ || rules.next_player(after)!=player_ || before.round!=after.round ||
       before.phase!=after.phase || before.players[actor].role_ids!=after.players[actor].role_ids ||
       before.players[actor].role_id!=after.players[actor].role_id ||
       before.deck.deck_count()!=after.deck.deck_count() || before.deck.discard_count()!=after.deck.discard_count() ||
       !tree.matches(rules.information_set_hash(before,actor),actor)){clear();return;}
    // New private observations change the posterior, not just the public state.
    // Conservatively discard pre-observation statistics rather than reweight them.
    const auto newly_seen=[](const auto& old_cards,const auto& new_cards){
      for(const auto& c:new_cards)if(std::none_of(old_cards.begin(),old_cards.end(),
          [&](const auto& old){return old.uid==c.uid;}))return true;
      return false;
    };
    if(newly_seen(before.players[actor].hand,after.players[actor].hand) ||
       newly_seen(before.pending_cards,after.pending_cards)){clear();return;}
    const auto legal=rules.ai_actions(before,actor);
    for(size_t i=0;i<legal.size();++i)if(heuristic_actions_equal(legal[i],action)){
      if(!tree.advance(i,rules.information_set_hash(after,actor),actor))clear();return;
    }
    clear();
  }
 private:
  int player_=-1,round_=0;NativePhase phase_=NativePhase::GameOver;
  std::string owner_,role_;HeuristicSearchConfig options_;
};

// One entry point for real games and training NPC advancement. The neural
// worker keeps its inexpensive NativeNpcPolicy simulation policy: no nested MCTS.
inline HeuristicDecision choose_native_npc(const NativeGameState& state,int player,
    const std::vector<NativeSearchAction>& actions,uint32_t seed=1,
    HeuristicSearchConfig options=heuristic_search_defaults(),HeuristicSearchSession* session=nullptr) {
  HeuristicDecision decision;
  if(actions.empty() || player<0 || player>=static_cast<int>(state.players.size())){if(session)session->clear();return decision;}
  if(session && !options.reuse_tree)session->clear();
  if(actions.size()==1){decision.selected=0;return decision;}
  if(!options.enabled || state.players[player].bot_level!="hard" || actions.front().type==ActionType::ConfirmRound) {
    if(session)session->clear();
    decision.selected=NativeNpcPolicy::choose(state,player,actions,seed);return decision;
  }
  const auto start=std::chrono::steady_clock::now();
  const auto deadline=start+std::chrono::milliseconds(std::max(0,options.time_budget_ms));
  const auto expired=[&]{return options.time_budget_ms>0 && std::chrono::steady_clock::now()>=deadline;};
  try {
    NativeHeuristicAdapter rules;
    std::vector<NativeGameState> particles;
    for(int i=0;i<std::max(1,options.particles);++i) {
      if(expired())break;
      auto world=determinize_native_state(state,player,seed+static_cast<uint32_t>(i)*0x9e3779b9u,true);
      const auto legal=rules.ai_actions(world,player);
      if(legal.size()!=actions.size())continue;
      bool aligned=true;
      for(size_t j=0;j<legal.size();++j)if(!heuristic_actions_equal(legal[j],actions[j])){aligned=false;break;}
      if(aligned)particles.push_back(std::move(world));
    }
    if(particles.empty())throw std::runtime_error("No legal information-set particles");
    Mcts<NativeGameState,NativeSearchAction>::Config config;
    config.simulations=std::max(1,options.simulations);config.max_depth=std::max(1,options.max_depth);
    config.seed=seed;config.c_puct=options.c_puct;config.dirichlet_epsilon=0;
    // Setup, root evaluation, paths and rollout all share the original deadline.
    // Never grant a fresh minimum simulation after setup has used the budget.
    config.time_budget_ms=options.time_budget_ms;config.deadline=deadline;
    NativeHeuristicEvaluator evaluator(options.rollout_steps,options.rollouts,seed,config.time_budget_ms,deadline);
    if(session)session->prepare(state,player,options);
    const auto result=Mcts<NativeGameState,NativeSearchAction>(rules,evaluator,config).search(particles,player,{},
        session && options.reuse_tree?&session->tree:nullptr);
    if(result.policy.size()!=actions.size())throw std::runtime_error("Invalid heuristic search policy");
    decision.selected=static_cast<int>(std::max_element(result.policy.begin(),result.policy.end())-result.policy.begin());
    decision.visits=result.visits;decision.expansions=result.expansions;
    decision.particles=static_cast<int>(particles.size());decision.searched=true;
    decision.new_visits=result.new_visits;decision.reused_visits=result.reused_visits;
    decision.retained_nodes=result.retained_nodes;
    decision.rollout_actions=evaluator.rollout_actions;decision.rollouts=evaluator.completed_rollouts;
    if(session && session->tree.nodes()>static_cast<size_t>(options.max_tree_nodes))session->clear();
  } catch(const std::exception& error) {
    if(session)session->clear();
    // The hard turn planner must not launch new search after a timed failure.
    decision.selected=options.time_budget_ms>0 ? NativeNpcPolicy::choose_rollout(state,player,actions,seed)
                                               : NativeNpcPolicy::choose(state,player,actions,seed);
    decision.fallback=true;
    decision.fallback_reason=error.what();
  }
  decision.elapsed_ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
  return decision;
}

} // namespace citadels::native
