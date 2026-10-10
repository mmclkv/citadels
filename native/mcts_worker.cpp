#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <algorithm>
#include <array>
#include <iostream>
#include <iomanip>
#include <new>
#include <optional>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "game_adapter.hpp"
#include "belief_weights.hpp"
#include "determinize.hpp"
#include "json_value.hpp"
#include "gpu_trainer_client.hpp"
#include "neural_evaluator.hpp"
#include "npc_policy.hpp"
#include "shared_memory_inference.hpp"
#include "seat_policy_evaluator.hpp"
#include "state_loader.hpp"
#include "state_writer.hpp"
#ifdef _WIN32
#include <windows.h>
#include <dbghelp.h>
#endif
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

// 显存不足（CUDA OOM）不是逻辑错误：6GB 显卡还要和桌面合成器共享，浏览器/系统
// 一动就可能把剩下的连续块吃掉。这类错误值得先回收缓存再重试一次，而不是让
// 一次搜索失败顺着 IPC 传回去把整轮训练掀翻（2026-09-19 训练日志：跑到第 6326
// 局因 OOM 直接中断，1h46m 的样本没存档）。
bool is_cuda_oom(const std::string& message) {
  return message.find("out of memory") != std::string::npos;
}

int player_index(const NativeGameState& state, const std::string& id) {
  for (size_t i = 0; i < state.players.size(); ++i)
    if (state.players[i].id == id) return static_cast<int>(i);
  return -1;
}

// JS 侧上报的合法动作 vs 本机规则算出来的合法动作。supplied 里留空的字段表示
// 「不关心」，只比对方填了的那些。抽出来是因为现在要比两次：主局面一次，
// 每个粒子一次 —— 粒子只有在动作列表逐项对得上时才允许进同一棵树，否则同一
// 棵树上的节点会对应不同的动作下标，统计量直接串味。
bool action_matches(const NativeSearchAction& native, const NativeSearchAction& supplied) {
  return native.type == supplied.type &&
    (supplied.uid.empty() || native.uid == supplied.uid) &&
    (supplied.target.empty() || native.target == supplied.target) &&
    (supplied.secondary_uid.empty() || native.secondary_uid == supplied.secondary_uid) &&
    (supplied.selected_uids.empty() || native.selected_uids == supplied.selected_uids) &&
    (!supplied.has_num || native.num == supplied.num) &&
    (supplied.gold < 0 || native.gold == supplied.gold) &&
    (supplied.cards < 0 || native.cards == supplied.cards) &&
    (supplied.type != ActionType::SpyColor || native.color == supplied.color) &&
    (supplied.name.empty() || native.name == supplied.name) &&
    (supplied.type != ActionType::Reaction || native.name == supplied.name);
}

bool actions_aligned(const std::vector<NativeSearchAction>& native_actions,
                     const std::vector<NativeSearchAction>& supplied, int* mismatch_index = nullptr) {
  if (native_actions.size() != supplied.size()) {
    if (mismatch_index) *mismatch_index = 0;
    return false;
  }
  for (size_t i = 0; i < supplied.size(); ++i) {
    if (!action_matches(native_actions[i], supplied[i])) {
      if (mismatch_index) *mismatch_index = static_cast<int>(i);
      return false;
    }
  }
  return true;
}

