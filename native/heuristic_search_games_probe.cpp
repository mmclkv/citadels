#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include "game_setup.hpp"
#include "heuristic_search.hpp"
using namespace citadels::native;
int main(int argc,char** argv){
  const int games=argc>1?std::stoi(argv[1]):10,players=argc>2?std::stoi(argv[2]):5;
  std::ifstream file("python_backend/catalog.json");const std::string catalog((std::istreambuf_iterator<char>(file)),{});
  NativeGameAdapter rules;int searches=0,visits=0,decisions=0,reused=0,rollout_actions=0;double max_ms=0;
  HeuristicSearchConfig config;
  const bool matchup=argc>4 && std::string(argv[4])=="matchup";
  double wins=0,reward=0;
  if(argc>3){config.simulations=std::stoi(argv[3]);config.time_budget_ms=0;}
  const auto start=std::chrono::steady_clock::now();
  for(int g=0;g<games;++g){
    std::ostringstream q;q<<"{\"seed\":"<<1700+g<<",\"initialCrownSeat\":"<<(g/players)%players<<",\"endDistricts\":8,\"charSetMode\":\"random\",\"catalog\":"<<catalog<<",\"seats\":[";
    for(int i=0;i<players;++i){if(i)q<<',';q<<"{\"id\":\"p"<<i<<"\",\"botLevel\":\"hard\"}";}q<<"]}";
    auto s=create_native_game(parse_json(q.str()));int steps=0;
    HeuristicSearchSession session;
    while(s.phase!=NativePhase::GameOver && steps<10000 && s.round<150){
      const int actor=rules.next_player(s);const auto legal=rules.legal_actions(s,actor);
      auto budget=config;if(matchup && actor!=g%players)budget.enabled=false;
      const auto choice=choose_native_npc(s,actor,legal,1700+g+steps,budget,&session);
      if(choice.fallback)throw std::runtime_error("unexpected search fallback: "+choice.fallback_reason+
        " round="+std::to_string(s.round)+" step="+std::to_string(steps)+" role="+s.players[actor].role_id+" pending="+s.pending_kind);
      const auto previous=s;
      if(choice.selected<0 || !rules.apply(s,actor,legal.at(choice.selected)))throw std::runtime_error("search selected illegal action");
      session.advance(previous,actor,legal.at(choice.selected),s);
      reused+=choice.reused_visits;rollout_actions+=choice.rollout_actions;
      searches+=choice.searched;visits+=choice.visits;max_ms=std::max(max_ms,choice.elapsed_ms);++steps;
    }
    if(s.phase!=NativePhase::GameOver)throw std::runtime_error("heuristic search game stalled");
    if(matchup){const int own=g%players;const double points=native_player_score(s,own);
      int above=0,tied=0;for(int i=0;i<players;++i){const double score=native_player_score(s,i);above+=score>points;tied+=score==points;}
      wins+=above?0:1.0/tied;reward+=native_terminal_reward_vector(s,own)[0];}
    decisions+=steps;std::cout<<"game="<<g<<" players="<<players<<" rounds="<<s.round<<" decisions="<<steps<<std::endl;
  }
  const auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count();
  std::cout<<"completed="<<games<<" decisions="<<decisions<<" searches="<<searches<<" visits="<<visits<<" elapsedMs="<<ms<<" maxDecisionMs="<<max_ms<<'\n';
  std::cout<<"reusedVisits="<<reused<<" rolloutActions="<<rollout_actions<<'\n';
  if(matchup)std::cout<<"searchVsFastHard firstRate="<<wins/games<<" meanRankReward="<<reward/games<<'\n';
}
