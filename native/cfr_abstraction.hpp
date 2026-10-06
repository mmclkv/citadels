#pragma once
#include "cfr_information.hpp"

namespace citadels::native {

// Deliberately lossy, imperfect-recall abstraction. This is not the exact
// perfect-recall game and carries no vanilla CFR convergence guarantee.
inline int cfr_amount_band(int n) {
  return n < 2 ? std::max(0,n) : n < 5 ? 2 : n < 9 ? 3 : 4;
}
inline std::string cfr_abstract_card(const DistrictCard& c) {
  CfrKey k; k.text(c.color); k.number(c.cost <= 2 ? 0 : c.cost <= 4 ? 1 : 2);
  // Purple effects and scoring exceptions are not interchangeable.
  k.text(c.purple_effect); k.number(c.score_as); k.number(c.score_value-c.cost);
  return k.value;
}
inline std::string cfr_abstract_reference(const NativeGameState& s,int me,const std::string& uid) {
  if(uid.empty())return {};
  // Enforce exactly the same observability check as transport normalization.
  cfr_card_reference(s,me,uid);
  for(const auto& c:s.players.at(me).hand)if(c.uid==uid)return cfr_abstract_card(c);
  for(size_t p=0;p<s.players.size();++p)for(const auto& d:s.players[p].city)if(d.card.uid==uid) {
    CfrKey k;k.number(cfr_relative(s,me,static_cast<int>(p)));k.text(cfr_abstract_card(d.card));
    k.number(d.beautified);k.number(d.fortress);return k.value;
  }
  if(me==s.active_player)for(const auto& c:s.pending_cards)if(c.uid==uid)return cfr_abstract_card(c);
  if(s.has_reaction_card && me==s.reaction_player && s.reaction_card.uid==uid)return cfr_abstract_card(s.reaction_card);
  throw std::runtime_error("Unobservable abstract CFR card");
}
inline std::string cfr_abstract_action(const NativeGameState& s,int me,const NativeSearchAction& a) {
  // Start from a copy with references removed; retain every non-card choice,
  // including character identity, payment choice and target-relative seat.
  auto plain=a;plain.uid.clear();plain.secondary_uid.clear();plain.selected_uids.clear();
  if(!a.uid.empty() || !a.secondary_uid.empty() || !a.selected_uids.empty())plain.name.clear();
  CfrKey k;k.text(cfr_action_key(s,me,plain));
  k.text(cfr_abstract_reference(s,me,a.uid));k.text(cfr_abstract_reference(s,me,a.secondary_uid));
  std::vector<std::string> cards;
  for(const auto& uid:a.selected_uids)cards.push_back(cfr_abstract_reference(s,me,uid));
  k.list(std::move(cards));return k.value;
}
inline CfrActionSet cfr_abstract_actions(const NativeGameState& s,int me,const std::vector<NativeSearchAction>& legal) {
  std::map<std::string,std::vector<size_t>> groups;
  for(size_t a=0;a<legal.size();++a)groups[cfr_abstract_action(s,me,legal[a])].push_back(a);
  CfrActionSet result;
  for(auto& [key,indices]:groups){result.keys.push_back(key);result.indices.push_back(std::move(indices));}
  return result;
}
inline std::string cfr_abstract_information(const NativeGameState& s,int me,const CfrActionSet& actions) {
  const auto& p=s.players.at(me);CfrKey k;k.text("cfr-abstract-v2");
  k.number(static_cast<int>(s.players.size()));k.number(static_cast<int>(s.phase));
  k.text(s.phase==NativePhase::Draft?s.draft_sub:s.turn_phase);k.text(s.phase==NativePhase::Draft?"":p.role_id);
  k.text(me==s.active_player?s.pending_kind:"");k.text(s.reaction_kind);
  k.number(cfr_amount_band(p.gold));k.number(std::min<int>(3,p.hand.size()));
  k.number(p.city.size()+2<static_cast<size_t>(s.end_districts)?0:
           p.city.size()+1<static_cast<size_t>(s.end_districts)?1:
           p.city.size()<static_cast<size_t>(s.end_districts)?2:3);
  k.number(p.has_crown);k.number(s.first_to_finish>=0);
  int next_cost=1000;
  for(const auto& c:p.hand)if(std::none_of(p.city.begin(),p.city.end(),[&](const auto& d){return d.name==c.name;}))
    next_cost=std::min(next_cost,c.cost);
  k.number(next_cost==1000?3:next_cost<=p.gold?0:next_cost<=p.gold+2?1:2);
  // Public race pressure; no opponent role/hand identities are accessed.
  int max_city=0;double best_score=0;
  for(size_t other=0;other<s.players.size();++other)if(static_cast<int>(other)!=me) {
    max_city=std::max(max_city,static_cast<int>(s.players[other].city.size()));
    best_score=std::max(best_score,static_cast<double>(native_player_score(s,static_cast<int>(other))));
  }
  k.number(max_city+1>=s.end_districts);const double gap=best_score-native_player_score(s,me);
  k.number(gap<=0?0:gap<=5?1:2);
  if(s.magistrate_player==me)k.number(s.magistrate_signed);
  if(s.blackmailer_player==me)k.number(s.blackmailer_signed);
  // Action support is part of the abstract information set: never splice
  // policies across states with different available choices.
  k.list(actions.keys,true);return cfr_digest(k.value);
}
} // namespace citadels::native
