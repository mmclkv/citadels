#include <iostream>
#include <stdexcept>
#include <string>

#include "game_adapter.hpp"
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
      for (const auto& record : records.as_array()) {
        const auto& player_value = required_item(record, "playerId");
        const auto& action = required_item(record, "action");
        if (!player_value.is_string() || !action.is_object()) throw std::runtime_error("动作记录格式错误");
        const auto type = string_field(action, "type");
        int player = -1;
        for (size_t i = 0; i < state.players.size(); ++i)
          if (state.players[i].id == player_value.as_string()) player = static_cast<int>(i);
        if (player < 0) throw std::runtime_error("动作玩家不存在");
        const int expected_player = state.reaction_kind == "graveyard" ? state.reaction_player :
          (state.phase == NativePhase::Draft ? state.draft_current_player : state.active_player);
        if (expected_player != player && type != "confirm_round")
          throw std::runtime_error("动作玩家不是当前行动者: " + type);
        if (type == "draft_pick") {
          if (state.phase != NativePhase::Draft || state.draft_sub != "pick" || !state.draft_remove(string_field(action, "charId")))
            throw std::runtime_error("draft_pick 执行失败");
          const auto char_id = string_field(action, "charId");
          state.players[player].role_ids.push_back(char_id);
          state.players[player].role_id = char_id;
          if (!state.advance_draft()) throw std::runtime_error("draft_pick 无法推进选角");
        } else if (type == "draft_discard") {
          const auto char_id = string_field(action, "charId");
          if (state.phase != NativePhase::Draft || state.draft_sub != "discard" || !state.draft_remove(char_id))
            throw std::runtime_error("draft_discard 执行失败");
          state.draft_face_down.push_back(char_id);
          if (!state.advance_draft()) throw std::runtime_error("draft_discard 无法推进选角");
        } else if (type == "choose_char") {
          NativeSearchAction chosen{ActionType::ChooseChar, {}, std::to_string(int_field(action, "num")), {}};
          NativeGameAdapter adapter;
          if (!adapter.apply(state, player, chosen)) throw std::runtime_error("choose_char 执行失败");
        } else if (type == "magician_mode") {
          NativeSearchAction chosen{ActionType::MagicianMode, {}, string_field(action, "mode"), {}, {}};
          NativeGameAdapter adapter;
          if (!adapter.apply(state, player, chosen)) throw std::runtime_error("magician_mode 执行失败");
        } else if (type == "choose_player") {
          NativeSearchAction chosen{ActionType::ChoosePlayer, {}, {}, {}, string_field(action, "target")};
          NativeGameAdapter adapter;
          if (!adapter.apply(state, player, chosen)) throw std::runtime_error("choose_player 执行失败");
        } else if (type == "emperor_crown") {
          NativeSearchAction chosen{ActionType::EmperorCrown, {}, {}, {}, string_field(action, "target")};
          NativeGameAdapter adapter;
          if (!adapter.apply(state, player, chosen)) throw std::runtime_error("emperor_crown 执行失败");
        } else if (type == "emperor_take") {
          NativeSearchAction chosen{ActionType::EmperorTake, {}, string_field(action, "mode"), {}, {}};
          NativeGameAdapter adapter;
          if (!adapter.apply(state, player, chosen)) throw std::runtime_error("emperor_take 执行失败");
        } else if (type == "choose_district") {
          NativeSearchAction chosen{ActionType::ChooseDistrict, string_field(action, "uid"), {}, {}, string_field(action, "target")};
          NativeGameAdapter adapter;
          if (!adapter.apply(state, player, chosen)) throw std::runtime_error("choose_district 执行失败");
        } else if (type == "reaction") {
          NativeSearchAction chosen{ActionType::Reaction, {}, bool_field(action, "use") ? "use" : "skip", {}, {}};
          NativeGameAdapter adapter;
          if (!adapter.apply(state, player, chosen)) throw std::runtime_error("reaction 执行失败");
        } else if (type == "navigator_bonus") {
          NativeSearchAction chosen{ActionType::NavigatorBonus, {}, string_field(action, "mode"), {}, {}};
          NativeGameAdapter adapter;
          if (!adapter.apply(state, player, chosen)) throw std::runtime_error("navigator_bonus 执行失败");
        } else if (type == "monk_resource") {
          NativeSearchAction chosen{ActionType::MonkResource, {}, std::to_string(int_field(action, "gold")), std::to_string(int_field(action, "cards")), {}};
          NativeGameAdapter adapter;
          if (!adapter.apply(state, player, chosen)) throw std::runtime_error("monk_resource 执行失败");
        } else if (type == "scholar_pick" || type == "draw_keep") {
          NativeSearchAction chosen{type == "scholar_pick" ? ActionType::ScholarPick : ActionType::DrawKeep,
            string_field(action, "uid"), {}, {}, {}};
          NativeGameAdapter adapter;
          if (!adapter.apply(state, player, chosen)) throw std::runtime_error(type + " 执行失败");
        } else if (type == "take_gold") {
          if (!state.take_gold()) throw std::runtime_error("take_gold 执行失败");
        } else if (type == "take_cards") {
          if (!state.take_cards()) throw std::runtime_error("take_cards 执行失败");
        } else if (type == "build") {
          const auto uid = string_field(action, "uid");
          const auto name = string_field(action, "name");
          if (!state.build(uid, name)) throw std::runtime_error("build 执行失败");
        } else if (type == "end_turn") {
          if (!state.end_turn()) throw std::runtime_error("end_turn 执行失败");
        } else {
          throw std::runtime_error("当前 probe 尚未迁移动作: " + type);
        }
      }
      std::cout << "{\"ok\":true,\"phase\":\"" << phase_name(state.phase)
                << "\",\"round\":" << state.round << ",\"players\":[";
      for (size_t i = 0; i < state.players.size(); ++i) {
        if (i) std::cout << ',';
        const auto& p = state.players[i];
        std::cout << "{\"id\":\"" << p.id << "\",\"gold\":" << p.gold
                  << ",\"handCount\":" << p.hand.size()
                  << ",\"cityCount\":" << p.city.size()
                  << ",\"hasCrown\":" << (p.has_crown ? "true" : "false") << ",\"chars\":[";
        for (size_t j = 0; j < p.role_ids.size(); ++j) {
          if (j) std::cout << ',';
          std::cout << '"' << p.role_ids[j] << '"';
        }
        std::cout << "]}";
      }
      std::cout << "]}\n" << std::flush;
    } catch (const std::exception& error) {
      std::cout << "{\"ok\":false,\"error\":\"" << error.what() << "\"}\n" << std::flush;
    }
  }
}
