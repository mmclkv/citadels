#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "game_adapter.hpp"
#include "json_value.hpp"
#include "state_loader.hpp"

using namespace citadels::native;

namespace {

std::string escape(const std::string& value) {
  std::string out;
  for (const char ch : value) {
    if (ch == '\\' || ch == '"') out.push_back('\\');
    if (ch == '\n') { out += "\\n"; continue; }
    if (ch == '\r') { out += "\\r"; continue; }
    out.push_back(ch);
  }
  return out;
}

int player_index(const NativeGameState& state, const std::string& id) {
  for (size_t i = 0; i < state.players.size(); ++i)
    if (state.players[i].id == id) return static_cast<int>(i);
  return -1;
}

NativeSearchAction decode_action(const JsonValue& value) {
  if (!value.is_object()) throw std::runtime_error("合法动作必须是对象");
  const auto type = string_field(value, "type");
  const auto parsed = action_type_from_string(type);
  if (!parsed) throw std::runtime_error("未知动作类型: " + type);
  return {*parsed, string_field(value, "uid"), string_field(value, "name"), string_field(value, "effect")};
}

void emit_error(const std::string& id, const std::string& message) {
  std::cout << "{\"v\":1,\"t\":\"error\",\"id\":\"" << escape(id)
            << "\",\"error\":\"" << escape(message) << "\"}\n" << std::flush;
}

}  // namespace

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::string id;
    try {
      const auto request = parse_json(line);
      const auto& id_value = required_field(request, "id");
      id = id_value.as_string();
      const auto& state_value = required_field(request, "state");
      const auto& actions_value = required_field(request, "legalActions");
      const auto root_id = string_field(request, "rootPlayerId");
      if (!actions_value.is_array() || actions_value.as_array().empty())
        throw std::runtime_error("legalActions 不能为空");
      NativeGameState state = load_native_state(state_value);
      const int root = player_index(state, root_id);
      if (root < 0) throw std::runtime_error("rootPlayerId 不存在");
      std::vector<NativeSearchAction> supplied;
      supplied.reserve(actions_value.as_array().size());
      for (const auto& value : actions_value.as_array()) supplied.push_back(decode_action(value));

      NativeGameAdapter game;
      UniformNativeEvaluator evaluator;
      Mcts<NativeGameState, NativeSearchAction>::Config config;
      config.simulations = std::max(1, int_field(request, "simulations", 50));
      config.max_depth = std::max(1, int_field(request, "maxDepth", 200));
      config.c_puct = static_cast<float>(int_field(request, "cPuct", 1));
      config.seed = static_cast<uint32_t>(int_field(request, "seed", 1));
      const auto native_actions = game.legal_actions(state, root);
      std::vector<float> policy;
      if (native_actions.size() == supplied.size()) {
        bool same_order = true;
        for (size_t i = 0; i < supplied.size(); ++i) {
          if (native_actions[i].type != supplied[i].type ||
              (!supplied[i].uid.empty() && native_actions[i].uid != supplied[i].uid)) {
            same_order = false; break;
          }
        }
        if (same_order) policy = Mcts<NativeGameState, NativeSearchAction>(game, evaluator, config)
          .search(state, root).policy;
      }
      if (policy.size() != supplied.size()) policy.assign(supplied.size(), 1.0f / supplied.size());
      std::cout << "{\"v\":1,\"t\":\"search_result\",\"id\":\"" << escape(id)
                << "\",\"policy\":[";
      for (size_t i = 0; i < policy.size(); ++i) {
        if (i) std::cout << ',';
        std::cout << policy[i];
      }
      std::cout << "],\"value\":0,\"backend\":\"native-mcts\"}\n" << std::flush;
    } catch (const std::exception& error) {
      emit_error(id, error.what());
    }
  }
}
