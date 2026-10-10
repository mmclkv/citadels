#include <iostream>
#include <map>
#include <stdexcept>
#include "neural_evaluator.hpp"
using namespace citadels::native;
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
int main() {
  NativeGameState s;
  s.players.resize(2); s.players[0].id="me"; s.players[1].id="other";
  s.active_player=0; s.has_turn=true; s.phase=NativePhase::Action;
  std::map<int,DistrictCard> cards;
  for (const auto& c : build_base_district_deck(71)) {
    int id=district_identity_index(c);
    require(id>=0 && id<54,"catalog card not encoded"); cards[id]=c;
  }
  require(cards.size()==54,"district identity collision");
  DistrictCard unknown;unknown.en="Unknown Building";unknown.uid="d0";
  require(district_identity_index(unknown)==-1,"scenario UID assigned an incorrect identity");
  constexpr int hand=32+8*184, context=hand+54;
  for (int id=0;id<54;++id) {
    auto c=cards.at(id); s.players[0].hand={c};
    NativeDistrict d; d.card=c; d.effect=c.purple_effect; s.players[0].city={d};
    auto v=encode_network_state(s,0);
    require(v.size()==2054 && v[0]==15,"state contract mismatch");
    require(v[32+56+3]==id+1 && v[hand+id]>0,"city or hand identity missing");
    NativeSearchAction a; a.type=ActionType::Build; a.uid=c.uid;
    auto encoded=encode_network_action(a,&s,0);
    require(encoded.size()==448 && encoded[256+id]==1,"primary action identity missing");
    a.secondary_uid=c.uid; encoded=encode_network_action(a,&s,0);
    require(encoded[310+id]==1,"secondary action identity missing");
    s.pending_uid=c.uid; s.pending_selected={c.uid}; s.pending_cards={c};
    s.pending_kind="wizard_choice"; s.reaction_uid=c.uid;
    v=encode_network_state(s,0);
    for(int block=0;block<4;++block) {
      int offset=id<30 ? 94+block*30+id : 256+block*24+id-30;
      require(v[context+offset]>0,"pending or reaction identity missing");
    }
    s.pending_kind.clear(); s.pending_cards.clear(); s.pending_selected.clear();s.pending_uid.clear();s.reaction_uid.clear();
  }
  s.players[0].city.clear(); s.players[0].hand={cards.at(30)};
  s.players[1].hand={cards.at(31)};
  const auto before=encode_network_state(s,0);
  s.players[1].hand={cards.at(32)};
  require(before==encode_network_state(s,0),"hidden opponent hand leaked into state");
  NativeSearchAction hidden; hidden.type=ActionType::WizardCard; hidden.uid=s.players[1].hand[0].uid;
  auto av=encode_network_action(hidden,&s,0);
  require(av[256+32]==0 && av[105]==0,"hidden opponent card leaked into action");
  s.pending_kind="wizard_card";s.pending_target=1;s.pending_uid=hidden.uid;
  require(encode_network_action(hidden,&s,0)[256+32]==1,"wizard cannot encode visible target card");
  auto legacy=encode_network_state(s,0,14);
  require(legacy.size()==1790 && legacy[0]==14 && legacy[32+56+3]==0,"legacy state layout changed");
  require(encode_network_action(hidden,&s,0,10).size()==256,"legacy action layout changed");
  s.pending_kind="lighthouse";s.pending_target=1;s.pending_cards={cards.at(33)};
  s.pending_uid=cards.at(33).uid;
  auto lighthouse=encode_network_state(s,1);
  require(lighthouse[context+328+3]>0 && lighthouse[context+280+3]==1,"lighthouse owner cannot see deck choice");
  require(encode_network_state(s,0)[context+328+3]==0,"lighthouse deck choice leaked");
  s.pending_cards.clear();s.pending_kind="thieves_den";s.building_mode="thievesDen";
  s.building_cards={s.players[0].hand[0].uid};
  require(encode_network_state(s,0)[context+352+30]>.0f,"den payment missing");
  require(encode_network_state(s,1)[context+352+30]==0,"den payment leaked");
  NativeDistrict bell;bell.card=cards.at(50);bell.effect="bellTower";s.players[1].city={bell};
  s.enabled_bell_towers={bell.card.uid};
  require(encode_network_state(s,0)[context+470]==1,"enabled bell tower missing");
  NativeSearchAction effect;effect.type=ActionType::DistrictEffect;effect.name="bell_enable";
  av=encode_network_action(effect,&s,0);
  require(av[364+9]==1 && av[379]==1,"district effect category or mode missing");
  effect.selected_uids={s.players[0].hand[0].uid};
  require(encode_network_action(effect,&s,0)[380+30]>.0f,"selected action card missing");
  std::cout<<"54 district identities, state/action context, legacy layouts and privacy passed\n";
}
