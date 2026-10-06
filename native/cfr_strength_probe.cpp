#include <fstream>
#include <iostream>
#include <sstream>
#include "game_setup.hpp"
#include "npc_policy.hpp"
#include "cfr_client.hpp"
using namespace citadels::native;
int main(int argc,char** argv) {
  try {
    const int seeds=argc>1?std::stoi(argv[1]):40;
    const int n=argc>2?std::stoi(argv[2]):5;
    if(seeds<1 || seeds>100000 || n<2 || n>8)throw std::runtime_error("Expected 1..100000 seeds and 2..8 players");
    const bool random_opponent=argc>3 && std::string(argv[3])=="random";
    std::ifstream f("python_backend/catalog.json");
    const std::string catalog((std::istreambuf_iterator<char>(f)),{});
    NativeGameAdapter rules; CfrClient client;
    double wins=0,rank=0,score=0; long decisions=0,hits=0,choices=0,choice_hits=0;
    for(int g=0;g<seeds*n;++g) {
      const int own=g%n; const uint32_t seed=930000+g/n;
      std::ostringstream q;
      q<<"{\"seed\":"<<seed<<",\"initialCrownSeat\":"<<(g/n)%n
       <<",\"endDistricts\":8,\"charSetMode\":\"random\",\"catalog\":"<<catalog<<",\"seats\":[";
      for(int i=0;i<n;++i) {if(i)q<<',';q<<"{\"id\":\"p"<<i<<"\",\"isBot\":true}";}
      q<<"]}"; auto state=create_native_game(parse_json(q.str()));
      for(auto& p:state.players)p.bot_level="hard"; // Explicit old fast-hard reference; setup now clears levels.
      int steps=0; long game_hits=0,game_decisions=0;
      while(state.phase!=NativePhase::GameOver && steps<60000) {
        const int actor=rules.next_player(state);const auto legal=rules.legal_actions(state,actor);
        const auto actions=cfr_abstract_actions(state,actor,legal);
        const uint32_t action_seed=seed+steps*1664525u+actor*1013904223u;
        int selected=-1;
        if(actor==own) {
          const auto choice=client.decide(cfr_abstract_information(state,actor,actions),actions,action_seed);
          selected=choice.selected;++decisions;++game_decisions;hits+=choice.hit;game_hits+=choice.hit;
          if(actions.keys.size()>1){++choices;choice_hits+=choice.hit;}
        } else if(random_opponent) {
          std::mt19937 rng(action_seed);const auto group=std::uniform_int_distribution<size_t>(0,actions.keys.size()-1)(rng);
          const auto& copies=actions.indices[group];selected=copies[std::uniform_int_distribution<size_t>(0,copies.size()-1)(rng)];
        } else selected=NativeNpcPolicy::choose(state,actor,legal,action_seed);
        if(selected<0 || !rules.apply(state,actor,legal.at(selected)))throw std::runtime_error("Rejected benchmark action");
        ++steps;
      }
      if(state.phase!=NativePhase::GameOver)throw std::runtime_error("Benchmark did not finish");
      const double points=native_player_score(state,own);int above=0,tied=0;
      for(int i=0;i<n;++i){const auto s=native_player_score(state,i);above+=s>points;tied+=s==points;}
      const double win=above?0:1.0/tied; const double reward=native_terminal_reward(state,own);
      wins+=win;rank+=reward;score+=points;
      std::cout<<"{\"game\":"<<g<<",\"seat\":"<<own<<",\"seed\":"<<seed<<",\"score\":"<<points
        <<",\"first\":"<<win<<",\"reward\":"<<reward<<",\"rounds\":"<<state.round
        <<",\"hits\":"<<game_hits<<",\"decisions\":"<<game_decisions<<"}\n"<<std::flush;
    }
    const int games=seeds*n;
    std::cout<<"{\"summary\":true,\"games\":"<<games<<",\"firstRate\":"<<wins/games
      <<",\"meanReward\":"<<rank/games<<",\"meanScore\":"<<score/games<<",\"hits\":"<<hits
      <<",\"decisions\":"<<decisions<<",\"choiceHits\":"<<choice_hits<<",\"choices\":"<<choices<<"}\n";
  }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
