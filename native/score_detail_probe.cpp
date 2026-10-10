#include <cassert>
#include <iostream>
#include <sstream>
#include "state_loader.hpp"
#include "state_writer.hpp"

using namespace citadels::native;
using Details = std::vector<std::pair<std::string, int>>;

static DistrictCard card(std::string name, std::string effect = {}, int cost = 3,
                         std::string color = "purple") {
  return {name, color, cost, name, cost, effect, name};
}
static void city(NativeGameState& s, DistrictCard c) {
  s.players[0].city.push_back({c, c.name, c.purple_effect, {}, false, false, s.round});
}
static NativeGameState base() {
  NativeGameState s;
  NativePlayer p; p.id = "p0"; p.name = "我"; p.gold = 20; p.has_crown = true;
  s.players.push_back(p);
  return s;
}
static Details rewards(const NativeGameState& s, int expected_bonus) {
  std::ostringstream output; write_native_state(output, s);
  const auto serialized = JsonParser(output.str()).parse();
  const auto& row = required_field(serialized, "scores").as_array().front();
  Details details;
  int sum = 0;
  for (const auto& item : required_field(row, "detail").as_array()) {
    const auto label = required_field(item, "label").as_string();
    const int points = static_cast<int>(required_field(item, "value").as_number());
    sum += points;
    if (label != "建筑总分") { assert(points > 0); details.emplace_back(label, points); }
  }
  assert(sum == required_field(row, "total").as_number());
  assert(expected_bonus == required_field(row, "bonus").as_number());
  assert(s.score_bonus(0) == expected_bonus);
  return details;
}
int main() {
  auto s = base();
  assert(rewards(s, 0).empty());
  city(s, card("象牙塔", "ivoryTower", 5));
  city(s, card("幽灵区", "anyColorScore", 2));
  for (const auto& color : {"yellow", "blue", "green", "red"}) city(s, card(color, {}, 1, color));
  assert((rewards(s, 8) == Details{{"五色齐全奖励", 3}, {"象牙塔加成奖励", 5}}));

  s = base();
  city(s, card("博物馆")); s.players[0].city.back().museum_cards = {card("展品")};
  s.players[0].city.back().beautified = true;
  city(s, card("金库", "treasury", 5)); city(s, card("地图室", "mapRoom", 5));
  city(s, card("雕像", "statue", 3));
  s.players[0].hand = {card("秘密宝库", "secretVault", 0), card("手牌")};
  s.first_finishers = {0};
  assert((rewards(s, 36) == Details{{"博物馆加成奖励", 1}, {"博物馆美化奖励", 1},
    {"金库加成奖励", 20}, {"地图室加成奖励", 2}, {"雕像加成奖励", 5},
    {"秘密宝库加成奖励", 3}, {"率先完工奖励", 4}}));
  s.first_finishers.clear(); s.end_districts = 4;
  assert((rewards(s, 34).back() == std::pair<std::string, int>{"完工奖励", 2}));

  s = base(); city(s, card("许愿井", "wishingWell", 5)); city(s, card("其他"));
  assert((rewards(s, 1) == Details{{"许愿井加成奖励", 1}}));
  s = base(); city(s, card("国会", "capitol", 5));
  for (int i = 0; i < 3; ++i) city(s, card("green" + std::to_string(i), {}, 1, "green"));
  assert((rewards(s, 3) == Details{{"国会加成奖励", 3}}));
  s = base(); city(s, card("大教堂", "basilica", 4)); city(s, card("奇数费用", {}, 3, "green"));
  assert((rewards(s, 1) == Details{{"大教堂加成奖励", 1}}));
  s.players[0].city.back().beautified = true;
  assert((rewards(s, 1) == Details{{"奇数费用美化奖励", 1}}));
  std::cout << "score detail checks passed\n";
}
