#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include "game_setup.hpp"
#include "npc_policy.hpp"
using namespace citadels::native;
int main(int argc,char** argv) {
  const int games=argc>1?std::stoi(argv[1]):10;
  const int players=argc>2?std::stoi(argv[2]):5;
  std::ifstream file("python_backend/catalog.json");
  const std::string catalog((std::istreambuf_iterator<char>(file)),{});
  NativeGameAdapter rules;
  const auto start=std::chrono::steady_clock::now();
  int total_steps=0;
  for(int g=0;g<games;++g) {
    std::ostringstream request;
    request<<"{\"seed\":"<<700+g<<",\"endDistricts\":8,\"charSetMode\":\"random\",\"catalog\":"<<catalog<<",\"seats\":[";
    for(int i=0;i<players;++i) {
      if(i)request<<',';
      request<<"{\"id\":\"p"<<i<<"\",\"botLevel\":\"hard\",\"isBot\":true}";
    }
    request<<"]}";
    auto s=create_native_game(parse_json(request.str()));
    int steps=0;
    while(s.phase!=NativePhase::GameOver && steps<10000 && s.round<=150) {
      const int actor=rules.next_player(s);
      const auto actions=rules.legal_actions(s,actor);
      const int choice=NativeNpcPolicy::choose(s,actor,actions,700+g+steps);
      if(choice<0 || !rules.apply(s,actor,actions.at(static_cast<size_t>(choice))))
        throw std::runtime_error("NPC failed legal action at round "+std::to_string(s.round)+" pending="+s.pending_kind);
      ++steps;
    }
    if(s.phase!=NativePhase::GameOver)throw std::runtime_error("NPC game stalled");
    total_steps+=steps;
    std::cout<<"game="<<g<<" rounds="<<s.round<<" steps="<<steps<<'\n';
  }
  const auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count();
  std::cout<<"completed="<<games<<" decisions="<<total_steps<<" elapsedMs="<<ms<<'\n';
}
