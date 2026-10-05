#include <iostream>
#include <stdexcept>
#include "npc_policy.hpp"
using namespace citadels::native;
void require(bool value,const char* message){if(!value)throw std::runtime_error(message);}
DistrictCard card(std::string uid,int cost,std::string color="green",std::string effect={}) {
  DistrictCard c{uid,color,cost,uid,cost,effect};return c;
}
NativeDistrict district(std::string uid,int cost,std::string color="green",std::string effect={}) {
  return {card(uid,cost,color,effect),uid,effect,{},false,false,1};
}
NativeGameState base(std::string role="king",std::string level="hard") {
  NativeGameState s;s.phase=NativePhase::Action;s.has_turn=true;s.active_player=0;
  s.turn_phase="main";s.resources_taken=true;s.ability_used=true;s.income_taken=true;s.round=2;
  s.players.push_back({"p0",role,6,{}, {},false});s.players[0].bot_level=level;
  s.players.push_back({"p1","merchant",2,{}, {},false});
  s.deck=DeckMachine({card("deck1",2),card("deck2",3),card("deck3",4)});
  return s;
}
NativeSearchAction choose(const NativeGameState& s) {
  NativeGameAdapter rules;const auto a=rules.legal_actions(s,0);
  const int i=NativeNpcPolicy::choose(s,0,a,19);require(i>=0,"no choice");return a[i];
}
int main(){
  auto redraw=base("magician");redraw.pending_kind="magician_redraw";
  redraw.players[0].hand={card("palace",5,"yellow"),card("duplicate",1)};
  redraw.players[0].city={district("duplicate",1)};
  redraw.pending_cursor=0;require(choose(redraw).mode=="skip","discarded useful card");
  redraw.pending_cursor=1;require(choose(redraw).mode=="use","kept unbuildable duplicate");

  auto lab=base("king","normal");lab.players[0].hand={card("duplicate",1)};
  lab.players[0].city={district("duplicate",1),district("lab",5,"purple","lab")};
  require(choose(lab).type==ActionType::Lab,"lab never exchanges redundant cards");
  lab.players[0].city.back()=district("museum",4,"purple","museum");
  require(choose(lab).type==ActionType::Museum,"museum never stores redundant cards");
  auto smithy=base("king","normal");smithy.players[0].city={district("smithy",5,"purple","smithy")};
  smithy.deck.load({},{});require(choose(smithy).type==ActionType::EndTurn,"smithy pays with no drawable cards");

  auto finish=base();finish.end_districts=4;finish.players[0].hand={card("last",1)};
  for(int i=0;i<3;++i)finish.players[0].city.push_back(district("own"+std::to_string(i),1));
  for(int i=0;i<3;++i)finish.players[1].city.push_back(district("rival"+std::to_string(i),5,"yellow"));
  require(choose(finish).type==ActionType::EndTurn,"finishes losing game blindly");

  auto combo=base("architect");combo.players[0].hand={card("big",6,"green"),card("a",2,"green"),card("b",2,"green"),card("c",2,"green")};
  require(choose(combo).uid!="big","hard ignores multi-build combination");
  auto resources=base();resources.resources_taken=false;resources.players[0].gold=2;
  resources.players[0].hand={card("affordable_after_gold",4)};
  require(choose(resources).type==ActionType::TakeGold,"hard fails to fund known construction");

  auto privacy=resources;privacy.players[1].hand={card("hidden",6,"purple")};
  privacy.players[1].role_ids={"assassin"};privacy.magistrate_signed=4;
  privacy.magistrate_player=1;privacy.magistrate_nums={4,7,8};
  const auto original=choose(privacy);
  privacy.players[1].hand={card("different",1,"yellow")};privacy.players[1].role_id="architect";
  privacy.players[1].role_ids={"wizard"};privacy.magistrate_signed=7;
  privacy.deck=DeckMachine({card("unknown1",6,"purple"),card("unknown2",1),card("unknown3",1)});
  const auto changed=choose(privacy);
  require(original.type==changed.type && original.uid==changed.uid,"planner leaks hidden information");

  auto attack=base("assassin");attack.pending_kind="assassin";attack.char_deck={"assassin","architect","artist"};
  require(choose(attack).num==7,"target ignores actual role utility");
  attack.char_deck={"assassin","navigator","artist"};require(choose(attack).num==7,"target role variant regression");
  auto war=base("warlord");war.pending_kind="warlord_destroy";war.players[0].gold=4;
  war.players[1].city={district("expensive",5,"yellow"),district("cheap",1,"blue")};
  require(choose(war).uid=="cheap","destroy ignores payment cost");
  auto useless=base("warlord");useless.ability_used=false;useless.players[0].gold=4;
  useless.players[0].hand={card("own_build",4)};
  useless.players[1].city={district("expensive",5,"yellow")};
  require(choose(useless).type!=ActionType::Ability,"activates attack that sacrifices better construction");
  auto scores=base();scores.players[0].city={district("museum",4,"purple","museum")};
  scores.players[0].city[0].museum_cards={card("stored",1)};scores.players[0].city[0].beautified=true;
  require(native_player_score(scores,0)==6,"shared scoring lost museum/beautification");
  std::cout<<"NPC tactical, planning, scoring and hidden-information checks passed\n";
}
