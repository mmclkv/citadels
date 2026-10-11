#include <cassert>
#include <fstream>
#include <iostream>
#include <sstream>
#include "game_setup.hpp"
#include "state_writer.hpp"
#include "determinize.hpp"
#include "cfr_information.hpp"
#include "neural_evaluator.hpp"

using namespace citadels::native;
static NativeGameAdapter rules;
static int checks = 0;
static void check_at(bool ok, int line, const char* expression) { ++checks; if (!ok) throw std::runtime_error("district check " + std::to_string(checks) + " at line " + std::to_string(line) + ": " + expression); }
#define check(expr) check_at(bool(expr), __LINE__, #expr)
static DistrictCard card(std::string uid, std::string effect = {}, int cost = 3, std::string color = "purple") {
  return {uid, color, cost, uid, cost, effect, uid};
}
static void city(NativeGameState& s, int owner, DistrictCard c) {
  s.players[owner].city.push_back({c, c.name, c.purple_effect, {}, c.purple_effect == "immune", false, s.round});
}
static NativeGameState base() {
  NativeGameState s; s.phase=NativePhase::Action; s.active_player=0; s.has_turn=true;
  s.turn_phase="main"; s.resources_taken=true; s.rng=JsRng(33);
  for (int i=0;i<3;++i) { NativePlayer p; p.id="p"+std::to_string(i); p.name=p.id; p.seat=i; p.gold=20; p.role_id="merchant"; p.role_ids={"merchant"}; s.players.push_back(p); }
  s.players[0].has_crown=true;
  s.deck=DeckMachine({card("deck1"),card("deck2"),card("deck3"),card("deck4")});
  return s;
}
static void choose(NativeGameState& s, int actor, const std::string& mode, const std::string& uid={}) {
  const auto actions=rules.legal_actions(s,actor);
  const auto it=std::find_if(actions.begin(),actions.end(),[&](const auto& a) {return a.type==ActionType::DistrictEffect && a.name==mode && (uid.empty() || a.uid==uid);});
  check(it!=actions.end()); const auto a=*it;
  check(!cfr_action_key(s,actor,a).empty());
  check(encode_network_action(a,&s,actor).size()==448);
  check(rules.apply(s,actor,a));
}
static NativeGameState roundtrip(const NativeGameState& s) {
  std::ostringstream out; write_native_state(out,s);
  return load_native_state(JsonParser(out.str()).parse());
}
int main(int argc,char** argv) {
  try {
    check(argc==2); std::ifstream file(argv[1]); std::ostringstream text; text<<file.rdbuf();
    const auto catalog=JsonParser(text.str()).parse(); const auto& defs=required_field(catalog,"districts").as_array();
    check(defs.size()==54); check(build_base_district_deck(1).size()==92);
    for (size_t i=30;i<defs.size();++i) {
      auto s=base(); auto c=load_card(defs[i]); c.uid="new"+std::to_string(i);
      s.players[0].hand={c};
      if (c.purple_effect=="secretVault") { check(!s.start_build(c.uid)); check(s.score_bonus(0)==3); continue; }
      check(s.start_build(c.uid)); check(s.players[0].city.size()==1);
      check(roundtrip(s).players[0].city.front().effect==c.purple_effect);
    }
    {
      // Bishop financing must use the Factory-discounted cost, just like
      // ordinary build legality and the final payment.
      const auto build_capitol = [](NativeGameState& s) {
        const auto actions = rules.legal_actions(s, 0);
        const auto it = std::find_if(actions.begin(), actions.end(), [](const auto& a) {
          return a.type == ActionType::Build && a.uid == "d70";
        });
        check(it != actions.end());
        const auto action = *it;
        check(rules.apply(s, 0, action));
      };
      auto s = base(); s.players[0].role_id = "bishop";
      city(s, 0, card("factory", "factory", 5));
      s.players[0].gold = 4; s.players[0].hand = {card("d70", "capitol", 5)};
      build_capitol(s); check(s.pending_kind.empty());
      check(s.players[0].city.back().card.uid == "d70");
      check(s.players[0].gold == 0); check(s.spent_on_build == 4);

      s = base(); s.players[0].role_id = "bishop";
      city(s, 0, card("factory", "factory", 5));
      s.players[0].gold = 4; s.players[0].hand = {card("d70", "capitol", 5), card("repay")};
      s.players[1].gold = s.players[2].gold = 0;
      build_capitol(s); check(s.pending_kind.empty()); check(s.players[0].hand.size() == 1);

      for (bool factory : {false, true}) {
        s = base(); s.players[0].role_id = "bishop";
        if (factory) city(s, 0, card("factory", "factory", 5));
        s.players[0].gold = factory ? 3 : 4;
        s.players[0].hand = {card("d70", "capitol", 5), card("repay")};
        s.players[1].gold = 1; s.players[2].gold = 0;
        build_capitol(s); check(s.pending_kind == "bishop_payer"); check(s.pending_amount == 1);
        NativeSearchAction payer{ActionType::ChoosePlayer}; payer.target = "p1";
        check(rules.apply(s, 0, payer)); check(s.pending_kind == "bishop_repay");
        NativeSearchAction repay{ActionType::ChooseCards}; repay.selected_uids = {"repay"};
        check(rules.apply(s, 0, repay)); check(s.pending_kind.empty());
        check(s.players[0].city.back().card.uid == "d70"); check(s.players[0].gold == 0);
        check(s.spent_on_build == (factory ? 4 : 5));
        check(s.players[1].gold == 0); check(s.players[1].hand.back().uid == "repay");
      }
      s = base(); s.players[0].role_id = "bishop";
      city(s, 0, card("factory", "factory", 5));
      s.players[0].gold = 3; s.players[0].hand = {card("d70", "capitol", 5), card("repay")};
      s.players[1].gold = s.players[2].gold = 0;
      const auto actions = rules.legal_actions(s, 0);
      check(std::none_of(actions.begin(), actions.end(), [](const auto& a) { return a.type == ActionType::Build && a.uid == "d70"; }));
      NativeSearchAction unaffordable{ActionType::Build}; unaffordable.uid = "d70";
      check(!rules.apply(s, 0, unaffordable)); check(s.pending_kind.empty());
    }
    {
      auto s=base(); s.players[0].hand={card("one","stables",2),card("two")}; s.builds=1;
      check(s.start_build("one")); check(s.builds==1); check(!s.start_build("two"));
      s=base(); city(s,0,card("f","factory",5)); s.players[0].gold=2; s.players[0].hand={card("cheap")};
      check(s.start_build("cheap")); check(s.players[0].gold==0); check(s.spent_on_build==2);
      s=base(); city(s,0,card("q","quarry")); auto c=card("copy"); city(s,0,c); city(s,0,c); city(s,0,c);
      c.uid="fourth"; s.players[0].hand={c}; check(s.start_build(c.uid));
    }
    {
      auto s=base(); city(s,0,card("f","framework")); s.players[0].gold=0; s.players[0].hand={card("expensive",{},6)};
      s.magistrate_player=1; s.magistrate_signed=6;
      choose(s,0,"framework"); check(s.players[0].city.front().card.uid=="expensive"); check(!s.magistrate_claimed);
      s=base(); city(s,0,card("sacrifice")); s.players[0].gold=0; s.players[0].hand={card("necro","necropolis",5)};
      choose(s,0,"necropolis"); check(s.players[0].city.size()==1); check(s.players[0].gold==0);
    }
    {
      auto s=base(); s.players[0].gold=4; s.players[0].hand={card("den","thievesDen",6),card("a"),card("b")};
      s.magistrate_player=1; s.magistrate_signed=6;
      choose(s,0,"thieves_begin");
      const auto ai=rules.ai_actions(s,0);
      check(std::none_of(ai.begin(),ai.end(),[](const auto& a){return a.name=="thieves_cancel";}));
      choose(s,0,"thieves_discard","a"); choose(s,0,"thieves_discard","b");
      s=roundtrip(s); check(s.building_cards.size()==2); choose(s,0,"thieves_pay");
      s=roundtrip(s); check(s.reaction_kind=="magistrate");
      auto particle=determinize_native_state(s,1,13,true); check(particle.resolve_build_reaction(true));
      check(s.resolve_build_reaction(true));
      check(s.players[0].gold==4); check(s.players[0].hand.empty()); check(s.players[1].city.size()==1); check(s.builds==1); check(s.spent_on_build==0);
    }
    {
      auto s=base(); city(s,0,card("arm","armory")); city(s,1,card("keep","immune"));
      choose(s,0,"armory"); check(s.players[0].city.empty()); check(s.players[1].city.empty()); check(s.deck.deck_count()==6);
      s=base(); city(s,1,card("museum","museum")); s.players[1].city[0].museum_cards={card("stored")};
      check(s.warlord_destroy("p1","museum")); check(s.deck.deck_cards().back().uid=="stored");
    }
    {
      auto s=base(); s.players[0].hand={card("light","lighthouse",3)}; check(s.start_build("light"));
      s=roundtrip(s); check(s.pending_cards.size()==s.deck.deck_count());
      auto d=determinize_native_state(s,0,7,true); check(d.pending_cards.front().uid==s.pending_cards.front().uid); check(d.deck.deck_count()==4);
      d=determinize_native_state(s,1,7,true); check(d.pending_cards.size()==d.deck.deck_count());
      choose(s,0,"lighthouse_pick","deck2"); check(s.players[0].hand.back().uid=="deck2"); check(s.deck.deck_count()==3);
      s=base(); for (int i=0;i<6;++i) city(s,0,card("d"+std::to_string(i))); s.players[0].hand={card("bell","bellTower",5)};
      check(s.start_build("bell")); choose(s,0,"bell_enable"); check(s.completion_limit()==7); check(s.first_finisher(0));
      s=roundtrip(s); check(s.completion_limit()==7); s.discard_district(0,"bell"); check(s.completion_limit()==8); check(s.first_finisher(0));
    }
    {
      auto s=base(); city(s,0,card("mon","monument",4)); check(s.city_count(0)==2);
      for(int i=0;i<5;++i) city(s,0,card("x"+std::to_string(i)));
      s.players[0].hand={card("last")}; check(s.start_build("last")); check(s.first_finisher(0));
      s=base(); for(int i=0;i<5;++i) city(s,0,card("x"+std::to_string(i)));
      s.players[0].hand={card("mon","monument",4)}; check(!s.start_build("mon"));
    }
    {
      auto s=base(); city(s,0,card("mine","goldMine",6)); s.resources_taken=false; s.players[0].gold=0;
      check(s.take_gold()); check(s.players[0].gold==4);
      s=base(); city(s,0,card("library","keepBoth")); city(s,0,card("obs","draw3keep1",4)); s.resources_taken=false;
      check(s.take_cards()); check(s.players[0].hand.size()==3); check(s.pending_kind.empty());
      s=base(); city(s,0,card("poor","poorHouse")); city(s,0,card("park","park",6)); s.players[0].role_id="alchemist"; s.players[0].gold=0; s.spent_on_build=5;
      check(s.end_turn()); check(s.players[0].gold==6); check(s.players[0].hand.size()==2);
      s=base(); city(s,0,card("throne","throneRoom",6)); s.players[0].gold=0; s.move_crown(1); s.move_crown(1); check(s.players[0].gold==1);
    }
    {
      auto s=base(); city(s,0,card("ivory","ivoryTower",5)); city(s,0,card("ghost","anyColorScore",2));
      for (const auto& color : {"yellow","blue","green","red"}) city(s,0,card(color,{},1,color));
      check(s.score_bonus(0)==8);
      s=base(); city(s,0,card("well","wishingWell",5)); city(s,0,card("other")); check(s.score_bonus(0)==1);
      s=base(); city(s,0,card("cap","capitol",5)); for(int i=0;i<3;++i) city(s,0,card("g"+std::to_string(i),{},1,"green"));
      check(s.score_bonus(0)==3);
      s=base(); city(s,0,card("bas","basilica",4)); city(s,0,card("odd",{},3,"green")); check(s.score_bonus(0)==1);
      s.players[0].city.back().beautified=true; check(s.score_bonus(0)==1);
      s=base(); city(s,0,card("treas","treasury",5)); city(s,0,card("map","mapRoom",5)); city(s,0,card("stat","statue",3));
      s.players[0].hand={card("vault","secretVault",0),card("held")}; check(s.score_bonus(0)==30);
    }
    {
      auto s=base(); city(s,1,card("hospital","hospital",6)); s.call_queue={{"merchant",6,0},{"architect",7,1}}; s.assassinated=7;
      check(s.end_turn()); check(s.active_player==1); check(s.turn_phase=="hospital"); check(s.take_gold()); check(s.players[1].gold==22);
      check(rules.legal_actions(s,1).size()==1); check(rules.legal_actions(s,1).front().type==ActionType::EndTurn);
      s=base(); city(s,0,card("ball","ballroom",6)); s.call_queue={{"merchant",6,0},{"architect",7,1}};
      check(s.end_turn()); check(s.pending_kind=="ballroom"); choose(s,1,"ballroom_thanks"); check(s.active_player==1); check(s.pending_kind.empty());
    }
    {
      auto s=base(); city(s,0,card("theater","theater",6)); s.phase=NativePhase::Draft; s.draft_step=0; s.draft_steps={{0,1,0,false}};
      s.players[0].role_ids={"merchant","king"}; s.players[1].role_ids={"architect","thief"}; s.players[2].role_ids={"warlord","magician"};
      check(s.advance_draft()); check(s.pending_kind=="theater_exchange"); check(s.turns_completed==0); check(s.call_index==-1);
      check(s.active_player==0); check(s.players[0].role_id.empty());
      s=roundtrip(s); choose(s,0,"theater_swap","0"); check(s.turns_completed==0); check(s.call_index==0); check(s.pending_kind.empty());
      check(s.players[0].role_ids[0]=="architect" || s.players[0].role_ids[0]=="thief");
    }
    {
      auto s=base(); for(int i=0;i<4;++i) city(s,0,card("x"+std::to_string(i)));
      city(s,0,card("frame","framework")); s.players[0].hand={card("mon","monument",4)};
      choose(s,0,"framework"); check(s.city_count(0)==6);
      s=base(); s.pending_kind="ballroom";
      const auto actions=rules.legal_actions(s,0);
      check(encode_network_action(actions[0],&s,0)!=encode_network_action(actions[1],&s,0));
      s=base(); city(s,0,card("own")); city(s,0,card("q","quarry"));
      auto duplicate=card("taken"); duplicate.name="own"; city(s,1,duplicate); s.pending_uid="q"; s.pending_kind="diplomat_theirs";
      check(!s.diplomat_swap("p1","taken"));
      s.pending_kind="marshal_seize"; check(!s.marshal_seize("p1","taken"));
      s=base(); city(s,0,card("mine",{},5)); city(s,1,card("wall","wallCost",6)); city(s,1,card("their",{},3));
      s.pending_uid="mine"; check(s.diplomat_swap("p1","their")); check(s.players[0].gold==20);
      s=base(); city(s,1,card("wall","wallCost",6)); city(s,1,card("three",{},3));
      s.pending_kind="marshal_seize";
      check(!s.marshal_seize("p1","three")); check(rules.legal_actions(s,0).size()==1);
      city(s,1,card("two",{},2)); check(s.marshal_seize("p1","two")); check(s.players[0].gold==17);
    }
    {
      auto s=base(); s.players[0].role_id="wizard"; s.pending_kind="wizard_choice"; s.pending_target=1; s.pending_uid="picked";
      s.players[1].hand={card("picked","lighthouse",3)}; s.magistrate_player=2; s.magistrate_signed=3;
      check(s.wizard_take(true)); check(s.reaction_kind=="magistrate"); check(s.resolve_build_reaction(true)); check(s.builds==0); check(s.pending_target==2);
      choose(s,2,"lighthouse_skip");
    }
    std::cout << "district checks passed: " << checks << '\n'; return 0;
  } catch(const std::exception& e) {std::cerr << e.what() << '\n';return 1;}
}