NativeSearchAction decode_action(const JsonValue& value) {
  if (!value.is_object()) throw std::runtime_error("合法动作必须是对象");
  const auto parsed = action_type_from_string(string_field(value, "type"));
  if (!parsed) throw std::runtime_error("策略请求包含未知动作类型");
  NativeSearchAction action;
  action.type = *parsed;
  action.uid = string_field(value, "uid");
  action.name = string_field(value, "name");
  if (action.name.empty()) action.name = string_field(value, "charId");
  if (action.name.empty()) action.name = string_field(value, "mode");
  action.effect = string_field(value, "effect");
  if (action.effect.empty() && value.get("use"))
    action.effect = bool_field(value, "use") ? "use" : "skip";
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

#ifdef _WIN32
namespace {

// 段错误（0xC0000005）一发生进程就没了，stderr 一个字都来不及写 —— 2026-09-19
// 训练里 worker 跑了 59 分钟后段错误，现场全靠猜。这里在进程死掉前把 minidump
// 落到 exe 同目录（native/crash-<pid>.dmp），下次再崩就能拿到崩溃线程的栈。
LONG WINAPI write_crash_dump(EXCEPTION_POINTERS* info) {
  char exe_path[MAX_PATH] = {};
  GetModuleFileNameA(nullptr, exe_path, MAX_PATH);
  std::string dir(exe_path);
  const size_t slash = dir.find_last_of("\\/");
  dir = (slash == std::string::npos) ? "." : dir.substr(0, slash);
  const std::string dump_path = dir + "\\crash-" + std::to_string(GetCurrentProcessId()) + ".dmp";
  HANDLE file = CreateFileA(dump_path.c_str(), GENERIC_WRITE, 0, nullptr,
                            CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (file != INVALID_HANDLE_VALUE) {
    MINIDUMP_EXCEPTION_INFORMATION dump_info{};
    dump_info.ThreadId = GetCurrentThreadId();
    dump_info.ExceptionPointers = info;
    dump_info.ClientPointers = FALSE;
    MiniDumpWriteDump(GetCurrentProcess(), GetCurrentProcessId(), file,
                      MiniDumpNormal, info ? &dump_info : nullptr, nullptr, nullptr);
    CloseHandle(file);
  }
  // CONTINUE_SEARCH：让默认处理继续，退出码保持原本的异常码（Node 侧仍能看到 3221225477）。
  return EXCEPTION_CONTINUE_SEARCH;
}

}  // namespace
#endif

int main() {
#ifdef _WIN32
  SetUnhandledExceptionFilter(write_crash_dump);
#endif
  std::string line;
  std::shared_ptr<GpuTrainerClient> gpu;
  std::unique_ptr<BatchEvaluator> batch;
  std::unique_ptr<NativeNeuralBatchedEvaluator> neural;
  std::unique_ptr<SharedMemoryInferenceClient> shared_inference;
  std::unique_ptr<BatchEvaluator> shared_batch;
  std::unique_ptr<NativeNeuralBatchedEvaluator> shared_neural;
#ifdef CITADELS_LIBTORCH
  std::unique_ptr<DirectNeuralEvaluator> direct_neural;
  std::unordered_map<std::string, std::unique_ptr<DirectNeuralEvaluator>> opponent_models;
#endif
  std::string gpu_model_path;
  std::string evaluator_config_key;
  int gpu_model_version = -1;
  while (std::getline(std::cin, line)) {
    std::string id;
    // 出错时把请求规模一起回传：只有一句「bad allocation」定位不到是哪个状态。
    std::string context;
    try {
      const auto request = parse_json(line);
      context = "行长=" + std::to_string(line.size());
      const auto& id_value = required_field(request, "id");
      id = id_value.as_string();
      context += " · id=" + id;
      if (string_field(request, "mode") == "forward_probe") {
#ifdef CITADELS_LIBTORCH
        const auto architecture = string_field(request, "architecture", "entity-v6");
        if (architecture != "entity-v6") throw std::runtime_error("C++ MCTS 只支持 entity-v6");
        const auto* probes_value = request.get("probes");
        if (!probes_value || !probes_value->is_array() || probes_value->as_array().empty())
          throw std::runtime_error("forward_probe 缺少输入样本");
        LibTorchEntityTransformerEvaluator probe(
          string_field(request, "profile", "balanced"), string_field(request, "modelPath"),
          string_field(request, "device", "cpu"), true,
          int_field(request, "actionEncodingVersion", kActionEncodingVersion));
        std::cout << "{\"v\":1,\"t\":\"forward_probe_result\",\"id\":\"" << escape(id) << "\",\"results\":[";
        for (size_t probe_index = 0; probe_index < probes_value->as_array().size(); ++probe_index) {
          if (probe_index) std::cout << ',';
          const auto& input = probes_value->as_array()[probe_index];
          const auto* state_value = input.get("stateFeatures");
          const auto* actions_value = input.get("actionFeatures");
          if (!state_value || !state_value->is_array() || !actions_value || !actions_value->is_array())
            throw std::runtime_error("forward_probe 输入样本缺少数值状态/动作特征");
          std::vector<float> state_features;
          for (const auto& value : state_value->as_array()) {
            if (!value.is_number()) throw std::runtime_error("forward_probe 状态特征必须为数字");
            state_features.push_back(static_cast<float>(value.as_number()));
          }
          std::vector<std::vector<float>> action_features;
          for (const auto& row : actions_value->as_array()) {
            if (!row.is_array()) throw std::runtime_error("forward_probe 动作特征必须是二维数组");
            action_features.emplace_back();
            for (const auto& value : row.as_array()) {
              if (!value.is_number()) throw std::runtime_error("forward_probe 动作特征必须为数字");
              action_features.back().push_back(static_cast<float>(value.as_number()));
            }
          }
          const auto outputs = probe.forward_encoded(state_features, action_features);
          std::cout << "{\"logits\":[";
          for (size_t i = 0; i < outputs.first.size(); ++i) {
            if (i) std::cout << ',';
            std::cout << std::setprecision(9) << outputs.first[i];
          }
          std::cout << "],\"values\":[";
          for (size_t i = 0; i < outputs.second.size(); ++i) {
            if (i) std::cout << ',';
            std::cout << std::setprecision(9) << outputs.second[i];
          }
          std::cout << "]}";
        }
        std::cout << "]}\n" << std::flush;
        continue;
#else
        throw std::runtime_error("当前 mcts_worker 未编译 LibTorch 后端，不能执行前向一致性检查");
#endif
      }
      const bool determinize_mode = string_field(request, "mode") == "determinize";
      const auto* state_value = request.get("state");
      if (!state_value || state_value->is_null())
        throw std::runtime_error("策略 worker 请求缺少 state");
      const auto* actions_value = request.get("legalActions");
      const auto root_id = string_field(request, "rootPlayerId");
      if (!determinize_mode && (!actions_value || !actions_value->is_array() || actions_value->as_array().empty()))
        throw std::runtime_error("legalActions 不能为空");
      NativeGameState state = load_native_state(*state_value);
      NativeGameAdapter game;
      if (determinize_mode) {
        const int viewer = player_index(state, string_field(request, "playerId"));
        if (viewer < 0) throw std::runtime_error("determinize 请求的 playerId 不存在");
        const int count = std::max(1, int_field(request, "count", 4));
        const uint32_t seed = static_cast<uint32_t>(int_field(request, "seed", 1));
        std::vector<NativeGameState> samples;
        samples.reserve(static_cast<size_t>(count));
        for (int sample = 0; sample < count; ++sample) {
          const uint32_t sample_seed = seed ^
            (static_cast<uint32_t>(sample + 1) * 0x9E3779B1u) ^
            (static_cast<uint32_t>(viewer + 1) * 0x85EBCA6Bu);
          samples.push_back(determinize_native_state(state, viewer, sample_seed));
        }
        const auto weights = native_belief_weights(samples, viewer, bool_field(request, "belief", true));
        std::cout << "{\"v\":1,\"t\":\"determinize_result\",\"id\":\"" << escape(id) << "\",\"particles\":[";
        for (size_t sample = 0; sample < samples.size(); ++sample) {
          if (sample) std::cout << ',';
          write_native_state(std::cout, samples[sample]);
        }
        std::cout << "],\"weights\":[";
        for (size_t sample = 0; sample < weights.size(); ++sample) {
          if (sample) std::cout << ',';
          std::cout << weights[sample];
        }
        std::cout << "]}\n" << std::flush;
        continue;
      }
      // 粒子池：其余几份「隐藏信息猜测」。整池进同一棵搜索树，每条模拟抽一份
      // （ISMCTS）；动作列表对不上的会在下面对齐校验里被丢掉。
      std::vector<NativeGameState> particles;
      if (const auto* particles_value = request.get("particles")) {
        if (particles_value->is_array()) {
          particles.reserve(particles_value->as_array().size());
          for (const auto& value : particles_value->as_array()) {
            if (value.is_object()) particles.push_back(load_native_state(value));
          }
        }
      }
      context += " · 玩家=" + std::to_string(state.players.size()) +
        " · round=" + std::to_string(state.round) +
        " · 粒子=" + std::to_string(1 + particles.size());
      const int root = player_index(state, root_id);
      if (root < 0) throw std::runtime_error("rootPlayerId 不存在");
      std::vector<NativeSearchAction> supplied;
      if (actions_value && actions_value->is_array()) {
        supplied.reserve(actions_value->as_array().size());
        for (const auto& value : actions_value->as_array()) supplied.push_back(decode_action(value));
      }
      context += " · 动作=" + std::to_string(supplied.size());

      UniformNativeEvaluator evaluator;
      const auto inference_backend = string_field(request, "inferenceBackend", "python-binary");
      const auto architecture = string_field(request, "architecture", "entity-v6");
      if (architecture != "entity-v6") throw std::runtime_error("C++ MCTS 只支持 entity-v6");
      const auto profile = string_field(request, "profile", "balanced");
      const auto device = string_field(request, "device", "cuda");
      const int action_encoding_version = int_field(request, "actionEncodingVersion", kActionEncodingVersion);
      if (action_encoding_version != 9 && action_encoding_version != 10 && action_encoding_version != kActionEncodingVersion)
        throw std::runtime_error("unsupported action encoding version");
      const bool include_training_features = bool_field(request, "includeTrainingFeatures");
      const auto config_key = inference_backend + "|" + architecture + "|" + profile + "|" + device + "|" +
        std::to_string(action_encoding_version) + "|" + string_field(request, "sharedMemoryName");
      if (evaluator_config_key != config_key) {
#ifdef CITADELS_LIBTORCH
        direct_neural.reset();
        opponent_models.clear();
#endif
        neural.reset(); batch.reset(); gpu.reset();
        shared_neural.reset(); shared_batch.reset(); shared_inference.reset();
        gpu_model_path.clear(); gpu_model_version = -1;
        evaluator_config_key = config_key;
      }
      if (bool_field(request, "gpuEvaluator") && !string_field(request, "modelPath").empty()) {
        const auto model_path = string_field(request, "modelPath");
        const int model_version = int_field(request, "modelVersion", 0);
        if (inference_backend == "libtorch") {
#ifdef CITADELS_LIBTORCH
          if (!direct_neural) {
            direct_neural = std::make_unique<LibTorchEntityTransformerEvaluator>(
              profile, model_path, device, true, action_encoding_version);
            context += " · 设备=" + direct_neural->device_name();
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
              profile, action_encoding_version);
          }
        } else if (!gpu) {
          gpu = std::make_shared<GpuTrainerClient>(string_field(request, "python"), string_field(request, "script"));
          gpu->start(string_field(request, "profile", "balanced"), model_path, 0.0003f,
                     string_field(request, "device", "cuda"), "binary",
                     string_field(request, "architecture", "entity-v6"), state_version_for_action(action_encoding_version));
          batch = std::make_unique<BatchEvaluator>(make_gpu_batch_backend(gpu,
            profile));
        neural = std::make_unique<NativeNeuralBatchedEvaluator>(*batch,
          profile, action_encoding_version);
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
      config.dirichlet_alpha = static_cast<float>(number_field(request, "dirichletAlpha", 0.3));
      config.dirichlet_epsilon = static_cast<float>(number_field(request, "dirichletEpsilon", 0.0));
      config.seed = static_cast<uint32_t>(int_field(request, "seed", 1));
      const int batch_size = std::max(1, int_field(request, "batchSize", 32));
      context += " · 模拟=" + std::to_string(config.simulations) +
        " · maxDepth=" + std::to_string(config.max_depth) +
        " · batch=" + std::to_string(batch_size) +
        " · 后端=" + inference_backend;
      const auto* opponent_policies = request.get("opponentPolicies");
      if (opponent_policies && !opponent_policies->is_array())
        throw std::runtime_error("opponentPolicies must be an array");
#ifdef CITADELS_LIBTORCH
      std::unique_ptr<SeatPolicyEvaluator<NativeGameState, NativeSearchAction>> seat_evaluator;
      std::unordered_map<int, BatchedEvaluator<NativeGameState, NativeSearchAction>*> seat_backends;
      std::unordered_set<std::string> active_models;
      if (opponent_policies && !opponent_policies->as_array().empty()) {
        if (!direct_neural || bool_field(request, "policyOnly"))
          throw std::runtime_error("opponentPolicies requires a full LibTorch search");
        if (opponent_policies->as_array().size() >= state.players.size())
          throw std::runtime_error("Too many opponent policies");
        for (const auto& entry : opponent_policies->as_array()) {
          const int actor = player_index(state, string_field(entry, "playerId"));
          const auto path = string_field(entry, "modelPath");
          const auto opponent_profile = string_field(entry, "profile", profile);
          const int version = int_field(entry, "modelVersion", 0);
          const int encoding = int_field(entry, "actionEncodingVersion", action_encoding_version);
          if (actor < 0 || actor == root || seat_backends.count(actor) || path.empty() ||
              !state.players[actor].is_bot || state.players[actor].bot_type != "neural")
            throw std::runtime_error("Invalid or duplicate opponent policy seat");
          if ((encoding != 9 && encoding != 10 && encoding != kActionEncodingVersion) ||
              state_version_for_action(encoding) != state_version_for_action(action_encoding_version))
            throw std::runtime_error("Opponent policy state encoding mismatch");
          if (opponent_profile != "fast" && opponent_profile != "balanced" && opponent_profile != "large")
            throw std::runtime_error("Invalid opponent policy profile");
          if (path == gpu_model_path && version == gpu_model_version &&
              opponent_profile == profile && encoding == action_encoding_version) {
            seat_backends[actor] = direct_neural.get();
          } else {
            const auto key = path + "|" + std::to_string(version) + "|" + opponent_profile + "|" + std::to_string(encoding);
            active_models.insert(key);
            auto& model = opponent_models[key];
            if (!model) model = std::make_unique<LibTorchEntityTransformerEvaluator>(
              opponent_profile, path, device, true, encoding);
            seat_backends[actor] = model.get();
          }
        }
        // Retain only this game's assigned models; direct-policy requests in
        // between learner searches do not flush the cache.
        for (auto it = opponent_models.begin(); it != opponent_models.end();)
          if (!active_models.count(it->first)) it = opponent_models.erase(it); else ++it;
      }
      if (direct_neural) seat_evaluator = std::make_unique<SeatPolicyEvaluator<NativeGameState, NativeSearchAction>>(
        *direct_neural, std::move(seat_backends));
#else
      if (opponent_policies && !opponent_policies->as_array().empty())
        throw std::runtime_error("opponentPolicies requires a LibTorch build");
#endif
      auto run_search = [&](const std::vector<NativeGameState>& states, int perspective,
                            int batch, const std::vector<float>& weights) {
#ifdef CITADELS_LIBTORCH
        if (bool_field(request, "policyOnly")) {
          if (!direct_neural) throw std::runtime_error("policyOnly requires LibTorch evaluator");
          const auto evaluated = direct_neural->evaluate(states.front(), perspective,
                                                        game.ai_actions(states.front(), perspective));
          Mcts<NativeGameState, NativeSearchAction>::Result result;
          result.policy = evaluated.priors;
          result.value = evaluated.value;
          result.value_vector = evaluated.value_vector;
          return result;
        }
#else
        if (bool_field(request, "policyOnly")) throw std::runtime_error("policyOnly requires LibTorch build");
#endif
        auto npc_choice = [seed = config.seed](const NativeGameState& game_state, int actor,
                                               int root_actor,
                                               const std::vector<NativeSearchAction>& legal) {
          if (actor < 0 || actor >= static_cast<int>(game_state.players.size()) ||
              actor == root_actor || !game_state.players[actor].is_bot ||
              game_state.players[actor].bot_type != "npc") return -1;
          const uint32_t policy_seed = seed ^
            (static_cast<uint32_t>(game_state.round) * 0x9e3779b9u) ^
            (static_cast<uint32_t>(actor) * 0x85ebca6bu) ^
            (static_cast<uint32_t>(game_state.turns_completed) * 0xc2b2ae35u);
          return NativeNpcPolicy::choose(game_state, actor, legal, policy_seed);
        };
#ifdef CITADELS_LIBTORCH
        if (direct_neural) {
          return BatchedMcts<NativeGameState, NativeSearchAction>(game, *seat_evaluator, config, npc_choice,
            [&](int player) { return seat_evaluator->has_policy(player); })
            .search(states, perspective, batch, weights);
        }
#endif
        if (shared_neural)
          return BatchedMcts<NativeGameState, NativeSearchAction>(game, *shared_neural, config, npc_choice)
            .search(states, perspective, batch, weights);
        if (neural)
          return BatchedMcts<NativeGameState, NativeSearchAction>(game, *neural, config, npc_choice)
            .search(states, perspective, batch, weights);
        return Mcts<NativeGameState, NativeSearchAction>(game, evaluator, config)
          .search(states, perspective, weights);
      };
      const auto native_actions = game.ai_actions(state, root);
      context += " · 原生动作=" + std::to_string(native_actions.size());
      std::vector<float> policy;
      float root_value = 0.0f;
      std::array<float, kValueSlots> root_value_vector{};
      int visits = 0, expansions = 0;
      int mismatch_index = -1;
      bool belief_applied = false;
      const bool actions_match = actions_aligned(native_actions, supplied, &mismatch_index);
      // 只有动作列表对得上的粒子才能进同一棵树；一个都不剩就回退成均匀策略，
      // 绝不能拿主局面以外的世界去搜（那就是把错的世界当真的）。
      //
      // 信念权重（与池等长，下标 0 是主局面）：粒子被丢弃时必须同步丢掉它的权重，
      // 否则权重会整体错位、套到别的世界上 —— 比没有信念更糟。
      std::vector<float> raw_weights;
      if (const auto* weights_value = request.get("particleWeights")) {
        if (weights_value->is_array()) {
          for (const auto& value : weights_value->as_array()) {
            raw_weights.push_back(value.is_number() ? static_cast<float>(value.as_number()) : 0.0f);
          }
        }
      }
      const auto weight_at = [&](size_t i) {
        return i < raw_weights.size() ? raw_weights[i] : 1.0f;
      };
      std::vector<NativeGameState> pool;
      std::vector<float> pool_weights;
      size_t particles_used = 0;
      if (actions_match) {
        pool.push_back(std::move(state));
        pool_weights.push_back(weight_at(0));
        for (size_t i = 0; i < particles.size(); ++i) {
          const auto particle_actions = game.ai_actions(particles[i], root);
          if (!actions_aligned(particle_actions, supplied)) continue;
          pool.push_back(std::move(particles[i]));
          pool_weights.push_back(weight_at(i + 1));
        }
        particles_used = pool.size();
        bool belief_used = false;
        for (float weight : pool_weights) if (weight > 0.0f && weight != 1.0f) belief_used = true;
        // 搜索可能因显存不足失败（评估发生在搜索内部）。先按原批跑；OOM 就清一次
        // 缓存、把评估批缩到 8 再跑一次。仍然失败才真正报错 —— 缩小批次只是让
        // 这一步慢一点，不会改变搜索语义（分批只影响叶节点收集）。
        Mcts<NativeGameState, NativeSearchAction>::Result result;
        try {
          result = run_search(pool, root, batch_size, pool_weights);
        } catch (const std::exception& error) {
          if (!is_cuda_oom(error.what())) throw;
          // 缓存分配器手里可能还攒着「已释放但没还给驱动」的块，这里没有别的
          // 回收手段（清缓存要引 CUDA 头文件，反而让编译多一条依赖），只能靠缩
          // 小评估批降低峰值；真正彻底的重置交给 JS 侧：它会把整个 worker 进程
          // 重启一次（连 CUDA 上下文一起还回去）再重试。
          result = run_search(pool, root, std::min(batch_size, 8), pool_weights);
        }
        policy = result.policy; visits = result.visits; expansions = result.expansions;
        root_value = result.value;
        root_value_vector = result.value_vector;
        belief_applied = belief_used && particles_used > 1;
      }
      if (policy.size() != supplied.size()) policy.assign(supplied.size(), 1.0f / supplied.size());
      std::optional<Evaluation> root_diagnostic;
#ifdef CITADELS_LIBTORCH
      if (bool_field(request, "includeRootDiagnostics") && actions_match && !pool.empty()) {
        if (!direct_neural) throw std::runtime_error("root diagnostics require LibTorch evaluator");
        root_diagnostic = direct_neural->evaluate(pool.front(), root, native_actions);
      }
#endif
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
                << ",\"actionEncodingVersion\":" << action_encoding_version
                << ",\"stateEncodingVersion\":" << state_version_for_action(action_encoding_version)
                << ",\"supportedActionEncodingVersion\":" << kActionEncodingVersion
                << ",\"policyOnly\":" << (bool_field(request, "policyOnly") ? "true" : "false")
                << ",\"fallback\":" << (actions_match ? "false" : "true")
                << ",\"particlesUsed\":" << particles_used
                << ",\"belief\":" << (belief_applied ? "true" : "false")
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
      std::cout << ']';
#ifdef CITADELS_LIBTORCH
      std::cout << ",\"opponentPolicyMode\":\"seat-policy-sampling-v1\""
                << ",\"opponentPolicyEvaluations\":" << (seat_evaluator ? seat_evaluator->policy_evaluations : 0);
#endif
      if (!actions_match) {
        std::cout << ",\"nativeActionDetails\":[";
        for (size_t i = 0; i < native_actions.size(); ++i) {
          if (i) std::cout << ',';
          write_native_action(std::cout, native_actions[i]);
        }
        std::cout << "],\"suppliedActionDetails\":[";
        for (size_t i = 0; i < supplied.size(); ++i) {
          if (i) std::cout << ',';
          write_native_action(std::cout, supplied[i]);
        }
        std::cout << ']';
      }
      if (root_diagnostic) {
        std::cout << ",\"networkPolicy\":[" << std::setprecision(9);
        for (size_t i = 0; i < root_diagnostic->priors.size(); ++i) {
          if (i) std::cout << ',';
          std::cout << root_diagnostic->priors[i];
        }
        std::cout << "],\"networkValueVector\":[";
        for (size_t i = 0; i < kValueSlots; ++i) {
          if (i) std::cout << ',';
          std::cout << root_diagnostic->value_vector[i];
        }
        std::cout << ']';
      }
      if (include_training_features && actions_match && !pool.empty()) {
        const auto state_features = encode_network_state(pool.front(), root, state_version_for_action(action_encoding_version));
        std::cout << ",\"stateFeatures\":[" << std::setprecision(9);
        for (size_t i = 0; i < state_features.size(); ++i) {
          if (i) std::cout << ',';
          std::cout << state_features[i];
        }
        std::cout << "],\"actionFeatures\":[";
        for (size_t i = 0; i < native_actions.size(); ++i) {
          if (i) std::cout << ',';
          const auto features = encode_network_action(native_actions[i], &pool.front(), root,
                                                      action_encoding_version);
          std::cout << '[';
          for (size_t j = 0; j < features.size(); ++j) {
            if (j) std::cout << ',';
            std::cout << features[j];
          }
          std::cout << ']';
        }
        std::cout << ']';
      }
      std::cout << ",\"backend\":\"native-mcts\"}\n" << std::flush;
    } catch (const std::bad_alloc& error) {
      // MSVC 下 bad_alloc::what() 固定是「bad allocation」，即主机内存申请失败；
      // CUDA 显存不足走下面的 std::exception 分支，文本是 torch 自己的报错。
      emit_error(id, std::string("native 搜索进程内存不足（") + error.what() + "）· " + context +
        " · 处理建议：降低 maxDepth / 模拟数 / batch 或减少 C++ worker 数");
    } catch (const std::exception& error) {
      emit_error(id, std::string(error.what()) + (context.empty() ? std::string() : " · " + context));
    }
  }
}
