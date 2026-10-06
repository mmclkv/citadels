#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <iostream>
#include <iomanip>
#include <algorithm>
#include <cstdint>
#include <limits>
#include <sstream>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <utility>

#include "game_adapter.hpp"
#include "game_setup.hpp"
#include "json_value.hpp"
#include "heuristic_search.hpp"
#include "state_loader.hpp"
#include "state_writer.hpp"

using namespace citadels::native;

namespace {
std::unordered_map<std::string, NativeGameState> games;
std::unordered_map<std::string, HeuristicSearchSession> heuristic_sessions;

HeuristicSearchConfig heuristic_options(const JsonValue& request) {
  auto config = heuristic_search_defaults();
  const auto* value = request.get("heuristicMcts");
  if (!value || !value->is_object()) return config;
  const auto* field=value->get("timeBudgetMs");
  if(field && field->is_number() && std::isfinite(field->as_number())) {
    const double milliseconds=field->as_number();
    if(milliseconds>=0 && milliseconds<=std::numeric_limits<int>::max()) {
      auto derived=heuristic_search_for_budget(static_cast<int>(milliseconds));
      derived.enabled=config.enabled;config=derived;
    }
  }
  return config;
}

void emit_error(const std::string& id, const std::string& message) {
  std::cout << "{\"v\":1,\"t\":\"error\",\"id\":";
  write_json_string(std::cout, id);
  std::cout << ",\"error\":";
  write_json_string(std::cout, message);
  std::cout << "}\n" << std::flush;
}

int player_index(const NativeGameState& state, const std::string& id) {
  for (size_t i = 0; i < state.players.size(); ++i)
    if (state.players[i].id == id) return static_cast<int>(i);
  return -1;
}

NativeSearchAction decode_action(const JsonValue& value) {
  if (!value.is_object()) throw std::runtime_error("行动必须是对象");
  NativeSearchAction action;
  const auto type = action_type_from_string(string_field(value, "type"));
  if (!type) throw std::runtime_error("未知行动类型");
  action.type = *type;
  action.uid = string_field(value, "uid");
  action.name = string_field(value, "name");
  if (action.name.empty()) action.name = string_field(value, "charId");
  if (action.name.empty()) action.name = string_field(value, "mode");
  action.effect = string_field(value, "effect");
  if (action.effect.empty() && value.get("use"))
    action.effect = bool_field(value, "use") ? "use" : "skip";
  action.target = string_field(value, "target");
  action.selected_uids = string_array_field(value, "uids");
  action.secondary_uid = string_field(value, "discardUid", string_field(value, "cardUid"));
  action.mode = string_field(value, "mode");
  action.color = string_field(value, "color");
  if (const auto* field = value.get("num"); field && field->is_number()) {
    action.num = static_cast<int>(field->as_number()); action.has_num = true;
  }
  if (const auto* field = value.get("gold"); field && field->is_number()) action.gold = static_cast<int>(field->as_number());
  if (const auto* field = value.get("cards"); field && field->is_number()) action.cards = static_cast<int>(field->as_number());
  action.use = bool_field(value, "use");
  if (action.name.empty() && action.type == ActionType::Reaction)
    action.name = action.effect;
  return action;
}

bool matches(const NativeSearchAction& candidate, const NativeSearchAction& action) {
  return candidate.type == action.type &&
      (action.uid.empty() || candidate.uid == action.uid) &&
      (action.name.empty() || candidate.name == action.name) &&
      (action.target.empty() || candidate.target == action.target) &&
      (action.secondary_uid.empty() || candidate.secondary_uid == action.secondary_uid) &&
      (action.selected_uids.empty() || candidate.selected_uids == action.selected_uids) &&
      (!action.has_num || candidate.num == action.num) &&
      (action.gold < 0 || candidate.gold == action.gold) &&
      (action.cards < 0 || candidate.cards == action.cards) &&
      (action.color.empty() || candidate.color == action.color);
}
}  // namespace

