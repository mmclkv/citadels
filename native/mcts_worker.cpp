#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <algorithm>
#include <array>
#include <iostream>
#include <new>
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
bool actions_aligned(const std::vector<NativeSearchAction>& native_actions,
                     const std::vector<NativeSearchAction>& supplied, int* mismatch_index = nullptr) {
  if (native_actions.size() != supplied.size()) {
    if (mismatch_index) *mismatch_index = 0;
    return false;
  }
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
      if (mismatch_index) *mismatch_index = static_cast<int>(i);
      return false;
    }
  }
  return true;
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
  std::unique_ptr<LibTorchNeuralBatchedEvaluator> direct_neural;
#endif
  std::string gpu_model_path;
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
      const auto& state_value = required_field(request, "state");
      const auto& actions_value = required_field(request, "legalActions");
      const auto root_id = string_field(request, "rootPlayerId");
      if (!actions_value.is_array() || actions_value.as_array().empty())
        throw std::runtime_error("legalActions 不能为空");
      NativeGameState state = load_native_state(state_value);
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
      supplied.reserve(actions_value.as_array().size());
      for (const auto& value : actions_value.as_array()) supplied.push_back(decode_action(value));
      context += " · 动作=" + std::to_string(supplied.size());

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
      context += " · 模拟=" + std::to_string(config.simulations) +
        " · maxDepth=" + std::to_string(config.max_depth) +
        " · maxNodes=" + std::to_string(config.max_nodes) +
        " · batch=" + std::to_string(batch_size) +
        " · 后端=" + inference_backend;
      const auto native_actions = game.legal_actions(state, root);
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
          const auto particle_actions = game.legal_actions(particles[i], root);
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
        auto run_search = [&](int batch) {
#ifdef CITADELS_LIBTORCH
          if (direct_neural) {
            return BatchedMcts<NativeGameState, NativeSearchAction>(game, *direct_neural, config)
              .search(pool, root, batch, pool_weights);
          }
#endif
          if (shared_neural) {
            return BatchedMcts<NativeGameState, NativeSearchAction>(game, *shared_neural, config)
              .search(pool, root, batch, pool_weights);
          }
          if (neural) {
            return BatchedMcts<NativeGameState, NativeSearchAction>(game, *neural, config)
              .search(pool, root, batch, pool_weights);
          }
          return Mcts<NativeGameState, NativeSearchAction>(game, evaluator, config)
            .search(pool, root, pool_weights);
        };
        Mcts<NativeGameState, NativeSearchAction>::Result result;
        try {
          result = run_search(batch_size);
        } catch (const std::exception& error) {
          if (!is_cuda_oom(error.what())) throw;
          // 缓存分配器手里可能还攒着「已释放但没还给驱动」的块，这里没有别的
          // 回收手段（清缓存要引 CUDA 头文件，反而让编译多一条依赖），只能靠缩
          // 小评估批降低峰值；真正彻底的重置交给 JS 侧：它会把整个 worker 进程
          // 重启一次（连 CUDA 上下文一起还回去）再重试。
          result = run_search(std::min(batch_size, 8));
        }
        policy = result.policy; visits = result.visits; expansions = result.expansions;
        root_value = result.value;
        root_value_vector = result.value_vector;
        belief_applied = belief_used && particles_used > 1;
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
      std::cout << "],\"backend\":\"native-mcts\"}\n" << std::flush;
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
