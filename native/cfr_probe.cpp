#include <iostream>
#include "cfr_core.hpp"
#include "cfr_information.hpp"
using namespace citadels::native;
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
DistrictCard card(std::string uid, std::string name="Tavern") {
  DistrictCard c; c.uid=uid; c.name=name; c.en=name; c.cost=1; c.score_value=1; c.color="green"; return c;
}
NativeGameState base() {
  NativeGameState s; s.phase=NativePhase::Action;s.has_turn=true;s.active_player=0;s.turn_phase="main";
  s.players={{"p0","wizard",4,{card("a"),card("b")},{},false},
             {"p1","king",2,{card("x","Palace")},{},true}};
  s.players[0].role_ids={"wizard"};s.players[1].role_ids={"king"};
  s.char_deck={"assassin","thief","wizard","king","bishop","merchant","architect","warlord","artist"};
  return s;
}
void information_tests() {
  require(cfr_digest("")=="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "SHA empty vector");
  require(cfr_digest("abc")=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA abc vector");
  auto s=base(), changed=s;
  changed.players[1].hand={card("secret","Library")};changed.players[1].role_ids={"artist"};changed.players[1].role_id="artist";
  changed.rng=JsRng(990);changed.magistrate_signed=9;changed.magistrate_player=1;
  s.magistrate_player=1;s.magistrate_signed=4;
  require(cfr_observation(s,0)==cfr_observation(changed,0), "Opponent secrets leak");
  require(cfr_observation(s,1)!=cfr_observation(changed,1), "Owner cannot distinguish own secrets");
  s.pending_kind="blackmailer_threat";changed=s;changed.pending_signed=1;
  require(cfr_observation(s,0)==cfr_observation(changed,0), "Victim sees real blackmail flag");
  s.pending_kind.clear();s.magistrate_nums={4,6,8};changed=s;changed.magistrate_nums={8,4,6};
  require(cfr_observation(s,0)==cfr_observation(changed,0), "Warrant ordering leaks truth");
  NativeSearchAction a{ActionType::Build};a.uid="a";
  NativeSearchAction b=a;b.uid="b";
  auto actions=cfr_action_set(s,0,{a,b});require(actions.keys.size()==1 && actions.indices[0].size()==2, "Equivalent copies not grouped");
  changed=s;changed.players[0].id="new-player";changed.players[0].hand[0].uid="new-card";
  a.uid="new-card";
  require(cfr_action_key(changed,0,a)==actions.keys[0], "Transport UID leaks into action key");
  auto reverse=cfr_action_set(s,0,{b,NativeSearchAction{ActionType::EndTurn}});
  auto forward=cfr_action_set(s,0,{NativeSearchAction{ActionType::EndTurn},b});
  require(reverse.keys==forward.keys,"Button order affects policy");
  bool rejected=false;
  try { a.uid="x"; cfr_action_key(s,0,a); } catch(const std::exception&) {rejected=true;}
  require(rejected,"Unseen hand card encoded");
  s.pending_kind="wizard_card";s.pending_target=1;s.pending_cards=s.players[1].hand;
  changed=s;changed.pending_cards={card("x","Library")};changed.players[1].hand=changed.pending_cards;
  require(cfr_observation(s,0)!=cfr_observation(changed,0),"Wizard cannot see inspected hand");
  require(cfr_observation(s,1)!=cfr_observation(changed,1),"Hand owner not seeing own hand");
  CfrHistory h(s),other(changed);
  auto after=s;after.pending_cards.clear();after.pending_kind.clear();
  NativeSearchAction skip{ActionType::AbilitySkip};
  h.transition(s,0,skip,after);other.transition(changed,0,skip,after);
  require(h.information(after,0)!=other.information(after,0),"Wizard observation forgotten");
  auto spy=base();spy.players[0].role_id="spy";spy.pending_kind="spy_color";spy.pending_target=1;
  auto altered=spy;altered.players[1].hand={card("x","Library")};
  CfrHistory hs(spy),ht(altered);NativeSearchAction investigate{ActionType::SpyColor};investigate.color="blue";
  auto final=spy;final.pending_kind.clear();final.pending_target=-1;
  hs.transition(spy,0,investigate,final);ht.transition(altered,0,investigate,final);
  require(hs.information(final,0)!=ht.information(final,0),"Spy hand observation forgotten");
  CfrTable table;table.lookup("I",{"a","b"});rejected=false;
  try{table.lookup("I",{"a","c"});}catch(const std::exception&){rejected=true;}
  require(rejected,"Information set action-support mismatch ignored");
  bool hit=true;table.average("I",{"a","b"},hit);require(!hit,"Untrained table row reported as learned coverage");
}
void estimator_tests() {
  const std::vector<double> behavior{.65,.35};
  std::vector<double> expected(2,0),average(2,0);
  for(size_t chosen=0;chosen<2;++chosen){
    CfrTable table;table.lookup("I",{"a","b"});
    CfrTraceStep frame{"I",0,chosen,{.75,.25},behavior[chosen],std::log(.2L),std::log(.3L),std::log(.4L)};
    cfr_update_episode(table,{frame},0,chosen==0?1:-1);
    const auto& e=table.entries.at("I");
    for(size_t a=0;a<2;++a){expected[a]+=behavior[chosen]*e.regrets[a]*std::exp(e.regret_scale);average[a]+=behavior[chosen]*e.strategy_sum[a]*std::exp(e.strategy_scale);}
  }
  require(std::abs(expected[0]-.375)<1e-12 && std::abs(expected[1]+1.125)<1e-12,"Biased sampled regret estimator");
  require(std::abs(average[0]-.375)<1e-12 && std::abs(average[1]-.125)<1e-12,"Biased average strategy estimator");
  CfrTable table;auto& entry=table.lookup("I",{"a","b"});entry.regrets={100,0};entry.strategy_sum={1,9};
  bool hit=false;require(std::abs(table.average("I",{"a","b"},hit)[1]-.9)<1e-12 && hit,"Inference uses last strategy instead of average");
  table.contract="test";std::stringstream checkpoint;table.save(checkpoint);CfrTable loaded;loaded.load(checkpoint,"test");
  require(loaded.entries.at("I").strategy_sum==entry.strategy_sum,"Checkpoint lost accumulators");
  bool rejected=false;std::stringstream wrong;table.save(wrong);
  try{loaded.load(wrong,"different");}catch(const std::exception&){rejected=true;}
  require(rejected && loaded.contract=="test","Incompatible checkpoint replaced working policy");
  CfrTraceStep huge{"I",0,0,{.5,.5},.5,0,0,-100000};
  cfr_update_episode(table,{huge},0,1);
  require(std::isfinite(table.entries.at("I").regret_scale) && table.entries.at("I").regret_scale>99999,
          "Long trajectory importance weight overflows");
  const auto before=table.entries.at("I").regrets;rejected=false;
  huge.sampling_probability=std::numeric_limits<double>::quiet_NaN();
  try{cfr_update_episode(table,{huge},0,1);}catch(const std::exception&){rejected=true;}
  require(rejected && table.entries.at("I").regrets==before && table.episodes==1,"Invalid episode partially committed");
}

bool terminal(const std::string& h){return h=="pp" || h=="bc" || h=="bf" || h=="pbc" || h=="pbf";}
double utility(const std::string& h,int c0,int c1){
  if(h=="bf")return 1;if(h=="pbf")return -1;
  return (c0>c1?1:-1)*(h=="pp"?1:2);
}
std::vector<std::string> support(const std::string& h){return h=="b" || h=="pb" ? std::vector<std::string>{"c","f"}:std::vector<std::string>{"b","p"};}
std::string info(int actor,int card,const std::string& h){return std::to_string(actor)+":"+std::to_string(card)+":"+h;}
double evaluate(const CfrTable& table,int c0,int c1,std::string history,int responding=-1,int mask=0){
  if(terminal(history))return utility(history,c0,c1);
  const int actor=static_cast<int>(history.size()%2),card=actor==0?c0:c1;
  const auto actions=support(history);bool hit=false;auto policy=table.average(info(actor,card,history),actions,hit);
  if(actor==responding){
    const int bit=card+((actor==0 ? history=="pb" : history=="p")?3:0);
    policy={0,0};policy[(mask>>bit)&1]=1;
  }
  double value=0;for(size_t a=0;a<2;++a)value+=policy[a]*evaluate(table,c0,c1,history+actions[a],responding,mask);
  return value;
}
double expected(const CfrTable& table,int responding=-1,int mask=0){
  double value=0;for(int a=0;a<3;++a)for(int b=0;b<3;++b)if(a!=b)value+=evaluate(table,a,b,"",responding,mask)/6;
  return value;
}
void kuhn_test(){
  CfrTable table;std::mt19937 rng(711);
  for(int iteration=0;iteration<80000;++iteration)for(int update=0;update<2;++update){
    const int c0=std::uniform_int_distribution<int>(0,2)(rng);int c1;
    do{c1=std::uniform_int_distribution<int>(0,2)(rng);}while(c1==c0);
    std::string history;std::vector<CfrTraceStep> trace;long double my=0,opp=0,sampled=0;
    while(!terminal(history)){
      const int actor=static_cast<int>(history.size()%2),card=actor==0?c0:c1;
      const auto actions=support(history);const auto key=info(actor,card,history);
      const auto policy=cfr_normalize(table.lookup(key,actions).regrets);auto behavior=policy;
      if(actor==update)for(auto& p:behavior)p=.4*p+.6/behavior.size();
      const auto selected=cfr_sample(behavior,rng);
      trace.push_back({key,actor,selected,policy,behavior[selected],my,opp,sampled});
      const auto logp=policy[selected]>0?std::log(static_cast<long double>(policy[selected])):-std::numeric_limits<long double>::infinity();
      if(actor==update)my+=logp;else opp+=logp;
      sampled+=std::log(static_cast<long double>(behavior[selected]));history+=actions[selected];
    }
    cfr_update_episode(table,trace,update,utility(history,c0,c1)*(update==0?1:-1));
  }
  double best0=-10,best1=-10;
  for(int mask=0;mask<64;++mask){best0=std::max(best0,expected(table,0,mask));best1=std::max(best1,-expected(table,1,mask));}
  const double value=expected(table),exploitability=(best0+best1)/2;
  std::cout<<"Kuhn value="<<value<<", exploitability="<<exploitability<<"\n";
  require(std::abs(value+1.0/18)<.03 && exploitability<.04,"MCCFR fails small-game convergence");
}
int main(){information_tests();estimator_tests();kuhn_test();std::cout<<"CFR information, estimator, checkpoint and convergence checks passed\n";}
