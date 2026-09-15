#include <iostream>
#include <stdexcept>
#include <string>

#include "state_loader.hpp"

using namespace citadels::native;

namespace {

std::string phase_name(NativePhase phase) {
  switch (phase) {
    case NativePhase::Lobby: return "lobby";
    case NativePhase::Draft: return "draft";
    case NativePhase::Action: return "action";
    case NativePhase::Reaction: return "reaction";
    case NativePhase::RoundConfirm: return "roundConfirm";
    case NativePhase::GameOver: return "gameover";
    default: return "unknown";
  }
}

const JsonValue& required_item(const JsonValue& object, const char* name) {
  const auto* value = object.get(name);
  if (!value) throw std::runtime_error(std::string("回放缺少字段: ") + name);
  return *value;
}

}  // namespace

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    try {
      const auto request = parse_json(line);
      const auto& initial = required_item(request, "initialState");
      const auto& records = required_item(request, "records");
      if (!records.is_array() || records.as_array().empty()) throw std::runtime_error("回放至少需要一条动作");
      NativeGameState state = load_native_state(initial);
      const auto& record = records.as_array().front();
      const auto& player_value = required_item(record, "playerId");
      const auto& action = required_item(record, "action");
      if (!player_value.is_string() || !action.is_object()) throw std::runtime_error("动作记录格式错误");
      const auto type = string_field(action, "type");
      int player = -1;
      for (size_t i = 0; i < state.players.size(); ++i)
        if (state.players[i].id == player_value.as_string()) player = static_cast<int>(i);
      if (player < 0) throw std::runtime_error("动作玩家不存在");
      if (type == "take_gold") {
        if (state.active_player != player || !state.take_gold()) throw std::runtime_error("take_gold 执行失败");
      } else {
        throw std::runtime_error("当前 probe 尚未迁移动作: " + type);
      }
      std::cout << "{\"ok\":true,\"phase\":\"" << phase_name(state.phase)
                << "\",\"round\":" << state.round << ",\"players\":[";
      for (size_t i = 0; i < state.players.size(); ++i) {
        if (i) std::cout << ',';
        const auto& p = state.players[i];
        std::cout << "{\"id\":\"" << p.id << "\",\"gold\":" << p.gold
                  << ",\"handCount\":" << p.hand.size()
                  << ",\"cityCount\":" << p.city.size()
                  << ",\"hasCrown\":" << (p.has_crown ? "true" : "false") << "}";
      }
      std::cout << "]}\n" << std::flush;
    } catch (const std::exception& error) {
      std::cout << "{\"ok\":false,\"error\":\"" << error.what() << "\"}\n" << std::flush;
    }
  }
}
