#include <iostream>
#include <stdexcept>
#include "game_adapter.hpp"
using namespace citadels::native;
void require(bool ok,const char* why){if(!ok)throw std::runtime_error(why);}
NativeGameState fixture(){
  NativeGameState s;s.phase=NativePhase::Action;s.has_turn=true;s.active_player=0;s.turn_phase="main";
  s.players={{"me","monk",1},{"rich1","king",8},{"rich2","merchant",8},{"poor","architect",2}};
  s.players[0].city.push_back({{"blue1","blue",1,"Temple"},"Temple"});
  s.players[0].hand.push_back({"blue2","blue",1,"Church"});
  s.deck=DeckMachine({{"draw1","green",1,"Market"},{"draw2","yellow",2,"Manor"}});
  return s;
}
std::vector<NativeSearchAction> of_type(const NativeGameState& s,ActionType type){
  NativeGameAdapter rules;std::vector<NativeSearchAction> found;
  for(const auto& a:rules.legal_actions(s,0))if(a.type==type)found.push_back(a);
  return found;
}
int main(){
  NativeGameAdapter rules;auto s=fixture();
  require(of_type(s,ActionType::Income).size()==1,"income unavailable before gathering");
  auto takes=of_type(s,ActionType::MonkTake);
  require(takes.size()==2 && takes[0].target=="rich1" && takes[1].target=="rich2","tied targets not selectable");
  require(rules.apply(s,0,takes[1]),"taking gold before income failed");
  require(s.players[0].gold==2 && s.players[2].gold==7 && s.players[1].gold==8,"wrong gold recipient or payer");
  require(of_type(s,ActionType::MonkTake).empty() && !rules.apply(s,0,takes[0]),"second take allowed");
  s=fixture();require(rules.apply(s,0,{ActionType::TakeGold}),"base resources failed");
  require(s.pending_kind.empty() && !s.income_taken,"income forced immediately after gathering");
  auto builds=of_type(s,ActionType::Build);require(!builds.empty() && rules.apply(s,0,builds[0]),"build before income failed");
  require(rules.apply(s,0,{ActionType::Income}),"starting voluntary income failed");
  auto combos=of_type(s,ActionType::MonkResource);require(combos.size()==3,"new blue district not included");
  const int old_gold=s.players[0].gold;const auto old_hand=s.players[0].hand.size();
  require(rules.apply(s,0,combos[1]),"resource combination failed");
  require(s.income_taken && s.pending_kind.empty() && s.players[0].gold==old_gold+1 &&
          s.players[0].hand.size()==old_hand+1,"income amounts or flag incorrect");
  require(!rules.apply(s,0,combos[1]) && !rules.apply(s,0,{ActionType::Income}),"income repeated");
  require(of_type(s,ActionType::MonkTake).size()==2,"take missing after income");
  s=fixture();s.players[0].gold=8;require(of_type(s,ActionType::MonkTake).empty(),"richest tie with self allowed");
  s.players[0].gold=10;require(of_type(s,ActionType::MonkTake).empty(),"richest self allowed");
  s=fixture();NativeSearchAction invalid{ActionType::MonkTake};invalid.target="poor";
  require(!rules.apply(s,0,invalid),"non-richest target accepted");
  invalid.target="missing";require(!rules.apply(s,0,invalid),"unknown target accepted");
  invalid.target.clear();require(!rules.apply(s,0,invalid),"ambiguous legacy take accepted");
  s.players[2].gold=7;require(rules.apply(s,0,invalid),"unique legacy take rejected");
  s=fixture();s.players[0].city.clear();require(rules.apply(s,0,{ActionType::Income}),"zero blue income failed");
  combos=of_type(s,ActionType::MonkResource);require(combos.size()==1 && rules.apply(s,0,combos[0]) && s.income_taken,"zero income not settled");
  require(!of_type(s,ActionType::MonkTake).empty(),"zero blue prevents gold take");
  s=fixture();s.turn_phase="bewitched";
  require(of_type(s,ActionType::Income).empty() && of_type(s,ActionType::MonkTake).empty(),"bewitched monk uses ability");
  require(!s.income() && !s.monk_take(1),"bewitched ability application accepted");
  s=fixture();s.turn_phase="witch_resume";s.resources_taken=true;
  require(rules.apply(s,0,{ActionType::Income}),"witch-controlled monk income unavailable");
  std::cout<<"monk rules regression checks passed\n";
}
