#pragma once

#include <string>
#include <vector>

#include "js_rng.hpp"

namespace citadels::native {

struct DistrictCard {
  std::string uid;
  std::string color;
  int cost = 0;
  // Loaded game snapshots carry the localized card name.  Keeping it after
  // the existing fields preserves aggregate initialization of the built-in deck.
  std::string name;
  int score_value = 0;
  std::string purple_effect;
  std::string en;
  int score_as = 0;
  std::string desc;
};

inline std::vector<DistrictCard> build_base_district_deck(uint32_t seed) {
  // 顺序与 src/cards.js DISTRICTS 完全一致；UID 先分配再洗牌。
  struct Definition { const char* color; int cost, count; const char* name; const char* en; const char* effect; int score_as; const char* desc; };
  static const Definition definitions[] = {
    {"yellow", 3, 5, "庄园", "Manor", "", 0, ""},
    {"yellow", 4, 4, "城堡", "Castle", "", 0, ""},
    {"yellow", 5, 3, "宫殿", "Palace", "", 0, ""},
    {"blue", 1, 3, "神庙", "Temple", "", 0, ""},
    {"blue", 2, 3, "教堂", "Church", "", 0, ""},
    {"blue", 3, 3, "修道院", "Monastery", "", 0, ""},
    {"blue", 5, 2, "大教堂", "Cathedral", "", 0, ""},
    {"green", 1, 5, "酒馆", "Tavern", "", 0, ""},
    {"green", 2, 4, "集市", "Market", "", 0, ""},
    {"green", 3, 3, "商栈", "Trading Post", "", 0, "商业建筑。建造费用3金币，计分价值3分。"},
    {"green", 4, 3, "船坞", "Docks", "", 0, ""},
    {"green", 4, 3, "港口", "Harbor", "", 0, ""},
    {"green", 5, 2, "市政厅", "Town Hall", "", 0, "商业建筑。建造费用5金币，计分价值6分。"},
    {"red", 1, 3, "了望塔", "Watchtower", "", 0, ""},
    {"red", 2, 3, "监狱", "Prison", "", 0, ""},
    {"red", 3, 3, "战场", "Battlefield", "", 0, ""},
    {"red", 5, 2, "要塞", "Fortress", "", 0, ""},
    {"purple", 2, 1, "鬼城", "Ghost Town", "anyColorScore", 0, "终局计分时可视为任意一种颜色，包括最后一轮建成时。"},
    {"purple", 3, 2, "堡垒", "Keep", "immune", 0, "堡垒不会被领主/外交官摧毁或交换。"},
    {"purple", 4, 1, "博物馆", "Museum", "museum", 0, "你的回合中可将1张手牌面朝下放到博物馆下；计分时其下每张牌+1分。"},
    {"purple", 5, 1, "墓地", "Graveyard", "graveyard", 0, "当领主摧毁一栋建筑时，你可支付1枚金币将被摧毁的建筑收入手牌（若你本人是领主则不可用）。"},
    {"purple", 5, 1, "实验室", "Laboratory", "lab", 0, "你的回合中可弃一张手牌换取2金币，每回合一次。"},
    {"purple", 5, 1, "铁匠铺", "Smithy", "smithy", 0, "你的回合中可支付2枚金币抽3张建筑牌，每回合限一次。"},
    {"purple", 4, 1, "天文台", "Observatory", "draw3keep1", 0, "领取资源选择抽牌时抽三张而非两张。"},
    {"purple", 6, 1, "图书馆", "Library", "keepBoth", 0, "领取资源选择抽牌时保留全部所抽卡牌，可与天文台叠加。"},
    {"purple", 6, 1, "魔法学院", "School of Magic", "anyColorIncome", 0, "计算角色收入时，魔法学院可视为任意一种颜色（收入+1）。"},
    {"purple", 6, 1, "巨龙门", "Dragon Gate", "scoreAs", 8, "建造花费6金，但计分时价值8分。"},
    {"purple", 6, 1, "大学", "University", "scoreAs", 8, "建造花费6金，但计分时价值8分。"},
    {"purple", 6, 1, "长城", "Great Wall", "wallCost", 0, "八号角色对你的其他建筑使用能力时多付1金币。"},
    {"purple", 5, 1, "采石场", "Quarry", "quarry", 0, "可建造任意数量的同名建筑；不放宽行政官、外交官或元帅获取同名建筑的限制。"},
    {"purple", 3, 1, "军械库", "Armory", "armory", 0, "你的回合中可摧毁军械库，再摧毁一栋未完成城市中的建筑。"},
    {"purple", 4, 1, "圣殿", "Basilica", "basilica", 0, "终局时，每栋建造费用为奇数的建筑额外得1分。"},
    {"purple", 5, 1, "国会大厦", "Capitol", "capitol", 0, "终局时若有至少三栋同类型建筑，额外得3分，只计一次。"},
    {"purple", 5, 1, "工厂", "Factory", "factory", 0, "建造其他紫色建筑少付1金币。"},
    {"purple", 3, 1, "脚手架", "Framework", "framework", 0, "可摧毁脚手架代替支付另一栋建筑的费用，仍占建造次数。"},
    {"purple", 6, 1, "金矿", "Gold Mine", "goldMine", 0, "领取资源时选择金币，额外获得1金币。"},
    {"purple", 5, 1, "帝国金库", "Imperial Treasury", "treasury", 0, "终局时，每枚持有的金币额外得1分。"},
    {"purple", 5, 1, "象牙塔", "Ivory Tower", "ivoryTower", 0, "终局时若它是城中唯一紫色建筑，额外得5分。"},
    {"purple", 5, 1, "地图室", "Map Room", "mapRoom", 0, "终局时，每张手牌额外得1分。"},
    {"purple", 4, 1, "纪念碑", "Monument", "monument", 0, "已有五栋或更多建筑时不能建造；计算城市完成条件时视为两栋。"},
    {"purple", 5, 1, "大墓园", "Necropolis", "necropolis", 0, "可摧毁自己的一栋建筑代替支付本建筑费用，仍占建造次数。"},
    {"purple", 6, 1, "公园", "Park", "park", 0, "你的回合结束时若没有手牌，获得两张建筑牌。"},
    {"purple", 4, 1, "救济院", "Poor House", "poorHouse", 0, "你的回合结束时若没有金币，获得1金币，在炼金术士退款前结算。"},
    {"purple", 0, 1, "秘密宝库", "Secret Vault", "secretVault", 0, "不能建造；终局时展示手中的秘密宝库，额外得3分。"},
    {"purple", 2, 1, "马厩", "Stables", "stables", 0, "建造本建筑不占本回合的建造次数。"},
    {"purple", 3, 1, "雕像", "Statue", "statue", 0, "终局时若持有王冠，额外得5分。"},
    {"purple", 6, 1, "剧院", "Theater", "theater", 0, "选角结束时，可盲选另一名玩家的一张角色牌与自己的一张角色牌交换。"},
    {"purple", 6, 1, "盗贼巢穴", "Thieves’ Den", "thievesDen", 0, "可弃手牌抵付部分或全部建造费，每张抵1金币；被没收时只退金币。"},
    {"purple", 5, 1, "许愿井", "Wishing Well", "wishingWell", 0, "终局时，每栋紫色建筑额外得1分，包括许愿井自己。"},
    {"purple", 3, 1, "灯塔", "Lighthouse", "lighthouse", 0, "建成时可查看建筑牌堆，选择一张加入手牌，然后洗牌。"},
    {"purple", 5, 1, "钟楼", "Bell Tower", "bellTower", 0, "建成时可宣布城市完成条件为七栋；钟楼被摧毁后恢复原条件。"},
    {"purple", 6, 1, "舞厅", "Ballroom", "ballroom", 0, "你持有王冠时，其他玩家开始回合须选择致谢，否则跳过本回合。"},
    {"purple", 6, 1, "医院", "Hospital", "hospital", 0, "被刺杀时仍可领取基础资源，但不能建造或发动能力。"},
    {"purple", 6, 1, "王座厅", "Throne Room", "throneRoom", 0, "每次王冠更换持有人时获得1金币。"}
  };
  std::vector<DistrictCard> deck;
  int uid = 0;
  for (const auto& d : definitions) for (int i = 0; i < d.count; ++i)
    deck.push_back({"d" + std::to_string(uid++), d.color, d.cost, d.name, d.score_as > 0 ? d.score_as : d.cost, d.effect, d.en, d.score_as, d.desc});
  JsRng rng(seed);
  for (size_t i = deck.size() - 1; i > 0; --i) {
    const size_t j = static_cast<size_t>(rng.next() * static_cast<double>(i + 1));
    std::swap(deck[i], deck[j]);
  }
  return deck;
}

}  // namespace citadels::native
