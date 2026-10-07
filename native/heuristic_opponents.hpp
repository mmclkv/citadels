#pragma once

#include <chrono>
#include <random>
#include "npc_policy.hpp"

namespace citadels::native {

enum class OpponentStyle { Greedy, FastBuild, HighScore, StopLeader };

// A style is drawn once per seat and rollout, not independently per action.
// This is a prior over plausible play, not a learned personality classifier.
inline OpponentStyle sample_opponent_style(uint32_t seed) {
  const int draw=seed%100;
  return draw<40?OpponentStyle::Greedy:draw<65?OpponentStyle::FastBuild:
         draw<85?OpponentStyle::HighScore:OpponentStyle::StopLeader;
}

inline double opponent_action_utility(const NativeGameState& s,int actor,
    const NativeSearchAction& a,OpponentStyle style) {
  double value=NativeNpcPolicy::search_utility(s,actor,a);
  const auto& p=s.players[actor];
  if(a.type==ActionType::DraftPick){
    if(style==OpponentStyle::FastBuild && (a.name=="architect" || a.name=="scholar" || a.name=="prophet"))value+=1.5;
    if(style==OpponentStyle::HighScore && (a.name=="merchant" || a.name=="alchemist"))value+=1.2;
    if(style==OpponentStyle::StopLeader && (a.name=="assassin" || a.name=="warlord" || a.name=="marshal"))value+=1.2;
  }
  if(a.type==ActionType::Build){
    const auto it=std::find_if(p.hand.begin(),p.hand.end(),[&](const auto& c){return c.uid==a.uid;});
    if(it!=p.hand.end()){
      if(style==OpponentStyle::FastBuild)value+=2.0-it->cost*0.65;
      if(style==OpponentStyle::HighScore)value+=(it->score_value>0?it->score_value:it->cost)*0.6;
    }
  }
  if(style==OpponentStyle::HighScore && a.type==ActionType::TakeGold){
    int cost=0;for(const auto& c:p.hand)cost=std::max(cost,c.cost);
    if(cost>p.gold)value+=1.0;
  }
  if(style==OpponentStyle::StopLeader){
    int leader=actor;for(size_t i=0;i<s.players.size();++i)
      if(native_player_score(s,static_cast<int>(i))>native_player_score(s,leader))leader=static_cast<int>(i);
    if(a.type==ActionType::Ability && (p.role_id=="warlord" || p.role_id=="marshal" || p.role_id=="diplomat"))value+=3.0;
    if(!a.target.empty() && s.find_player(a.target)==leader && leader!=actor)value+=3.0;
  }
  return value;
}

inline int choose_opponent_rollout(const NativeGameState& s,int actor,
    const std::vector<NativeSearchAction>& actions,OpponentStyle style,uint32_t seed) {
  if(actor<0 || actor>=static_cast<int>(s.players.size()) || actions.empty())return -1;
  if(style==OpponentStyle::Greedy)return NativeNpcPolicy::choose_rollout(s,actor,actions,seed);
  std::vector<double> scores;double best=-std::numeric_limits<double>::infinity();
  for(const auto& a:actions){scores.push_back(opponent_action_utility(s,actor,a,style));best=std::max(best,scores.back());}
  // Explore only near-equivalent choices, never uniformly random bad moves.
  std::vector<double> weights;double total=0;
  for(double score:scores){weights.push_back(score>=best-1.0?std::exp((score-best)/0.4):0);total+=weights.back();}
  std::mt19937 rng(seed);double pick=std::generate_canonical<double,32>(rng)*total;
  for(size_t i=0;i<weights.size();++i){pick-=weights[i];if(pick<0)return static_cast<int>(i);}
  return static_cast<int>(std::max_element(scores.begin(),scores.end())-scores.begin());
}

inline bool critical_opponent_position(const NativeGameState& s) {
  if(s.first_to_finish>=0)return true;
  for(const auto& p:s.players)if(static_cast<int>(p.city.size())>=s.end_districts-3)return true;
  return false;
}

// Bounded same-turn tactical check on a sampled world. Empty the deck so a
// "guaranteed" line cannot depend on a conveniently sampled future draw.
class CriticalOpponentResponse {
 public:
  static int choose(const NativeGameState& s,int actor,int protected_player,
      const std::vector<NativeSearchAction>& actions,
      std::chrono::steady_clock::time_point deadline={}) {
    if(actor<0 || protected_player<0 || actor==protected_player ||
       actor>=static_cast<int>(s.players.size()) || protected_player>=static_cast<int>(s.players.size()) ||
       !critical_opponent_position(s))return -1;
    CriticalOpponentResponse check(s,actor,protected_player,deadline);
    double best=0;int selected=-1;
    for(size_t i=0;i<actions.size() && !check.expired();++i){
      if(!check.relevant(s,actions[i]))continue;
      auto next=s;next.deck.load({},{});
      if(!check.rules_.apply(next,actor,actions[i]))continue;
      const double value=check.tail(next,5);
      if(value>best){best=value;selected=static_cast<int>(i);}
    }
    return selected;
  }
 private:
  CriticalOpponentResponse(const NativeGameState& s,int actor,int target,
      std::chrono::steady_clock::time_point deadline):before_(s),actor_(actor),target_(target),deadline_(deadline){}
  bool expired() const {return deadline_!=std::chrono::steady_clock::time_point{} && std::chrono::steady_clock::now()>=deadline_;}
  bool relevant(const NativeGameState& s,const NativeSearchAction& a) const {
    if(a.type==ActionType::Build || a.type==ActionType::TakeGold || a.type==ActionType::Income || a.type==ActionType::EndTurn)return true;
    const auto& role=s.players[actor_].role_id;
    const bool military=role=="warlord" || role=="marshal" || role=="diplomat";
    return military && (a.type==ActionType::Ability || a.type==ActionType::ChooseDistrict);
  }
  double goal(const NativeGameState& s) const {
    const double own=native_player_score(s,actor_);double rival=0;
    for(size_t i=0;i<s.players.size();++i)if(static_cast<int>(i)!=actor_)rival=std::max(rival,static_cast<double>(native_player_score(s,static_cast<int>(i))));
    if(s.players[actor_].city.size()>=static_cast<size_t>(s.end_districts) && own>=rival)return 1000+own-rival;
    const auto& target=before_.players[target_];
    if(static_cast<int>(target.city.size())<before_.end_districts-2)return 0;
    double other=0;for(size_t i=0;i<before_.players.size();++i)if(static_cast<int>(i)!=target_)
      other=std::max(other,static_cast<double>(native_player_score(before_,static_cast<int>(i))));
    if(native_player_score(before_,target_)+8<other)return 0;
    const double damage=native_player_score(before_,target_)-native_player_score(s,target_);
    const double lost_city=static_cast<double>(target.city.size())-s.players[target_].city.size();
    if(damage<=0 || lost_city<=0)return 0;
    const double gain=own-native_player_score(before_,actor_)+
      (s.players[actor_].gold-before_.players[actor_].gold)*0.8+
      (static_cast<double>(s.players[actor_].city.size())-before_.players[actor_].city.size())*2+
      damage*0.8+lost_city*5;
    return gain>0?10+gain:0;
  }
  double tail(const NativeGameState& s,int depth) {
    const double value=goal(s);
    if(value>0 || !depth || budget_<=0 || expired() || rules_.terminal(s) || rules_.next_player(s)!=actor_)return value;
    double best=0;auto actions=rules_.ai_actions(s,actor_);
    for(const auto& a:actions){
      if(!relevant(s,a))continue;
      if(budget_--<=0 || expired())break;
      auto next=s;if(!rules_.apply(next,actor_,a))continue;
      best=std::max(best,tail(next,depth-1));
    }
    return best;
  }
  const NativeGameState& before_;int actor_,target_,budget_=64;
  std::chrono::steady_clock::time_point deadline_;NativeGameAdapter rules_;
};

} // namespace citadels::native
