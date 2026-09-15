#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

#include "game_adapter.hpp"
#include "json_value.hpp"
#include "gpu_trainer_client.hpp"
#include "neural_evaluator.hpp"
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
  // Draft/pending actions that are not yet executable by the native rules
  // layer still pass through the protocol.  They deliberately produce the
  // safe uniform fallback below instead of aborting the whole self-play game.
  return {parsed.value_or(ActionType::EndTurn), string_field(value, "uid"),
          string_field(value, "name"), string_field(value, "effect"), string_field(value, "target"),
          string_array_field(value, "uids"), string_field(value, "discardUid").empty()
            ? string_field(value, "cardUid") : string_field(value, "discardUid")};
}

void emit_error(const std::string& id, const std::string& message) {
  std::cout << "{\"v\":1,\"t\":\"error\",\"id\":\"" << escape(id)
            << "\",\"error\":\"" << escape(message) << "\"}\n" << std::flush;
}

}  // namespace

int main() {
  std::string line;
  std::shared_ptr<GpuTrainerClient> gpu;
  std::unique_ptr<BatchEvaluator> batch;
  std::unique_ptr<NativeNeuralBatchedEvaluator> neural;
  std::unique_ptr<NativeNeuralEvaluator> neural_single;
  std::string gpu_model_path;
  int gpu_model_version = -1;
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
      if (bool_field(request, "gpuEvaluator") && !string_field(request, "modelPath").empty()) {
        const auto model_path = string_field(request, "modelPath");
        const int model_version = int_field(request, "modelVersion", 0);
        if (!gpu) {
          gpu = std::make_shared<GpuTrainerClient>(string_field(request, "python"), string_field(request, "script"));
          gpu->start(string_field(request, "profile", "balanced"), model_path, 0.0003f,
                     string_field(request, "device", "cuda"));
          batch = std::make_unique<BatchEvaluator>(make_gpu_batch_backend(gpu,
            string_field(request, "profile", "balanced")));
          neural = std::make_unique<NativeNeuralBatchedEvaluator>(*batch,
            string_field(request, "profile", "balanced"));
          neural_single = std::make_unique<NativeNeuralEvaluator>(*neural);
          gpu_model_path = model_path;
        } else if (model_path != gpu_model_path || model_version != gpu_model_version) {
          gpu->reload_model(model_path);
          gpu_model_path = model_path;
        }
        gpu_model_version = model_version;
      }
      Mcts<NativeGameState, NativeSearchAction>::Config config;
      config.simulations = std::max(1, int_field(request, "simulations", 50));
      config.max_depth = std::max(1, int_field(request, "maxDepth", 200));
      config.c_puct = static_cast<float>(number_field(request, "cPuct", 1.0));
      config.seed = static_cast<uint32_t>(int_field(request, "seed", 1));
      const auto native_actions = game.legal_actions(state, root);
      std::vector<float> policy;
      float root_value = 0.0f;
      int visits = 0, expansions = 0;
      if (native_actions.size() == supplied.size()) {
        bool same_order = true;
        for (size_t i = 0; i < supplied.size(); ++i) {
          if (native_actions[i].type != supplied[i].type ||
              (!supplied[i].uid.empty() && native_actions[i].uid != supplied[i].uid) ||
              (!supplied[i].target.empty() && native_actions[i].target != supplied[i].target) ||
              (!supplied[i].secondary_uid.empty() &&
               native_actions[i].secondary_uid != supplied[i].secondary_uid) ||
              (!supplied[i].selected_uids.empty() &&
               native_actions[i].selected_uids != supplied[i].selected_uids)) {
            same_order = false; break;
          }
        }
        if (same_order) {
          auto* selected_evaluator = neural_single
            ? static_cast<Evaluator<NativeGameState, NativeSearchAction>*>(neural_single.get())
            : static_cast<Evaluator<NativeGameState, NativeSearchAction>*>(&evaluator);
          const auto result = Mcts<NativeGameState, NativeSearchAction>(game, *selected_evaluator, config)
            .search(state, root);
          policy = result.policy; visits = result.visits; expansions = result.expansions;
          root_value = result.value;
        }
      }
      if (policy.size() != supplied.size()) policy.assign(supplied.size(), 1.0f / supplied.size());
      std::cout << "{\"v\":1,\"t\":\"search_result\",\"id\":\"" << escape(id)
                << "\",\"policy\":[";
      for (size_t i = 0; i < policy.size(); ++i) {
        if (i) std::cout << ',';
        std::cout << policy[i];
      }
      std::cout << "],\"value\":" << root_value << ",\"visits\":" << visits
                << ",\"expansions\":" << expansions
                << ",\"backend\":\"native-mcts\"}\n" << std::flush;
    } catch (const std::exception& error) {
      emit_error(id, error.what());
    }
  }
}
