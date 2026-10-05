#include <iostream>
#include <stdexcept>
#include <thread>
#include "heuristic_search.hpp"
using namespace citadels::native;
void require(bool v,const char* m){if(!v)throw std::runtime_error(m);}
class SlowEvaluator final : public Evaluator<NativeGameState,NativeSearchAction> {
 public:
  Evaluation evaluate(const NativeGameState& s,int player,const std::vector<NativeSearchAction>& a) override {
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
    NativeHeuristicEvaluator evaluator;return evaluator.evaluate(s,player,a);
  }
};
DistrictCard card(std::string uid,int cost,std::string color="green"){return {uid,color,cost,uid,cost};}
NativeGameState fixture(){
  NativeGameState s;s.phase=NativePhase::Action;s.has_turn=true;s.active_player=0;
  s.resources_taken=true;s.income_taken=true;s.ability_used=true;s.turn_phase="main";s.round=2;
  s.players.push_back({"p0","king",4,{card("own",2)}, {},false});
  s.players.push_back({"p1","architect",2,{card("hidden1",1)}, {},false});
  s.players.push_back({"p2","warlord",3,{card("hidden2",5,"purple")}, {},false});
  for(auto& p:s.players)p.bot_level="hard";
  s.players[0].role_ids={"king"};s.players[0].played={"king"};
  s.players[1].role_ids={"architect"};s.players[2].role_ids={"warlord"};
  s.char_deck={"king","architect","warlord"};s.call_queue={{"king",4,0},{"architect",7,1},{"warlord",8,2}};
  s.deck=DeckMachine({card("deck1",1),card("deck2",6,"yellow")});
  return s;
}
int main(){
  NativeGameAdapter rules;NativeHeuristicEvaluator evaluator;auto s=fixture();
  auto legal=rules.legal_actions(s,0);auto e=evaluator.evaluate(s,0,legal);
  require(e.has_value_vector && e.priors.size()==legal.size(),"bad heuristic evaluation shape");
  float total=0;for(float p:e.priors){require(p>0 && std::isfinite(p),"lost action exploration floor");total+=p;}
  require(std::abs(total-1)<1e-5,"priors not normalized");
  float value_sum=0;for(size_t i=0;i<s.players.size();++i){require(std::isfinite(e.value_vector[i]) && std::abs(e.value_vector[i])<=1,"invalid multiplayer value");value_sum+=e.value_vector[i];}
  require(std::abs(value_sum)<1e-5,"expected rank values not zero-sum");
  auto hoard=s;hoard.players[0].hand.assign(6,card("quality",4));
  const double capped=NativeNpcPolicy::search_strength(hoard,0,0);
  hoard.players[0].hand.assign(60,card("quality",4));
  require(std::abs(capped-NativeNpcPolicy::search_strength(hoard,0,0))<1e-6,"surplus known cards have unbounded value");
  require(std::abs(capped-NativeNpcPolicy::search_strength(hoard,0,1))<=1.20001,"known/private hand estimates use incompatible scales");
  auto changed=s;std::swap(changed.players[1].hand[0],changed.deck.deck_cards()[0]);
  std::swap(changed.players[1].role_ids,changed.players[2].role_ids);
  changed.players[1].role_id="warlord";changed.players[2].role_id="architect";
  changed.call_queue={{"king",4,0},{"architect",7,2},{"warlord",8,1}};
  changed.magistrate_signed=7;changed.blackmailer_signed=8;
  const auto hidden_eval=evaluator.evaluate(changed,0,legal);
  require(e.priors==hidden_eval.priors && e.value_vector==hidden_eval.value_vector,"evaluation leaks hidden truth");
  HeuristicSearchConfig fixed;fixed.simulations=96;fixed.time_budget_ms=0;fixed.critical_time_budget_ms=0;fixed.max_depth=24;
  const auto a=choose_native_npc(s,0,legal,71,fixed),b=choose_native_npc(changed,0,legal,71,fixed);
  require(a.searched && !a.fallback && a.visits>0 && a.particles==8,"hard did not search");
  require(legal[a.selected].type==ActionType::Build,"search ignored profitable affordable construction");
  require(a.selected==b.selected && a.visits==b.visits && a.expansions==b.expansions,"fixed-seed search depends on hidden arrangement");
  require(s.players[0].hand.size()==1 && s.deck.deck_count()==2,"search mutated authoritative state");
  require(a.rollout_actions>0 && a.rollouts>0,"search did not run rollouts");
  NativeHeuristicEvaluator rollout(8,1,71);
  const auto rolled=rollout.evaluate(s,0,legal);
  auto tail=s;for(int step=0;step<8 && !rules.terminal(tail);++step){
    const int actor=rules.next_player(tail);const auto options=rules.legal_actions(tail,actor);
    // Fixture moves are deterministic (no draft); replicate the greedy policy.
    const int selected=NativeNpcPolicy::choose_rollout(tail,actor,options,1);
    require(selected>=0 && rules.apply(tail,actor,options[selected]),"manual rollout failed");
  }
  const auto start_value=NativeHeuristicEvaluator::static_value(s,0),tail_value=NativeHeuristicEvaluator::static_value(tail,0);
  for(size_t i=0;i<kValueSlots;++i)
    require(std::abs(rolled.value_vector[i]-(0.4f*start_value[i]+0.6f*tail_value[i]))<1e-5,"rollout changed the value-vector perspective");
  auto reusable=fixture();reusable.players[0].hand.push_back(card("own2",1,"blue"));
  reusable.players[0].role_id="architect";reusable.players[0].role_ids={"architect"};
  reusable.players[0].played={"architect"};reusable.bonus_done=true;
  reusable.players[1].role_id="king";reusable.players[1].role_ids={"king"};
  reusable.call_queue={{"architect",7,0},{"king",4,1},{"warlord",8,2}};
  HeuristicSearchSession cache;auto deterministic=fixed;deterministic.rollout_steps=0;
  auto choices=rules.legal_actions(reusable,0);
  const auto first=choose_native_npc(reusable,0,choices,71,deterministic,&cache);
  require(first.reused_visits==0 && first.new_visits==deterministic.simulations,"fresh search visits wrong");
  const auto previous=reusable;
  require(choices[first.selected].type==ActionType::Build && rules.apply(reusable,0,choices[first.selected]),"reuse fixture failed to build");
  cache.advance(previous,0,choices[first.selected],reusable);
  require(cache.tree.nodes()>0,"matching build subtree was discarded");
  choices=rules.legal_actions(reusable,0);
  const auto second=choose_native_npc(reusable,0,choices,72,deterministic,&cache);
  require(second.reused_visits>0 && second.new_visits==deterministic.simulations,"subtree statistics not reused across actions");
  // An observation can look like a simulated child, but changes the posterior.
  auto observed=reusable;observed.players[0].hand.push_back(card("newly-seen",1));
  cache.advance(reusable,0,choices[second.selected],observed);
  require(cache.tree.nodes()==0,"new private card did not invalidate retained statistics");
  choose_native_npc(previous,0,rules.legal_actions(previous,0),71,deterministic,&cache);
  cache.advance(previous,1,choices[0],reusable);
  require(cache.tree.nodes()==0,"other player's action did not clear the tree");
  choose_native_npc(previous,0,rules.legal_actions(previous,0),71,deterministic,&cache);
  auto new_round=previous;++new_round.round;
  const auto reset=choose_native_npc(new_round,0,rules.legal_actions(new_round,0),71,deterministic,&cache);
  require(reset.reused_visits==0,"round change reused stale statistics");
  deterministic.rollout_steps=1;
  const auto new_evaluation=choose_native_npc(new_round,0,rules.legal_actions(new_round,0),71,deterministic,&cache);
  require(new_evaluation.reused_visits==0,"rollout configuration change reused incompatible values");
  deterministic.max_tree_nodes=1;
  choose_native_npc(new_round,0,rules.legal_actions(new_round,0),71,deterministic,&cache);
  require(cache.tree.nodes()==0,"retained node budget did not release the tree");
  s.players[0].bot_level="normal";require(!choose_native_npc(s,0,legal).searched,"normal difficulty unexpectedly searches");
  const auto single=choose_native_npc(s,0,{legal.front()});require(single.selected==0 && !single.searched,"single action should bypass search");
  require(choose_native_npc(s,0,{}).selected==-1,"empty legal actions accepted");
  s.players[0].bot_level="hard";
  auto disabled=fixed;disabled.enabled=false;
  const auto fast=choose_native_npc(s,0,legal,71,disabled);
  require(!fast.searched && !fast.fallback && fast.selected==NativeNpcPolicy::choose(s,0,legal,71),"disabled search changed fast hard policy");
  auto bad=legal;bad[0].uid="not-legal";const auto fallback=choose_native_npc(s,0,bad,1,fixed);
  require(fallback.fallback && !fallback.searched && !fallback.fallback_reason.empty(),"failed search has no fallback diagnostic");
  auto wizard=fixture();wizard.players[0].role_id="wizard";wizard.players[0].role_ids={"wizard"};
  wizard.pending_kind="wizard_card";wizard.pending_target=1;wizard.pending_cards=wizard.players[1].hand;
  for(int i=0;i<8;++i){const auto world=determinize_native_state(wizard,0,10+i,true);
    require(world.players[1].hand[0].uid==wizard.players[1].hand[0].uid,"wizard revealed cards were re-sampled");}
  auto terminal=fixture();terminal.phase=NativePhase::GameOver;
  auto arrest=fixture();arrest.active_player=1;arrest.reaction_player=0;arrest.reaction_kind="magistrate";
  arrest.reaction_build=true;arrest.reaction_uid=arrest.players[1].hand[0].uid;
  for(int i=0;i<8;++i){const auto world=determinize_native_state(arrest,0,100+i,true);
    require(world.players[1].hand[0].uid==arrest.reaction_uid,"announced construction disappeared from reaction particle");}
  require(evaluator.evaluate(terminal,0,{}).value_vector==native_terminal_reward_vector(terminal,0),"terminal heuristic differs from true reward");
  require(rollout.evaluate(terminal,0,{}).value_vector==native_terminal_reward_vector(terminal,0),"terminal rollout evaluation was blended with a nonterminal estimate");
  SlowEvaluator slow;Mcts<NativeGameState,NativeSearchAction>::Config deadline;
  deadline.simulations=1000;deadline.max_depth=3;deadline.time_budget_ms=1;
  const auto limited=Mcts<NativeGameState,NativeSearchAction>(rules,slow,deadline).search(fixture(),0);
  require(limited.visits>0 && limited.visits<1000,"time budget did not interrupt fixed simulation loop");
  std::cout<<"heuristic ISMCTS checks passed visits="<<a.visits<<" expansions="<<a.expansions<<" ms="<<a.elapsed_ms<<'\n';
}
