#include <iostream>
#include <stdexcept>
#include "game_adapter.hpp"
#include "state_loader.hpp"
#include "state_writer.hpp"

using namespace citadels::native;
static NativeGameAdapter rules;
static int checks = 0;
static void check(bool ok, const char* message) {
  ++checks; if (!ok) throw std::runtime_error(message);
}
static NativePlayer player(const char* id, const char* role, int gold) {
  NativePlayer p; p.id=id; p.role_id=role; p.role_ids={role}; p.gold=gold; return p;
}
static DistrictCard card(const std::string& uid, const std::string& effect={}) {
  return {uid,"purple",3,uid,3,effect};
}
static void city(NativeGameState& s, int owner, DistrictCard c) {
  s.players[owner].city.push_back({c,c.name,c.purple_effect});
}
static NativeGameState marked(const char* role="wizard", int gold=5, bool real=true) {
  NativeGameState s; s.phase=NativePhase::Action; s.active_player=0; s.has_turn=true;
  s.turn_phase="main"; s.players={player("owner","blackmailer",2),player("target",role,gold)};
  const int number=s.role_number(role); s.call_queue={{role,number,1}}; s.call_index=-1;
  s.blackmailer_player=0; s.blackmailer_nums={number}; s.blackmailer_signed=real?number:8;
  std::vector<DistrictCard> cards; for (int i=0;i<12;++i) cards.push_back(card("deck"+std::to_string(i)));
  s.deck=DeckMachine(cards);
  check(s.end_turn(),"call marked role"); return s;
}
static void allowed_only(const NativeGameState& s, int actor, ActionType a, ActionType b) {
  auto actions=rules.legal_actions(s,actor);
  check(actions.size()==2,"only two choices should be legal");
  check(actions[0].type==a && actions[1].type==b,"expected phase choices");
}
static void reveal(NativeGameState& s, bool use) {
  check(rules.apply(s,1,NativeSearchAction{ActionType::BlackmailerRefuse}),"refuse bribe");
  check(rules.next_player(s)==0,"blackmailer is next decision actor");
  NativeSearchAction response; response.type=ActionType::Reaction; response.name=use?"use":"skip";
  check(rules.apply(s,0,response),"resolve threat");
  check(s.resources_taken && rules.next_player(s)==1,"resume target after resources");
}
static NativeGameState wizard() {
  NativeGameState s; s.phase=NativePhase::Action; s.active_player=0; s.resources_taken=true;
  s.turn_phase="main"; s.players={player("wizard","wizard",7),player("source","king",0),player("magistrate","magistrate",2)};
  s.pending_kind="wizard_choice"; s.pending_target=1; s.pending_uid="stolen";
  s.players[1].hand={card("stolen")}; s.players[0].hand={card("normal")};
  s.magistrate_player=2; s.magistrate_signed=3; return s;
}
int main() {
  try {
    {
      auto s=marked();
      check(s.pending_kind.empty() && !s.resources_taken,"no threat before resources");
      allowed_only(s,1,ActionType::TakeGold,ActionType::TakeCards);
      check(rules.apply(s,1,NativeSearchAction{ActionType::TakeGold}),"take gold");
      check(s.players[1].gold==7 && s.pending_kind=="blackmailer_threat","gold collected before threat");
      allowed_only(s,1,ActionType::BlackmailerBribe,ActionType::BlackmailerRefuse);
      check(rules.legal_actions(s,0).empty(),"owner cannot decide before refusal");
      check(rules.apply(s,1,NativeSearchAction{ActionType::BlackmailerBribe}),"pay bribe");
      check(s.players[1].gold==4 && s.players[0].gold==5,"half current gold paid to owner, rounded down");
      check(s.resources_taken && !s.take_gold() && !s.take_cards(),"resources cannot be taken twice");
      s.after_resources(); check(s.pending_kind.empty(),"mark is resolved once");
    }
    {
      auto s=marked("wizard",0);
      check(s.take_gold() && s.players[1].gold==2,"gold gathered before threat");
      reveal(s,true); check(s.players[0].gold==4 && s.players[1].gold==0,"real threat takes new resources too");
    }
    for (bool real : {true,false}) for (bool use : {true,false}) {
      auto s=marked("wizard",4,real); check(s.take_gold(),"gather before refusal");
      reveal(s,use);
      check(s.players[1].gold==(real&&use?0:6),"fake token and declined reveal preserve gold");
      check(s.pending_kind.empty() && !s.take_gold(),"all resolution paths finish the resource phase");
    }
    {
      auto s=marked(); check(s.take_cards(),"draw resources");
      check(s.pending_kind=="draw_keep" && s.pending_cards.size()==2,"finish selection before threat");
      auto actions=rules.legal_actions(s,1); check(actions.size()==2 && actions[0].type==ActionType::DrawKeep,"only card choices legal");
      check(rules.apply(s,1,actions[0]),"keep drawn card");
      check(s.players[1].hand.size()==1 && s.pending_kind=="blackmailer_threat","selected card kept before threat");
      check(s.blackmailer_bribe() && s.players[1].gold==3 && s.players[0].gold==4,"card branch uses unchanged resource gold");
    }
    {
      auto s=marked("architect",4); city(s,1,card("library","keepBoth"));
      check(s.take_cards(),"library resource draw");
      check(s.pending_kind=="blackmailer_threat" && s.players[1].hand.size()==2 && !s.bonus_done,"library resources finish before threat, ability waits");
      check(s.blackmailer_bribe(),"architect bribe");
      check(s.players[1].hand.size()==4 && s.bonus_done,"architect bonus follows threat");
      s.after_resources(); check(s.players[1].hand.size()==4,"architect bonus is not duplicated");
    }
    {
      auto s=marked("merchant",3); check(s.take_gold(),"merchant gathers");
      check(s.players[1].gold==5 && !s.bonus_done,"merchant bonus excluded from threatened resources");
      reveal(s,true); check(s.players[0].gold==7 && s.players[1].gold==1,"merchant receives ability gold after seizure");
      s.after_resources(); check(s.players[1].gold==1,"merchant bonus occurs once");
    }
    {
      auto s=marked("noble",3); auto noble=card("noble"); noble.color="yellow"; city(s,1,noble);
      check(s.take_gold() && s.players[1].hand.empty() && !s.income_taken,"noble income waits for threat");
      check(s.blackmailer_bribe() && s.players[1].hand.size()==1 && s.income_taken,"noble income resumes after threat");
    }
    {
      auto s=marked("queen",3); s.players[0].role_ids={"king"};
      check(s.take_gold() && s.players[1].gold==5,"queen bonus waits for threat");
      reveal(s,true); check(s.players[1].gold==3 && s.players[0].gold==7,"queen bonus comes after seizure");
    }
    {
      auto s=marked("navigator",3); check(s.take_gold() && s.pending_kind=="blackmailer_threat","navigator threat before ability prompt");
      check(s.blackmailer_bribe() && s.pending_kind=="navigator_bonus","navigator prompt resumes after threat");
    }
    {
      auto s=marked("monk",3); s.players[0].gold=8;
      allowed_only(s,1,ActionType::TakeGold,ActionType::TakeCards);
      check(s.take_gold() && s.pending_kind=="blackmailer_threat","monk must gather before any income or extra take");
    }
    {
      auto s=marked("wizard",0); s.deck=DeckMachine(std::vector<DistrictCard>{});
      check(s.take_cards() && s.pending_kind=="blackmailer_threat","empty deck still finishes resource gathering");
      check(s.blackmailer_bribe() && s.resources_taken && s.players[0].gold==2,"zero gold bribe resolves normally");
    }
    {
      auto s=wizard(); check(rules.apply(s,0,NativeSearchAction{ActionType::WizardBuild}),"wizard special build");
      check(s.reaction_kind=="magistrate" && s.building_mode=="wizard" && rules.next_player(s)==2,"wizard first paid build offers magistrate response");
      std::ostringstream snapshot; write_native_state(snapshot, s);
      s = load_native_state(parse_json(snapshot.str()));
      check(s.reaction_uid=="stolen" && s.building_mode=="wizard", "wizard response survives state roundtrip");
      NativeSearchAction seize; seize.type=ActionType::Reaction; seize.name="use";
      check(rules.apply(s,2,seize),"magistrate confiscates wizard build");
      check(s.players[0].city.empty() && s.players[2].city.size()==1 && s.players[1].hand.empty(),"district moves from source hand to magistrate");
      check(s.players[0].gold==7 && s.builds==0 && s.building_mode.empty(),"refund and special-build quota survive confiscation");
      NativeSearchAction normal; normal.type=ActionType::Build; normal.uid="normal";
      check(rules.apply(s,0,normal) && s.reaction_kind.empty() && s.builds==1,"one ordinary build remains and cannot be confiscated again");
    }
    {
      auto s=wizard(); check(s.wizard_take(true),"wizard starts build before decline");
      check(s.resolve_build_reaction(false),"magistrate declines");
      check(s.players[0].city.size()==1 && s.players[0].gold==4 && s.builds==0,"declined special build costs gold but no normal quota");
    }
    {
      auto s=wizard(); city(s,2,s.players[1].hand[0]);
      check(s.wizard_take(true) && s.reaction_kind.empty() && s.players[0].city.size()==1,"same-name restriction prevents confiscation");
      check(s.magistrate_claimed,"ineligible first paid build still consumes warrant opportunity");
    }
    {
      auto s=wizard(); s.magistrate_signed=4;
      check(s.wizard_take(true) && s.reaction_kind.empty() && s.builds==0,"false warrant does not intercept wizard");
      s=wizard(); s.magistrate_claimed=true;
      check(s.wizard_take(true) && s.reaction_kind.empty(),"previous paid build prevents later special-build interception");
    }
    {
      auto s=wizard(); s.players[0].gold=0;
      check(!s.wizard_take(true) && s.players[1].hand.size()==1 && s.players[0].hand.size()==1,"unaffordable wizard build cannot move card or trigger response");
      check(s.wizard_take(false) && s.reaction_kind.empty() && !s.magistrate_claimed,"taking a card is not building");
    }
    std::cout<<"turn-interruption checks passed: "<<checks<<'\n'; return 0;
  } catch (const std::exception& error) { std::cerr<<error.what()<<'\n'; return 1; }
}
