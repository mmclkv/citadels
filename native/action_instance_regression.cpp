#include <iostream>
#include <stdexcept>
#include "neural_evaluator.hpp"
using namespace citadels::native;
static void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
int main() {
  NativeGameState state; state.phase=NativePhase::Action; state.has_turn=true;
  state.active_player=0; state.turn_phase="main"; state.pending_kind="warlord_destroy";
  state.players={{"a","warlord",20},{"b","merchant",2}};
  DistrictCard first{"d0","yellow",3,"Manor"}; first.en="Manor";
  auto second=first; second.uid="d1";
  state.players[1].city={{first,first.name,"",{},false,false,1},
                         {second,second.name,"",{},false,true,1}};
  auto swapped=state;
  std::swap(swapped.players[1].city[0].card.uid,swapped.players[1].city[1].card.uid);
  NativeSearchAction action; action.type=ActionType::ChooseDistrict; action.uid="d0"; action.target="b";
  const auto old=encode_network_action(action,&state,0,9);
  const auto legacy_swapped=encode_network_action(action,&swapped,0,9);
  const auto current=encode_network_action(action,&state,0,10);
  const auto current_swapped=encode_network_action(action,&swapped,0,10);
  require(encode_features(state,0)==encode_features(swapped,0),"diagnostic state changed");
  require(old==legacy_swapped,"legacy diagnostic no longer reproduces alias");
  require(current!=current_swapped,"v10 still aliases distinct building instances");
  require(current.size()==256 && std::equal(old.begin(),old.begin()+182,current.begin()),"legacy prefix changed");
  require(current[183]==0 && current_swapped[183]==1,"beautification missing");
  require(current[188]==.1f && current_swapped[188]==.15f,"actual destruction costs missing");
  require(current[190]==1 && current[197]==1 && current_swapped[198]==1,"owner/slot links missing");
  NativeGameAdapter game; auto a=state,b=swapped;
  require(game.apply(a,0,action) && game.apply(b,0,action),"diagnostic action is illegal");
  require(a.players[0].gold==18 && b.players[0].gold==17,"different effects no longer reproduced");
  auto enriched=state;
  enriched.players[1].city[0].museum_cards.resize(3);
  enriched.players[1].city[0].fortress=true;
  enriched.players[1].city[0].built_round=7;
  const auto details=encode_network_action(action,&enriched,0,10);
  require(details[184]==3.0f/8 && details[185]==.07f && details[186]==1,"instance attributes missing");
  enriched.pending_kind="diplomat_theirs"; enriched.pending_uid="d1";
  const auto exchange=encode_network_action(action,&enriched,0,10);
  require(exchange[213]==1 && exchange[214]==1 && exchange[229]==1,"diplomat's selected building missing");
  std::cout<<"action instance regressions passed\n";
}
