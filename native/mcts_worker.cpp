#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <array>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "game_adapter.hpp"
#include "json_value.hpp"
#include "gpu_trainer_client.hpp"
#include "neural_evaluator.hpp"
#include "shared_memory_inference.hpp"
#include "state_loader.hpp"
#ifdef CITADELS_LIBTORCH
#include "libtorch_evaluator.hpp"
#endif

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
  auto name = string_field(value, "name");
  if (name.empty()) name = string_field(value, "charId");
  if (name.empty()) name = string_field(value, "mode");
  auto effect = string_field(value, "effect");
  if (effect.empty() && value.get("use")) effect = bool_field(value, "use") ? "use" : "skip";
  NativeSearchAction action;
  action.type = parsed.value_or(ActionType::EndTurn);
  action.uid = string_field(value, "uid");
  action.name = std::move(name);
  action.effect = std::move(effect);
  if (action.name.empty() && action.type == ActionType::Reaction) action.name = action.effect;
  action.target = string_field(value, "target");
  action.selected_uids = string_array_field(value, "uids");
  action.secondary_uid = string_field(value, "discardUid");
  if (action.secondary_uid.empty()) action.secondary_uid = string_field(value, "cardUid");
  action.mode = string_field(value, "mode");
  action.color = string_field(value, "color");
  if (const auto* field = value.get("num"); field && field->is_number()) {
    action.num = static_cast<int>(field->as_number()); action.has_num = true;
  }
  if (const auto* field = value.get("gold"); field && field->is_number()) action.gold = static_cast<int>(field->as_number());
  if (const auto* field = value.get("cards"); field && field->is_number()) action.cards = static_cast<int>(field->as_number());
  action.use = bool_field(value, "use");
  return action;
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
  std::unique_ptr<SharedMemoryInferenceClient> shared_inference;
  std::unique_ptr<BatchEvaluator> shared_batch;
  std::unique_ptr<NativeNeuralBatchedEvaluator> shared_neural;
#ifdef CITADELS_LIBTORCH
  std::unique_ptr<LibTorchNeuralBatchedEvaluator> direct_neural;