int main() {
  std::string line;
  while (std::getline(std::cin, line)) {
    std::string id;
    try {
      const auto request = parse_json(line);
      id = string_field(request, "id");
      const auto mode = string_field(request, "mode");
      const auto game_id = string_field(request, "gameId");
      NativeGameAdapter rules;
      if (mode == "create") {
        const auto* new_game = request.get("newGame");
        if (!new_game) throw std::runtime_error("create 缺少 newGame");
        const auto state = create_native_game(*new_game);
        games[game_id] = state;
        heuristic_sessions.erase(game_id);
        std::cout << "{\"v\":1,\"t\":\"game_result\",\"id\":";
        write_json_string(std::cout, id);
        std::cout << ",\"state\":"; write_native_state(std::cout, state);
        std::cout << "}\n" << std::flush;
        continue;
      }
      auto found = games.find(game_id);
      if (game_id.empty() || found == games.end()) throw std::runtime_error("未知 gameId");
      auto& state = found->second;
      if (mode == "snapshot") {
        std::cout << "{\"v\":1,\"t\":\"game_result\",\"id\":";
        write_json_string(std::cout, id);
        std::cout << ",\"state\":"; write_native_state(std::cout, state);
        std::cout << "}\n" << std::flush;
      } else if (mode == "current") {
        const int actor = rules.next_player(state);
        std::cout << "{\"v\":1,\"t\":\"current_result\",\"id\":";
        write_json_string(std::cout, id);
        std::cout << ",\"playerId\":";
        if (actor < 0 || actor >= static_cast<int>(state.players.size())) std::cout << "null";
        else write_json_string(std::cout, state.players[static_cast<size_t>(actor)].id);
        const bool terminal = state.phase == NativePhase::GameOver;
        const bool include_rewards = terminal || bool_field(request, "includeRewards");
        std::cout << ",\"round\":" << state.round
                  << ",\"gameOver\":" << (terminal ? "true" : "false")
                  << ",\"rewards\":[";
        if (include_rewards) for (size_t i = 0; i < state.players.size(); ++i) {
          if (i) std::cout << ',';
          std::cout << native_terminal_reward(state, static_cast<int>(i));
        }
        std::cout << "]}\n" << std::flush;
      } else if (mode == "decision") {
        const int actor = rules.next_player(state);
        if (actor < 0 || actor >= static_cast<int>(state.players.size()))
          throw std::runtime_error("当前局面没有行动玩家");
        const auto actions = rules.legal_actions(state, actor);
        std::cout << "{\"v\":1,\"t\":\"decision_result\",\"id\":";
        write_json_string(std::cout, id);
        std::cout << ",\"playerId\":"; write_json_string(std::cout, state.players[actor].id);
        std::cout << ",\"round\":" << state.round << ",\"state\":";
        write_native_state(std::cout, state);
        std::cout << ",\"actions\":[";
        for (size_t i = 0; i < actions.size(); ++i) {
          if (i) std::cout << ',';
          write_native_action(std::cout, actions[i]);
        }
        std::cout << "]}\n" << std::flush;
      } else if (mode == "advance_npcs") {
        std::unordered_set<std::string> network_players;
        for (const auto& player : string_array_field(request, "networkPlayerIds"))
          network_players.insert(player);
        const int max_steps = std::max(1, int_field(request, "maxSteps", 60000));
        const uint32_t seed = static_cast<uint32_t>(number_field(request, "seed", 1));
        int steps = 0;
        int heuristic_searches=0,heuristic_fallbacks=0,heuristic_visits=0;
        int heuristic_reused=0,heuristic_rollout_actions=0,heuristic_new_visits=0;
        double heuristic_ms=0;
        std::string heuristic_failure;
        const bool include_training_features = bool_field(request, "includeTrainingFeatures");
        std::vector<std::pair<std::string, std::vector<float>>> training_samples;
        while (steps < max_steps && state.phase != NativePhase::GameOver &&
               state.round <= int_field(request, "maxRounds", 1000)) {
          const int actor = rules.next_player(state);
          if (actor < 0 || actor >= static_cast<int>(state.players.size())) break;
          if (network_players.count(state.players[actor].id)) break;
          const auto actions = rules.legal_actions(state, actor);
          const auto heuristic_decision = choose_native_npc(state, actor, actions,
              seed + static_cast<uint32_t>(steps) * 0x9E3779B1u,heuristic_options(request),&heuristic_sessions[game_id]);
          const int selected=heuristic_decision.selected;
          heuristic_searches+=heuristic_decision.searched;heuristic_fallbacks+=heuristic_decision.fallback;
          heuristic_visits+=heuristic_decision.visits;heuristic_ms+=heuristic_decision.elapsed_ms;
          heuristic_reused+=heuristic_decision.reused_visits;
          heuristic_rollout_actions+=heuristic_decision.rollout_actions;
          heuristic_new_visits+=heuristic_decision.new_visits;
          if(heuristic_decision.fallback && heuristic_failure.empty())heuristic_failure=heuristic_decision.fallback_reason;
          if (selected < 0 || selected >= static_cast<int>(actions.size())) {
            std::ostringstream detail;
            detail << "NPC 策略未选出有效行动（player=" << state.players[actor].id
                   << ", actor=" << actor << ", phase=" << native_phase_name(state.phase)
                   << ", role=" << state.players[actor].role_id
                   << ", pending=" << state.pending_kind << ", round=" << state.round
                   << ", legalCount=" << actions.size() << ", selected=" << selected << ")";
            throw std::runtime_error(detail.str());
          }
          const auto& action = actions[static_cast<size_t>(selected)];
          if (include_training_features && state.players[actor].is_bot &&
              state.players[actor].bot_type != "neural") {
            training_samples.emplace_back(state.players[actor].id,
                encode_features(state, actor, 8));
          }
          std::optional<NativeGameState> previous;
          if(!heuristic_sessions[game_id].tree.empty())previous=state;
          if (!rules.apply(state, actor, action)) {
            std::ostringstream detail;
            detail << "游戏主进程无法应用 NPC 合法行动（player=" << state.players[actor].id
                   << ", actor=" << actor << ", phase=" << native_phase_name(state.phase)
                   << ", role=" << state.players[actor].role_id
                   << ", pending=" << state.pending_kind << ", turnPhase=" << state.turn_phase
                   << ", round=" << state.round << ", steps=" << steps
                   << ", legalCount=" << actions.size() << ", selected=" << selected
                   << ", action=";
            write_native_action(detail, action);
            detail << ", legalActions=[";
            for (size_t i = 0; i < actions.size(); ++i) {
              if (i) detail << ',';
              write_native_action(detail, actions[i]);
            }
            detail << "])";
            throw std::runtime_error(detail.str());
          }
          if(previous)heuristic_sessions[game_id].advance(*previous,actor,action,state);
          ++steps;
        }
        const int actor = rules.next_player(state);
        std::cout << "{\"v\":1,\"t\":\"advance_result\",\"id\":";
        write_json_string(std::cout, id);
        std::cout << ",\"steps\":" << steps << ",\"round\":" << state.round
                  << ",\"heuristicSearch\":{\"searches\":" << heuristic_searches << ",\"fallbacks\":" << heuristic_fallbacks
                  << ",\"visits\":" << heuristic_visits << ",\"newVisits\":" << heuristic_new_visits
                  << ",\"reusedVisits\":" << heuristic_reused << ",\"rolloutActions\":" << heuristic_rollout_actions
                  << ",\"elapsedMs\":" << heuristic_ms << ",\"fallbackReason\":";
        write_json_string(std::cout,heuristic_failure);
        std::cout << "}"
                  << ",\"gameOver\":" << (state.phase == NativePhase::GameOver ? "true" : "false")
                  << ",\"playerId\":";
        if (actor < 0 || actor >= static_cast<int>(state.players.size())) std::cout << "null";
        else write_json_string(std::cout, state.players[static_cast<size_t>(actor)].id);
        if (include_training_features) {
          std::cout << ",\"trainingSamples\":[";
          for (size_t i = 0; i < training_samples.size(); ++i) {
            if (i) std::cout << ',';
            std::cout << "{\"playerId\":"; write_json_string(std::cout, training_samples[i].first);
            std::cout << ",\"state\":[" << std::setprecision(9);
            for (size_t j = 0; j < training_samples[i].second.size(); ++j) {
              if (j) std::cout << ',';
              std::cout << training_samples[i].second[j];
            }
            std::cout << "]}";
          }
          std::cout << ']';
        }
        std::cout << ",\"state\":"; write_native_state(std::cout, state);
        std::cout << "}\n" << std::flush;
      } else if (mode == "actions" || mode == "npc") {
        const int actor = player_index(state, string_field(request, "playerId"));
        const auto actions = actor < 0 ? std::vector<NativeSearchAction>{} : rules.legal_actions(state, actor);
        if (mode == "npc") {
          const auto decision = choose_native_npc(state, actor, actions,
              static_cast<uint32_t>(number_field(request, "seed", 1)),heuristic_options(request),&heuristic_sessions[game_id]);
          const int selected=decision.selected;
          std::cout << "{\"v\":1,\"t\":\"npc_result\",\"id\":";
          write_json_string(std::cout, id);
          std::cout << ",\"action\":";
          if (selected < 0 || selected >= static_cast<int>(actions.size())) std::cout << "null";
          else write_native_action(std::cout, actions[static_cast<size_t>(selected)]);
          std::cout << ",\"heuristicSearch\":{\"searched\":" << (decision.searched?"true":"false")
                    << ",\"fallback\":" << (decision.fallback?"true":"false")
                    << ",\"visits\":" << decision.visits << ",\"expansions\":" << decision.expansions
                    << ",\"newVisits\":" << decision.new_visits << ",\"reusedVisits\":" << decision.reused_visits
                    << ",\"retainedNodes\":" << decision.retained_nodes << ",\"rollouts\":" << decision.rollouts
                    << ",\"rolloutActions\":" << decision.rollout_actions
                    << ",\"particles\":" << decision.particles << ",\"elapsedMs\":" << decision.elapsed_ms << ",\"fallbackReason\":";
          write_json_string(std::cout,decision.fallback_reason);
          std::cout << "}}\n" << std::flush;
        } else {
          std::cout << "{\"v\":1,\"t\":\"legal_actions_result\",\"id\":";
          write_json_string(std::cout, id);
          std::cout << ",\"phase\":"; write_json_string(std::cout, native_phase_name(state.phase));
          std::cout << ",\"actions\":[";
          for (size_t i = 0; i < actions.size(); ++i) {
            if (i) std::cout << ',';
            write_native_action(std::cout, actions[i]);
          }
          std::cout << "]}\n" << std::flush;
        }
      } else if (mode == "apply") {
        const auto player_id = string_field(request, "playerId");
        const int actor = player_index(state, player_id);
        const auto* action_value = request.get("action");
        if (actor < 0 || !action_value) throw std::runtime_error("apply 缺少有效 playerId/action");
        const auto action = decode_action(*action_value);
        // Round results are acknowledged independently by each player. The
        // next-player order only drives sequential gameplay and NPC scheduling.
        const bool round_confirmation = state.phase == NativePhase::RoundConfirm &&
            action.type == ActionType::ConfirmRound;
        if (!round_confirmation && actor != rules.next_player(state))
          throw std::runtime_error("不是该玩家的行动时机");
        const auto legal = rules.legal_actions(state, actor);
        if (std::none_of(legal.begin(), legal.end(), [&](const auto& candidate) { return matches(candidate, action); }))
          throw std::runtime_error("行动不在当前合法动作列表中");
        std::optional<NativeGameState> previous;
        if(!heuristic_sessions[game_id].tree.empty())previous=state;
        if (!rules.apply(state, actor, action)) {
          std::ostringstream detail;
          detail << "游戏引擎拒绝行动"
                 << "（player=" << player_id
                 << ", actor=" << actor
                 << ", phase=" << native_phase_name(state.phase)
                 << ", role=" << state.players[static_cast<size_t>(actor)].role_id
                 << ", pending=" << state.pending_kind
                 << ", turnPhase=" << state.turn_phase
                 << ", round=" << state.round
                 << ", legalCount=" << legal.size()
                 << ", action=";
          write_native_action(detail, action);
          detail << "）";
          throw std::runtime_error(detail.str());
        }
        if(previous)heuristic_sessions[game_id].advance(*previous,actor,action,state);
        std::cout << "{\"v\":1,\"t\":\"game_result\",\"id\":";
        write_json_string(std::cout, id);
        if (bool_field(request, "returnState", true)) {
          std::cout << ",\"state\":"; write_native_state(std::cout, state);
        }
        std::cout << ",\"round\":" << state.round << "}\n" << std::flush;
      } else if (mode == "close") {
        games.erase(found);
        heuristic_sessions.erase(game_id);
        std::cout << "{\"v\":1,\"t\":\"closed\",\"id\":";
        write_json_string(std::cout, id);
        std::cout << "}\n" << std::flush;
      } else {
        throw std::runtime_error("未知游戏引擎操作");
      }
    } catch (const std::exception& error) {
      emit_error(id, error.what());
    }
  }
  return 0;
}
