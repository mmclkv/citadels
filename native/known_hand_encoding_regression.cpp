#include <iostream>
#include <stdexcept>
#include "neural_evaluator.hpp"
using namespace citadels::native;
void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
int main(){
  NativeGameState s;s.players.resize(3);s.active_player=0;s.has_turn=true;s.phase=NativePhase::Action;
  for(int i=0;i<3;++i)s.players[i].id="p"+std::to_string(i);
  auto cards=build_base_district_deck(123);s.players[1].hand={cards[0],cards[1]};
  s.players[1].is_bot=true;s.players[1].bot_type="npc";s.players[1].bot_level="hard";
  const int id=district_identity_index(cards[0]);require(id>=0,"card identity");
  const auto unknown=encode_network_state(s,0,16),legacy=encode_network_state(s,0,15);
  s.known_hand_cards.push_back({0,1,cards[0].uid});
  const auto known=encode_network_state(s,0,16);
  require(known.size()==2486 && legacy.size()==2054,"versioned widths");
  require(known[32+184+18]==1 && legacy[32+184+18]==0,"public difficulty or legacy slot changed");
  require(known[2054+54+id]==.2f && unknown[2054+54+id]==0,"known card missing");
  require(encode_network_state(s,0,15)==legacy,"legacy encoding changed");
  const auto other=encode_network_state(s,2,16);
  require(std::all_of(other.begin()+2054,other.end(),[](float x){return x==0;}),"private knowledge leaked");
  s.known_hand_cards.push_back({0,1,cards[0].uid});
  require(encode_network_state(s,0,16)==known,"duplicate counted twice");
  s.players[1].hand.erase(s.players[1].hand.begin());
  require(encode_network_state(s,0,16)[2054+54+id]==0,"stale known card retained");
  s.pending_kind="wizard_card";s.pending_target=1;
  require(encode_network_state(s,0,16)[2054+54+district_identity_index(cards[1])]==.2f,"visible wizard hand missing");
  std::cout<<"known-hand ownership, stale cards, deduplication, privacy and legacy layouts passed\n";
}