#endif
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
      const auto inference_backend = string_field(request, "inferenceBackend", "python-binary");
      if (bool_field(request, "gpuEvaluator") && !string_field(request, "modelPath").empty()) {
        const auto model_path = string_field(request, "modelPath");
        const int model_version = int_field(request, "modelVersion", 0);
        if (inference_backend == "libtorch") {
#ifdef CITADELS_LIBTORCH
          if (!direct_neural) {
            direct_neural = std::make_unique<LibTorchNeuralBatchedEvaluator>(
              string_field(request, "profile", "balanced"), model_path,
              string_field(request, "device", "cuda"));
          } else if (model_path != gpu_model_path || model_version != gpu_model_version) {
            direct_neural->reload_model(model_path);
          }
#else
          throw std::runtime_error("当前 mcts_worker 未编译 LibTorch 后端");
#endif
        } else if (!string_field(request, "sharedMemoryName").empty()) {
          if (!shared_inference) {
            shared_inference = std::make_unique<SharedMemoryInferenceClient>(
              string_field(request, "sharedMemoryName"),
              static_cast<uint32_t>(std::max(1, int_field(request, "sharedMemorySlots", 8))),
              static_cast<uint32_t>(std::max(1024, int_field(request, "sharedMemorySlotBytes", 8 * 1024 * 1024))));
            shared_batch = std::make_unique<BatchEvaluator>(make_shared_memory_batch_backend(*shared_inference));
            shared_neural = std::make_unique<NativeNeuralBatchedEvaluator>(*shared_batch,
              string_field(request, "profile", "balanced"));
          }
        } else if (!gpu) {
          gpu = std::make_shared<GpuTrainerClient>(string_field(request, "python"), string_field(request, "script"));
          gpu->start(string_field(request, "profile", "balanced"), model_path, 0.0003f,
                     string_field(request, "device", "cuda"), "binary");
          batch = std::make_unique<BatchEvaluator>(make_gpu_batch_backend(gpu,
            string_field(request, "profile", "balanced")));
          neural = std::make_unique<NativeNeuralBatchedEvaluator>(*batch,
            string_field(request, "profile", "balanced"));
        } else if (model_path != gpu_model_path || model_version != gpu_model_version) {
          gpu->reload_model(model_path);
        }
        gpu_model_path = model_path;
        gpu_model_version = model_version;
      }
      Mcts<NativeGameState, NativeSearchAction>::Config config;
      config.simulations = std::max(1, int_field(request, "simulations", 50));
      config.max_depth = std::max(1, int_field(request, "maxDepth", 200));
      config.c_puct = static_cast<float>(number_field(request, "cPuct", 1.0));
      config.seed = static_cast<uint32_t>(int_field(request, "seed", 1));
      const int batch_size = std::max(1, int_field(request, "batchSize", 32));
      const auto native_actions = game.legal_actions(state, root);
      std::vector<float> policy;
      float root_value = 0.0f;
      std::array<float, kValueSlots> root_value_vector{};
      int visits = 0, expansions = 0;
      bool actions_match = native_actions.size() == supplied.size();
      int mismatch_index = actions_match ? -1 : 0;
      if (actions_match) {
        for (size_t i = 0; i < supplied.size(); ++i) {
          if (native_actions[i].type != supplied[i].type ||
              (!supplied[i].uid.empty() && native_actions[i].uid != supplied[i].uid) ||
              (!supplied[i].target.empty() && native_actions[i].target != supplied[i].target) ||
              (!supplied[i].secondary_uid.empty() &&
               native_actions[i].secondary_uid != supplied[i].secondary_uid) ||
              (!supplied[i].selected_uids.empty() &&
               native_actions[i].selected_uids != supplied[i].selected_uids) ||
              (supplied[i].has_num && native_actions[i].num != supplied[i].num) ||
              (supplied[i].gold >= 0 && native_actions[i].gold != supplied[i].gold) ||
              (supplied[i].cards >= 0 && native_actions[i].cards != supplied[i].cards) ||
              (supplied[i].type == ActionType::SpyColor && native_actions[i].color != supplied[i].color) ||
              (!supplied[i].name.empty() && native_actions[i].name != supplied[i].name) ||
              (supplied[i].type == ActionType::Reaction && native_actions[i].name != supplied[i].name)) {
            actions_match = false;
            mismatch_index = static_cast<int>(i);
            break;
          }
        }
        if (actions_match) {
          Mcts<NativeGameState, NativeSearchAction>::Result result;
#ifdef CITADELS_LIBTORCH
          if (direct_neural) {
            result = BatchedMcts<NativeGameState, NativeSearchAction>(game, *direct_neural, config)
              .search(state, root, batch_size);
          } else if (shared_neural) {
            result = BatchedMcts<NativeGameState, NativeSearchAction>(game, *shared_neural, config)
              .search(state, root, batch_size);
          } else if (neural) {
#else
          if (shared_neural) {
            result = BatchedMcts<NativeGameState, NativeSearchAction>(game, *shared_neural, config)
              .search(state, root, batch_size);
          } else if (neural) {
#endif
            result = BatchedMcts<NativeGameState, NativeSearchAction>(game, *neural, config)
              .search(state, root, batch_size);
          } else {
            result = Mcts<NativeGameState, NativeSearchAction>(game, evaluator, config)
              .search(state, root);
          }
          policy = result.policy; visits = result.visits; expansions = result.expansions;
          root_value = result.value;
          root_value_vector = result.value_vector;
        }
      }
      if (policy.size() != supplied.size()) policy.assign(supplied.size(), 1.0f / supplied.size());
      std::cout << "{\"v\":1,\"t\":\"search_result\",\"id\":\"" << escape(id)
                << "\",\"policy\":[";
      for (size_t i = 0; i < policy.size(); ++i) {
        if (i) std::cout << ',';
        std::cout << policy[i];
      }
      std::cout << "],\"valueVector\":[";
      for (size_t i = 0; i < kValueSlots; ++i) {
        if (i) std::cout << ',';
        std::cout << root_value_vector[i];
      }
      std::cout << "],\"value\":" << root_value << ",\"visits\":" << visits
                << ",\"expansions\":" << expansions
                << ",\"fallback\":" << (actions_match ? "false" : "true")
                << ",\"nativeActionCount\":" << native_actions.size()
                << ",\"mismatchIndex\":" << mismatch_index
                << ",\"nativeActionTypes\":[";
      for (size_t i = 0; i < native_actions.size(); ++i) {
        if (i) std::cout << ',';
        std::cout << '"' << action_type_name(native_actions[i].type) << '"';
      }
      std::cout << "],\"suppliedActionTypes\":[";
      for (size_t i = 0; i < supplied.size(); ++i) {
        if (i) std::cout << ',';
        std::cout << '"' << action_type_name(supplied[i].type) << '"';
      }
      std::cout << "],\"backend\":\"native-mcts\"}\n" << std::flush;
    } catch (const std::exception& error) {
      emit_error(id, error.what());
    }
  }
}
